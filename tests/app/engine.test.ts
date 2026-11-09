import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classify, cleanAnswers, computeState, evaluate, text, type Workflow } from "../../app/src/engine";

const root = resolve(__dirname, "../..");
const load = (p: string) => JSON.parse(readFileSync(resolve(root, p), "utf-8"));

describe("condition vectors (shared with Python)", () => {
  for (const c of load("tests/vectors/conditions.json").cases) {
    it(c.name, () => expect(evaluate(c.cond, c.answers)).toBe(c.expected));
  }
});

describe("workflow vectors (shared with Python)", () => {
  for (const c of load("tests/vectors/workflows.json").cases) {
    it(c.name, () => {
      const wf: Workflow = load(c.workflow);
      const exp = c.expected;
      const st = computeState(wf, c.answers);
      const hidden = wf.fields.map((f) => f.id).filter((id) => !st.visible.includes(id));
      expect(hidden).toEqual(exp.hidden);
      expect(st.errors).toEqual(exp.errors);
      expect(st.complete).toBe(exp.complete);
      const findings = classify(wf, c.answers);
      expect(findings.map((f) => f.id)).toEqual(exp.finding_ids);
      expect(findings.every((f) => f.source === "local")).toBe(true);
      const byId = Object.fromEntries(findings.map((f) => [f.id, f]));
      for (const [id, sev] of Object.entries(exp.severities ?? {})) expect(byId[id].severity).toBe(sev);
      for (const [id, score] of Object.entries(exp.scores ?? {})) expect(byId[id].score).toBe(score);
      for (const [id, detail] of Object.entries(exp.details ?? {})) expect(byId[id].detail).toBe(detail);
      if (exp.cleaned_keys) expect(Object.keys(cleanAnswers(wf, c.answers)).sort()).toEqual(exp.cleaned_keys);
    });
  }
});

it("multilingual labels fall back", () => {
  expect(text({ en: "Hi", hi: "नमस्ते" }, "hi")).toBe("नमस्ते");
  expect(text({ en: "Hi" }, "xx")).toBe("Hi");
});

describe("0.2.5 example rules: rust and leaks (same results as the Python engine)", () => {
  const wf = load("examples/maintenance/workflow.json") as Workflow;
  const decide = (a: Record<string, unknown>) => classify(wf, cleanAnswers(wf, a), "en").find((f) => f.kind === "decision_tree")?.detail;
  it("the hosted PMP-0045 inspection (fair, rust and leak in notes) is no longer 'continue monitoring'", () => {
    const a = { asset_id: "PMP-0045", running_hours: 1280, condition: "fair", symptoms: ["noise"], guard_ok: true,
      notes: "Rust on the housing, water leaking near the pump casing" };
    const f = classify(wf, cleanAnswers(wf, a), "en");
    expect(f.find((x) => x.kind === "score")?.severity).toBe("medium");
    expect(decide(a)).toBe("Repair within 7 days and re-inspect");
  });
  it("routine, Hindi notes, vibration, poor and guard paths", () => {
    expect(decide({ condition: "good", symptoms: [], guard_ok: true, notes: "all normal" })).toBe("Continue routine monitoring");
    expect(decide({ condition: "fair", guard_ok: true, notes: "जंग लगी है" })).toBe("Repair within 7 days and re-inspect");
    expect(decide({ condition: "good", guard_ok: true, symptoms: ["vibration"], vibration_level: 8 })).toBe("Repair within 7 days and re-inspect");
    expect(decide({ condition: "poor", guard_ok: true })).toBe("Schedule repair this week");
    expect(decide({ condition: "good", guard_ok: false })).toBe("Stop and tag out");
  });
});
