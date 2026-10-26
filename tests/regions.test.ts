import { describe, expect, it } from "vitest";
import { planRegions, REGION_PADDING } from "../src/core/regions";
import type { DiagramItem } from "../src/core/classify";
import { shape, stroke } from "./helpers";

const diagram = (x: number, y: number, w: number, h: number, extra: Partial<DiagramItem> = {}): DiagramItem => ({
  rect: { x, y, w, h },
  elementIds: [],
  labels: [],
  ...extra,
});

let n = 0;
const newId = () => `new${++n}`;

describe("planRegions", () => {
  it("creates regions for new diagrams and references frames directly", () => {
    const d1 = diagram(0, 0, 100, 100);
    const d2 = diagram(500, 0, 100, 100, { frameId: "F1" });
    const rule = diagram(0, 300, 600, 4, { isRule: true });
    const plan = planRegions([d1, d2, rule], [], true, newId);
    expect(plan.create).toHaveLength(1);
    expect(plan.create[0].rect).toEqual({ x: -REGION_PADDING, y: -REGION_PADDING, w: 100 + 2 * REGION_PADDING, h: 100 + 2 * REGION_PADDING });
    expect(plan.refs.get(d1)).toBe(`area=${plan.create[0].id}`);
    expect(plan.refs.get(d2)).toBe("frame=F1");
    expect(plan.refs.has(rule)).toBe(false);
  });

  it("reuses and updates existing regions, removes stale ones", () => {
    const d1 = diagram(0, 0, 120, 100); // grew a bit
    const existing = [
      { id: "R1", rect: { x: -8, y: -8, w: 116, h: 116 } },
      { id: "STALE", rect: { x: 2000, y: 2000, w: 50, h: 50 } },
    ];
    const plan = planRegions([d1], existing, true, newId);
    expect(plan.refs.get(d1)).toBe("area=R1");
    expect(plan.update).toEqual([{ id: "R1", rect: { x: -8, y: -8, w: 136, h: 116 } }]);
    expect(plan.remove).toEqual(["STALE"]);
    expect(plan.create).toEqual([]);
  });

  it("only reuses regions when the drawing cannot be modified", () => {
    const d1 = diagram(0, 0, 100, 100);
    const d2 = diagram(1000, 1000, 100, 100);
    const plan = planRegions([d1, d2], [{ id: "R1", rect: { x: -8, y: -8, w: 116, h: 116 } }], false, newId);
    expect(plan.refs.get(d1)).toBe("area=R1");
    expect(plan.refs.has(d2)).toBe(false);
    expect(plan.create).toEqual([]);
    expect(plan.update).toEqual([]);
    expect(plan.remove).toEqual([]);
  });

  it("matches each region to at most one diagram", () => {
    const a = diagram(0, 0, 100, 100);
    const b = diagram(20, 20, 60, 60);
    const plan = planRegions([a, b], [{ id: "R1", rect: { x: -8, y: -8, w: 116, h: 116 } }], true, newId);
    const refs = [plan.refs.get(a), plan.refs.get(b)];
    expect(refs.filter((r) => r === "area=R1")).toHaveLength(1);
    expect(plan.create).toHaveLength(1);
  });
});
