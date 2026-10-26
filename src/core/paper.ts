/**
 * Paper templates (like the page templates in GoodNotes or the Boox Notes app). The ink
 * view draws them on the canvas; the paper picker shows them as SVG.
 */

export type PaperStyle = "blank" | "lined" | "dots" | "grid" | "graph" | "isometric" | "cornell" | "checklist" | "music";
export type PaperSpacing = "narrow" | "normal" | "wide";
export type PaperColor = "white" | "ivory" | "yellow" | "blue";
export type PaperOrientation = "portrait" | "landscape";

/** Everything that describes a paper page. */
export interface PaperSpec {
  style: PaperStyle;
  spacing: PaperSpacing;
  color: PaperColor;
  orientation: PaperOrientation;
}

export const PAPER_STYLES: Record<PaperStyle, string> = {
  blank: "Blank",
  lined: "Ruled",
  dots: "Dotted",
  grid: "Squared",
  graph: "Graph paper",
  isometric: "Isometric",
  cornell: "Cornell notes",
  checklist: "Checklist",
  music: "Music staff",
};

export const PAPER_SPACINGS: Record<PaperSpacing, string> = {
  narrow: "Narrow",
  normal: "Normal",
  wide: "Wide",
};

export const PAPER_COLORS: Record<PaperColor, { label: string; fill: string }> = {
  white: { label: "White", fill: "#ffffff" },
  ivory: { label: "Ivory", fill: "#fbf6ea" },
  yellow: { label: "Yellow", fill: "#fff5c2" },
  blue: { label: "Blue", fill: "#edf3fb" },
};

export const PAPER_ORIENTATIONS: Record<PaperOrientation, string> = {
  portrait: "Portrait",
  landscape: "Landscape",
};

export const DEFAULT_PAPER: PaperSpec = { style: "lined", spacing: "normal", color: "white", orientation: "portrait" };

/** Page size in scene units (A4 proportions). */
export const PAGE_WIDTH = 1000;
export const PAGE_HEIGHT = 1414;
/** Ruled line distance for "normal" spacing. */
export const LINE_SPACING = 44;

const LINE_SPACINGS: Record<PaperSpacing, number> = { narrow: 34, normal: LINE_SPACING, wide: 56 };

const has = (obj: object, key: unknown): boolean => typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);

export function isPaperStyle(v: unknown): v is PaperStyle {
  return has(PAPER_STYLES, v);
}

/** A complete, valid paper spec from stored data (unknown fields fall back). */
export function normalizePaperSpec(raw: unknown, fallback: PaperSpec = DEFAULT_PAPER): PaperSpec {
  const r = (raw && typeof raw === "object" ? raw : typeof raw === "string" ? { style: raw } : {}) as Record<string, unknown>;
  const style = isPaperStyle(r.style) ? r.style : fallback.style;
  return {
    style,
    // spacing means nothing on blank paper; keeping it fixed avoids duplicate files
    spacing: style === "blank" ? "normal" : has(PAPER_SPACINGS, r.spacing) ? (r.spacing as PaperSpacing) : fallback.spacing,
    color: has(PAPER_COLORS, r.color) ? (r.color as PaperColor) : fallback.color,
    orientation: has(PAPER_ORIENTATIONS, r.orientation) ? (r.orientation as PaperOrientation) : fallback.orientation,
  };
}

export function paperSize(spec: Pick<PaperSpec, "orientation">): { width: number; height: number } {
  return spec.orientation === "landscape" ? { width: PAGE_HEIGHT, height: PAGE_WIDTH } : { width: PAGE_WIDTH, height: PAGE_HEIGHT };
}

export function paperLineSpacing(spec: Pick<PaperSpec, "spacing">): number {
  return LINE_SPACINGS[spec.spacing] ?? LINE_SPACING;
}

