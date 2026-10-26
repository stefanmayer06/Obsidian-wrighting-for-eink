import { describe, expect, it } from "vitest";
import { findHandwrittenLinks } from "../src/core/links";
import type { SceneLine } from "../src/core/classify";
import type { Rect } from "../src/core/geometry";

function sceneLine(words: Array<[string, Rect]>, strokeIds: string[]): SceneLine {
  return {
    text: words.map((w) => w[0]).join(" "),
    box: { x: 0, y: 0, w: 500, h: 30 },
    words: words.map(([text, box]) => ({ text, box, confidence: 0.9 })),
    strokeIds,
  };
}

const rects = new Map<string, Rect>([
  ["s1", { x: 0, y: 0, w: 80, h: 30 }],
  ["s2", { x: 100, y: 0, w: 40, h: 30 }],
  ["s3", { x: 150, y: 0, w: 120, h: 30 }],
  ["s4", { x: 300, y: 0, w: 60, h: 30 }],
]);

describe("findHandwrittenLinks", () => {
  it("puts the link on the first stroke of the linked words", () => {
    const line = sceneLine(
      [
        ["Meet", { x: 0, y: 0, w: 80, h: 30 }],
        ["[[Anna", { x: 100, y: 0, w: 60, h: 30 }],
        ["Lee]]", { x: 160, y: 0, w: 110, h: 30 }],
        ["today", { x: 300, y: 0, w: 60, h: 30 }],
      ],
      ["s1", "s2", "s3", "s4"],
    );
    expect(findHandwrittenLinks([line], rects)).toEqual([{ strokeId: "s2", link: "[[Anna Lee]]" }]);
  });

  it("tolerates broken brackets and ignores plain brackets", () => {
    const broken = sceneLine(
      [
        ["see", { x: 0, y: 0, w: 80, h: 30 }],
        ["[Anna]]", { x: 100, y: 0, w: 170, h: 30 }],
      ],
      ["s1", "s2", "s3"],
    );
    expect(findHandwrittenLinks([broken], rects)).toEqual([{ strokeId: "s2", link: "[[Anna]]" }]);
    const plain = sceneLine([["[note]", { x: 0, y: 0, w: 80, h: 30 }]], ["s1"]);
    expect(findHandwrittenLinks([plain], rects)).toEqual([]);
  });
});
