import { describe, expect, it } from "vitest";
import { classifyScene, DEFAULT_CLASSIFY_OPTIONS, isDiagramFrameName } from "../src/core/classify";
import { DEFAULT_LAYOUT_OPTIONS, layoutTranscript, type LayoutOptions } from "../src/core/layout";
import type { ExElement } from "../src/types/excalidraw";
import { boxStroke, line, shape, stroke, textEl } from "./helpers";

const layoutOpts: LayoutOptions = {
  ...DEFAULT_LAYOUT_OPTIONS,
  drawingLink: "Notes/Page.excalidraw",
  linkFor: (p) => p.replace(/\.md$/, ""),
};

/** A page with a paragraph, a list, a hand-drawn diagram with a label, a typed text element and noise. */
function scene() {
  const els: ExElement[] = [
    // paragraph: two lines
    stroke("a1", 0, 100, 90, 30),
    stroke("a2", 100, 100, 90, 30),
    stroke("a3", 200, 100, 100, 30),
    stroke("b1", 0, 140, 90, 30),
    stroke("b2", 100, 140, 100, 30),
    // list
    stroke("c1", 0, 260, 120, 30),
    stroke("d1", 0, 300, 120, 30),
    // diagram: hand-drawn box with a label, plus an arrow shape
    boxStroke("box", 400, 100, 200, 120),
    stroke("lbl", 450, 140, 100, 30),
    shape("arrow1", "arrow", 600, 160, 120, 0, { points: [[0, 0], [120, 0]] }),
    // typed text element on the ink page
    textEl("t1", "Typed on the [[Ink]] page", 0, 400),
    // noise dot far away
    stroke("dot", 900, 700, 3, 3),
    // our own helper elements are ignored
    shape("region1", "rectangle", 390, 90, 340, 140, { customData: { inkNotebook: { role: "region", kind: "diagram" } } }),
    textEl("card", "typed card", 0, 900, 200, 25, { customData: { inkNotebook: { role: "typed" } } }),
  ];
  const lines = [
    line("The quick brown", { x: 0, y: 100, w: 300, h: 30 }),
    line("fox jumps", { x: 0, y: 140, w: 200, h: 30 }),
    line("- milk", { x: 0, y: 260, w: 120, h: 30 }),
    line("- eggs", { x: 0, y: 300, w: 120, h: 30 }),
    line("Start", { x: 450, y: 140, w: 100, h: 30 }),
  ];
  return { els, lines };
}

