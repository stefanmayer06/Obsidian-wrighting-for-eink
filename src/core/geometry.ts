import type { ExElement } from "../types/excalidraw";

/** Axis-aligned rectangle in scene coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Pt {
  x: number;
  y: number;
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

export function right(r: Rect): number {
  return r.x + r.w;
}

export function bottom(r: Rect): number {
  return r.y + r.h;
}

export function center(r: Rect): Pt {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function area(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.h);
}

export function inflate(r: Rect, dx: number, dy: number = dx): Rect {
  return { x: r.x - dx, y: r.y - dy, w: r.w + 2 * dx, h: r.h + 2 * dy };
}

export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(right(a), right(b)) - x, h: Math.max(bottom(a), bottom(b)) - y };
}

export function unionAll(rects: ReadonlyArray<Rect>): Rect | null {
  if (rects.length === 0) return null;
  let acc = rects[0];
  for (let i = 1; i < rects.length; i++) acc = union(acc, rects[i]);
  return acc;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x <= right(b) && b.x <= right(a) && a.y <= bottom(b) && b.y <= bottom(a);
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(right(a), right(b));
  const btm = Math.min(bottom(a), bottom(b));
  if (r < x || btm < y) return null;
  return { x, y, w: r - x, h: btm - y };
}

export function containsPoint(r: Rect, p: Pt): boolean {
  return p.x >= r.x && p.x <= right(r) && p.y >= r.y && p.y <= bottom(r);
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y && right(inner) <= right(outer) && bottom(inner) <= bottom(outer);
}

/** Vertical overlap of two rects relative to the smaller height (0..1). */
export function verticalOverlapRatio(a: Rect, b: Rect): number {
  const top = Math.max(a.y, b.y);
  const btm = Math.min(bottom(a), bottom(b));
  const overlap = Math.max(0, btm - top);
  const minH = Math.max(1e-6, Math.min(a.h, b.h));
  return overlap / minH;
}

export function rectFromPoints(points: ReadonlyArray<Pt>): Rect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function rotatePoint(p: Pt, c: Pt, angle: number): Pt {
  if (!angle) return p;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

const LINEAR_TYPES = new Set(["freedraw", "line", "arrow"]);

/**
 * Absolute points of a linear element (freedraw / line / arrow), with the
 * element's rotation applied. Excalidraw stores points relative to (x, y)
 * and rotates around the centre of the points' bounding box.
 */
export function absolutePoints(el: ExElement): Pt[] {
  const pts = el.points ?? [];
  const abs: Pt[] = [];
  for (const p of pts) {
    if (!p || p.length < 2) continue;
    abs.push({ x: el.x + p[0], y: el.y + p[1] });
  }
  if (!el.angle || abs.length === 0) return abs;
  const box = rectFromPoints(abs);
  if (!box) return abs;
  const c = center(box);
  return abs.map((p) => rotatePoint(p, c, el.angle ?? 0));
}

/** Axis-aligned bounding box of an element in scene coordinates. */
export function elementRect(el: ExElement): Rect {
  if (LINEAR_TYPES.has(el.type) && el.points && el.points.length > 0) {
    const r = rectFromPoints(absolutePoints(el));
    if (r) return r;
  }
  const base: Rect = { x: el.x, y: el.y, w: Math.abs(el.width ?? 0), h: Math.abs(el.height ?? 0) };
  if (!el.angle) return base;
  const c = center(base);
  const corners = [
    { x: base.x, y: base.y },
    { x: right(base), y: base.y },
    { x: right(base), y: bottom(base) },
    { x: base.x, y: bottom(base) },
  ].map((p) => rotatePoint(p, c, el.angle ?? 0));
  return rectFromPoints(corners) ?? base;
}

/** Simple union-find over indices. */
export class UnionFind {
  private parent: number[];
  private rank: number[];

  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
    this.rank = new Array<number>(n).fill(0);
  }

  find(i: number): number {
    let root = i;
    while (this.parent[root] !== root) root = this.parent[root];
    // path compression
    let cur = i;
    while (this.parent[cur] !== root) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else {
      this.parent[rb] = ra;
      this.rank[ra]++;
    }
  }

  groups(): number[][] {
    const map = new Map<number, number[]>();
    for (let i = 0; i < this.parent.length; i++) {
      const r = this.find(i);
      const list = map.get(r);
      if (list) list.push(i);
      else map.set(r, [i]);
    }
    return [...map.values()];
  }
}

/**
 * Groups rectangles whose gap is at most `gap` (in both axes).
 * Uses a sweep over x so that large pages with thousands of strokes stay fast.
 * Returns groups of indices into `rects`, ordered by their first index.
 */
export function clusterRects(rects: ReadonlyArray<Rect>, gap: number): number[][] {
  const n = rects.length;
  if (n === 0) return [];
  const uf = new UnionFind(n);
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => rects[a].x - rects[b].x);
  for (let oi = 0; oi < n; oi++) {
    const i = order[oi];
    const a = inflate(rects[i], gap / 2);
    for (let oj = oi + 1; oj < n; oj++) {
      const j = order[oj];
      const bRect = rects[j];
      if (bRect.x - gap / 2 > right(a)) break;
      const b = inflate(bRect, gap / 2);
      if (intersects(a, b)) uf.union(i, j);
    }
  }
  return uf
    .groups()
    .map((g) => g.sort((a, b) => a - b))
    .sort((a, b) => a[0] - b[0]);
}

