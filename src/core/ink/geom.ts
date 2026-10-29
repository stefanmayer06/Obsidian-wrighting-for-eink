import { distanceToSegment, inflate, intersects, type Pt, type Rect } from "../geometry";
import type { Figure, ImageItem, LinkItem, Page, Stroke, TextBox } from "./model";

/** Bounds, hit testing and a spatial index for the items of a page. */

const boundsCache = new WeakMap<Stroke, Rect>();

/** Bounding box of a stroke's points (without the stroke width). */
export function strokePointBounds(s: Stroke): Rect {
  const hit = boundsCache.get(s);
  if (hit) return hit;
  const p = s.pts;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i + 2 < p.length; i += 3) {
    const x = p[i];
    const y = p[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const r = minX === Infinity ? { x: 0, y: 0, w: 0, h: 0 } : { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  boundsCache.set(s, r);
  return r;
}

/** Largest width factor of any pen (brush at full pressure). */
const MAX_WIDTH_FACTOR = 1.9;

/** Area a stroke can paint (points plus the widest the pen can get, and the arrow head). */
export function strokeBounds(s: Stroke): Rect {
  const r = strokePointBounds(s);
  const pad = (s.width * MAX_WIDTH_FACTOR) / 2 + 1 + (s.arrow || s.arrowStart ? Math.max(14, s.width * 5) : 0);
  return inflate(r, pad);
}

export function textBounds(t: TextBox): Rect {
  return { x: t.x, y: t.y, w: t.w, h: t.h };
}

export function imageBounds(i: ImageItem): Rect {
  return { x: i.x, y: i.y, w: i.w, h: i.h };
}

export const LINK_CHIP_HEIGHT = 34;

/** Width of a link chip (an estimate the renderer keeps to: long names are shortened). */
export function linkChipWidth(target: string): number {
  return Math.round(46 + 9.2 * Math.min(32, linkLabel(target).length));
}

/** What a link chip shows: the note name without folders, heading or alias. */
export function linkLabel(target: string): string {
  const [path, alias] = target.split("|");
  if (alias?.trim()) return alias.trim();
  const name = (path ?? "").split("#")[0].split("/").pop() ?? "";
  return name.replace(/\.md$/i, "").trim() || target;
}

export function linkBounds(l: LinkItem): Rect {
  return { x: l.x, y: l.y, w: linkChipWidth(l.target), h: LINK_CHIP_HEIGHT };
}

export function figureBounds(f: Figure): Rect {
  return { x: f.x, y: f.y, w: f.w, h: f.h };
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Bounds of everything on a page (null for an empty page). */
export function pageContentBounds(page: Page): Rect | null {
  let r: Rect | null = null;
  for (const s of page.strokes) r = unionRect(r, strokeBounds(s));
  for (const t of page.texts) r = unionRect(r, textBounds(t));
  for (const i of page.images) r = unionRect(r, imageBounds(i));
  for (const l of page.links) r = unionRect(r, linkBounds(l));
  return r;
}

// ------------------------------------------------------------------ distances

/** Smallest distance between segments a–b and c–d. */
export function segmentDistance(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (segmentsCross(a, b, c, d)) return 0;
  return Math.min(distanceToSegment(a, c, d), distanceToSegment(b, c, d), distanceToSegment(c, a, b), distanceToSegment(d, a, b));
}

function orient(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

export function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

/** Distance from the segment a–b (e.g. the path of the eraser) to a stroke's centre line. */
export function strokeDistance(s: Stroke, a: Pt, b: Pt): number {
  const p = s.pts;
  const n = Math.floor(p.length / 3);
  if (n === 0) return Infinity;
  if (n === 1) return distanceToSegment({ x: p[0], y: p[1] }, a, b);
  let best = Infinity;
  for (let i = 1; i < n; i++) {
    const d = segmentDistance({ x: p[(i - 1) * 3], y: p[(i - 1) * 3 + 1] }, { x: p[i * 3], y: p[i * 3 + 1] }, a, b);
    if (d < best) best = d;
    if (best === 0) break;
  }
  if (s.closed && n > 2) best = Math.min(best, segmentDistance({ x: p[(n - 1) * 3], y: p[(n - 1) * 3 + 1] }, { x: p[0], y: p[1] }, a, b));
  return best;
}

/** Does the eraser (a disc of `radius` moving from a to b) touch the stroke? */
export function strokeHit(s: Stroke, a: Pt, b: Pt, radius: number): boolean {
  const reach = radius + s.width / 2;
  const box = strokePointBounds(s);
  const sweep = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
  if (!intersects(inflate(box, reach), sweep)) return false;
  return strokeDistance(s, a, b) <= reach;
}

/** Point in polygon (even-odd rule). */
export function pointInPolygon(x: number, y: number, poly: ReadonlyArray<Pt>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1e-12) + a.x) inside = !inside;
  }
  return inside;
}

/** Share of a stroke's points inside the polygon (0..1). */
export function strokeInside(s: Stroke, poly: ReadonlyArray<Pt>): number {
  const p = s.pts;
  const n = Math.floor(p.length / 3);
  if (n === 0) return 0;
  const step = Math.max(1, Math.floor(n / 48));
  let total = 0;
  let inside = 0;
  for (let i = 0; i < n; i += step) {
    total++;
    if (pointInPolygon(p[i * 3], p[i * 3 + 1], poly)) inside++;
  }
  return inside / total;
}

export function rectInside(r: Rect, poly: ReadonlyArray<Pt>): boolean {
  return pointInPolygon(r.x + r.w / 2, r.y + r.h / 2, poly);
}

// ------------------------------------------------------------------ spatial index

/** Uniform grid over stroke bounds: finds the strokes near a point or rectangle quickly. */
export class StrokeIndex {
  private cells = new Map<number, Stroke[]>();
  private big: Stroke[] = [];
  private readonly size: number;

  constructor(strokes: readonly Stroke[], cellSize = 64) {
    this.size = cellSize;
    for (const s of strokes) this.insert(s);
  }

  private key(cx: number, cy: number): number {
    return (cx + 4096) * 8192 + (cy + 4096);
  }

  insert(s: Stroke): void {
    const r = strokeBounds(s);
    const x0 = Math.floor(r.x / this.size);
    const x1 = Math.floor((r.x + r.w) / this.size);
    const y0 = Math.floor(r.y / this.size);
    const y1 = Math.floor((r.y + r.h) / this.size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) {
      this.big.push(s);
      return;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        const list = this.cells.get(k);
        if (list) list.push(s);
        else this.cells.set(k, [s]);
      }
    }
  }

  remove(s: Stroke): void {
    const r = strokeBounds(s);
    const x0 = Math.floor(r.x / this.size);
    const x1 = Math.floor((r.x + r.w) / this.size);
    const y0 = Math.floor(r.y / this.size);
    const y1 = Math.floor((r.y + r.h) / this.size);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) {
      this.big = this.big.filter((b) => b !== s);
      return;
    }
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const k = this.key(cx, cy);
        const list = this.cells.get(k);
        if (!list) continue;
        const i = list.indexOf(s);
        if (i >= 0) list.splice(i, 1);
      }
    }
  }

  query(r: Rect): Stroke[] {
    const out = new Set<Stroke>();
    const x0 = Math.floor(r.x / this.size);
    const x1 = Math.floor((r.x + r.w) / this.size);
    const y0 = Math.floor(r.y / this.size);
    const y1 = Math.floor((r.y + r.h) / this.size);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (const s of this.cells.get(this.key(cx, cy)) ?? []) out.add(s);
      }
    }
    for (const s of this.big) out.add(s);
    return [...out].filter((s) => intersects(strokeBounds(s), r));
  }
}
