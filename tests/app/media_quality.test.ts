// Regression cases from real-iPhone offline testing (0.2.4): speech, OCR, translation and attachment previews.
import { beforeEach, describe, expect, it } from "vitest";
import { collapseRepeats, isSilent, prepareSpeech, whisperOptions } from "../../app/src/audio_prep";
import { _resetDbForTests, db, type Attachment, type InstalledModel } from "../../app/src/db";
import { ocrVerdict, sttPackFor } from "../../app/src/intel";
import { attachmentUrl, memoryBlob, pickRecorderMime, updateAttachment } from "../../app/src/media";
import { keepWords, pageLines } from "../../app/src/ocr_prep";
import { protectTerms, restoreTerms, splitSentences, termPairs, tidyOutput } from "../../app/src/translate_prep";
import { sha256Hex } from "../../app/src/util";

describe("speech preparation (Whisper)", () => {
  const rate = 16000;
  const tone = (s: number, amp: number) => Float32Array.from({ length: s * rate }, (_, i) => amp * Math.sin(i / 8));
  it("trims the silence around a quiet phone recording and normalises its level", () => {
    const speech = tone(1, 0.05);
    const x = new Float32Array(rate * 4);                          // 1.5 s silence, 1 s speech, 1.5 s silence
    for (let i = 0; i < x.length; i++) x[i] = 0.0005 * Math.sin(i * 1.7);
    x.set(speech, rate * 1.5);
    const y = prepareSpeech(x);
    expect(y.length / rate).toBeGreaterThan(1.2);
    expect(y.length / rate).toBeLessThan(1.8);                     // 1 s + 2 x 0.3 s padding
    expect(Math.max(...Array.from(y, Math.abs))).toBeCloseTo(0.9, 1);
  });
  it("never amplifies more than 30x and reports silence instead of transcribing it", () => {
    expect(Math.max(...Array.from(prepareSpeech(tone(1, 0.001)), Math.abs))).toBeLessThanOrEqual(0.031);
    expect(isSilent(new Float32Array(rate))).toBe(true);
    expect(isSilent(tone(1, 0.05))).toBe(false);
  });
  it("guards against Whisper loops and caps the output length by duration", () => {
    const o = whisperOptions(rate * 5, "hindi");
    expect(o).toMatchObject({ language: "hindi", task: "transcribe", no_repeat_ngram_size: 4, max_new_tokens: 116 });
    expect(collapseRepeats("5th year, 5th year, 5th year, 5th year, done")).toBe("5th year, done");
    expect(collapseRepeats("The pump is fine.")).toBe("The pump is fine.");
  });
});

describe("speech pack choice", () => {
  const model = (id: string, model: string, languages: string[], size: number, version = 1) =>
    ({ id, capability: "stt", version, title: id, installed_at: "", verified: true, verify_detail: "", size,
      manifest: { model, languages, download_size: size } }) as unknown as InstalledModel;
  const tinyV1 = model("stt-whisper-tiny", "Xenova/whisper-tiny", ["en", "hi"], 41e6);   // as stored by 0.2.3 installs
  const small = model("stt-whisper-small", "Xenova/whisper-small", ["hi", "en"], 249e6);
  it("never uses Whisper tiny for Hindi, even an old pack that claims it (it romanises Hindi)", () => {
    expect(sttPackFor([tinyV1], "hi")).toBeUndefined();
    expect(sttPackFor([tinyV1, small], "hi")?.id).toBe("stt-whisper-small");
  });
  it("uses the smaller pack for English when both are installed", () => {
    expect(sttPackFor([small, tinyV1], "en")?.id).toBe("stt-whisper-tiny");
    expect(sttPackFor([small], "en")?.id).toBe("stt-whisper-small");
  });
});

describe("OCR result filtering and verdict", () => {
  const page = { blocks: [{ paragraphs: [{ lines: [
    { words: [{ text: "Pump", confidence: 92 }, { text: "P-204", confidence: 91 }, { text: "isolated", confidence: 93 }] },
    { words: [{ text: "]", confidence: 18 }, { text: ":", confidence: 0 }] },                 // page edge read as symbols
    { words: [{ text: "Wag", confidence: 19 }, { text: "nia", confidence: 1 }, { text: "a", confidence: 19 }] },  // shadow texture
  ] }] }] };
  it("keeps confident words and drops edge marks and texture", () => {
    const r = keepWords(pageLines(page));
    expect(r.text).toBe("Pump P-204 isolated");
    expect(r.confidence).toBe(92);
    expect(r.dropped).toBe(5);
  });
  it("scores a full read above a confident heading alone (the iPhone failure mode)", () => {
    const heading = keepWords([{ words: [{ text: "EQUIPMENT", confidence: 96 }, { text: "NOTICE", confidence: 96 }] }]);
    const full = keepWords([{ words: "Check the bearing temperature every shift and record the oil level".split(" ").map((t) => ({ text: t, confidence: 88 })) }]);
    expect(full.score).toBeGreaterThan(heading.score);
    expect(heading.confidence).toBeGreaterThan(full.confidence);
  });
  it("never presents a weak read as reliable", () => {
    expect(ocrVerdict(92, 30, 3, 120).quality).toBe("good");
    expect(ocrVerdict(70, 10, 4, 50).quality).toBe("check");
    expect(ocrVerdict(30, 3, 20, 12)).toMatchObject({ quality: "poor" });
    expect(ocrVerdict(0, 0, 0, 0).note).toMatch(/No readable text/);
  });
});