describe("classifyScene", () => {
  it("separates handwriting, diagrams, typed text and noise", () => {
    const { els, lines } = scene();
    const c = classifyScene(els, lines, new Set());
    expect([...c.textStrokeIds].sort()).toEqual(["a1", "a2", "a3", "b1", "b2", "c1", "d1", "lbl"]);
    expect(c.lines.map((l) => l.text)).toEqual(["The quick brown", "fox jumps", "- milk", "- eggs"]);
    expect(c.lines[0].strokeIds.sort()).toEqual(["a1", "a2", "a3"]);
    expect(c.diagrams).toHaveLength(1);
    expect(c.diagrams[0].labels).toEqual(["Start"]);
    expect(c.diagrams[0].elementIds).toEqual(expect.arrayContaining(["box", "arrow1", "lbl"]));
    expect(c.texts.map((t) => t.text)).toEqual(["Typed on the [[Ink]] page"]);
    expect(c.noiseStrokeIds).toEqual(["dot"]);
    expect(c.pendingInk).toEqual([]);
  });

  it("treats strokes without OCR as pending ink", () => {
    const { els } = scene();
    const pending = new Set(els.filter((e) => e.type === "freedraw").map((e) => e.id));
    const c = classifyScene(els, [], pending);
    expect(c.lines).toEqual([]);
    expect(c.pendingInk.length).toBeGreaterThan(0);
    expect(c.pendingInk.flatMap((p) => p.strokeIds).sort()).toEqual([...pending].sort());
    // the arrow shape is still a diagram
    expect(c.diagrams.some((d) => d.elementIds.includes("arrow1"))).toBe(true);
  });

  it("ignores low-confidence lines and huge short 'letters' that are really drawings", () => {
    const els = [stroke("w1", 0, 0, 100, 30), stroke("w2", 0, 40, 100, 30), stroke("w3", 0, 80, 100, 30), boxStroke("circle", 300, 0, 150, 150)];
    const lines = [
      line("one", { x: 0, y: 0, w: 100, h: 30 }),
      line("two", { x: 0, y: 40, w: 100, h: 30 }),
      line("three", { x: 0, y: 80, w: 100, h: 30 }),
      line("O", { x: 300, y: 0, w: 150, h: 150 }),
      line("zz", { x: 0, y: 200, w: 50, h: 30 }, 0.1),
    ];
    const c = classifyScene(els, lines, new Set());
    expect(c.lines.map((l) => l.text)).toEqual(["one", "two", "three"]);
    expect(c.diagrams).toHaveLength(1);
    expect(c.diagrams[0].elementIds).toContain("circle");
  });

  it("recognises pages, page backgrounds and diagram frames", () => {
    const els: ExElement[] = [
      shape("paper", "image", 0, 0, 1000, 1414, { locked: true, customData: { inkNotebook: { role: "paper" } } }),
      shape("pdfimg", "image", 0, 1500, 800, 1100, { locked: true, customData: { inkNotebook: { role: "pdf-page", pdf: "Docs/Paper.pdf", page: 3 } } }),
      shape("frameA", "frame", 2000, 0, 500, 500, { name: "Diagram: flow" }),
      shape("frameB", "frame", 3000, 0, 500, 500, { name: "Chapter 2" }),
      shape("marker", "frame", 4000, 0, 600, 800, { frameRole: "marker", link: "[[Other.pdf#page=2]]" }),
      shape("markerImg", "image", 4000, 0, 600, 800),
      stroke("inFrame", 2100, 100, 100, 30, { frameId: "frameA" }),
    ];
    const c = classifyScene(els, [], new Set());
    expect(c.pages.map((p) => [p.id, p.kind])).toEqual([
      ["paper", "paper"],
      ["pdfimg", "pdf"],
      ["frameB", "frame"],
      ["marker", "pdf"],
    ]);
    expect(c.pages[1]).toMatchObject({ pdfPath: "Docs/Paper.pdf", pdfPage: 3 });
    expect(c.pages[3]).toMatchObject({ pdfPath: "Other.pdf", pdfPage: 2 });
    expect(c.pages[2].title).toBe("Chapter 2");
    // the page-sized image under the marker frame is a background, not a diagram
    expect(c.diagrams.map((d) => d.frameId ?? d.elementIds.join())).toEqual(["frameA"]);
    expect(c.diagrams[0].elementIds).toEqual(["inFrame"]);
  });

  it("detects diagram frame names", () => {
    expect(isDiagramFrameName("Diagram 1")).toBe(true);
    expect(isDiagramFrameName("figure: flow")).toBe(true);
    expect(isDiagramFrameName("Skizze")).toBe(true);
    expect(isDiagramFrameName("Chapter 2")).toBe(false);
    expect(isDiagramFrameName(null)).toBe(false);
  });

  it("keeps a diagram from swallowing the paragraph below it", () => {
    const els: ExElement[] = [
      shape("rect", "rectangle", 0, 0, 300, 100),
      stroke("l1", 0, 105, 200, 30),
      stroke("l2", 0, 140, 200, 30),
      stroke("l3", 0, 175, 200, 30),
    ];
    const lines = [
      line("first line", { x: 0, y: 105, w: 200, h: 30 }),
      line("second line", { x: 0, y: 140, w: 200, h: 30 }),
      line("third line", { x: 0, y: 175, w: 200, h: 30 }),
    ];
    const c = classifyScene(els, lines, new Set(), { ...DEFAULT_CLASSIFY_OPTIONS, labelMargin: 25 });
    // only the first line touches the rectangle's margin
    expect(c.diagrams[0].labels).toEqual(["first line"]);
    expect(c.lines.map((l) => l.text)).toEqual(["second line", "third line"]);
  });

  it("turns a long thin hand-drawn line into a rule", () => {
    const els = [stroke("rule", 0, 500, 600, 4)];
    const c = classifyScene(els, [], new Set());
    expect(c.diagrams[0].isRule).toBe(true);
  });
});

