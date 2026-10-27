import { describe, expect, it } from "vitest";
import {
  decodePoints,
  docLinks,
  encodePoints,
  fromBase64Url,
  inkDataOf,
  InkParseError,
  parseInkFile,
  serializeInkFile,
  toBase64Url,
  withInkFrontmatter,
} from "../src/core/ink/codec";
import {
  addItems,
  cloneItems,
  duplicatePage,
  EMPTY_META,
  makeStroke,
  movePage,
  newDoc,
  paperPage,
  pickItems,
  q,
  qp,
  removeItems,
  type InkDoc,
  type PenType,
  type Stroke,
} from "../src/core/ink/model";
import { lighten, StrokeBuilder, strokeRuns, strokeSegments } from "../src/core/ink/pens";
import { eraseFromStroke, isScribble, partialErase, scribbleTargets, strokeErase, strokesInLasso } from "../src/core/ink/erase";
import { pointInPolygon, StrokeIndex, strokeBounds, strokeHit } from "../src/core/ink/geom";
import { recognizeShape, shapeFromDrag } from "../src/core/ink/shapes";
import { canRotate, IDENTITY, multiply, rotation, scaling, transformItems, translation, apply } from "../src/core/ink/transform";
import { History } from "../src/core/ink/history";
import { inkScene, regionsFromScene, SCENE_PAGE_GAP, toPageRect } from "../src/core/ink/scene";
import { getInkData } from "../src/core/scene";
import { drawSegments } from "../src/ink/render";

/** A stroke through the given points (pressure 0.5 unless given). */
function ink(points: Array<[number, number, number?]>, pen: PenType = "ballpoint", extra: Partial<Stroke> = {}): Stroke {
  const pts = new Float32Array(points.length * 3);
  points.forEach(([x, y, p], i) => {
    pts[i * 3] = q(x);
    pts[i * 3 + 1] = q(y);
    pts[i * 3 + 2] = qp(p ?? 0.5);
  });
  return makeStroke({ pen, color: "#000000", width: 2, pts, ...extra });
}

