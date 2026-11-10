import { describe, expect, it } from "vitest";
import { languageLabel, requestOutcome, storageMessage } from "../../app/src/storage";

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

describe("language names", () => {
  it("shows readable names for language codes", () => {
    expect(languageLabel("hi")).toMatch(/Hindi/);
    expect(languageLabel("en-GB")).toMatch(/English/);
  });
});
