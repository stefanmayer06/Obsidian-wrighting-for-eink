import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAPER,
  isPaperStyle,
  normalizePaperSpec,
  PAPER_COLORS,
  PAPER_STYLES,
  paperLabel,
  paperSize,
  paperSvg,
  type PaperSpec,
  type PaperStyle,
} from "../src/core/paper";

const spec = (p: Partial<PaperSpec>): PaperSpec => normalizePaperSpec({ ...DEFAULT_PAPER, ...p });

describe("paper templates", () => {
  it("generates a small, valid SVG for every style, spacing, colour and orientation", () => {
    for (const style of Object.keys(PAPER_STYLES) as PaperStyle[]) {
      expect(isPaperStyle(style)).toBe(true);
      for (const spacing of ["narrow", "normal", "wide"] as const) {
        for (const orientation of ["portrait", "landscape"] as const) {
          const s = spec({ style, spacing, orientation, color: "ivory" });
          const svg = paperSvg(s);
          const { width, height } = paperSize(s);
          expect(svg.startsWith("<svg")).toBe(true);
          expect(svg.endsWith("</svg>")).toBe(true);
          expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
          expect(svg).toContain(PAPER_COLORS.ivory.fill);
          expect(svg).not.toMatch(/NaN|Infinity|undefined/);
          // stored once per folder and loaded on every page: keep them small
          expect(svg.length).toBeLessThan(40_000);
        }
      }
    }
    expect(isPaperStyle("nope")).toBe(false);
  });

  it("draws the expected structure", () => {
    expect(paperSvg("blank")).not.toContain("<path");
    expect(paperSvg("lined").match(/M0 \d+(\.\d+)?H1000/g)?.length).toBeGreaterThan(25);
    expect(paperSvg("dots")).toContain("stroke-dasharray");
    expect(paperSvg(spec({ style: "lined", spacing: "narrow" })).match(/H1000/g)!.length).toBeGreaterThan(paperSvg(spec({ style: "lined", spacing: "wide" })).match(/H1000/g)!.length);
    expect(paperSvg("music").match(/H/g)!.length % 5).toBe(0);
  });

  it("landscape swaps the page size", () => {
    expect(paperSize(spec({ orientation: "portrait" }))).toEqual({ width: 1000, height: 1414 });
    expect(paperSize(spec({ orientation: "landscape" }))).toEqual({ width: 1414, height: 1000 });
  });

  it("thumbnails can use thicker strokes", () => {
    expect(paperSvg("grid")).toContain('stroke-width="1"');
    expect(paperSvg("grid", { strokeScale: 3 })).toContain('stroke-width="3"');
  });

  it("normalizes stored specs", () => {
    expect(normalizePaperSpec(undefined)).toEqual(DEFAULT_PAPER);
    expect(normalizePaperSpec("dots")).toEqual({ ...DEFAULT_PAPER, style: "dots" });
    expect(normalizePaperSpec({ style: "grid", spacing: "huge", color: 3, orientation: "landscape" })).toEqual({
      style: "grid",
      spacing: "normal",
      color: "white",
      orientation: "landscape",
    });
    expect(normalizePaperSpec({ style: "nope" }, spec({ style: "cornell" })).style).toBe("cornell");
  });

  it("describes a spec", () => {
    expect(paperLabel(DEFAULT_PAPER)).toBe("Ruled");
    expect(paperLabel(spec({ style: "dots", spacing: "narrow", color: "ivory", orientation: "landscape" }))).toBe("Dotted · narrow · ivory · landscape");
  });
});