describe("dictionary-guided translation", () => {
  const entries = [
    { term: "bearing", lang: "en", translations: { hi: "बेयरिंग" } },
    { term: "lubrication", lang: "en", translations: { hi: "स्नेहन" }, synonyms: ["greasing"] },
    { term: "safety guard", lang: "en", translations: { hi: "सुरक्षा कवर" } },
    { term: "कंपन", lang: "hi", translations: { en: "vibration" } },
  ];
  it("builds term pairs for both directions, longest first", () => {
    const en = termPairs(entries, "en", "hi");
    // A Hindi-headword entry (कंपन → vibration) serves the reverse direction too.
    expect(en.map((p) => p.source)).toEqual(["safety guard", "lubrication", "vibration", "greasing", "bearing"]);
    expect(en.find((p) => p.source === "vibration")?.target).toBe("कंपन");
    const hi = termPairs(entries, "hi", "en");
    expect(hi).toEqual(expect.arrayContaining([{ source: "बेयरिंग", target: "bearing" }, { source: "कंपन", target: "vibration" }]));
  });
  it("protects terms with placeholders and restores the dictionary translation", () => {
    const p = protectTerms("The bearing is hot.", termPairs(entries, "en", "hi"));
    expect(p.text).toBe("The XQ1 is hot.");
    expect(restoreTerms("XQ1 गर्म है.", p.slots)).toEqual({ text: "बेयरिंग गर्म है.", ok: true });
  });
  it("matches Devanagari terms on letter boundaries", () => {
    const p = protectTerms("बेयरिंग गरम है।", termPairs(entries, "hi", "en"));
    expect(p.text).toBe("XQ1 गरम है।");
    expect(protectTerms("बेयरिंगों", termPairs(entries, "hi", "en")).slots).toHaveLength(0);
  });
  it("detects a lost placeholder so the sentence is retranslated plainly", () => {
    const p = protectTerms("The bearing is hot.", termPairs(entries, "en", "hi"));
    expect(restoreTerms("गर्म हवा और गर्म है;", p.slots).ok).toBe(false);
  });
  it("uses Hindi sentence punctuation and keeps line breaks", () => {
    expect(tidyOutput("मोटर गर्म है.", "hi")).toBe("मोटर गर्म है।");
    expect(tidyOutput("गर्म हवा और गर्म है;", "hi")).toBe("गर्म हवा और गर्म है।");
    expect(splitSentences("One. Two!\nThree")).toEqual([["One.", "Two!"], ["Three"]]);
  });
});

describe("voice recording format", () => {
  it("records MP4/AAC on Apple devices even when WebM is also recordable (iPhone playback error)", () => {
    expect(pickRecorderMime({ apple: true, isTypeSupported: () => true, canPlay: () => "maybe" })).toBe("audio/mp4");
  });
  it("keeps WebM/Opus elsewhere and never picks a format the device can't play", () => {
    expect(pickRecorderMime({ apple: false, isTypeSupported: () => true, canPlay: () => "probably" })).toBe("audio/webm;codecs=opus");
    expect(pickRecorderMime({ apple: false, isTypeSupported: () => true, canPlay: (m) => (m === "audio/webm" ? "" : "maybe") })).toBe("audio/mp4");
  });
});

describe("attachment previews (broken thumbnail / audio error on Results)", () => {
  const bytes = new TextEncoder().encode("jpeg-bytes-of-a-photo");
  let att: Attachment;
  beforeEach(async () => {
    indexedDB = new IDBFactory();
    _resetDbForTests();
    att = { id: "att_photo_1", record_id: "rec_1", field_id: "photos", kind: "photo", mime: "image/jpeg", size: bytes.length,
      sha256: await sha256Hex(bytes.buffer), blob: new Blob([bytes], { type: "image/jpeg" }), created_at: "", uploaded: true, meta: {} };
    await (await db()).put("attachments", att);
  });
  const noFetch = (() => { throw new Error("must not fetch"); }) as unknown as typeof fetch;

  it("shows the device copy after checking it against the captured SHA-256", async () => {
    const r = await attachmentUrl(att, noFetch);
    expect(r.source).toBe("device");
    expect(r.url).toMatch(/^blob:/);
  });
  it("falls back to Hermes' verified copy when the device copy is unreadable, and repairs it", async () => {
    const broken = { ...att, blob: new Blob([]) };
    const r = await attachmentUrl(broken, (async () => new Response(bytes, { status: 200 })) as typeof fetch);
    expect(r).toMatchObject({ source: "hermes", repaired: true });
    const fixed = await (await db()).get("attachments", att.id);
    expect(await sha256Hex(await fixed!.blob.arrayBuffer())).toBe(att.sha256);
  });
  it("refuses a Hermes copy that doesn't match, and explains a damaged file that never uploaded", async () => {
    const broken = { ...att, blob: new Blob([]) };
    await expect(attachmentUrl(broken, (async () => new Response("other", { status: 200 })) as typeof fetch)).rejects.toThrow(/doesn't match/);
    await expect(attachmentUrl({ ...broken, uploaded: false }, noFetch)).rejects.toThrow(/hasn't reached Hermes/);
  });
  it("updates metadata (OCR text, transcript) without changing the file", async () => {
    const next = await updateAttachment(att.id, { meta: { ocr_text: "Pump P-204" } });
    expect(next!.meta?.ocr_text).toBe("Pump P-204");
    const stored = await (await db()).get("attachments", att.id);
    expect(await sha256Hex(await stored!.blob.arrayBuffer())).toBe(att.sha256);
    expect((await memoryBlob(stored!.blob, "image/jpeg")).blob.type).toBe("image/jpeg");
  });
});
