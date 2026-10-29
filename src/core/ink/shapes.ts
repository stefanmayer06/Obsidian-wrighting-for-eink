import { convexHull, polygonArea, polygonPerimeter, simplifyIndices, type Pt } from "../geometry";
import { strokePointBounds } from "./geom";
import { makeStroke, q, type FillStyle, type PenType, type Stroke } from "./model";

/**
 * Shapes: the shape tool draws them from a drag, and "hold to snap" turns a
 * hand-drawn line, rectangle, triangle or ellipse into a clean one when the pen
 * rests at the end of the stroke (like Boox Notes' shape recognition).
 */

export type ShapeKind = "line" | "arrow" | "elbow" | "dashed" | "rect" | "ellipse" | "circle" | "triangle" | "diamond";

export const SHAPES: Record<ShapeKind, { label: string; icon: string }> = {
  line: { label: "Line", icon: "minus" },
  arrow: { label: "Arrow", icon: "move-up-right" },
  elbow: { label: "Elbow arrow", icon: "corner-down-right" },
  dashed: { label: "Dashed line", icon: "ellipsis" },
  rect: { label: "Rectangle", icon: "square" },
  ellipse: { label: "Ellipse", icon: "circle" },
  circle: { label: "Circle", icon: "circle-dot" },
  triangle: { label: "Triangle", icon: "triangle" },
  diamond: { label: "Diamond", icon: "diamond" },
};

export interface ShapeStyle {
  pen: PenType;
  color: string;
  width: number;
  /** Fill of closed shapes (none when not set). */
  fill?: string;
  fillStyle?: FillStyle;
}

/** Arrows and elbow arrows connect shapes (see connectors.ts). */
export function isConnectorKind(kind: ShapeKind): boolean {
  return kind === "arrow" || kind === "elbow";
}

const P = 0.5;

function fromPoints(points: ReadonlyArray<Pt>, style: ShapeStyle, extra: Partial<Pick<Stroke, "closed" | "arrow" | "dash" | "elbow">> = {}): Stroke {
  const pts = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    pts[i * 3] = q(p.x);
    pts[i * 3 + 1] = q(p.y);
    pts[i * 3 + 2] = P;
  });
  // shapes are drawn with an even line whatever pen is selected (a highlighter stays a highlighter)
  const pen: PenType = style.pen === "marker" ? "marker" : "ballpoint";
  const fill = extra.closed && pen !== "marker" && style.fill ? { fill: style.fill, fillStyle: style.fillStyle } : {};
  return makeStroke({ pen, color: style.color, width: style.width, pts, poly: true, ...extra, ...fill });
}

/** Points around an ellipse (enough for a smooth outline at its size). */
export function ellipsePoints(cx: number, cy: number, rx: number, ry: number, angle = 0): Pt[] {
  const n = Math.max(24, Math.min(96, Math.round((Math.abs(rx) + Math.abs(ry)) / 4)));
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = rx * Math.cos(t);
    const y = ry * Math.sin(t);
    out.push({ x: cx + x * cos - y * sin, y: cy + x * sin + y * cos });
  }
  return out;
}

/** The shape spanned by a drag from `a` to `b`. */
export function shapeFromDrag(kind: ShapeKind, a: Pt, b: Pt, style: ShapeStyle): Stroke {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  switch (kind) {
    case "line":
      return fromPoints([a, b], style);
    case "dashed":
      return fromPoints([a, b], style, { dash: true });
    case "arrow":
      return fromPoints([a, b], style, { arrow: true });
    case "elbow": {
      // one right angle, horizontal first when the drag is wider than high
      const corner = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
      return fromPoints([a, corner, b], style, { arrow: true, elbow: true });
    }
    case "rect":
      return fromPoints(
        [
          { x: x0, y: y0 },
          { x: x1, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
        style,
        { closed: true },
      );
    case "triangle":
      return fromPoints(
        [
          { x: (x0 + x1) / 2, y: y0 },
          { x: x1, y: y1 },
          { x: x0, y: y1 },
        ],
        style,
        { closed: true },
      );
    case "diamond":
      return fromPoints(
        [
          { x: (x0 + x1) / 2, y: y0 },
          { x: x1, y: (y0 + y1) / 2 },
          { x: (x0 + x1) / 2, y: y1 },
          { x: x0, y: (y0 + y1) / 2 },
        ],
        style,
        { closed: true },
      );
    case "circle": {
      const r = Math.hypot(b.x - a.x, b.y - a.y);
      return fromPoints(ellipsePoints(a.x, a.y, r, r), style, { closed: true });
    }
    case "ellipse":
    default:
      return fromPoints(ellipsePoints((x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2), style, { closed: true });
  }
}

/** Snap a direction to horizontal/vertical/45° when it is close. */
function snapAngle(a: Pt, b: Pt, tolerance = (6 * Math.PI) / 180): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx);
  const step = Math.PI / 4;
  const snapped = Math.round(ang / step) * step;
  if (Math.abs(ang - snapped) > tolerance) return b;
  return { x: a.x + Math.cos(snapped) * len, y: a.y + Math.sin(snapped) * len };
}

function pointsOf(s: Stroke): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 2 < s.pts.length; i += 3) out.push({ x: s.pts[i], y: s.pts[i + 1] });
  return out;
}

