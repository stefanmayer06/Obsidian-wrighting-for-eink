import { describe, expect, it } from "vitest";
import { boxesOverlap, placeDock, type Box, type DockInput } from "../src/core/dock";

const box = (left: number, top: number, w: number, h: number): Box => ({ left, top, right: left + w, bottom: top + h });

/** The stack as placed, in viewport coordinates. */
function placed(input: DockInput): { rect: Box; compact: boolean; fits: boolean } {
  const p = placeDock(input);
  const size = p.compact ? input.compact : input.full;
  const right = input.container.right - p.right;
  return { rect: { left: right - size.width, right, top: input.container.top + p.top, bottom: input.container.top + p.top + size.height }, compact: p.compact, fits: p.fits };
}

const FULL = { width: 100, height: 160 };
const COMPACT = { width: 50, height: 120 };

describe("bookmark placement", () => {
  it("clears Excalidraw's tool panel on a short desktop window (the reported overlap)", () => {
    // 800×600 window: header, top toolbar, tray tool panel on the right edge, status bar
    const container = box(344, 40, 456, 560);
    const obstacles = [box(344, 40, 456, 37), box(353, 85, 490, 42), box(766, 157, 33, 128), box(600, 573, 200, 27)];
    const r = placed({ container, obstacles, full: FULL, compact: COMPACT, preferred: "top" });
    expect(r.fits).toBe(true);
    for (const o of obstacles) expect(boxesOverlap(r.rect, o)).toBe(false);
    expect(r.rect.top).toBeGreaterThanOrEqual(285 + 8);
  });

  it("clears the mobile tool panel and help button", () => {
    const container = box(0, 99, 700, 901);
    const obstacles = [box(0, 99, 700, 52), box(9, 159, 682, 45), box(666, 231, 33, 127), box(654, 955, 29, 29)];
    const r = placed({ container, obstacles, full: FULL, compact: COMPACT, preferred: "top" });
    for (const o of obstacles) expect(boxesOverlap(r.rect, o)).toBe(false);
  });

  it("stays near the preferred spot when nothing is in the way", () => {
    const container = box(0, 0, 1000, 1000);
    expect(placeDock({ container, obstacles: [], full: FULL, compact: COMPACT, preferred: "top" })).toMatchObject({ top: 250, right: 0, compact: false });
    expect(placeDock({ container, obstacles: [], full: FULL, compact: COMPACT, preferred: "middle" }).top).toBe(420);
    expect(placeDock({ container, obstacles: [], full: FULL, compact: COMPACT, preferred: "bottom" }).top).toBe(560);
  });

  it("goes compact when the full stack does not fit between panels", () => {
    const container = box(0, 0, 400, 400);
    const obstacles = [box(360, 0, 40, 130), box(360, 270, 40, 130)];
    const r = placed({ container, obstacles, full: FULL, compact: { width: 50, height: 120 }, preferred: "top" });
    expect(r.compact).toBe(true);
    expect(r.fits).toBe(true);
    for (const o of obstacles) expect(boxesOverlap(r.rect, o)).toBe(false);
  });

  it("moves left of a sidebar docked on the right edge", () => {
    const container = box(0, 0, 1000, 800);
    const sidebar = box(700, 0, 300, 800);
    const r = placed({ container, obstacles: [sidebar], full: FULL, compact: COMPACT, preferred: "top" });
    expect(r.fits).toBe(true);
    expect(boxesOverlap(r.rect, sidebar)).toBe(false);
    expect(r.rect.right).toBeLessThanOrEqual(700);
  });

  it("covers as little as possible when nothing fits", () => {
    const container = box(0, 0, 300, 200);
    const panel = box(0, 0, 300, 150); // no room to step around it
    const r = placed({ container, obstacles: [panel], full: FULL, compact: COMPACT, preferred: "top" });
    expect(r.fits).toBe(false);
    expect(r.compact).toBe(true);
    expect(r.rect.bottom).toBeLessThanOrEqual(200);
    expect(r.rect.top).toBeGreaterThanOrEqual(70); // the lowest position overlaps least
  });

  it("ignores obstacles outside the strip and empty boxes", () => {
    const container = box(0, 0, 1000, 1000);
    const r = placeDock({ container, obstacles: [box(0, 200, 500, 400), box(900, 300, 0, 0)], full: FULL, compact: COMPACT, preferred: "top" });
    expect(r).toMatchObject({ top: 250, right: 0, compact: false, fits: true });
  });
});
