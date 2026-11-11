// Form language helpers: yes/no answer words with an English fallback, and which language a label is shown in.
import { describe, expect, it } from "vitest";
import { text, textLang, yesNo, yesNoLang } from "../../app/src/engine";

describe("yes/no answers", () => {
  it("are in Hindi when the form language is Hindi", () => {
    expect([yesNo(true, "hi"), yesNo(false, "hi")]).toEqual(["हाँ", "नहीं"]);
    expect(yesNoLang("hi")).toBe("hi");
  });
  it("fall back to English for English and for languages without the words", () => {
    expect([yesNo(true, "en"), yesNo(false, "en")]).toEqual(["Yes", "No"]);
    expect([yesNo(true, "mr"), yesNo(false, "mr")]).toEqual(["Yes", "No"]);
    expect(yesNoLang("mr")).toBe("en");
  });
});

describe("label language", () => {
  const both = { en: "Asset tag", hi: "एसेट टैग" };
  it("is the chosen language when the label has it", () => {
    expect([text(both, "hi"), textLang(both, "hi")]).toEqual(["एसेट टैग", "hi"]);
  });
  it("is English when the label lacks the chosen language", () => {
    expect([text({ en: "Notes" }, "hi"), textLang({ en: "Notes" }, "hi")]).toEqual(["Notes", "en"]);
  });
  it("is the label's own language when it has neither", () => {
    expect([text({ hi: "टिप्पणी" }, "en"), textLang({ hi: "टिप्पणी" }, "en")]).toEqual(["टिप्पणी", "hi"]);
    expect(textLang("plain text", "hi")).toBe("en");
  });
});
