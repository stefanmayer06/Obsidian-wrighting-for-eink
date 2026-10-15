/**
 * Paper templates (like the backgrounds in the Boox Notes app), generated as SVG.
 * The SVG is stored once in the vault and placed as a locked image on ink pages.
 */

export type PaperStyle = "blank" | "lined" | "grid" | "dots" | "cornell";

export const PAPER_STYLES: Record<PaperStyle, string> = {
  blank: "Blank",
  lined: "Lined",
  grid: "Grid",
  dots: "Dotted",
  cornell: "Cornell (cue column + summary)",
};

/** Page size in scene units (A4 proportions). */
export const PAGE_WIDTH = 1000;
export const PAGE_HEIGHT = 1414;
export const LINE_SPACING = 44;

export function isPaperStyle(v: unknown): v is PaperStyle {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PAPER_STYLES, v);
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** SVG for a paper style. Colours are light grey so they print and OCR well. */
export function paperSvg(style: PaperStyle, width = PAGE_WIDTH, height = PAGE_HEIGHT, spacing = LINE_SPACING): string {
  const line = "#c8c8c8";
  const margin = "#e09a9a";
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" stroke="#d0d0d0" stroke-width="2"/>`);
  const top = spacing * 2.5;
  switch (style) {
    case "lined": {
      for (let y = top; y < height - spacing / 2; y += spacing) {
        parts.push(`<line x1="0" y1="${fmt(y)}" x2="${width}" y2="${fmt(y)}" stroke="${line}" stroke-width="1.5"/>`);
      }
      parts.push(`<line x1="${spacing * 2}" y1="0" x2="${spacing * 2}" y2="${height}" stroke="${margin}" stroke-width="1.5"/>`);
      break;
    }
    case "grid": {
      const g = spacing / 1.5;
      for (let y = g; y < height; y += g) parts.push(`<line x1="0" y1="${fmt(y)}" x2="${width}" y2="${fmt(y)}" stroke="${line}" stroke-width="1"/>`);
      for (let x = g; x < width; x += g) parts.push(`<line x1="${fmt(x)}" y1="0" x2="${fmt(x)}" y2="${height}" stroke="${line}" stroke-width="1"/>`);
      break;
    }
    case "dots": {
      const g = spacing / 1.5;
      // one path with many tiny circles keeps the SVG small
      let d = "";
      for (let y = g; y < height; y += g) {
        for (let x = g; x < width; x += g) d += `M${fmt(x)} ${fmt(y)}m-1.6 0a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0 -3.2 0`;
      }
      parts.push(`<path d="${d}" fill="#a8a8a8"/>`);
      break;
    }
    case "cornell": {
      const cue = width * 0.28;
      const summaryTop = height - height * 0.2;
      for (let y = top; y < summaryTop - spacing / 2; y += spacing) {
        parts.push(`<line x1="${fmt(cue)}" y1="${fmt(y)}" x2="${width}" y2="${fmt(y)}" stroke="${line}" stroke-width="1.5"/>`);
      }
      parts.push(`<line x1="${fmt(cue)}" y1="0" x2="${fmt(cue)}" y2="${fmt(summaryTop)}" stroke="#909090" stroke-width="2"/>`);
      parts.push(`<line x1="0" y1="${fmt(summaryTop)}" x2="${width}" y2="${fmt(summaryTop)}" stroke="#909090" stroke-width="2"/>`);
      break;
    }
    default:
      break;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join("")}</svg>`;
}

export function paperFileName(style: PaperStyle): string {
  return `ink-paper-${style}.svg`;
}
