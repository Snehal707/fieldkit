import { describe, expect, it } from "vitest";
import { requestOutcome, storageMessage, summarizeVoices } from "../../app/src/storage";

describe("storage messages", () => {
  it("distinguishes the three states and never uses an error tone", () => {
    const p = storageMessage({ kind: "protected", standalone: true });
    const b = storageMessage({ kind: "best-effort", standalone: false });
    const u = storageMessage({ kind: "unsupported", standalone: false });
    expect([p.label, b.label, u.label]).toEqual(["Protected", "Standard storage (not protected)", "Standard storage"]);
    expect([p.tone, b.tone, u.tone]).toEqual(["ok", "info", "info"]);
    expect([p.canRequest, b.canRequest, u.canRequest]).toEqual([false, true, false]);
  });

  it("never promises permanent storage and stays calm", () => {
    for (const kind of ["protected", "best-effort", "unsupported"] as const) {
      for (const standalone of [true, false]) {
        const m = storageMessage({ kind, standalone });
        expect(m.detail).not.toMatch(/permanent|guaranteed forever|will be lost|danger|warning/i);
      }
    }
    expect(storageMessage({ kind: "best-effort", standalone: false }).detail).toContain("not guaranteed");
    expect(storageMessage({ kind: "best-effort", standalone: true }).detail).not.toContain("Home Screen");
  });

  it("explains a declined request as normal", () => {
    expect(requestOutcome("best-effort")).toEqual({ tone: "info", text: expect.stringContaining("common on iPhone") });
    expect(requestOutcome("protected").tone).toBe("ok");
    expect(requestOutcome("unsupported").tone).toBe("info");
  });
});

describe("voice summary", () => {
  it("groups, dedupes and counts only on-device voices", () => {
    const voices = [
      { name: "Samantha", lang: "en-US", localService: true }, { name: "Samantha", lang: "en-US", localService: true },
      { name: "Daniel", lang: "en-GB", localService: true }, { name: "Lekha", lang: "hi-IN", localService: true },
      { name: "Cloud Voice", lang: "en-US", localService: false },
    ];
    const s = summarizeVoices(voices);
    expect(s.total).toBe(4);
    expect(s.languages.map((l) => l.code)).toEqual(expect.arrayContaining(["en-US", "en-GB", "hi-IN"]));
    expect(s.languages.find((l) => l.code === "en-US")!.voices).toEqual(["Samantha"]);
    expect(s.languages.find((l) => l.code === "hi-IN")!.label).toMatch(/Hindi/);
    expect(s.languages.flatMap((l) => l.voices)).not.toContain("Cloud Voice");
  });
});
