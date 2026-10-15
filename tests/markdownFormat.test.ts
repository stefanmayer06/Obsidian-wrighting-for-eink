import { describe, expect, it } from "vitest";
import {
  classifyLine,
  escapePlainLine,
  formatLine,
  joinParagraphLines,
  lineTextWithHighlights,
  normalizeWikilinks,
} from "../src/core/markdownFormat";
import { line } from "./helpers";

describe("normalizeWikilinks", () => {
  it.each([
    ["see [[Page]] now", "see [[Page]] now"],
    ["see [ [Page] ] now", "see [[Page]] now"],
    ["see [[Page] now", "see [[Page]] now"],
    ["see [Page]] now", "see [[Page]] now"],
    ["[[A]] and [[B]", "[[A]] and [[B]]"],
    ["[[[Page]]]", "[[Page]]"],
    ["plain [brackets] stay", "plain [brackets] stay"],
    ["[[Page|alias]]", "[[Page|alias]]"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeWikilinks(input)).toBe(expected);
  });
});

describe("classifyLine / formatLine", () => {
  it.each([
    ["- milk", "- milk"],
    ["• eggs", "- eggs"],
    ["-> follow up", "- follow up"],
    ["1. first", "1. first"],
    ["2) second", "2. second"],
    ["[ ] call Bob", "- [ ] call Bob"],
    ["☐ call Bob", "- [ ] call Bob"],
    ["[x] done", "- [x] done"],
    ["☑ done", "- [x] done"],
    ["Just text", "Just text"],
    ["2026 was great", "2026 was great"],
  ])("%s -> %s", (input, expected) => {
    expect(formatLine(classifyLine(input))).toBe(expected);
  });

  it("escapes lines that would turn into setext headings or tables", () => {
    expect(escapePlainLine("===")).toBe("\\===");
    expect(escapePlainLine("| a | b")).toBe("\\| a | b");
    expect(escapePlainLine("normal")).toBe("normal");
  });
});

describe("paragraph joining", () => {
  it("joins wrapped lines with spaces and keeps hyphenation", () => {
    expect(joinParagraphLines(["The quick", "brown fox"])).toBe("The quick brown fox");
    expect(joinParagraphLines(["Bei-", "spiel"])).toBe("Bei-spiel");
    expect(joinParagraphLines(["Haus-", "Und Garten"])).toBe("Haus- Und Garten");
    expect(joinParagraphLines(["", " a ", ""])).toBe("a");
  });
});

describe("low confidence highlighting", () => {
  it("marks uncertain words only", () => {
    const l = line("hello wrld again", { x: 0, y: 0, w: 300, h: 30 });
    l.words[1].confidence = 0.3;
    expect(lineTextWithHighlights(l, 0.5)).toBe("hello ==wrld== again");
    expect(lineTextWithHighlights(l, 0)).toBe("hello wrld again");
  });

  it("keeps trailing punctuation outside the highlight and skips links", () => {
    const l = line("Hi there, [[Anna]]", { x: 0, y: 0, w: 300, h: 30 });
    l.words[1].confidence = 0.2;
    l.words[2].confidence = 0.2;
    expect(lineTextWithHighlights(l, 0.5)).toBe("Hi ==there==, [[Anna]]");
  });
});
