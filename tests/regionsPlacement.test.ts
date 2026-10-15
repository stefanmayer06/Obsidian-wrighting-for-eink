import { describe, expect, it } from "vitest";
import { planRegions, REGION_PADDING } from "../src/core/regions";
import { cardPosition } from "../src/core/placement";
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

describe("cardPosition", () => {
  it("places the card below content on an empty canvas", () => {
    expect(cardPosition([], 500)).toEqual({ x: 40, y: 40, width: 500 });
    const pos = cardPosition([stroke("s", 100, 100, 200, 50)], 500);
    expect(pos.x).toBe(100);
    expect(pos.y).toBe(210);
  });

  it("places the card inside the page holding the lowest content", () => {
    const paper1 = shape("p1", "image", 0, 0, 1000, 1414, { customData: { inkNotebook: { role: "paper" } } });
    const paper2 = shape("p2", "image", 0, 1500, 1000, 1414, { customData: { inkNotebook: { role: "paper" } } });
    const ink = stroke("s", 100, 1600, 300, 40);
    const pos = cardPosition([paper1, paper2, ink], 560);
    expect(pos.y).toBe(1680);
    expect(pos.x).toBe(100);
    expect(pos.width).toBe(560);
    // empty page: below the header area of the first page
    expect(cardPosition([paper1], 560).y).toBe(110);
  });

  it("ignores helper elements", () => {
    const region = shape("r", "rectangle", 0, 5000, 10, 10, { customData: { inkNotebook: { role: "region" } } });
    expect(cardPosition([region], 400)).toEqual({ x: 40, y: 40, width: 400 });
  });
});
