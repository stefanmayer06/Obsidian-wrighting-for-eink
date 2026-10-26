import { describe, expect, it } from "vitest";
import { detectDevice } from "../src/core/device";
import { applyTransform, displayedSize, normalizeRotation, parsePageRange, unrotateTransform } from "../src/core/pdfMath";
import { imageRectToScene, makeRenderPlan, planOcrUnits, sceneToImage, DEFAULT_RASTER_LIMITS } from "../src/core/rasterPlan";
import { applyTypedNotes, extractTypedNotes } from "../src/core/typedNotes";
import { START_MARKER, parseNote } from "../src/core/transcript";
import { stroke } from "./helpers";

describe("device detection", () => {
  it.each([
    ["Mozilla/5.0 (Linux; Android 12; NoteAir3C Build/2023-08-25_10-19_3.5_68b2ac4f2; wv) AppleWebKit/537.36", true],
    ["Mozilla/5.0 (Linux; Android 11; Tab Ultra C Build/RKQ1; wv) AppleWebKit/537.36", true],
    ["Mozilla/5.0 (Linux; Android 13; Note Air4 C Build/TP1A; wv) AppleWebKit/537.36", true],
    ["Mozilla/5.0 (Linux; Android 12; Go Color 7 Build/SKQ1; wv) AppleWebKit/537.36", true],
    ["Mozilla/5.0 (Linux; Android 11; Palma Build/RKQ1; wv) AppleWebKit/537.36", true],
    ["Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A; wv) AppleWebKit/537.36", false],
    ["Mozilla/5.0 (Linux; Android 10; HUAWEI nova 5T Build/HUAWEI; wv)", false],
    ["Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 obsidian/1.9.0 Chrome/132", false],
    ["Mozilla/5.0 (Linux; Android 11; ONYX BOOX Build/1)", true],
  ])("%s -> %s", (ua, expected) => {
    expect(detectDevice(ua).isEink).toBe(expected);
  });
});

describe("pdf math", () => {
  it("normalises rotations", () => {
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(0)).toBe(0);
  });

  it.each([0, 90, 180, 270] as const)("maps displayed corners back into the unrotated page (%i°)", (rot) => {
    const W = 600;
    const H = 800; // unrotated page
    const d = displayedSize(W, H, rot);
    const t = unrotateTransform(W, H, rot);
    const corners = [
      [0, 0],
      [d.width, 0],
      [d.width, d.height],
      [0, d.height],
    ].map(([x, y]) => applyTransform(t, x, y));
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(-1e-9);
      expect(c.x).toBeLessThanOrEqual(W + 1e-9);
      expect(c.y).toBeGreaterThanOrEqual(-1e-9);
      expect(c.y).toBeLessThanOrEqual(H + 1e-9);
    }
    if (rot === 90) {
      // displayed top-left is the unrotated bottom-left for a page rotated clockwise
      expect(corners[0]).toEqual({ x: 0, y: H });
    }
  });

  it("parses page ranges", () => {
    expect(parsePageRange("", 3)).toEqual([1, 2, 3]);
    expect(parsePageRange("all", 2)).toEqual([1, 2]);
    expect(parsePageRange("1-3, 5, 9-", 10)).toEqual([1, 2, 3, 5, 9, 10]);
    expect(parsePageRange("0, 12, 3", 5)).toEqual([3]);
    expect(parsePageRange("4-2", 5)).toEqual([2, 3, 4]);
  });
});