/** Points along a polyline, `step` apart. */
function along(corners: Array<[number, number]>, step = 3): Array<[number, number]> {
  const out: Array<[number, number]> = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const [x0, y0] = corners[i - 1];
    const [x1, y1] = corners[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

function zigzag(x: number, y: number, w: number, h: number, turns: number): Array<[number, number]> {
  const corners: Array<[number, number]> = [];
  for (let i = 0; i <= turns; i++) corners.push([x + (i % 2 === 0 ? 0 : w), y + (h * i) / turns]);
  return along(corners, 3);
}

describe("codec", () => {
  it("encodes points compactly and losslessly", () => {
    const s = ink([
      [10.04, 20, 0.2],
      [10.5, 21.3, 0.25],
      [-5, 1400.7, 1],
      [999.9, 0, 0],
    ]);
    const enc = encodePoints(s.pts);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Array.from(decodePoints(enc))).toEqual(Array.from(s.pts));
  });

  it("round-trips base64url for all lengths", () => {
    for (let n = 0; n < 10; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + 13) % 256);
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it("round-trips a whole notebook", () => {
    let doc: InkDoc = newDoc({ style: "dots", spacing: "narrow", color: "ivory", orientation: "landscape" });
    const p0 = doc.pages[0];
    doc = {
      pages: [
        addItems(p0, {
          strokes: [ink([[1, 2], [3, 4], [5, 7]], "fountain"), shapeFromDrag("arrow", { x: 0, y: 0 }, { x: 100, y: 50 }, { pen: "ballpoint", color: "#d32f2f", width: 3 })],
          texts: [{ id: "t1", x: 10, y: 20, w: 300, h: 30, text: 'Hello "world" 100% %% done\nline 2', size: 24, color: "#1565c0" }],
          images: [{ id: "i1", x: 0, y: 0, w: 50, h: 40, src: "Pics/a b.png" }],
          links: [{ id: "l1", x: 5, y: 5, target: "Some Note" }],
          figures: [{ id: "f1", x: 1, y: 2, w: 3, h: 4 }],
        }),
        { ...paperPage(), bg: { kind: "pdf", path: "Docs/x.pdf", page: 3 } },
      ],
    };
    const meta = { regions: [{ id: "r1", page: p0.id, x: 1, y: 2, w: 30, h: 40 }], handLinks: { abc: "[[Anna]]" } };
    const text = serializeInkFile("---\ntags: [x]\n---\n", { doc, meta });
    // the data is inside a comment and "%%" never appears inside it
    const data = text.slice(text.indexOf("%%\n```ink-data") + 3, text.lastIndexOf("```\n%%"));
    expect(data).not.toContain("%");
    const back = parseInkFile(text);
    expect(back.frontmatter).toContain("tags: [x]");
    expect(back.frontmatter).toContain("ink-notebook: 1");
    expect(back.meta).toEqual(meta);
    expect(back.doc.pages).toHaveLength(2);
    const [a, b] = back.doc.pages;
    expect(a.bg).toEqual(p0.bg);
    expect(a.w).toBe(1414);
    expect(a.strokes.map((s) => [s.id, s.pen, s.color, s.width, !!s.arrow, !!s.poly])).toEqual(
      doc.pages[0].strokes.map((s) => [s.id, s.pen, s.color, s.width, !!s.arrow, !!s.poly]),
    );
    expect(Array.from(a.strokes[0].pts)).toEqual(Array.from(doc.pages[0].strokes[0].pts));
    expect(a.texts).toEqual(doc.pages[0].texts);
    expect(a.images).toEqual(doc.pages[0].images);
    expect(a.links).toEqual(doc.pages[0].links);
    expect(a.figures).toEqual(doc.pages[0].figures);
    expect(b.bg).toEqual({ kind: "pdf", path: "Docs/x.pdf", page: 3 });
    // serialising again gives the same text
    expect(serializeInkFile(back.frontmatter, back)).toBe(text);
    // links are listed in the Markdown part
    expect(text).toContain("[[Pics/a b.png]] · [[Some Note]] · [[Docs/x.pdf]] · [[Anna]]");
  });

  it("treats a file without ink data as a new notebook and refuses damaged data", () => {
    const fresh = parseInkFile("---\nink-notebook: 1\n---\n");
    expect(fresh.doc.pages).toHaveLength(1);
    expect(fresh.meta).toEqual(EMPTY_META);
    expect(() => parseInkFile("```ink-data\nH {}\nP {broken\n```")).toThrow(InkParseError);
    expect(() => parseInkFile("```ink-data\nH {}\n```")).toThrow(InkParseError);
    expect(() => parseInkFile("```ink-data\nH {}\nP {\"id\":\"p\"}\nS a b 000000 1 0 !!!\n```")).toThrow(InkParseError);
    expect(() => parseInkFile('```ink-data\nH {"v":99}\nP {"id":"p"}\n```')).toThrow(/newer version/);
  });

  it("adds the ink-notebook property and keeps other properties", () => {
    expect(withInkFrontmatter("")).toBe("---\nink-notebook: 1\n---\n");
    expect(withInkFrontmatter("---\ntags: a\n---\n", { "ink-text": '"[[x]]"' })).toBe('---\ntags: a\nink-notebook: 1\nink-text: "[[x]]"\n---\n');
    expect(withInkFrontmatter('---\nink-notebook: 1\nink-text: "[[old]]"\n---\n', { "ink-text": '"[[new]]"' })).toBe('---\nink-notebook: 1\nink-text: "[[new]]"\n---\n');
  });

  it("tells frontmatter edits from ink changes", () => {
    const doc = newDoc();
    const a = serializeInkFile("---\nink-notebook: 1\n---\n", { doc, meta: EMPTY_META });
    const b = serializeInkFile("---\nink-notebook: 1\ntags: x\n---\n", { doc, meta: EMPTY_META });
    expect(inkDataOf(a)).toBe(inkDataOf(b));
    expect(docLinks(doc, EMPTY_META)).toEqual([]);
  });
});

describe("pens", () => {
  it("builds the same segments live and when redrawing", () => {
    const pts: Array<[number, number, number]> = [
      [0, 0, 0.1],
      [5, 2, 0.4],
      [10, 5, 0.9],
      [15, 5, 0.8],
      [20, 3, 0.3],
    ];
    const s = ink(pts, "fountain");
    const b = new StrokeBuilder("fountain", "#000000", 2);
    const live = [];
    for (let i = 0; i < pts.length; i++) {
      const seg = b.add(s.pts[i * 3], s.pts[i * 3 + 1], s.pts[i * 3 + 2]);
      if (seg) live.push(seg);
    }
    live.push(b.end());
    expect(strokeSegments(s)).toEqual(live);
    expect(live[0]?.kind).toBe("line");
    expect(live[1]?.kind).toBe("quad");
    // the width follows the pressure: thin at first, wider later
    expect((live[3]?.w ?? 0) > (live[0]?.w ?? 0)).toBe(true);
  });

  it("draws a dot for a single point and groups equal widths into one path", () => {
    expect(strokeRuns(ink([[5, 5]]))).toEqual([{ w: 2, color: "#000000", d: "M5 5l0.01 0" }]);
    const even = ink(along([[0, 0], [100, 0]], 5));
    expect(strokeRuns(even)).toHaveLength(1);
    const rect = shapeFromDrag("rect", { x: 0, y: 0 }, { x: 10, y: 20 }, { pen: "fountain", color: "#000000", width: 2 });
    expect(strokeRuns(rect)[0].d).toBe("M0 0L10 0L10 20L0 20L0 0");
  });

  it("shades the pencil and keeps the marker even", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080");
    const pencil = strokeRuns(ink([[0, 0, 0.1], [5, 0, 0.1], [10, 0, 1], [15, 0, 1], [20, 0, 1]], "pencil"));
    expect(new Set(pencil.map((r) => r.color)).size).toBeGreaterThan(1);
    const marker = strokeRuns(ink([[0, 0, 0.1], [5, 0, 1], [10, 0, 0.2]], "marker"));
    expect(marker).toHaveLength(1);
  });

  it("draws live ink in as few calls as the widths allow, the same path as a redraw", () => {
    const calls: string[] = [];
    const ctx = {
      set strokeStyle(v: string) {
        calls.push(`color ${v}`);
      },
      set lineWidth(v: number) {
        calls.push(`width ${v}`);
      },
      beginPath: () => calls.push("begin"),
      moveTo: (x: number, y: number) => calls.push(`M${x} ${y}`),
      lineTo: (x: number, y: number) => calls.push(`L${x} ${y}`),
      quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => calls.push(`Q${cx} ${cy} ${x} ${y}`),
      stroke: () => calls.push("stroke"),
    } as unknown as CanvasRenderingContext2D;
    const even = strokeSegments(ink(along([[0, 0], [30, 0]], 5)));
    drawSegments(ctx, even);
    expect(calls.filter((c) => c === "stroke")).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("M"))).toHaveLength(1);
    expect(calls.filter((c) => /^[MLQ]/.test(c)).join("")).toBe(strokeRuns(ink(along([[0, 0], [30, 0]], 5)))[0].d);
    calls.length = 0;
    const pressure = strokeSegments(ink([[0, 0, 0.1], [5, 0, 0.1], [10, 0, 1], [15, 0, 1], [20, 0, 1]], "fountain"));
    drawSegments(ctx, pressure);
    expect(calls.filter((c) => c === "stroke")).toHaveLength(strokeRuns(ink([[0, 0, 0.1], [5, 0, 0.1], [10, 0, 1], [15, 0, 1], [20, 0, 1]], "fountain")).length);
  });

  it("makes calligraphy thin along the nib and wide across it", () => {
    const along45 = strokeSegments(ink(along([[0, 0], [60, -60]], 3), "calligraphy", { width: 6 }));
    const across = strokeSegments(ink(along([[0, 0], [60, 60]], 3), "calligraphy", { width: 6 }));
    const mid = (segs: ReturnType<typeof strokeSegments>) => segs[Math.floor(segs.length / 2)].w;
    expect(mid(across)).toBeGreaterThan(3 * mid(along45));
  });
});