function pathLength(pts: ReadonlyArray<Pt>): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return len;
}

/**
 * Recognise a hand-drawn shape. Returns the clean shape (same style as the
 * stroke) or null when the stroke does not look like a shape.
 */
export function recognizeShape(s: Stroke): { kind: ShapeKind; stroke: Stroke } | null {
  const pts = pointsOf(s);
  if (pts.length < 4 || s.pen === "marker") return null;
  const style: ShapeStyle = { pen: s.pen, color: s.color, width: s.width };
  const box = strokePointBounds(s);
  const diag = Math.hypot(box.w, box.h);
  if (diag < 24) return null;
  const len = pathLength(pts);
  const first = pts[0];
  const last = pts[pts.length - 1];
  const chord = Math.hypot(last.x - first.x, last.y - first.y);

  // a straight line: the path is barely longer than its chord
  if (chord > 0.85 * diag && len < 1.12 * chord) {
    let worst = 0;
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    for (const p of pts) worst = Math.max(worst, Math.abs((p.x - first.x) * dy - (p.y - first.y) * dx) / chord);
    if (worst <= Math.max(4, 0.06 * chord)) return { kind: "line", stroke: shapeFromDrag("line", first, snapAngle(first, last), style) };
  }

  // closed shapes: the end comes back near the start
  if (chord > Math.max(0.22 * len, 0.35 * diag)) return null;
  const hull = convexHull(pts);
  if (hull.length < 3) return null;
  const hullArea = polygonArea(hull);
  const perim = polygonPerimeter(hull);
  if (hullArea < 200) return null;
  // corners: simplify the closed path
  const loop = [...pts, pts[0]];
  const idx = simplifyIndices(loop, Math.max(5, 0.07 * diag));
  const corners = idx.slice(0, -1).map((i) => loop[i]);
  // merge corners that are very close (start/end overlap)
  const merged: Pt[] = [];
  for (const c of corners) {
    if (merged.some((m) => Math.hypot(m.x - c.x, m.y - c.y) < 0.12 * diag)) continue;
    merged.push(c);
  }
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  // an ellipse: every point is about one "radius" from the centre (a rectangle's corners are √2 out)
  const rx0 = Math.max(1, box.w / 2);
  const ry0 = Math.max(1, box.h / 2);
  let dev = 0;
  for (const p of pts) dev += Math.abs(Math.hypot((p.x - cx) / rx0, (p.y - cy) / ry0) - 1);
  dev /= pts.length;
  // roundness: 4πA/P² is 1 for a circle, 0.785 for a square, 0.6 for an equilateral triangle
  const roundness = (4 * Math.PI * hullArea) / (perim * perim);
  if (dev < 0.085 && merged.length >= 4) {
    if (Math.abs(box.w - box.h) < 0.12 * Math.max(box.w, box.h)) {
      const r = (box.w + box.h) / 4;
      return { kind: "circle", stroke: fromPoints(ellipsePoints(cx, cy, r, r), style, { closed: true }) };
    }
    return { kind: "ellipse", stroke: fromPoints(ellipsePoints(cx, cy, box.w / 2, box.h / 2), style, { closed: true }) };
  }
  if (merged.length === 3 && roundness < 0.75) {
    return { kind: "triangle", stroke: fromPoints(merged, style, { closed: true }) };
  }
  if (merged.length === 4 && roundness < 0.86) {
    // axis aligned rectangle when the edges are nearly horizontal/vertical, else a diamond or a free quadrilateral
    const edgesAligned = merged.every((c, i) => {
      const d = merged[(i + 1) % 4];
      const ang = Math.abs(Math.atan2(d.y - c.y, d.x - c.x)) % (Math.PI / 2);
      return Math.min(ang, Math.PI / 2 - ang) < (12 * Math.PI) / 180;
    });
    if (edgesAligned) return { kind: "rect", stroke: shapeFromDrag("rect", { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, style) };
    const diagonalOnes = merged.every((c, i) => {
      const d = merged[(i + 1) % 4];
      const ang = Math.abs(Math.atan2(d.y - c.y, d.x - c.x)) % (Math.PI / 2);
      return Math.abs(ang - Math.PI / 4) < (14 * Math.PI) / 180;
    });
    if (diagonalOnes) return { kind: "diamond", stroke: shapeFromDrag("diamond", { x: box.x, y: box.y }, { x: box.x + box.w, y: box.y + box.h }, style) };
    return { kind: "rect", stroke: fromPoints(merged, style, { closed: true }) };
  }
  // a rounder ellipse drawn less evenly
  if (roundness >= 0.84 && dev < 0.14 && merged.length >= 5) {
    return { kind: "ellipse", stroke: fromPoints(ellipsePoints(cx, cy, box.w / 2, box.h / 2), style, { closed: true }) };
  }
  return null;
}