describe("raster planning", () => {
  it("round-trips coordinates", () => {
    const plan = makeRenderPlan({ x: 100, y: 200, w: 500, h: 300 });
    expect(plan.scale).toBe(2);
    const p = sceneToImage(plan, { x: 150, y: 260 });
    const back = imageRectToScene(plan, { x: p.x, y: p.y, w: 20, h: 10 });
    expect(back.x).toBeCloseTo(150);
    expect(back.y).toBeCloseTo(260);
    expect(back.w).toBeCloseTo(10);
  });

  it("downscales large areas and keeps Azure's minimum size", () => {
    expect(makeRenderPlan({ x: 0, y: 0, w: 3000, h: 100 }).width).toBeLessThanOrEqual(DEFAULT_RASTER_LIMITS.maxSide);
    const tiny = makeRenderPlan({ x: 0, y: 0, w: 2, h: 2 });
    expect(tiny.width).toBeGreaterThanOrEqual(50);
    expect(tiny.height).toBeGreaterThanOrEqual(50);
  });

  it("splits far-apart strokes into units with stable keys", () => {
    const strokes = [stroke("a", 0, 0, 100, 30), stroke("b", 110, 0, 100, 30), stroke("c", 0, 2000, 100, 30)];
    const units = planOcrUnits(strokes, 150);
    expect(units.map((u) => u.elementIds)).toEqual([["a", "b"], ["c"]]);
    expect(planOcrUnits(strokes, 150).map((u) => u.key)).toEqual(units.map((u) => u.key));
    const moved = [strokes[0], { ...strokes[1], x: strokes[1].x + 3 }, strokes[2]];
    const units2 = planOcrUnits(moved, 150);
    expect(units2[0].key).not.toBe(units[0].key);
    expect(units2[1].key).toBe(units[1].key);
    // non-geometric changes (version bump, link, colour) keep the cache key
    const relinked = [{ ...strokes[0], version: 99, link: "[[X]]", strokeColor: "#f00" }, strokes[1], strokes[2]];
    expect(planOcrUnits(relinked, 150)[0].key).toBe(units[0].key);
  });

  it("splits very tall units into bands", () => {
    const strokes = Array.from({ length: 40 }, (_, i) => stroke(`s${i}`, 0, i * 400, 300, 30));
    const units = planOcrUnits(strokes, 1000);
    expect(units.length).toBeGreaterThan(1);
    for (const u of units) expect(u.plan.scale).toBeGreaterThanOrEqual(DEFAULT_RASTER_LIMITS.minScale - 0.05);
    expect(units.flatMap((u) => u.elementIds).sort()).toEqual(strokes.map((s) => s.id).sort());
  });
});

describe("typed notes", () => {
  const region = `${START_MARKER}\nfrom ink\n%% ink-notebook:end v1 %%`;
  const fm = "---\na: 1\n---\n";

  it("extracts text outside the region (losslessly)", () => {
    expect(extractTypedNotes(`${fm}${region}\n\nHello [[World]]\n%% secret %%\n`)).toBe("Hello [[World]]\n%% secret %%");
    expect(extractTypedNotes(`${fm}top\n${region}\nbottom`)).toBe("top\n\nbottom");
    expect(extractTypedNotes("no region here")).toBe("no region here");
  });

  it("writes edited notes back below the region", () => {
    const md = `${fm}${region}\n\nold text\n`;
    const out = applyTypedNotes(md, "new text\nline 2");
    expect(out).toBe(`${fm}${region}\n\nnew text\nline 2\n`);
    expect(parseNote(out).inner).toBe("from ink");
    expect(extractTypedNotes(out)).toBe("new text\nline 2");
  });

  it("keeps the split when notes exist above and below", () => {
    const md = `${fm}intro\n\n${region}\n\nold end\n`;
    const out = applyTypedNotes(md, "intro\n\nnew end");
    expect(out).toBe(`${fm}intro\n\n${region}\n\nnew end\n`);
  });

  it("round-trips comments and hard line breaks through the notes panel", () => {
    const md = `${fm}${region}\n\nline one  \nline two\n%% private reminder %%\n`;
    const typed = extractTypedNotes(md);
    expect(typed).toBe("line one  \nline two\n%% private reminder %%");
    const out = applyTypedNotes(md, typed.replace("line two", "line 2"));
    expect(out).toContain("line one  \nline 2\n%% private reminder %%");
  });

  it("only keeps the above/below split at a line boundary", () => {
    const md = `${fm}Hello\n\n${region}\n\nBye\n`;
    const out = applyTypedNotes(md, "Hello world\n\nBye");
    expect(out).toBe(`${fm}Hello world\n\n${region}\n\nBye\n`);
    expect(extractTypedNotes(out)).toBe("Hello world\n\nBye");
  });
});