describe("erasers", () => {
  const line = ink(along([[0, 0], [100, 0]], 2));

  it("splits a stroke where the partial eraser passes", () => {
    const pieces = eraseFromStroke(line, { x: 50, y: -20 }, { x: 50, y: 20 }, 5);
    expect(pieces).toHaveLength(2);
    const [a, b] = pieces as Stroke[];
    expect(Math.max(...Array.from(a.pts).filter((_, i) => i % 3 === 0))).toBeLessThan(45);
    expect(Math.min(...Array.from(b.pts).filter((_, i) => i % 3 === 0))).toBeGreaterThan(55);
    expect(a.id).not.toBe(line.id);
    // missing the stroke changes nothing
    expect(eraseFromStroke(line, { x: 50, y: 30 }, { x: 60, y: 30 }, 5)).toBeNull();
    // erasing all of it leaves nothing
    expect(eraseFromStroke(line, { x: -10, y: 0 }, { x: 110, y: 0 }, 5)).toEqual([]);
  });

  it("cuts straight shapes in the middle of an edge", () => {
    const rect = shapeFromDrag("rect", { x: 0, y: 0 }, { x: 100, y: 100 }, { pen: "ballpoint", color: "#000000", width: 2 });
    const res = partialErase([rect], { x: 50, y: -10 }, { x: 50, y: 10 }, 4);
    expect(res.removed.has(rect.id)).toBe(true);
    expect(res.added).toHaveLength(1);
    expect(res.added[0].closed).toBeUndefined();
  });

  it("removes whole strokes with the stroke eraser and the lasso", () => {
    const other = ink(along([[0, 50], [100, 50]], 2));
    expect([...strokeErase([line, other], { x: 30, y: -3 }, { x: 30, y: 3 }, 2)]).toEqual([line.id]);
    expect(strokeHit(other, { x: 30, y: 44 }, { x: 30, y: 45 }, 2)).toBe(false);
    const lasso = [
      { x: -10, y: 40 },
      { x: 110, y: 40 },
      { x: 110, y: 60 },
      { x: -10, y: 60 },
    ];
    expect([...strokesInLasso([line, other], lasso)]).toEqual([other.id]);
    expect(pointInPolygon(0, 50, lasso)).toBe(true);
    expect(pointInPolygon(0, 0, lasso)).toBe(false);
  });

  it("recognises a scribble and erases what is underneath", () => {
    const word = ink(along([[100, 100], [140, 120], [180, 100]], 2));
    const far = ink(along([[400, 400], [450, 400]], 2));
    const scratch = ink(zigzag(95, 95, 90, 30, 10), "ballpoint");
    expect(isScribble(scratch)).toBe(true);
    expect(isScribble(word)).toBe(false);
    // handwriting with ups and downs is not a scribble
    expect(isScribble(ink(along([[0, 0], [5, 20], [10, 0], [15, 20], [20, 0], [25, 20], [30, 0]], 2)))).toBe(false);
    expect([...scribbleTargets(scratch, [word, far])]).toEqual([word.id]);
  });

  it("finds strokes with the spatial index", () => {
    const strokes = Array.from({ length: 200 }, (_, i) => ink([[(i % 20) * 50, Math.floor(i / 20) * 50], [(i % 20) * 50 + 10, Math.floor(i / 20) * 50 + 10]]));
    const idx = new StrokeIndex(strokes);
    const found = idx.query({ x: 95, y: 95, w: 20, h: 20 });
    expect(found.map((s) => s.id)).toEqual([strokes[42].id]);
    expect(strokeBounds(strokes[0]).w).toBeGreaterThan(10);
  });
});

