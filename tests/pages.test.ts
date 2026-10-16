import { describe, expect, it } from "vitest";
import { collectPages, elementsBelow, pageAt, planPageInsert, PAGE_GAP } from "../src/core/pages";
import type { ExElement } from "../src/types/excalidraw";
import { shape, stroke } from "./helpers";

const paper = (id: string, y: number, extra: Partial<ExElement> = {}) =>
  shape(id, "image", 0, y, 1000, 1414, { locked: true, customData: { inkNotebook: { role: "paper", paper: { style: "dots", spacing: "narrow", color: "white", orientation: "portrait" } } }, ...extra });

describe("pages", () => {
  const p1 = paper("p1", 0);
  const p2 = paper("p2", 1414 + PAGE_GAP);
  const pdf = shape("pdf", "image", 0, 2 * (1414 + PAGE_GAP), 1000, 1300, { locked: true, customData: { inkNotebook: { role: "pdf-page", pdf: "a.pdf", page: 1 } } });

  it("collects pages top to bottom with their paper", () => {
    const pages = collectPages([pdf, stroke("s", 10, 10, 50, 20), p2, p1]);
    expect(pages.map((p) => p.id)).toEqual(["p1", "p2", "pdf"]);
    expect(pages[0].paper).toEqual({ style: "dots", spacing: "narrow", color: "white", orientation: "portrait" });
    expect(pages[2].paper).toBeUndefined();
  });

  it("finds the page on screen", () => {
    const pages = collectPages([p1, p2]);
    expect(pageAt(pages, { x: 500, y: 2000 })?.id).toBe("p2");
    expect(pageAt(pages, { x: 500, y: 1440 })?.id).toBe("p1"); // in the gap, closer to p1
    expect(pageAt(pages, { x: 3000, y: 100 })?.id).toBe("p1");
    expect(pageAt([], { x: 0, y: 0 })).toBeNull();
  });

  it("adds at the end without moving anything", () => {
    const pages = collectPages([p1, p2]);
    expect(planPageInsert(pages, pages[0], "end", 1414, null)).toEqual({ x: 0, y: 2 * 1414 + 2 * PAGE_GAP, threshold: null, shift: 0 });
    // "after" the last page is the same as the end
    expect(planPageInsert(pages, pages[1], "after", 1414, null).threshold).toBeNull();
  });

  it("inserts after / before a page and moves the rest down", () => {
    const pages = collectPages([p1, p2]);
    const after = planPageInsert(pages, pages[0], "after", 1000, null);
    expect(after).toEqual({ x: 0, y: 1414 + PAGE_GAP, threshold: 1414 + PAGE_GAP / 2, shift: 1000 + PAGE_GAP });
    const before = planPageInsert(pages, pages[0], "before", 1414, null);
    expect(before).toEqual({ x: 0, y: 0, threshold: -PAGE_GAP / 2, shift: 1414 + PAGE_GAP });
  });

  it("starts below existing writing when there are no pages", () => {
    expect(planPageInsert([], null, "after", 1414, 500)).toEqual({ x: 0, y: 500 + PAGE_GAP, threshold: null, shift: 0 });
    expect(planPageInsert([], null, "end", 1414, null).y).toBe(0);
  });

  it("moves whole groups, labels with their box, frame children and bound arrows", () => {
    const els: ExElement[] = [
      p1,
      p2,
      stroke("onP1", 100, 100, 50, 20),
      stroke("onP2", 100, 1600, 50, 20),
      // a group straddling the line stays with its top
      stroke("g1", 100, 1400, 50, 20, { groupIds: ["G"] }),
      stroke("g2", 100, 1600, 50, 20, { groupIds: ["G"] }),
      // a box whose label is below the line
      shape("box", "rectangle", 100, 1470, 200, 100),
      shape("label", "text", 120, 1500, 100, 20, { containerId: "box" }),
      // an arrow on page 2 bound to a box on page 1
      shape("a", "arrow", 100, 1700, 100, 10, { startBinding: { elementId: "boxOnP1" } }),
      shape("boxOnP1", "rectangle", 100, 1000, 100, 100),
      shape("deleted", "rectangle", 100, 1700, 10, 10, { isDeleted: true }),
    ];
    const moving = elementsBelow(els, 1414 + PAGE_GAP / 2);
    expect([...moving].sort()).toEqual(["box", "label", "onP2", "p2"]);
  });
});
