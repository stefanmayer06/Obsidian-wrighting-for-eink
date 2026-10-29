import { containsPoint, polygonArea, simplifyIndices, type Pt, type Rect } from "../geometry";
import { pointInPolygon, strokePointBounds } from "./geom";
import { makeStroke, pointCount, q, type FillStyle, type Page, type Stroke } from "./model";

/**
 * Fills: the area a closed stroke (a shape, or a loop drawn with the pen)
 * encloses can be filled with a colour, drawn solid or with hatching. The fill
 * tool fills the shape that was tapped, or – when strokes that do not belong
 * together enclose the spot (a box drawn with four lines, a line across a
 * circle) – that area: it is traced and becomes an "area", a stroke that is
 * only a fill.
 */

/** Fill colours: light tints that keep writing readable (greys on black-and-white screens), and some strong ones. */
export const FILL_COLORS: ReadonlyArray<{ color: string; label: string }> = [
  { color: "#ffffff", label: "White" },
  { color: "#e6e6e6", label: "Light grey" },
  { color: "#a6a6a6", label: "Grey" },
  { color: "#000000", label: "Black" },
  { color: "#ffc9c9", label: "Pink" },
  { color: "#ffd8a8", label: "Peach" },
  { color: "#fff3bf", label: "Cream" },
  { color: "#c8f0cc", label: "Mint" },
  { color: "#c4dfff", label: "Sky" },
  { color: "#e3d4ff", label: "Lavender" },
  { color: "#d32f2f", label: "Red" },
  { color: "#1565c0", label: "Blue" },
];

export const FILL_STYLE_INFO: Record<FillStyle, { label: string; icon: string }> = {
  solid: { label: "Solid", icon: "square" },
  hatch: { label: "Hatched", icon: "align-justify" },
  cross: { label: "Cross-hatched", icon: "grid-3x3" },
};

function pointsOf(s: Stroke): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 2 < s.pts.length; i += 3) out.push({ x: s.pts[i], y: s.pts[i + 1] });
  return out;
}

/** Path length of a stroke's points. */
function pathLength(pts: ReadonlyArray<Pt>): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

const outlineCache = new WeakMap<Stroke, Pt[] | null>();

/**
 * The area a stroke encloses, as a polygon – for shapes, areas and filled
 * strokes, and for pen strokes that come back to where they started (a loop,
 * a hand-drawn box). Null for strokes that enclose nothing.
 */
export function closedOutline(s: Stroke): Pt[] | null {
  const hit = outlineCache.get(s);
  if (hit !== undefined) return hit;
  let out: Pt[] | null = null;
  if (s.pen !== "marker" && pointCount(s) >= 3) {
    const pts = pointsOf(s);
    if (s.closed || s.area || s.fill) out = pts;
    else if (!s.poly && pts.length >= 8) {
      const box = strokePointBounds(s);
      const diag = Math.hypot(box.w, box.h);
      const first = pts[0];
      const last = pts[pts.length - 1];
      const gap = Math.hypot(last.x - first.x, last.y - first.y);
      if (diag >= 16 && gap <= Math.max(14, 0.22 * diag) && pathLength(pts) >= 2.2 * diag && polygonArea(pts) >= 0.08 * box.w * box.h) out = pts;
    }
  }
  outlineCache.set(s, out);
  return out;
}

/** The polygon a fill covers (null: the stroke has no fill). */
export function fillOutline(s: Stroke): Pt[] | null {
  if (!s.fill || s.pen === "marker") return null;
  const poly = closedOutline(s);
  return poly && poly.length >= 3 ? poly : null;
}

// ------------------------------------------------------------------ hatching

/** Spacing and line width of hatching (page units). */
export function hatchMetrics(s: Pick<Stroke, "width" | "area">): { gap: number; width: number } {
  const w = s.area ? 1.6 : s.width;
  return { gap: Math.min(22, Math.max(8, 6 + 2.2 * w)), width: Math.min(4, Math.max(1, 0.45 * w + 0.5)) };
}

/**
 * Parallel lines `gap` apart at `angle` (radians, screen coordinates), cut to
 * the inside of a polygon (even-odd rule). The lines lie on one grid for the
 * whole page, so the hatching of neighbouring areas lines up.
 */