describe("shapes", () => {
  it("snaps a hand-drawn line", () => {
    const r = recognizeShape(ink(along([[0, 0], [60, 2], [120, 1]], 3)));
    expect(r?.kind).toBe("line");
    // nearly horizontal snaps to horizontal
    expect(r?.stroke.pts[4]).toBe(r?.stroke.pts[1]);
  });

  it("recognises rectangles, triangles and ellipses", () => {
    const rect = along([[0, 0], [200, 3], [202, 100], [-2, 98], [1, 4]], 4);
    expect(recognizeShape(ink(rect))?.kind).toBe("rect");
    const tri = along([[100, 0], [200, 160], [0, 158], [98, 4]], 4);
    expect(recognizeShape(ink(tri))?.kind).toBe("triangle");
    const ell: Array<[number, number]> = [];
    for (let i = 0; i <= 60; i++) ell.push([150 + 140 * Math.cos((i / 60) * Math.PI * 2), 80 + 60 * Math.sin((i / 60) * Math.PI * 2)]);
    expect(recognizeShape(ink(ell))?.kind).toBe("ellipse");
    const circle = ell.map(([x, y]): [number, number] => [x, 80 + ((y - 80) * 140) / 60]);
    expect(recognizeShape(ink(circle))?.kind).toBe("circle");
    // handwriting is not a shape
    expect(recognizeShape(ink(zigzag(0, 0, 40, 30, 6)))).toBeNull();
    expect(recognizeShape(ink(along([[0, 0], [30, 40], [60, 0], [90, 40]], 3)))).toBeNull();
  });

  it("draws shapes from a drag", () => {
    const style = { pen: "fountain" as const, color: "#000000", width: 2 };
    expect(shapeFromDrag("triangle", { x: 0, y: 0 }, { x: 10, y: 10 }, style).closed).toBe(true);
    expect(shapeFromDrag("dashed", { x: 0, y: 0 }, { x: 10, y: 10 }, style).dash).toBe(true);
    expect(shapeFromDrag("line", { x: 0, y: 0 }, { x: 10, y: 10 }, style).pen).toBe("ballpoint");
    expect(shapeFromDrag("line", { x: 0, y: 0 }, { x: 10, y: 10 }, { ...style, pen: "marker" }).pen).toBe("marker");
  });
});

