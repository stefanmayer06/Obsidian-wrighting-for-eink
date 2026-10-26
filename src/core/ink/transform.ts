import type { Pt, Rect } from "../geometry";
import { figureBounds, imageBounds, linkBounds, strokeBounds, textBounds, unionRect } from "./geom";
import { q, type Items, type Stroke } from "./model";

/**
 * Moving, resizing and rotating a lasso selection. A transform is an affine
 * matrix [a, b, c, d, e, f] mapping (x, y) to (a·x + c·y + e, b·x + d·y + f),
 * like canvas' setTransform.
 */

export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function apply(m: Matrix, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

export function multiply(m: Matrix, n: Matrix): Matrix {
  // m after n
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function translation(dx: number, dy: number): Matrix {
  return [1, 0, 0, 1, dx, dy];
}

/** Uniform scale around a fixed point. */
export function scaling(k: number, origin: Pt): Matrix {
  return [k, 0, 0, k, origin.x - k * origin.x, origin.y - k * origin.y];
}

export function rotation(angle: number, origin: Pt): Matrix {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return [cos, sin, -sin, cos, origin.x - cos * origin.x + sin * origin.y, origin.y - sin * origin.x - cos * origin.y];
}

/** Scale factor of a transform (for stroke widths and font sizes). */
export function scaleOf(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

export function isIdentity(m: Matrix): boolean {
  return m.every((v, i) => Math.abs(v - IDENTITY[i]) < 1e-9);
}

export function transformStroke(s: Stroke, m: Matrix): Stroke {
  const pts = new Float32Array(s.pts.length);
  for (let i = 0; i + 2 < s.pts.length; i += 3) {
    const x = s.pts[i];
    const y = s.pts[i + 1];
    pts[i] = q(m[0] * x + m[2] * y + m[4]);
    pts[i + 1] = q(m[1] * x + m[3] * y + m[5]);
    pts[i + 2] = s.pts[i + 2];
  }
  const k = scaleOf(m);
  return { ...s, pts, width: Math.abs(k - 1) < 1e-6 ? s.width : Math.max(0.25, Math.round(s.width * k * 100) / 100) };
}

/**
 * Transform items. Strokes follow the matrix exactly; boxes (text, images,
 * links, figures) keep their orientation: their top-left corner moves with the
 * matrix and they scale with it.
 */
export function transformItems(items: Items, m: Matrix): Items {
  const k = scaleOf(m);
  const box = <T extends { x: number; y: number }>(it: T, center: Pt, w: number, h: number): Pt => {
    // keep the box centred on its transformed centre
    const c = apply(m, center);
    return { x: q(c.x - (w * k) / 2), y: q(c.y - (h * k) / 2) };
  };
  return {
    strokes: items.strokes.map((s) => transformStroke(s, m)),
    texts: items.texts.map((t) => {
      const p = box(t, { x: t.x + t.w / 2, y: t.y + t.h / 2 }, t.w, t.h);
      return { ...t, ...p, w: q(t.w * k), h: q(t.h * k), size: Math.max(4, Math.round(t.size * k * 10) / 10) };
    }),
    images: items.images.map((i) => {
      const p = box(i, { x: i.x + i.w / 2, y: i.y + i.h / 2 }, i.w, i.h);
      return { ...i, ...p, w: q(i.w * k), h: q(i.h * k) };
    }),
    links: items.links.map((l) => {
      const r = linkBounds(l);
      // link chips keep their size
      const c = apply(m, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
      return { ...l, x: q(c.x - r.w / 2), y: q(c.y - r.h / 2) };
    }),
    figures: items.figures.map((f) => {
      const p = box(f, { x: f.x + f.w / 2, y: f.y + f.h / 2 }, f.w, f.h);
      return { ...f, ...p, w: q(f.w * k), h: q(f.h * k) };
    }),
  };
}

export function itemsBounds(items: Items): Rect | null {
  let r: Rect | null = null;
  for (const s of items.strokes) r = unionRect(r, strokeBounds(s));
  for (const t of items.texts) r = unionRect(r, textBounds(t));
  for (const i of items.images) r = unionRect(r, imageBounds(i));
  for (const l of items.links) r = unionRect(r, linkBounds(l));
  for (const f of items.figures) r = unionRect(r, figureBounds(f));
  return r;
}

/** Can the items be rotated? Boxes keep their orientation, so only strokes rotate. */
export function canRotate(items: Items): boolean {
  return items.strokes.length > 0 && items.texts.length + items.images.length + items.links.length + items.figures.length === 0;
}