/** Short human readable description, e.g. "Dotted · narrow · ivory". */
export function paperLabel(spec: PaperSpec): string {
  const parts = [PAPER_STYLES[spec.style]];
  if (spec.style !== "blank" && spec.spacing !== "normal") parts.push(PAPER_SPACINGS[spec.spacing].toLowerCase());
  if (spec.color !== "white") parts.push(PAPER_COLORS[spec.color].label.toLowerCase());
  if (spec.orientation === "landscape") parts.push("landscape");
  return parts.join(" · ");
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

export interface PaperSvgOptions {
  /** Multiplies stroke widths and dot sizes (thumbnails need thicker lines to stay visible). */
  strokeScale?: number;
}

/** One set of lines of a paper template (SVG path data, usable with canvas' Path2D too). */
export interface PaperPath {
  d: string;
  stroke: string;
  width: number;
  /** Round caps with a dash pattern draw dots. */
  dots?: { gap: number };
}

export interface PaperDrawing {
  width: number;
  height: number;
  fill: string;
  paths: PaperPath[];
}

/**
 * The lines of a paper template for a page of the given size (default: the
 * spec's A4 size). Lines are light grey so they print well; OCR never sees them
 * (only strokes are sent).
 */
export function paperDrawing(specOrStyle: PaperSpec | PaperStyle, size?: { width: number; height: number }, opts: PaperSvgOptions = {}): PaperDrawing {
  const spec = normalizePaperSpec(specOrStyle);
  const { width: W, height: H } = size ?? paperSize(spec);
  const s = paperLineSpacing(spec);
  const k = opts.strokeScale ?? 1;
  const paths: PaperPath[] = [];
  const path = (d: string, stroke: string, width: number, dots?: { gap: number }) => {
    if (d) paths.push({ d, stroke, width: width * k, ...(dots ? { dots } : {}) });
  };
  const hLines = (from: number, to: number, step: number, x1 = 0, x2 = W) => {
    let d = "";
    for (let y = from; y < to; y += step) d += `M${fmt(x1)} ${fmt(y)}H${fmt(x2)}`;
    return d;
  };
  const vLines = (from: number, to: number, step: number, y1 = 0, y2 = H) => {
    let d = "";
    for (let x = from; x < to; x += step) d += `M${fmt(x)} ${fmt(y1)}V${fmt(y2)}`;
    return d;
  };
  const line = "#c8c8c8";
  const strong = "#909090";
  const margin = "#e09a9a";
  const top = s * 2.5;

  switch (spec.style) {
    case "lined": {
      path(hLines(top, H - s / 2, s), line, 1.5);
      path(`M${fmt(s * 2)} 0V${fmt(H)}`, margin, 1.5);
      break;
    }
    case "dots": {
      // each row is one dashed line whose (almost) zero-length dashes with round caps are the dots
      const g = s / 1.5;
      const lastX = g * Math.floor((W - g / 2) / g);
      let d = "";
      for (let y = g; y < H - g / 2; y += g) d += `M${fmt(g)} ${fmt(y)}H${fmt(lastX)}`;
      path(d, "#a0a0a0", 3.4, { gap: g });
      break;
    }
    case "grid": {
      const g = s / 1.5;
      path(hLines(g, H, g) + vLines(g, W, g), line, 1);
      break;
    }
    case "graph": {
      const m = s / 4;
      let minor = "";
      let major = "";
      for (let i = 1; i * m < H; i++) {
        const d = `M0 ${fmt(i * m)}H${fmt(W)}`;
        if (i % 4 === 0) major += d;
        else minor += d;
      }
      for (let i = 1; i * m < W; i++) {
        const d = `M${fmt(i * m)} 0V${fmt(H)}`;
        if (i % 4 === 0) major += d;
        else minor += d;
      }
      path(minor, "#dedede", 0.8);
      path(major, "#b8b8b8", 1.3);
      break;
    }
    case "isometric": {
      // triangular grid: vertical lines plus lines at ±30°
      const a = s * 0.8;
      const t = Math.tan(Math.PI / 6);
      let d = vLines(0, W + 0.1, (a * Math.sqrt(3)) / 2);
      for (let y0 = -Math.ceil((W * t) / a) * a; y0 < H; y0 += a) d += `M0 ${fmt(y0)}L${fmt(W)} ${fmt(y0 + W * t)}`;
      for (let y0 = 0; y0 < H + W * t; y0 += a) d += `M0 ${fmt(y0)}L${fmt(W)} ${fmt(y0 - W * t)}`;
      path(d, "#d2d2d2", 1);
      break;
    }
    case "cornell": {
      const cue = W * 0.28;
      const summaryTop = H * 0.8;
      path(hLines(top, summaryTop - s / 2, s, cue, W), line, 1.5);
      path(`M${fmt(cue)} 0V${fmt(summaryTop)}M0 ${fmt(summaryTop)}H${fmt(W)}`, strong, 2);
      break;
    }
    case "checklist": {
      const b = s * 0.48;
      const x = s * 0.75;
      let boxes = "";
      for (let y = top; y + s < H - s / 2; y += s) boxes += `M${fmt(x)} ${fmt(y + (s - b) / 2)}h${fmt(b)}v${fmt(b)}h${fmt(-b)}Z`;
      path(hLines(top, H - s / 2, s), line, 1.5);
      path(boxes, "#9a9a9a", 1.6);
      break;
    }
    case "music": {
      const d0 = s / 4;
      const staff = d0 * 4;
      const gap = s * 1.6;
      const x1 = s;
      const x2 = W - s;
      let lines = "";
      let bars = "";
      for (let y = s * 2; y + staff < H - s; y += staff + gap) {
        lines += hLines(y, y + staff + 0.1, d0, x1, x2);
        bars += `M${fmt(x1)} ${fmt(y)}V${fmt(y + staff)}M${fmt(x2)} ${fmt(y)}V${fmt(y + staff)}`;
      }
      path(lines, "#a8a8a8", 1.2);
      path(bars, "#a8a8a8", 1.6);
      break;
    }
    default:
      break;
  }
  return { width: W, height: H, fill: PAPER_COLORS[spec.color].fill, paths };
}

/** SVG for a paper spec (thumbnails in the paper picker). */
export function paperSvg(specOrStyle: PaperSpec | PaperStyle, opts: PaperSvgOptions = {}): string {
  const p = paperDrawing(specOrStyle, undefined, opts);
  const k = opts.strokeScale ?? 1;
  const parts = [`<rect x="0" y="0" width="${p.width}" height="${p.height}" fill="${p.fill}" stroke="#d0d0d0" stroke-width="${fmt(2 * k)}"/>`];
  for (const path of p.paths) {
    const extra = path.dots ? ` stroke-linecap="round" stroke-dasharray="0.01 ${fmt(path.dots.gap - 0.01)}"` : "";
    parts.push(`<path d="${path.d}" fill="none" stroke="${path.stroke}" stroke-width="${fmt(path.width)}"${extra}/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${p.width}" height="${p.height}" viewBox="0 0 ${p.width} ${p.height}">${parts.join("")}</svg>`;
}
