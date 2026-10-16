import { describe, expect, it } from "vitest";
import { analyseBox } from "../src/core/checkbox";
import { classifyScene } from "../src/core/classify";
import type { Pt } from "../src/core/geometry";
import { DEFAULT_LAYOUT_OPTIONS, layoutTranscript, type LayoutOptions } from "../src/core/layout";
import type { OcrLine } from "../src/core/ocrTypes";
import type { ExElement } from "../src/types/excalidraw";
import { poly, shape, textEl, wordsLine } from "./helpers";

const layoutOpts: LayoutOptions = {
  ...DEFAULT_LAYOUT_OPTIONS,
  drawingLink: "Notes/Page.excalidraw",
  linkFor: (p) => p.replace(/\.md$/, ""),
};

function transcribe(els: ExElement[], lines: OcrLine[]): string[] {
  return layoutTranscript(classifyScene(els, lines, new Set()), () => "area=REG", layoutOpts).map((b) => b.md);
}

const pts = (list: ReadonlyArray<[number, number]>): Pt[] => list.map(([x, y]) => ({ x, y }));

// ---------------------------------------------------------------------------------------
// A ticked box in front of "get the" (traced from a real page: the box is slanted, the
// tick's long arm reaches up into the line above, the "g" has a long descender).

const BOX: Array<[number, number]> = [
  [122, 80], [160, 75], [200, 70], [206, 64], [212, 70], [240, 67], [268, 64], [272, 70], [275, 110], [279, 163],
  [240, 172], [190, 182], [140, 197], [136, 160], [130, 120], [125, 85], [118, 76],
];
const TICK: Array<[number, number]> = [[178, 90], [180, 110], [182, 128], [210, 100], [250, 62], [290, 25], [320, -5]];

function getThe(): ExElement[] {
  return [
    // g, written like a "y" with a long descender
    poly("g", [[372, 98], [376, 120], [384, 138], [394, 140], [403, 125], [407, 100], [407, 140], [403, 180], [396, 220], [385, 243], [365, 252], [345, 250], [332, 238], [328, 222], [335, 205], [342, 200]]),
    poly("e1", [[440, 118], [470, 117], [495, 113], [488, 100], [468, 95], [448, 104], [441, 120], [450, 135], [472, 141], [500, 135]]),
    poly("t1a", [[520, 98], [570, 97], [625, 97]]),
    poly("t1b", [[565, 75], [566, 100], [566, 127]]),
    poly("t2a", [[690, 98], [745, 98]]),
    poly("t2b", [[718, 70], [719, 125]]),
    poly("h", [[775, 70], [777, 100], [779, 126], [785, 108], [800, 98], [818, 100], [826, 112], [828, 126]]),
    poly("e2", [[836, 120], [862, 118], [888, 115], [878, 100], [858, 97], [842, 108], [840, 128], [858, 145], [875, 147], [892, 128]]),
  ];
}

/** OCR's reading of "get the": word boxes with the descender, or tight ones without. */
const GET_THE_TALL = wordsLine([
  ["get", { x: 328, y: 70, w: 300, h: 182 }],
  ["the", { x: 686, y: 68, w: 206, h: 82 }],
]);
const GET_THE_TIGHT = wordsLine([
  ["get", { x: 370, y: 72, w: 256, h: 76 }],
  ["the", { x: 686, y: 68, w: 206, h: 80 }],
]);