describe("layoutTranscript", () => {
  it("produces paragraphs, lists, diagram embeds and typed text in reading order", () => {
    const { els, lines } = scene();
    const c = classifyScene(els, lines, new Set());
    const blocks = layoutTranscript(c, () => "area=REG1", layoutOpts);
    expect(blocks.map((b) => b.md)).toEqual([
      "The quick brown fox jumps",
      "![[Notes/Page.excalidraw#^area=REG1|320]]\n%% Start %%",
      "- milk\n- eggs",
      "Typed on the [[Ink]] page",
    ]);
    // keys are stable across runs
    const again = layoutTranscript(classifyScene(els, lines, new Set()), () => "area=REG1", layoutOpts);
    expect(again.map((b) => b.key)).toEqual(blocks.map((b) => b.key));
    expect(new Set(blocks.map((b) => b.key)).size).toBe(blocks.length);
  });

  it("falls back to a page/drawing embed when ink is pending or no region exists", () => {
    const { els } = scene();
    const pending = new Set(els.filter((e) => e.type === "freedraw").map((e) => e.id));
    const blocks = layoutTranscript(classifyScene(els, [], pending), () => null, layoutOpts);
    const embeds = blocks.filter((b) => b.md.startsWith("![["));
    expect(embeds).toHaveLength(1);
    expect(embeds[0].md).toBe("![[Notes/Page.excalidraw]]");
    expect(blocks.some((b) => b.md === "Typed on the [[Ink]] page")).toBe(true);
  });

  it("detects headings by size and numbered/task lists", () => {
    const els = [
      stroke("h", 0, 0, 300, 70),
      stroke("p1", 0, 100, 300, 30),
      stroke("p2", 0, 135, 300, 30),
      stroke("n1", 0, 220, 200, 30),
      stroke("n2", 0, 255, 200, 30),
      stroke("n2b", 40, 290, 200, 30),
      stroke("k1", 0, 380, 200, 30),
    ];
    const lines = [
      line("Big Title", { x: 0, y: 0, w: 300, h: 70 }),
      line("some text that", { x: 0, y: 100, w: 300, h: 30 }),
      line("wraps around", { x: 0, y: 135, w: 300, h: 30 }),
      line("1. alpha", { x: 0, y: 220, w: 200, h: 30 }),
      line("2. beta", { x: 0, y: 255, w: 200, h: 30 }),
      line("continued", { x: 40, y: 290, w: 200, h: 30 }),
      line("[ ] call [Anna]]", { x: 0, y: 380, w: 200, h: 30 }),
    ];
    const blocks = layoutTranscript(classifyScene(els, lines, new Set()), () => null, layoutOpts);
    expect(blocks.map((b) => b.md)).toEqual([
      "## Big Title",
      "some text that wraps around",
      "1. alpha\n2. beta continued",
      "- [ ] call [[Anna]]",
    ]);
  });

  it("groups content by PDF page with linked headings", () => {
    const els: ExElement[] = [
      shape("p1", "image", 0, 0, 800, 1100, { locked: true, customData: { inkNotebook: { role: "pdf-page", pdf: "Docs/Paper.pdf", page: 1 } } }),
      shape("p2", "image", 0, 1200, 800, 1100, { locked: true, customData: { inkNotebook: { role: "pdf-page", pdf: "Docs/Paper.pdf", page: 2 } } }),
      stroke("n1", 50, 1300, 200, 30),
      stroke("n0", 50, 50, 200, 30),
    ];
    const lines = [line("note on two", { x: 50, y: 1300, w: 200, h: 30 }), line("note on one", { x: 50, y: 50, w: 200, h: 30 })];
    const blocks = layoutTranscript(classifyScene(els, lines, new Set()), () => null, layoutOpts);
    expect(blocks.map((b) => b.md)).toEqual([
      "### [[Docs/Paper.pdf#page=1|Page 1]]",
      "note on one",
      "### [[Docs/Paper.pdf#page=2|Page 2]]",
      "note on two",
    ]);
  });

  it("puts same-row lines together left to right", () => {
    const els = [stroke("r", 300, 0, 100, 30), stroke("l", 0, 2, 100, 30)];
    const lines = [line("right", { x: 300, y: 0, w: 100, h: 30 }), line("left", { x: 0, y: 2, w: 100, h: 30 })];
    const blocks = layoutTranscript(classifyScene(els, lines, new Set()), () => null, layoutOpts);
    expect(blocks.map((b) => b.md)).toEqual(["left right"]);
  });
});
