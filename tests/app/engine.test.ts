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
  expect(text({ en: "Hi" }, "mr")).toBe("Hi");
});