describe("hand-drawn checkboxes", () => {
  it.each([
    ["word boxes with descenders", GET_THE_TALL],
    ["tight word boxes", GET_THE_TIGHT],
  ])("a ticked box becomes a done task (%s)", (_name, ocr) => {
    const els = [poly("box", BOX), poly("tick", TICK), ...getThe()];
    expect(transcribe(els, [ocr])).toEqual(["- [x] get the"]);
  });

  it("an empty box becomes an open task", () => {
    const els = [poly("box", BOX), ...getThe()];
    expect(transcribe(els, [GET_THE_TIGHT])).toEqual(["- [ ] get the"]);
  });

  it("keeps the line above apart even though the tick reaches into it", () => {
    const els = [
      poly("s1", [[200, -80], [230, -40], [260, -80], [290, -40], [320, -80], [350, -40]]),
      poly("s2", [[380, -80], [410, -40], [440, -80], [470, -40], [500, -80], [530, -40]]),
      poly("box", BOX),
      poly("tick", TICK),
      ...getThe(),
    ];
    const above = wordsLine([
      ["Shopping", { x: 200, y: -82, w: 150, h: 44 }],
      ["list", { x: 380, y: -82, w: 150, h: 44 }],
    ]);
    expect(transcribe(els, [above, GET_THE_TIGHT])).toEqual(["Shopping list", "- [x] get the"]);
  });

  it("recognises a box drawn with two strokes", () => {
    const els = [
      poly("box1", [[122, 80], [200, 70], [268, 64], [272, 70], [275, 110], [279, 163]]),
      poly("box2", [[279, 165], [190, 182], [140, 197], [136, 160], [130, 120], [124, 82]]),
      ...getThe(),
    ];
    expect(transcribe(els, [GET_THE_TIGHT])).toEqual(["- [ ] get the"]);
  });

  it("drops OCR's reading of the box and tick as a letter", () => {
    const els = [poly("box", BOX), poly("tick", TICK), ...getThe()];
    const ocr = wordsLine([
      ["D", { x: 118, y: 62, w: 162, h: 136 }],
      ["get", { x: 370, y: 72, w: 256, h: 76 }],
      ["the", { x: 686, y: 68, w: 206, h: 80 }],
    ]);
    expect(transcribe(els, [ocr])).toEqual(["- [x] get the"]);
  });

  it("makes a list of several checkbox lines", () => {
    const els: ExElement[] = [];
    const lines: OcrLine[] = [];
    ["milk", "eggs", "bread"].forEach((name, i) => {
      const y = i * 80;
      els.push(poly(`b${i}`, [[0, y], [40, y], [40, y + 40], [0, y + 40], [0, y + 2]]));
      els.push(poly(`w${i}`, [[70, y + 5], [90, y + 40], [110, y + 5], [130, y + 40], [150, y + 5], [170, y + 40]]));
      lines.push(wordsLine([[name, { x: 70, y: y + 4, w: 100, h: 37 }]]));
    });
    els.push(poly("tick1", [[8, 105], [18, 115], [45, 70]]));
    expect(transcribe(els, lines)).toEqual(["- [ ] milk\n- [x] eggs\n- [ ] bread"]);
  });

  it("leaves circles, letters and labelled boxes alone", () => {
    const circle: Array<[number, number]> = Array.from({ length: 33 }, (_, i) => [
      200 + 70 * Math.cos((i / 32) * 2 * Math.PI),
      133 + 65 * Math.sin((i / 32) * 2 * Math.PI),
    ]);
    expect(transcribe([poly("o", circle), ...getThe()], [GET_THE_TIGHT])[0]).not.toMatch(/^- \[/);

    // a big box with a label inside next to text is a diagram, not a task
    const els = [poly("box", BOX), poly("lbl", [[150, 110], [170, 150], [190, 110], [210, 150], [230, 110]]), ...getThe()];
    const lbl = wordsLine([["ab", { x: 150, y: 108, w: 80, h: 44 }]]);
    expect(transcribe(els, [lbl, GET_THE_TIGHT]).some((md) => md.startsWith("- ["))).toBe(false);
  });

  it("tells boxes from other shapes", () => {
    const square = pts([[0, 0], [100, 0], [100, 100], [0, 100], [0, 2]]);
    const dShape = pts([[0, 0], [40, 0], ...Array.from({ length: 17 }, (_, i): [number, number] => {
      const a = -Math.PI / 2 + (i / 16) * Math.PI;
      return [40 + 50 * Math.cos(a), 50 + 50 * Math.sin(a)];
    }), [0, 100], [0, 0]]);
    const triangle = pts([[0, 100], [50, 0], [100, 100], [0, 100]]);
    const open = pts([[0, 0], [0, 100], [100, 100], [100, 0]]);
    expect(analyseBox([square])).not.toBeNull();
    expect(analyseBox([pts(BOX)])).not.toBeNull();
    expect(analyseBox([pts(BOX), pts(TICK)])).toBeNull();
    expect(analyseBox([dShape])).toBeNull();
    expect(analyseBox([triangle])).toBeNull();
    expect(analyseBox([open])).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// A table: one header line (curving down at its end like an arrow), two column lines,
// headings "+", "Y" and "X" (traced from a real page).

function headerTable(): ExElement[] {
  return [
    poly("H", [[0, 128], [100, 128], [205, 128], [300, 130], [440, 134], [560, 142], [700, 160], [800, 178], [860, 196], [900, 215], [918, 232], [926, 248], [912, 236]]),
    poly("V1", [[205, 75], [205, 200], [204, 350], [204, 502]]),
    poly("V2", [[437, 78], [439, 200], [440, 370], [436, 410], [430, 442]]),
    poly("plus1", [[22, 65], [98, 65]]),
    poly("plus2", [[57, 48], [57, 98]]),
    poly("y1", [[240, 40], [265, 52], [290, 72]]),
    poly("y2", [[328, 25], [305, 70], [278, 118]]),
    poly("x1", [[565, 48], [572, 85], [580, 122]]),
    poly("x2", [[615, 62], [570, 95], [522, 127]]),
  ];
}
const PLUS = { x: 22, y: 48, w: 76, h: 50 };
const Y = { x: 240, y: 25, w: 88, h: 93 };
const X = { x: 522, y: 48, w: 93, h: 79 };

describe("hand-drawn tables", () => {
  it.each<[string, OcrLine[]]>([
    ["one line per heading", [wordsLine([["+", PLUS]]), wordsLine([["Y", Y]]), wordsLine([["X", X]])]],
    ["all headings in one line", [wordsLine([["+", PLUS], ["Y", Y], ["X", X]])]],
    [
      "the column lines read as '|'",
      [wordsLine([["+", PLUS], ["|", { x: 200, y: 75, w: 10, h: 427 }], ["Y", Y], ["|", { x: 432, y: 78, w: 10, h: 364 }], ["X", X]])],
    ],
  ])("becomes a Markdown table (%s)", (_name, ocr) => {
    expect(transcribe(headerTable(), ocr)).toEqual(["| + | Y | X |\n| --- | --- | --- |"]);
  });

  it("keeps a cell empty when a heading was not recognised", () => {
    expect(transcribe(headerTable(), [wordsLine([["Y", Y], ["X", X]])])).toEqual(["|  | Y | X |\n| --- | --- | --- |"]);
  });

  it("turns every line of handwriting below the header into a row", () => {
    const els = [
      poly("H", [[0, 60], [400, 62]]),
      poly("V", [[200, 0], [201, 400]]),
      poly("hx", [[60, 10], [120, 50]]),
      poly("hy", [[260, 10], [320, 50]]),
      ...[0, 1, 2].flatMap((i) => [poly(`a${i}`, [[60, 90 + i * 70], [100, 130 + i * 70]]), poly(`b${i}`, [[260, 90 + i * 70], [300, 130 + i * 70]])]),
    ];
    const lines = [
      wordsLine([["x", { x: 60, y: 10, w: 60, h: 40 }], ["y", { x: 260, y: 10, w: 60, h: 40 }]]),
      ...[0, 1, 2].map((i) =>
        wordsLine([
          [String(i + 1), { x: 60, y: 90 + i * 70, w: 40, h: 40 }],
          [String(2 * (i + 1)), { x: 260, y: 90 + i * 70, w: 40, h: 40 }],
        ]),
      ),
    ];
    expect(transcribe(els, lines)).toEqual(["| x | y |\n| --- | --- |\n| 1 | 2 |\n| 2 | 4 |\n| 3 | 6 |"]);
  });

  it("reads a T-chart with the headings above the line", () => {
    const els = [
      poly("H", [[0, 100], [500, 100]]),
      poly("V", [[250, 100], [250, 400]]),
      poly("p", [[40, 50], [80, 90], [120, 50], [160, 90]]),
      poly("c", [[300, 50], [340, 90], [380, 50], [420, 90]]),
      poly("p1", [[40, 130], [80, 170], [120, 130]]),
    ];
    const lines = [
      wordsLine([["Pro", { x: 40, y: 50, w: 120, h: 40 }]]),
      wordsLine([["Contra", { x: 300, y: 50, w: 120, h: 40 }]]),
      wordsLine([["cheap", { x: 40, y: 130, w: 80, h: 40 }]]),
    ];
    expect(transcribe(els, lines)).toEqual(["| Pro | Contra |\n| --- | --- |\n| cheap |  |"]);
  });

  it("uses drawn row lines, typed text and escapes pipes", () => {
    const els = [
      poly("top", [[0, 0], [400, 0]]),
      poly("mid", [[0, 60], [400, 60]]),
      poly("bot", [[0, 120], [400, 120]]),
      poly("L", [[0, 0], [0, 120]]),
      poly("M", [[200, 0], [200, 120]]),
      poly("R", [[400, 0], [400, 120]]),
      poly("w1", [[20, 15], [60, 45], [100, 15]]),
      poly("w2", [[220, 75], [260, 105], [300, 75]]),
      textEl("typed", "typed", 30, 75, 100, 30),
    ];
    const lines = [
      wordsLine([["Name", { x: 20, y: 12, w: 80, h: 36 }]]),
      wordsLine([["[[Page|alias]]", { x: 220, y: 72, w: 100, h: 36 }]]),
    ];
    expect(transcribe(els, lines)).toEqual(["| Name |  |\n| --- | --- |\n| typed | [[Page\\|alias]] |"]);
  });

  it("keeps the text around the table as paragraphs", () => {
    const els = [
      poly("t1", [[0, -120], [40, -80], [80, -120], [120, -80]]),
      ...headerTable(),
      poly("t2", [[0, 560], [40, 600], [80, 560], [120, 600]]),
    ];
    const lines = [
      wordsLine([["Values", { x: 0, y: -122, w: 120, h: 44 }]]),
      wordsLine([["+", PLUS], ["Y", Y], ["X", X]]),
      wordsLine([["done", { x: 0, y: 558, w: 120, h: 44 }]]),
    ];
    expect(transcribe(els, lines)).toEqual(["Values", "| + | Y | X |\n| --- | --- | --- |", "done"]);
  });

  it("leaves charts, crosses and axes as drawings", () => {
    // coordinate axes with a curve
    const axes = [
      poly("xa", [[0, 300], [400, 300]]),
      poly("ya", [[50, 0], [50, 350]]),
      poly("curve", [[60, 290], [150, 200], [250, 80], [350, 20]]),
      poly("lx", [[380, 310], [400, 340]]),
      poly("ly", [[60, 0], [80, 30]]),
    ];
    const axisLabels = [wordsLine([["x", { x: 380, y: 310, w: 20, h: 30 }]]), wordsLine([["y", { x: 60, y: 0, w: 20, h: 30 }]])];
    const c1 = classifyScene(axes, axisLabels, new Set());
    expect(c1.tables).toEqual([]);
    expect(c1.diagrams.length).toBeGreaterThan(0);

    // a plus sign with labels at its ends (crossing in the middle)
    const cross = [poly("h", [[0, 200], [400, 200]]), poly("v", [[200, 0], [200, 400]]), poly("a", [[350, 210], [380, 240]]), poly("b", [[210, 10], [240, 40]])];
    const crossLabels = [wordsLine([["x", { x: 350, y: 210, w: 30, h: 30 }]]), wordsLine([["y", { x: 210, y: 10, w: 30, h: 30 }]])];
    expect(classifyScene(cross, crossLabels, new Set()).tables).toEqual([]);

    // an empty grid has nothing to transcribe
    expect(classifyScene(headerTable().slice(0, 3), [], new Set()).tables).toEqual([]);

    // a grid with an Excalidraw shape in it is a diagram
    const withShape = [...headerTable(), shape("r", "rectangle", 250, 250, 100, 60)];
    expect(classifyScene(withShape, [wordsLine([["Y", Y], ["X", X]])], new Set()).tables).toEqual([]);
  });
});