export function hatchLines(poly: ReadonlyArray<Pt>, gap: number, angle: number): Array<[Pt, Pt]> {
  if (poly.length < 3 || gap <= 0) return [];
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // rotate by -angle: the lines become horizontal
  const rot = poly.map((p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }));
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of rot) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const out: Array<[Pt, Pt]> = [];
  const back = (x: number, y: number): Pt => ({ x: x * cos - y * sin, y: x * sin + y * cos });
  const n = rot.length;
  for (let y = Math.ceil(minY / gap) * gap; y <= maxY; y += gap) {
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = rot[i];
      const b = rot[(i + 1) % n];
      if (a.y === b.y) continue;
      // half-open, so a line through a corner counts it once
      if ((y >= a.y && y < b.y) || (y >= b.y && y < a.y)) xs.push(a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y));
    }
    xs.sort((u, v) => u - v);
    for (let i = 0; i + 1 < xs.length; i += 2) if (xs[i + 1] - xs[i] > 0.5) out.push([back(xs[i], y), back(xs[i + 1], y)]);
  }
  return out;
}

const f = (n: number) => (Math.round(n * 100) / 100).toString();

/** How to draw a fill: SVG path data for the area (solid) or for its hatching lines. */
export interface FillGeometry {
  color: string;
  /** Path to fill (solid fills). */
  area: string | null;
  /** Lines to stroke (hatching). */
  lines: string | null;
  lineWidth: number;
}

const geometryCache = new WeakMap<Stroke, FillGeometry | null>();

