/**
 * Geometry helpers for PDF annotation export.
 *
 * The ink overlay for a page is rendered in *displayed* orientation (what the
 * user saw on the ink page). PDF pages may carry a /Rotate entry, in which case
 * the overlay must be rotated back into the page's unrotated user space before
 * it is drawn with pdf-lib.
 */

export type PdfRotation = 0 | 90 | 180 | 270;

export function normalizeRotation(deg: number): PdfRotation {
  const r = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  return r as PdfRotation;
}

/** Size of the displayed page for an unrotated page size and a rotation. */
export function displayedSize(width: number, height: number, rotation: PdfRotation): { width: number; height: number } {
  return rotation === 90 || rotation === 270 ? { width: height, height: width } : { width, height };
}

/**
 * Canvas transform that draws a displayed-orientation image into an unrotated
 * canvas of size (width × height). Apply as:
 *   ctx.translate(tx, ty); ctx.rotate(angle); ctx.drawImage(img, 0, 0, dw, dh)
 * where (dw, dh) is the displayed size.
 */
export function unrotateTransform(
  width: number,
  height: number,
  rotation: PdfRotation,
): { tx: number; ty: number; angle: number } {
  switch (rotation) {
    case 90:
      return { tx: 0, ty: height, angle: -Math.PI / 2 };
    case 180:
      return { tx: width, ty: height, angle: Math.PI };
    case 270:
      return { tx: width, ty: 0, angle: Math.PI / 2 };
    default:
      return { tx: 0, ty: 0, angle: 0 };
  }
}

/** Apply the transform to a point (used by tests to verify the mapping). */
export function applyTransform(t: { tx: number; ty: number; angle: number }, x: number, y: number): { x: number; y: number } {
  const cos = Math.round(Math.cos(t.angle));
  const sin = Math.round(Math.sin(t.angle));
  return { x: t.tx + x * cos - y * sin, y: t.ty + x * sin + y * cos };
}

/** Parse a page range like "1-3, 5, 8-" into sorted unique 1-based page numbers. */
export function parsePageRange(input: string, pageCount: number): number[] {
  const text = input.trim().toLowerCase();
  if (!text || text === "all" || text === "*") return Array.from({ length: pageCount }, (_, i) => i + 1);
  const pages = new Set<number>();
  for (const part of text.split(/[,;\s]+/)) {
    if (!part) continue;
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : pageCount;
      for (let p = Math.max(1, Math.min(a, b)); p <= Math.min(pageCount, Math.max(a, b)); p++) pages.add(p);
    } else if (/^\d+$/.test(part)) {
      const p = parseInt(part, 10);
      if (p >= 1 && p <= pageCount) pages.add(p);
    }
  }
  return [...pages].sort((a, b) => a - b);
}
