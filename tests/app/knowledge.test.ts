import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KnowledgeIndex, bestExcerpt, lookup } from "../../app/src/knowledge";
import type { InstalledPack } from "../../app/src/db";

const root = resolve(__dirname, "../..");
const pack = (p: string): InstalledPack => {
  const content = JSON.parse(readFileSync(resolve(root, p), "utf-8"));
  return { id: content.id, kind: content.kind, version: 1, sha256: "", size: 0, title: "", languages: content.languages,
    domain: content.domain, installed_at: "", content };
};
const packs = ["maintenance", "education", "agriculture"].flatMap((d) => [pack(`examples/${d}/knowledge.json`), pack(`examples/${d}/dictionary.json`)]);
const idx = new KnowledgeIndex(packs);

describe("offline question answering", () => {
  it("answers each demo domain from its own pack, with a source", () => {
    const cases: [string, string][] = [
      ["Explain photosynthesis", "science-basics::photosynthesis"],
      ["Explain common reasons for equipment vibration", "maintenance-basics::vibration"],
      ["What are possible causes of leaf discoloration?", "crop-basics::leaf-discoloration"],
      ["why is my bearing overheating", "maintenance-basics::bearing-overheating"],
      ["how does the water cycle work evaporation", "science-basics::water-cycle"],
    ];
    for (const [q, key] of cases) {
      const a = idx.ask(q, { packs });
      expect(a.supported, q).toBe(true);
      expect(a.entry!.key, q).toBe(key);
      expect(a.entry!.source.length).toBeGreaterThan(0);
    }
  });

  it("answers a Hindi question from the Hindi text", () => {
    const a = idx.ask("प्रकाश संश्लेषण क्या है", { packs, lang: "hi" });
    expect(a.supported).toBe(true);
    expect(a.entry!.id).toBe("photosynthesis");
    expect(a.entry!.text).toContain("क्लोरोफिल");
  });

  it("reports unsupported questions instead of guessing", () => {
    const a = idx.ask("What is the capital of Peru?", { packs });
    expect(a.supported).toBe(false);
    expect(a.note).toBeTruthy();
    expect(idx.ask("", { packs }).supported).toBe(false);
  });

  it("returns predefined follow-ups and related topics", () => {
    const a = idx.ask("equipment vibration causes", { packs });
    expect(a.followups.length).toBeGreaterThan(0);
    expect(a.related.map((r) => r.key)).toContain("maintenance-basics::alignment");
  });

  it("prefers the workflow's own packs when asked in context", () => {
    const a = idx.ask("photograph samples", { packs, domainPacks: ["crop-basics"] });
    expect(a.entry?.pack_id ?? a.others[0]?.key.split("::")[0]).toBe("crop-basics");
  });

  it("excerpt keeps the most relevant sentences in order", () => {
    const body = "One. Bearings fail. Two unrelated. Lubrication matters for bearings. Five.";
    expect(bestExcerpt(body, ["bearings", "lubrication"])).toBe("One. Bearings fail. Lubrication matters for bearings.");
    expect(bestExcerpt("Short. Text.", ["x"])).toBe("Short. Text.");
  });
});

describe("offline dictionary", () => {
  it("exact, translation, prefix and fuzzy matches", () => {
    expect(lookup(packs, "bearing")[0]).toMatchObject({ term: "bearing", match: "exact", translations: { hi: "बेयरिंग" } });
    expect(lookup(packs, "कंपन")[0].match).toBe("exact");
    expect(lookup(packs, "सिंचाई").some((h) => h.term === "irrigation" && h.match === "translation")).toBe(true);
    expect(lookup(packs, "evap")[0].term).toBe("evaporation");
    expect(lookup(packs, "chlorophyl")[0].term).toBe("chlorophyll");
    expect(lookup(packs, "zzzz")).toEqual([]);
  });
});
