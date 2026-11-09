// Offline assistant engine (0.2.5). A word-hash embedder stands in for the multilingual model so the logic is tested
// deterministically; understanding quality with the real model is measured in tests/eval/assistant_eval.mjs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { beginGuide, buildCorpus, newState, respond, type AskContext, type Corpus, type EmbedFn } from "../../app/src/assistant";
import { isFollowUp, itemReference, linkEntities } from "../../app/src/assistant_core";
import { answerGuide, outcomeOf, startGuide, type Guide } from "../../app/src/guides";

const root = resolve(import.meta.dirname, "../..");
const fake: EmbedFn = async (texts) => texts.map((t) => {
  const v = new Array(512).fill(0);
  for (const w of t.toLowerCase().split(/[^\p{L}\p{M}\p{N}]+/u).filter((x) => x.length > 2)) {
    let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 512] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
});
const none: EmbedFn = async () => null;

// A published workspace manifest like the server makes (the synthetic dairy fixture), plus the example packs.
const B = JSON.parse(readFileSync(resolve(root, "tests/app/fixtures/dairy_manifest.json"), "utf-8"));
const maint = JSON.parse(readFileSync(resolve(root, "examples/maintenance/knowledge.json"), "utf-8"));
const terms = JSON.parse(readFileSync(resolve(root, "examples/maintenance/dictionary.json"), "utf-8"));
const packs = [{ id: "ws-dairy-collection-mh", kind: "workspace", content: B }, { id: "maintenance-basics", kind: "knowledge", content: maint },
  { id: "maintenance-terms", kind: "dictionary", content: terms }];
const guide: Guide = B.guides[0];

async function corpus(e: EmbedFn = fake): Promise<Corpus> { return buildCorpus(packs, e, "en"); }

describe("decision guides", () => {
  it("fill questions from the record and ask only what is missing", () => {
    let run = startGuide(guide, "dairy-collection-mh", { snf_pct: 8.2 });
    expect(run.steps[0]).toMatchObject({ slot: "snf_pct", value: 8.2, source: "record" });
    expect(run.node).toBe("n_retested");                  // the record can't answer this: ask
    run = answerGuide(guide, run, "yes", { snf_pct: 8.2 });
    expect(outcomeOf(guide, run)?.decision).toBe("reject");
  });
  it("reach every outcome on its scripted path", () => {
    expect(outcomeOf(guide, startGuide(guide, "w", { snf_pct: 8.7 }))?.decision).toBe("accept");
    expect(outcomeOf(guide, answerGuide(guide, startGuide(guide, "w", { snf_pct: 8.0 }), false, { snf_pct: 8.0 }))?.decision).toBe("retest");
    const asked = startGuide(guide, "w", {});
    expect(asked.node).toBe("n_snf");                     // no record value: the guide asks for it
    expect(outcomeOf(guide, answerGuide(guide, asked, 9.1))?.decision).toBe("accept");
  });
});

describe("understanding helpers", () => {
  it("resolve item references and follow-ups in English and Hindi", () => {
    expect(itemReference("Explain issue 2")).toEqual({ kind: "issue", index: 2 });
    expect(itemReference("tell me about the second problem")).toEqual({ kind: "issue", index: 2 });
    expect(itemReference("दूसरी समस्या समझाइए")).toEqual({ kind: "issue", index: 2 });
    expect(itemReference("what about the last action")).toEqual({ kind: "action", index: -1 });
    expect(isFollowUp("what about the seal?")).toBe(true);
    expect(isFollowUp("और इसका क्या?")).toBe(true);
    expect(isFollowUp("How do I check shaft alignment on the main pump")).toBe(false);
  });
  it("link workspace terms in both languages", () => {
    const ents = [{ id: "t1", kind: "term" as const, names: ["coupling", "कपलिंग"] }, { id: "t2", kind: "term" as const, names: ["seal", "सील"] }];
    expect(linkEntities("is the coupling worn?", ents)[0].id).toBe("t1");
    expect(linkEntities("सील से रिसाव", ents)[0].id).toBe("t2");
  });
});

