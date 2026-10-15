import { describe, expect, it } from "vitest";
import { clusterRects, elementRect, GridIndex, median, unionAll } from "../src/core/geometry";
import { stroke, shape } from "./helpers";

describe("elementRect", () => {
  it("uses points for freedraw elements, including negative offsets", () => {
    const el = { ...stroke("a", 100, 100, 50, 20), points: [[0, 0], [-10, 5], [40, -8]] as Array<[number, number]> };
    expect(elementRect(el)).toEqual({ x: 90, y: 92, w: 50, h: 13 });
  });

  it("returns the rotated bounding box for shapes", () => {
    const r = elementRect(shape("r", "rectangle", 0, 0, 100, 20, { angle: Math.PI / 2 }));
    expect(r.w).toBeCloseTo(20);
    expect(r.h).toBeCloseTo(100);
    expect(r.x).toBeCloseTo(40);
    expect(r.y).toBeCloseTo(-40);
  });

  it("falls back to x/y/width/height for elements without points", () => {
    expect(elementRect(shape("e", "ellipse", 5, 6, 7, 8))).toEqual({ x: 5, y: 6, w: 7, h: 8 });
  });
});

describe("clusterRects", () => {
  it("groups rectangles closer than the gap", () => {
    const rects = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 15, y: 0, w: 10, h: 10 },
      { x: 200, y: 0, w: 10, h: 10 },
      { x: 30, y: 2, w: 5, h: 5 },
    ];
    expect(clusterRects(rects, 8)).toEqual([[0, 1, 3], [2]]);
  });

  it("handles many rectangles quickly", () => {
    const rects = Array.from({ length: 4000 }, (_, i) => ({ x: (i % 80) * 12, y: Math.floor(i / 80) * 50, w: 10, h: 20 }));
    const t0 = Date.now();
    const groups = clusterRects(rects, 4);
    expect(Date.now() - t0).toBeLessThan(1500);
    // each row of 80 rects is one group (horizontal gap 2 < 4, vertical gap 30 > 4)
    expect(groups.length).toBe(50);
  });

  it("returns empty for no input", () => {
    expect(clusterRects([], 10)).toEqual([]);
    expect(unionAll([])).toBeNull();
  });
});

describe("GridIndex", () => {
  it("finds intersecting items only once", () => {
    const idx = new GridIndex<string>(10);
    idx.insert({ x: 0, y: 0, w: 35, h: 5 }, "wide");
    idx.insert({ x: 100, y: 100, w: 5, h: 5 }, "far");
    expect(idx.query({ x: 20, y: 0, w: 2, h: 2 })).toEqual(["wide"]);
    expect(idx.query({ x: 0, y: 0, w: 200, h: 200 }).sort()).toEqual(["far", "wide"]);
  });

  it("survives huge rectangles", () => {
    const idx = new GridIndex<string>(1);
    idx.insert({ x: -1e6, y: -1e6, w: 2e6, h: 2e6 }, "huge");
    expect(idx.query({ x: 0, y: 0, w: 1, h: 1 })).toEqual(["huge"]);
  });
});

describe("median", () => {
  it("computes medians", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