describe("transforms", () => {
  it("moves, scales and rotates items", () => {
    const s = ink([[0, 0], [10, 0]]);
    const items = { strokes: [s], texts: [{ id: "t", x: 0, y: 0, w: 100, h: 20, text: "hi", size: 20, color: "#000000" }], images: [], links: [], figures: [] };
    const moved = transformItems(items, translation(5, 7));
    expect(Array.from(moved.strokes[0].pts)).toEqual([5, 7, s.pts[2], 15, 7, s.pts[5]]);
    expect(moved.texts[0]).toMatchObject({ x: 5, y: 7, w: 100 });
    const scaled = transformItems(items, scaling(2, { x: 0, y: 0 }));
    expect(scaled.strokes[0].width).toBe(4);
    expect(scaled.texts[0]).toMatchObject({ x: 0, y: 0, w: 200, h: 40, size: 40 });
    const rot = apply(rotation(Math.PI / 2, { x: 0, y: 0 }), { x: 10, y: 0 });
    expect(rot.x).toBeCloseTo(0);
    expect(rot.y).toBeCloseTo(10);
    expect(multiply(IDENTITY, translation(1, 2))).toEqual(translation(1, 2));
    expect(canRotate(items)).toBe(false);
    expect(canRotate({ ...items, texts: [] })).toBe(true);
  });
});