describe("conversation", () => {
  const report = { version: 1, schema_version: 2, summary: "Guard missing and vibration high.",
    decision: { outcome: "stop", rationale: "Running without a guard risks injury.", confidence: "high", escalate_to: "maintenance supervisor" },
    decision_scale: [{ id: "stop", label: "Stop and escalate now", severity: "critical" }],
    issues: [{ title: "Safety guard missing", severity: "critical", interpretation: "Exposed coupling can catch clothing.", evidence_refs: [{ kind: "answer", ref: "guard_ok" }] },
      { title: "High vibration", severity: "high", interpretation: "9 mm/s is above the alarm level; bearings will wear fast.", evidence_refs: [{ kind: "measurement", ref: "vibration_level" }] }],
    next_actions: [{ action: "Tag out the machine", who: "inspector", by_when_days: 0, verify_by: "Tag in place", origin: "ai_suggestion" },
      { action: "Check alignment", who: "technician", by_when_days: 7, verify_by: "Vibration below 4.5 mm/s", origin: "ai_suggestion" }],
    uncertainty: [{ unknown: "Bearing temperature", how_to_resolve: "Measure it" }] };
  const wf = JSON.parse(readFileSync(resolve(root, "examples/maintenance/workflow.json"), "utf-8"));
  const ctx: AskContext = { record: { id: "rec_1", workflow_id: wf.id, answers: { guard_ok: false, vibration_level: 9, condition: "poor", asset_id: "PMP-1" } }, report, workflow: wf };

  it("explains an issue with the record's evidence, then follows up on 'what next' and 'why'", async () => {
    const c = await corpus();
    let s = newState("en");
    let r = await respond(c, s, "Explain issue 2", ctx, fake);
    expect(r.reply.intent).toBe("explain_issue");
    expect(r.reply.text).toContain("High vibration");
    expect(r.reply.text).toContain("Vibration velocity: 9 mm/s");      // the record's value, with its label and unit
    s = r.state;
    r = await respond(c, s, "What should I do next?", ctx, fake);
    expect(r.reply.text).toMatch(/1\. Tag out the machine[\s\S]*Check it worked: Tag in place/);
    r = await respond(c, r.state, "Why?", ctx, fake);
    expect(r.reply.text).toContain("Running without a guard risks injury");
    expect(r.reply.uncertainty).toContain("Bearing temperature");
  });

  it("answers from workspace content with the evidence status, and runs a guide from the conversation", async () => {
    const c = await corpus();
    const r = await respond(c, newState("en"), "accept or reject milk", { record: { id: "m1", workflow_id: "milk-collection-check", answers: { snf_pct: 8.2 } } }, fake);
    expect(r.reply.kind).toBe("guide_question");
    expect(r.reply.text).toMatch(/From this record: .*8.2/);
    expect(r.reply.options?.map((o) => o.label)).toEqual(["Yes", "No"]);
    const r2 = await respond(c, r.state, "Yes", { record: { id: "m1", workflow_id: "milk-collection-check", answers: { snf_pct: 8.2 } } }, fake);
    expect(r2.reply.kind).toBe("guide_outcome");
    expect(r2.reply.text).toMatch(/Reject and record the reason — Verified source/);
    expect(r2.reply.text).toContain("Tell the centre manager (escalate)");
  });

  it("starts a guide directly (report action / workspace page)", async () => {
    const c = await corpus();
    const r = beginGuide(c, newState("en"), "dairy-collection-mh", "g_accept", { record: null });
    expect(r?.reply.kind).toBe("guide_question");
  });

  it("refuses to guess, flags a knowledge gap, and keeps the conversation usable", async () => {
    const c = await corpus();
    const r = await respond(c, newState("en"), "Who won the cricket match yesterday?", {}, fake);
    expect(r.reply.kind).toBe("not_covered");
    expect(r.reply.gap).toBe(true);
    expect(r.reply.citations).toEqual([]);
  });

  it("follows a short follow-up with the previous intent", async () => {
    const c = await corpus();
    const r1 = await respond(c, newState("en"), "What are common reasons for equipment vibration?", {}, fake);
    expect(r1.reply.kind).toBe("answer");
    const r2 = await respond(c, r1.state, "what about the bearing?", {}, fake);
    expect(r2.reply.kind).toBe("answer");
    expect(r2.reply.text.toLowerCase()).toContain("bearing");
  });

  it("defines terms from the dictionary and answers Hindi questions in Hindi labels", async () => {
    const c = await corpus();
    const r = await respond(c, newState("en"), "What is coupling?", {}, fake);
    expect(r.reply.text).toMatch(/^coupling \(hi: कपलिंग\)/);
    const h = await respond(c, newState("en"), "दूसरी समस्या समझाइए", ctx, fake);
    expect(h.state.lang).toBe("hi");
    expect(h.reply.text).toContain("समस्या 2");
  });

  it("works without the understanding model (basic mode), and guides stay deterministic", async () => {
    const c = await corpus(none);
    expect(c.mode).toBe("basic");
    const r = await respond(c, newState("en"), "lockout before inspection", {}, none);
    expect(r.reply.kind).toBe("answer");
    expect(r.reply.citations[0].title).toMatch(/Lockout/);
  });
});

describe("guide answers are typed", () => {
  it("a numeric question never accepts a sentence as its reading; a new question leaves the guide", async () => {
    const c = await corpus();
    const r1 = await respond(c, newState("en"), "accept or reject milk", { record: null }, fake);
    expect(r1.reply.kind).toBe("guide_question");          // asks for the SNF reading (inferred: number)
    const r2 = await respond(c, r1.state, "Who won the cricket match yesterday?", { record: null }, fake);
    expect(r2.reply.kind).toBe("not_covered");              // not taken as a reading
    const r3 = await respond(c, r1.state, "8.2", { record: null }, fake);
    expect(r3.reply.kind).toBe("guide_question");
    expect(r3.reply.text).toContain("Was it re-tested?");
  });
});

describe("basic mode never answers from function words", () => {
  it("refuses an off-topic question that only shares words like 'what' and 'the'", async () => {
    const c = await corpus(none);
    expect((await respond(c, newState("en"), "What is the capital of Peru?", {}, none)).reply.kind).toBe("not_covered");
    expect((await respond(c, newState("en"), "Explain common reasons for equipment vibration", {}, none)).reply.kind).toBe("answer");
  });
});