/** Median of a list of numbers (0 for an empty list). */
export function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Simple uniform grid spatial index for rectangles. */
export class GridIndex<T> {
  private cells = new Map<string, Array<{ rect: Rect; item: T }>>();

  constructor(private cellSize: number) {
    if (!(cellSize > 0)) this.cellSize = 100;
  }

  private keys(r: Rect): string[] {
    const keys: string[] = [];
    const x0 = Math.floor(r.x / this.cellSize);
    const x1 = Math.floor(right(r) / this.cellSize);
    const y0 = Math.floor(r.y / this.cellSize);
    const y1 = Math.floor(bottom(r) / this.cellSize);
    // guard against absurdly large rects producing millions of cells
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 10000) return ["*"];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) keys.push(`${x},${y}`);
    return keys;
  }

  insert(rect: Rect, item: T): void {
    for (const k of this.keys(rect)) {
      const list = this.cells.get(k);
      if (list) list.push({ rect, item });
      else this.cells.set(k, [{ rect, item }]);
    }
  }

  query(rect: Rect): T[] {
    const seen = new Set<T>();
    const out: T[] = [];
    const keys = this.keys(rect);
    if (!keys.includes("*")) keys.push("*");
    for (const k of keys) {
      const list = this.cells.get(k);
      if (!list) continue;
      for (const entry of list) {
        if (seen.has(entry.item)) continue;
        if (intersects(entry.rect, rect)) {
          seen.add(entry.item);
          out.push(entry.item);
        }
      }
    }
    return out;
  }
}

// ----- polylines and polygons (used to recognise hand-drawn checkboxes and tables) -----

export function distance(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Length of a polyline. */
export function polylineLength(points: ReadonlyArray<Pt>): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += distance(points[i - 1], points[i]);
  return len;
}

/** Points along a polyline, `step` apart (first and last point included). */
export function resample(points: ReadonlyArray<Pt>, step: number): Pt[] {
  if (points.length === 0) return [];
  const out: Pt[] = [points[0]];
  if (!(step > 0)) return [...points];
  let carry = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = distance(a, b);
    let t = step - carry;
    while (t <= seg) {
      out.push({ x: a.x + ((b.x - a.x) * t) / seg, y: a.y + ((b.y - a.y) * t) / seg });
      t += step;
    }
    carry = seg - (t - step);
  }
  const last = points[points.length - 1];
  if (distance(out[out.length - 1], last) > 1e-6) out.push(last);
  return out;
}

/** Distance from a point to the segment a–b. */
export function distanceToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Convex hull (Andrew's monotone chain), counter-clockwise, without repeated points. */
export function convexHull(points: ReadonlyArray<Pt>): Pt[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Area of a simple polygon (always positive). */
export function polygonArea(poly: ReadonlyArray<Pt>): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function polygonPerimeter(poly: ReadonlyArray<Pt>): number {
  return poly.length < 2 ? 0 : polylineLength([...poly, poly[0]]);
}

/** Distance from a point to the outline of a polygon. */
export function distanceToOutline(p: Pt, poly: ReadonlyArray<Pt>): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, distanceToSegment(p, poly[i], poly[(i + 1) % poly.length]));
  return best;
}

/** Is the point inside a convex polygon (either orientation)? */
export function insideConvex(p: Pt, poly: ReadonlyArray<Pt>): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Ramer–Douglas–Peucker: indices of the points that keep the polyline within `epsilon`. */
export function simplifyIndices(points: ReadonlyArray<Pt>, epsilon: number): number[] {
  if (points.length <= 2) return points.map((_, i) => i);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [a, b] = stack.pop() as [number, number];
    let worst = -1;
    let worstD = epsilon;
    for (let i = a + 1; i < b; i++) {
      const d = distanceToSegment(points[i], points[a], points[b]);
      if (d > worstD) {
        worst = i;
        worstD = d;
      }
    }
    if (worst >= 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => k && out.push(i));
  return out;
}

const MAX_LINE_TILT = (20 * Math.PI) / 180;

/**
 * Is the polyline one long, fairly straight, roughly horizontal or vertical line (a ruled
 * line, an underline, a table line)? Gentle curves and a hook at the end are allowed.
 */
export function straightLineDirection(pts: ReadonlyArray<Pt>, minLen: number): "h" | "v" | null {
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < minLen) return null;
  const angle = Math.abs(Math.atan2(b.y - a.y, b.x - a.x));
  const fromHorizontal = Math.min(angle, Math.PI - angle);
  const horizontal = fromHorizontal <= Math.PI / 4;
  if ((horizontal ? fromHorizontal : Math.PI / 2 - fromHorizontal) > MAX_LINE_TILT) return null;
  if (polylineLength(pts) > 1.25 * chord) return null;
  for (const p of pts) if (distanceToSegment(p, a, b) > 0.12 * chord) return null;
  return horizontal ? "h" : "v";
}