export function fillGeometry(s: Stroke): FillGeometry | null {
  const hit = geometryCache.get(s);
  if (hit !== undefined) return hit;
  const poly = fillOutline(s);
  let g: FillGeometry | null = null;
  if (poly && s.fill) {
    const style = s.fillStyle ?? "solid";
    const { gap, width } = hatchMetrics(s);
    if (style === "solid") {
      g = { color: s.fill, area: poly.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`).join("") + "Z", lines: null, lineWidth: 0 };
    } else {
      const lines = hatchLines(poly, gap, -Math.PI / 4);
      if (style === "cross") lines.push(...hatchLines(poly, gap, Math.PI / 4));
      g = { color: s.fill, area: null, lines: lines.map(([a, b]) => `M${f(a.x)} ${f(a.y)}L${f(b.x)} ${f(b.y)}`).join(""), lineWidth: width };
    }
  }
  geometryCache.set(s, g);
  return g;
}

// ------------------------------------------------------------------ enclosed areas (the fill tool)

export interface EnclosedArea {
  /** Outline (page coordinates), reaching a little under the strokes around it. */
  pts: Pt[];
  /** Size of the area (page units²). */
  area: number;
  bounds: Rect;
}

export interface EnclosedOptions {
  /** Grid cell size (page units). */
  cell?: number;
  /** Gaps this wide where lines do not quite meet still close the area. */
  gap?: number;
}

/** 8 neighbours, clockwise on screen (y down), starting east. */
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * The area around `p` enclosed by strokes. The strokes are drawn into a grid
 * (thickened, so that small gaps close), the grid is flood-filled from `p`
 * and the outline of what was filled is traced. Starts with a window around
 * `p` and grows it while the fill reaches its edge; null when `p` is on a line
 * or the fill reaches the edge of the page (nothing encloses it).
 */
export function enclosedArea(strokesIn: (r: Rect) => Iterable<Stroke>, p: Pt, page: { w: number; h: number }, opts: EnclosedOptions = {}): EnclosedArea | null {
  const gap = opts.gap ?? 3;
  if (!containsPoint({ x: 0, y: 0, w: page.w, h: page.h }, p)) return null;
  for (let half = 200; ; half *= 2) {
    const win = {
      x: Math.max(0, p.x - half),
      y: Math.max(0, p.y - half),
      w: 0,
      h: 0,
    };
    win.w = Math.min(page.w, p.x + half) - win.x;
    win.h = Math.min(page.h, p.y + half) - win.y;
    const whole = win.x <= 0 && win.y <= 0 && win.x + win.w >= page.w && win.y + win.h >= page.h;
    // big areas need less detail: a coarser grid keeps the tap quick on slow e-ink tablets
    const cell = opts.cell ?? (half <= 400 ? 2 : half <= 800 ? 3 : 4);
    const res = floodIn(strokesIn(win), p, win, cell, gap);
    if (res === "on-line") return null;
    if (res === "open") {
      if (whole) return null;
      continue;
    }
    return res;
  }
}

function floodIn(strokes: Iterable<Stroke>, p: Pt, win: Rect, cell: number, gap: number): EnclosedArea | "open" | "on-line" {
  const W = Math.max(1, Math.ceil(win.w / cell));
  const H = Math.max(1, Math.ceil(win.h / cell));
  const ink = new Uint8Array(W * H);
  // draw every stroke's centre line, as thick as the stroke plus the gap
  // (this runs for every segment of every stroke near the tap: no allocations in here)
  const mark = (ax: number, ay: number, bx: number, by: number, r: number) => {
    const x0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - win.x) / cell));
    const x1 = Math.min(W - 1, Math.floor((Math.max(ax, bx) + r - win.x) / cell));
    const y0 = Math.max(0, Math.floor((Math.min(ay, by) - r - win.y) / cell));
    const y1 = Math.min(H - 1, Math.floor((Math.max(ay, by) + r - win.y) / cell));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const r2 = r * r;
    for (let cy = y0; cy <= y1; cy++) {
      const py = win.y + (cy + 0.5) * cell - ay;
      for (let cx = x0; cx <= x1; cx++) {
        const i = cy * W + cx;
        if (ink[i]) continue;
        const px = win.x + (cx + 0.5) * cell - ax;
        const t = len2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy) / len2)) : 0;
        const ex = px - t * dx;
        const ey = py - t * dy;
        if (ex * ex + ey * ey <= r2) ink[i] = 1;
      }
    }
  };
  for (const s of strokes) {
    if (s.pen === "marker" || s.area) continue;
    const r = s.width / 2 + gap + cell * 0.25;
    const n = pointCount(s);
    const p3 = s.pts;
    if (n === 1) mark(p3[0], p3[1], p3[0], p3[1], r);
    for (let i = 1; i < n; i++) mark(p3[(i - 1) * 3], p3[(i - 1) * 3 + 1], p3[i * 3], p3[i * 3 + 1], r);
    if (s.closed && n > 2) mark(p3[(n - 1) * 3], p3[(n - 1) * 3 + 1], p3[0], p3[1], r);
  }
  const sx = Math.min(W - 1, Math.max(0, Math.floor((p.x - win.x) / cell)));
  const sy = Math.min(H - 1, Math.max(0, Math.floor((p.y - win.y) / cell)));
  if (ink[sy * W + sx]) return "on-line";
  // flood fill (4 neighbours)
  const region = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  queue[tail++] = sy * W + sx;
  region[sy * W + sx] = 1;
  let count = 0;
  while (head < tail) {
    const i = queue[head++];
    count++;
    const cx = i % W;
    const cy = (i - cx) / W;
    if (cx === 0 || cy === 0 || cx === W - 1 || cy === H - 1) return "open";
    // (not on the edge: all four neighbours exist)
    if (!region[i - 1] && !ink[i - 1]) {
      region[i - 1] = 1;
      queue[tail++] = i - 1;
    }
    if (!region[i + 1] && !ink[i + 1]) {
      region[i + 1] = 1;
      queue[tail++] = i + 1;
    }
    if (!region[i - W] && !ink[i - W]) {
      region[i - W] = 1;
      queue[tail++] = i - W;
    }
    if (!region[i + W] && !ink[i + W]) {
      region[i + W] = 1;
      queue[tail++] = i + W;
    }
  }
  // reach under the lines around it (the fill is drawn underneath the ink)
  const grow = Math.max(1, Math.round(gap / cell));
  let mask = region;
  for (let g = 0; g < grow; g++) {
    const next = mask.slice();
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const cx = i % W;
      if (cx > 0) next[i - 1] = 1;
      if (cx < W - 1) next[i + 1] = 1;
      if (i >= W) next[i - W] = 1;
      if (i + W < mask.length) next[i + W] = 1;
    }
    mask = next;
  }
  const outline = traceOutline(mask, W, H);
  if (outline.length < 3) return "on-line";
  const raw = outline.map(([cx, cy]) => ({ x: win.x + (cx + 0.5) * cell, y: win.y + (cy + 0.5) * cell }));
  const loop = [...raw, raw[0]];
  const pts = simplifyIndices(loop, cell * 0.6)
    .slice(0, -1)
    .map((i) => ({ x: q(loop[i].x), y: q(loop[i].y) }));
  if (pts.length < 3) return "on-line";
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const v of pts) {
    minX = Math.min(minX, v.x);
    minY = Math.min(minY, v.y);
    maxX = Math.max(maxX, v.x);
    maxY = Math.max(maxY, v.y);
  }
  return { pts, area: count * cell * cell, bounds: { x: minX, y: minY, w: maxX - minX, h: maxY - minY } };
}

/** Outer outline of the cells set in `mask` (Moore neighbour tracing), clockwise on screen. */
export function traceOutline(mask: Uint8Array, W: number, H: number): Array<[number, number]> {
  let start = -1;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const sx = start % W;
  const sy = (start - sx) / W;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  const out: Array<[number, number]> = [[sx, sy]];
  // we "came from" the west: the cell to the left of the first one is empty
  let x = sx;
  let y = sy;
  let back = 4;
  const startBack = back;
  const limit = 4 * W * H + 8;
  for (let step = 0; step < limit; step++) {
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      if (inside(x + DX[d], y + DY[d])) {
        found = d;
        break;
      }
    }
    if (found < 0) return out; // a single cell
    // the empty cell checked just before, seen from the new cell
    const ex = x + DX[(found + 7) % 8];
    const ey = y + DY[(found + 7) % 8];
    x += DX[found];
    y += DY[found];
    back = directionOf(ex - x, ey - y);
    if (x === sx && y === sy && back === startBack) break;
    if (x === sx && y === sy) {
      // back at the start, entered differently: keep going until it repeats (Jacob's criterion)
      continue;
    }
    out.push([x, y]);
  }
  return out;
}

function directionOf(dx: number, dy: number): number {
  for (let d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
  return 4;
}

// ------------------------------------------------------------------ what the fill tool fills

export type FillTarget =
  /** A shape or a closed pen stroke: it gets the fill. */
  | { kind: "stroke"; stroke: Stroke }
  /** An area enclosed by several strokes; `existing` is the area stroke already filling it. */
  | { kind: "area"; pts: ReadonlyArray<Pt>; existing: Stroke | null };

function rectOverlap(a: Rect, b: Rect): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  const union = a.w * a.h + b.w * b.h - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * What tapping `p` with the fill tool fills: the smallest shape around `p` –
 * unless other strokes divide it and `p` is in a smaller part of it – or the
 * area that strokes enclose around `p`, or an area filled before.
 */
export function fillTargetAt(page: Page, p: Pt, strokesIn: (r: Rect) => Iterable<Stroke>, opts: EnclosedOptions = {}): FillTarget | null {
  let shape: Stroke | null = null;
  let shapeArea = Infinity;
  for (const s of page.strokes) {
    if (s.area || s.pen === "marker" || !containsPoint(strokePointBounds(s), p)) continue;
    const poly = closedOutline(s);
    if (!poly || !pointInPolygon(p.x, p.y, poly)) continue;
    const a = polygonArea(poly);
    if (a < shapeArea) {
      shape = s;
      shapeArea = a;
    }
  }
  const region = enclosedArea(strokesIn, p, page, opts);
  if (shape && (!region || region.area >= 0.7 * shapeArea)) return { kind: "stroke", stroke: shape };
  const areas = page.strokes.filter((s) => s.area && containsPoint(strokePointBounds(s), p) && pointInPolygon(p.x, p.y, closedOutline(s) ?? []));
  if (region) {
    const existing = [...areas].reverse().find((s) => rectOverlap(strokePointBounds(s), region.bounds) > 0.8) ?? null;
    return { kind: "area", pts: region.pts, existing };
  }
  if (shape) return { kind: "stroke", stroke: shape };
  const top = areas[areas.length - 1];
  return top ? { kind: "area", pts: closedOutline(top) ?? [], existing: top } : null;
}

/** A new area stroke (only a fill) with the given outline. */
export function areaStroke(pts: ReadonlyArray<Pt>, fill: string, fillStyle: FillStyle): Stroke {
  const arr = new Float32Array(pts.length * 3);
  pts.forEach((v, i) => {
    arr[i * 3] = q(v.x);
    arr[i * 3 + 1] = q(v.y);
    arr[i * 3 + 2] = 0.5;
  });
  // the line colour is the fill colour: versions without fills show a thin outline of it
  return makeStroke({ pen: "ballpoint", color: fill, width: 0.5, pts: arr, poly: true, closed: true, area: true, fill, fillStyle });
}