describe("model and history", () => {
  it("edits pages immutably", () => {
    const doc = newDoc();
    const page = doc.pages[0];
    const s = ink([[1, 1], [2, 2]]);
    const with1 = addItems(page, { strokes: [s] });
    expect(page.strokes).toHaveLength(0);
    expect(with1.strokes).toEqual([s]);
    const sel = { strokes: new Set([s.id]), texts: new Set<string>(), images: new Set<string>(), links: new Set<string>(), figures: new Set<string>() };
    expect(removeItems(with1, sel).strokes).toHaveLength(0);
    const copy = cloneItems(pickItems(with1, sel));
    expect(copy.strokes[0].id).not.toBe(s.id);
    const dup = duplicatePage(with1);
    expect(dup.id).not.toBe(with1.id);
    expect(dup.strokes[0].id).not.toBe(s.id);
    const two = { pages: [with1, dup] };
    expect(movePage(two, dup.id, 0).pages.map((p) => p.id)).toEqual([dup.id, with1.id]);
  });

  it("undoes and redoes", () => {
    const h = new History<number>();
    h.record(1);
    h.record(2);
    expect(h.undo(3)).toBe(2);
    expect(h.undo(2)).toBe(1);
    expect(h.undo(1)).toBeNull();
    expect(h.redo(1)).toBe(2);
    h.record(2);
    expect(h.canRedo).toBe(false);
  });
});

describe("scene adapter", () => {
  it("stacks pages and maps items to scene elements", () => {
    const p1 = addItems(paperPage(), {
      strokes: [ink([[10, 10], [20, 20]]), ink([[0, 0], [5, 5]], "marker"), shapeFromDrag("rect", { x: 0, y: 0 }, { x: 50, y: 50 }, { pen: "ballpoint", color: "#000000", width: 2 })],
      texts: [{ id: "t", x: 1, y: 2, w: 100, h: 20, text: "typed", size: 20, color: "#000000" }],
      links: [{ id: "l", x: 0, y: 0, target: "Note" }],
      figures: [{ id: "f", x: 0, y: 0, w: 10, h: 10 }],
    });
    const p2 = addItems(paperPage(), { strokes: [ink([[10, 10], [20, 20]])] });
    const doc = { pages: [p1, p2] };
    const meta = { regions: [{ id: "r", page: p2.id, x: 1, y: 1, w: 5, h: 5 }], handLinks: {} };
    const { elements, offsets } = inkScene(doc, meta);
    expect(offsets.get(p2.id)).toBe(1414 + SCENE_PAGE_GAP);
    const byType = (t: string) => elements.filter((e) => e.type === t);
    expect(byType("freedraw")).toHaveLength(2); // the highlighter is left out
    expect(byType("freedraw")[1].y).toBe(10 + 1414 + SCENE_PAGE_GAP);
    expect(byType("rectangle").map((e) => getInkData(e)?.role ?? "shape")).toEqual(["shape", "region"]);
    expect(byType("text").map((e) => e.text)).toEqual(["typed", "[[Note]]"]);
    expect(byType("frame")[0].name).toBe("Diagram");
    expect(elements.filter((e) => getInkData(e)?.role === "paper")).toHaveLength(2);

    const back = toPageRect(doc, offsets, { x: 5, y: 1414 + SCENE_PAGE_GAP + 100, w: 10, h: 10 });
    expect(back).toEqual({ page: p2.id, rect: { x: 5, y: 100, w: 10, h: 10 } });
    const regions = regionsFromScene(doc, offsets, meta.regions, {
      create: [{ id: "n", rect: { x: 0, y: 20, w: 30, h: 30 } }],
      update: [],
      remove: ["r"],
    });
    expect(regions).toEqual([{ id: "n", page: p1.id, x: 0, y: 20, w: 30, h: 30 }]);
  });
});
