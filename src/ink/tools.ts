import { containsPoint, distanceToSegment, inflate, type Pt, type Rect } from "../core/geometry";
import { eraseFromStroke, isScribble, scribbleTargets, strokeErase, strokesInLasso } from "../core/ink/erase";
import { figureBounds, imageBounds, linkBounds, rectInside, strokeBounds, strokeDistance, textBounds, unionRect } from "../core/ink/geom";
import { addItems, EMPTY_SELECTION, makeStroke, q, qp, replaceItems, type Items, type Page, type PenType, type Selection, type Stroke } from "../core/ink/model";
import { StrokeBuilder, type Segment } from "../core/ink/pens";
import { recognizeShape, shapeFromDrag } from "../core/ink/shapes";
import { apply, canRotate, IDENTITY, isIdentity, itemsBounds, rotation, scaling, transformItems, translation, type Matrix } from "../core/ink/transform";
import { drawFigure, drawImageItem, drawLink, drawStroke, drawText, segmentPath } from "./render";
import type { InkSurface } from "./surface";
import type { ToolId } from "./types";

/** A point of pen/finger input: page coordinates, pressure, time and screen position. */
export interface InputPt {
  x: number;
  y: number;
  p: number;
  t: number;
  cx: number;
  cy: number;
}

/** One press of the pen (or mouse/finger) with a tool, from down to up. */
export interface ToolSession {
  /** Started by a pen (palm rejection, keep ink on cancel). */
  readonly pen: boolean;
  move(points: InputPt[]): void;
  /** `null`: the pointer was cancelled (finish with what there is). */
  up(last: InputPt | null): void;
  cancel(): void;
}

export function createSession(s: InkSurface, tool: ToolId, pt: InputPt, opts: { isPen: boolean; ctrl: boolean }): ToolSession {
  switch (tool) {
    case "marker":
      return new PenSession(s, pt, opts.isPen, true);
    case "eraser":
      return s.tools.eraser === "lasso" ? new LassoSession(s, pt, opts.isPen, "erase") : new EraserSession(s, pt, opts.isPen);
    case "lasso":
      return new LassoSession(s, pt, opts.isPen, "select");
    case "shape":
      return new ShapeSession(s, pt, opts.isPen);
    case "text":
      return new TextSession(s, pt, opts.isPen);
    case "pen":
    default:
      return new PenSession(s, pt, opts.isPen, false);
  }
}

// ------------------------------------------------------------------ pen and highlighter

const HOLD_MS = 600;
const HOLD_SLOP_PX = 4;

class PenSession implements ToolSession {
  private builder: StrokeBuilder;
  private pts: number[] = [];
  private lastX = NaN;
  private lastY = NaN;
  /** Pieces of pen ink not drawn yet (drawn together, once per pen move). */
  private pending: Segment[] = [];
  /** The highlighter so far (it is one width and colour, so one path). */
  private markerPath: Path2D | null = null;
  private holdTimer: number | null = null;
  private holdAnchor: { cx: number; cy: number } | null = null;
  /** When the pen last moved away from the hold anchor. */
  private holdSince = 0;
  private snapped: Stroke | null = null;
  private readonly penType: PenType;
  private readonly color: string;
  private readonly width: number;

  constructor(
    private s: InkSurface,
    first: InputPt,
    readonly pen: boolean,
    private marker: boolean,
  ) {
    const t = s.tools;
    this.penType = marker ? "marker" : t.pen;
    this.color = marker ? t.markerColor : t.color;
    this.width = t.widths[this.penType];
    this.builder = new StrokeBuilder(this.penType, this.color, this.width);
    if (!marker) s.beginLive();
    this.add(first);
    this.redrawMarker();
    this.armHold(first);
  }

  private add(p: InputPt): void {
    const x = q(p.x);
    const y = q(p.y);
    if (Math.abs(x - this.lastX) < 0.25 && Math.abs(y - this.lastY) < 0.25) return;
    const pr = qp(p.p);
    this.pts.push(x, y, pr);
    this.lastX = x;
    this.lastY = y;
    const seg = this.builder.add(x, y, pr);
    if (!seg) return;
    if (!this.marker) {
      this.pending.push(seg);
      return;
    }
    if (!this.markerPath) {
      this.markerPath = new Path2D();
      this.markerPath.moveTo(seg.a.x, seg.a.y);
    }
    segmentPath(this.markerPath, seg);
  }

  /** Draw the pen ink that arrived since the last call. */
  private flush(): void {
    if (this.pending.length === 0) return;
    this.s.drawLive(this.pending);
    this.pending = [];
  }

  private stroke(): Stroke {
    return makeStroke({ pen: this.penType, color: this.color, width: this.width, pts: Float32Array.from(this.pts) });
  }

  /**
   * The highlighter is shown on the preview canvas (multiply-blended) until it
   * is finished. Its path grows piece by piece; it is drawn exactly like the
   * finished stroke will be.
   */
  private redrawMarker(): void {
    if (!this.marker || this.pts.length === 0) return;
    const ctx = this.s.wetContext();
    const end = this.builder.end();
    const path = this.markerPath ? new Path2D(this.markerPath) : new Path2D();
    if (end) {
      if (!this.markerPath) path.moveTo(end.a.x, end.a.y);
      segmentPath(path, end);
    }
    ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = end?.color ?? this.color;
    ctx.lineWidth = end?.w ?? this.width;
    ctx.stroke(path);
    ctx.globalCompositeOperation = "source-over";
  }

  /**
   * "Hold to snap": when the pen rests at the end of a stroke, it becomes a
   * clean shape. One timer per stroke: it looks again when it fires, instead of
   * being restarted on every pen move.
   */
  private armHold(p: InputPt): void {
    if (!this.s.settings.holdToShape || this.snapped) return;
    if (this.holdAnchor && Math.hypot(p.cx - this.holdAnchor.cx, p.cy - this.holdAnchor.cy) < HOLD_SLOP_PX) return;
    this.holdAnchor = { cx: p.cx, cy: p.cy };
    this.holdSince = performance.now();
    if (this.holdTimer === null) this.holdTimer = window.setTimeout(() => this.holdCheck(), HOLD_MS);
  }

  private holdCheck(): void {
    const left = HOLD_MS - (performance.now() - this.holdSince);
    if (left > 5) {
      this.holdTimer = window.setTimeout(() => this.holdCheck(), left);
      return;
    }
    this.holdTimer = null;
    this.snap();
  }

  private snap(): void {
    if (this.pts.length < 12) return;
    this.flush();
    const live = this.stroke();
    const shape = recognizeShape(live);
    if (!shape) return;
    this.snapped = shape.stroke;
    // replace the hand-drawn stroke with the clean shape
    if (this.marker) {
      drawStroke(this.s.wetContext(), shape.stroke);
    } else {
      this.s.renderRect(strokeBounds(live));
      this.s.pageTransform(this.s.bctx);
      drawStroke(this.s.bctx, shape.stroke);
    }
  }

  move(points: InputPt[]): void {
    if (this.snapped) return;
    for (const p of points) this.add(p);
    this.flush();
    this.redrawMarker();
    const last = points[points.length - 1];
    if (last) this.armHold(last);
  }

  up(last: InputPt | null): void {
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (last && !this.snapped) this.add(last);
    if (!this.marker && !this.snapped) {
      const seg = this.builder.end();
      if (seg) this.pending.push(seg);
      this.flush();
    }
    if (this.pts.length === 0) return;
    const stroke = this.snapped ?? this.stroke();
    if (this.marker) this.s.clearWet();
    const page = this.s.page;
    // scratching over writing erases it
    if (!this.snapped && !this.marker && this.s.settings.scribbleErase && isScribble(stroke)) {
      const near = this.s.strokeIndex(page).query(strokeBounds(stroke));
      const targets = scribbleTargets(stroke, near);
      if (targets.size > 0) {
        let dirty: Rect | null = strokeBounds(stroke);
        for (const t of page.strokes) if (targets.has(t.id)) dirty = unionRect(dirty, strokeBounds(t));
        this.s.commitPage({ ...page, strokes: page.strokes.filter((t) => !targets.has(t.id)) }, dirty);
        return;
      }
    }
    // pen ink is already on the canvas exactly as it will stay; highlighter and shapes are redrawn in place
    this.s.commitPage(addItems(page, { strokes: [stroke] }), this.marker || this.snapped ? strokeBounds(stroke) : null);
  }

  cancel(): void {
    if (this.holdTimer !== null) window.clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (this.marker) this.s.clearWet();
    else if (this.pts.length > 0) this.s.renderRect(strokeBounds(this.snapped ?? this.stroke()));
  }
}

// ------------------------------------------------------------------ eraser

class EraserSession implements ToolSession {
  private last: Pt;
  private radius: number;
  private changed = false;

  constructor(
    private s: InkSurface,
    first: InputPt,
    readonly pen: boolean,
  ) {
    // the eraser has the same size on screen at any zoom
    this.radius = Math.max(1, s.tools.eraserSize / s.view.scale);
    s.beginWork();
    this.last = first;
    this.erase(first, first);
  }

  private erase(a: Pt, b: Pt): void {
    const page = this.s.page;
    const r = this.radius;
    const box = inflate({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) }, r + 1);
    const near = this.s.strokeIndex(page).query(box);
    if (near.length === 0) return;
    const removed: Stroke[] = [];
    const added: Stroke[] = [];
    let next: Page;
    if (this.s.tools.eraser === "stroke") {
      const ids = strokeErase(near, a, b, r);
      if (ids.size === 0) return;
      for (const st of near) if (ids.has(st.id)) removed.push(st);
      next = { ...page, strokes: page.strokes.filter((st) => !ids.has(st.id)) };
    } else {
      const pieces = new Map<string, Stroke[]>();
      for (const st of near) {
        const res = eraseFromStroke(st, a, b, r);
        if (!res || (res.length === 1 && res[0] === st)) continue;
        pieces.set(st.id, res);
        removed.push(st);
        added.push(...res);
      }
      if (pieces.size === 0) return;
      const strokes: Stroke[] = [];
      for (const st of page.strokes) {
        const rep = pieces.get(st.id);
        if (rep) strokes.push(...rep);
        else strokes.push(st);
      }
      next = { ...page, strokes };
    }
    let dirty: Rect | null = null;
    for (const st of removed) dirty = unionRect(dirty, strokeBounds(st));
    this.s.updateIndex(page, next, removed, added);
    this.s.setWork(next, dirty);
    this.changed = true;
  }

  move(points: InputPt[]): void {
    for (const p of points) {
      if (Math.hypot(p.x - this.last.x, p.y - this.last.y) < this.radius * 0.25) continue;
      this.erase(this.last, p);
      this.last = p;
    }
  }

  up(last: InputPt | null): void {
    if (last) this.erase(this.last, last);
    this.s.endWork(this.changed);
  }

  cancel(): void {
    this.s.endWork(false);
  }
}

// ------------------------------------------------------------------ lasso (select / erase)

type DragKind = "move" | "scale" | "rotate";

class LassoSession implements ToolSession {
  private poly: Pt[] = [];
  private drag: { kind: DragKind; start: Pt; box: Rect; items: Items; matrix: Matrix } | null = null;

  constructor(
    private s: InkSurface,
    first: InputPt,
    readonly pen: boolean,
    private mode: "select" | "erase",
  ) {
    if (mode === "select" && s.selectionBounds()) {
      const handle = s.selectionOverlay.handleAt(first.cx, first.cy);
      const box = s.selectionBounds() as Rect;
      const slack = 10 / s.view.scale;
      if (handle || containsPoint(inflate(box, slack), first)) {
        this.startDrag(handle ?? "move", first, box);
        return;
      }
    }
    if (mode === "select" && s.selectionBounds()) s.setSelection(EMPTY_SELECTION);
    this.poly = [first];
  }

  private startDrag(kind: DragKind, start: Pt, box: Rect): void {
    const items = this.s.selectedItems();
    this.drag = { kind, start, box, items, matrix: IDENTITY };
    // take the selection off the page while it moves
    const ids = [...items.strokes, ...items.texts, ...items.images, ...items.links, ...items.figures].map((i) => i.id);
    for (const id of ids) this.s.hidden.add(id);
    this.s.renderRect(inflate(box, 30));
    this.preview();
  }

  private preview(): void {
    const d = this.drag;
    if (!d) return;
    const ctx = this.s.wetContext();
    const m = d.matrix;
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    for (const it of d.items.images) drawImageItem(ctx, it, this.s.images);
    for (const st of d.items.strokes) drawStroke(ctx, st);
    // boxes keep their orientation: draw them transformed for the preview, they are placed exactly on drop
    for (const t of d.items.texts) drawText(ctx, t);
    for (const l of d.items.links) drawLink(ctx, l);
    for (const f of d.items.figures) drawFigure(ctx, f);
    this.s.selectionOverlay.update(m);
  }

  private drawPath(): void {
    const ctx = this.s.wetContext();
    ctx.setLineDash([6 / this.s.view.scale, 5 / this.s.view.scale]);
    ctx.lineWidth = 1.6 / this.s.view.scale;
    ctx.strokeStyle = this.mode === "erase" ? "#c62828" : "#1a1a1a";
    ctx.beginPath();
    this.poly.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
  }

  move(points: InputPt[]): void {
    const d = this.drag;
    if (d) {
      const p = points[points.length - 1];
      const box = d.box;
      if (d.kind === "move") d.matrix = translation(p.x - d.start.x, p.y - d.start.y);
      else if (d.kind === "scale") {
        const o = { x: box.x, y: box.y };
        const v0 = { x: d.start.x - o.x, y: d.start.y - o.y };
        const v1 = { x: p.x - o.x, y: p.y - o.y };
        const k = Math.max(0.1, (v0.x * v1.x + v0.y * v1.y) / Math.max(1e-6, v0.x * v0.x + v0.y * v0.y));
        d.matrix = scaling(k, o);
      } else {
        const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
        const a0 = Math.atan2(d.start.y - c.y, d.start.x - c.x);
        const a1 = Math.atan2(p.y - c.y, p.x - c.x);
        let ang = a1 - a0;
        // snap to multiples of 15°
        const step = Math.PI / 12;
        if (Math.abs(ang - Math.round(ang / step) * step) < 0.04) ang = Math.round(ang / step) * step;
        d.matrix = rotation(ang, c);
      }
      this.preview();
      return;
    }
    for (const p of points) {
      const last = this.poly[this.poly.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) * this.s.view.scale < 2) continue;
      this.poly.push({ x: p.x, y: p.y });
    }
    this.drawPath();
  }

  up(last: InputPt | null): void {
    const d = this.drag;
    if (d) {
      if (last) this.move([last]);
      this.drag = null;
      this.s.hidden.clear();
      this.s.clearWet();
      if (isIdentity(d.matrix)) {
        this.s.renderRect(inflate(d.box, 30));
        this.s.selectionOverlay.update();
        return;
      }
      const moved = transformItems(d.items, d.matrix);
      const page = replaceItems(this.s.page, moved);
      const after = itemsBounds(moved);
      this.s.commitPage(page, unionRect(inflate(d.box, 30), after ? inflate(after, 30) : null), { keepSelection: true });
      this.s.selectionOverlay.update();
      return;
    }
    if (last) this.poly.push({ x: last.x, y: last.y });
    this.s.clearWet();
    const page = this.s.page;
    let length = 0;
    for (let i = 1; i < this.poly.length; i++) length += Math.hypot(this.poly[i].x - this.poly[i - 1].x, this.poly[i].y - this.poly[i - 1].y);
    if (length * this.s.view.scale < 12) {
      // a tap: select the item under the pen
      if (this.mode === "select") {
        const sel = itemAt(page, this.poly[0], 8 / this.s.view.scale);
        this.s.setSelection(sel ?? EMPTY_SELECTION);
      }
      return;
    }
    const poly = this.poly;
    const strokes = strokesInLasso(page.strokes, poly);
    if (this.mode === "erase") {
      if (strokes.size === 0) return;
      let dirty: Rect | null = null;
      for (const st of page.strokes) if (strokes.has(st.id)) dirty = unionRect(dirty, strokeBounds(st));
      this.s.commitPage({ ...page, strokes: page.strokes.filter((st) => !strokes.has(st.id)) }, dirty);
      return;
    }
    const inside = <T>(list: readonly T[], bounds: (t: T) => Rect, id: (t: T) => string) => new Set(list.filter((t) => rectInside(bounds(t), poly)).map(id));
    this.s.setSelection({
      strokes,
      texts: inside(page.texts, textBounds, (t) => t.id),
      images: inside(page.images, imageBounds, (t) => t.id),
      links: inside(page.links, linkBounds, (t) => t.id),
      figures: inside(page.figures, figureBounds, (t) => t.id),
    });
  }

  cancel(): void {
    if (this.drag) {
      this.s.hidden.clear();
      this.s.renderRect(inflate(this.drag.box, 30));
      this.drag = null;
      this.s.selectionOverlay.update();
    }
    this.s.clearWet();
  }
}

/** The topmost item under a point (for tapping with the lasso). */
export function itemAt(page: Page, p: Pt, slack: number): Selection | null {
  const one = (kind: keyof Selection, id: string): Selection => ({ ...EMPTY_SELECTION, [kind]: new Set([id]) });
  for (let i = page.links.length - 1; i >= 0; i--) if (containsPoint(inflate(linkBounds(page.links[i]), slack), p)) return one("links", page.links[i].id);
  for (let i = page.texts.length - 1; i >= 0; i--) if (containsPoint(inflate(textBounds(page.texts[i]), slack), p)) return one("texts", page.texts[i].id);
  for (let i = page.strokes.length - 1; i >= 0; i--) {
    const st = page.strokes[i];
    if (!containsPoint(inflate(strokeBounds(st), slack), p)) continue;
    if (strokeDistance(st, p, p) <= slack + st.width / 2) return one("strokes", st.id);
  }
  for (let i = page.images.length - 1; i >= 0; i--) if (containsPoint(imageBounds(page.images[i]), p)) return one("images", page.images[i].id);
  for (const f of page.figures) {
    const r = figureBounds(f);
    const edges: Array<[Pt, Pt]> = [
      [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }],
      [{ x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }],
      [{ x: r.x, y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h }],
      [{ x: r.x, y: r.y }, { x: r.x, y: r.y + r.h }],
    ];
    if (edges.some(([a, b]) => distanceToSegment(p, a, b) <= slack * 1.5)) return one("figures", f.id);
  }
  return null;
}

// ------------------------------------------------------------------ shapes

class ShapeSession implements ToolSession {
  private a: Pt;
  private b: Pt;

  constructor(
    private s: InkSurface,
    first: InputPt,
    readonly pen: boolean,
  ) {
    this.a = { x: first.x, y: first.y };
    this.b = this.a;
  }

  private shape(): Stroke {
    const t = this.s.tools;
    return shapeFromDrag(t.shape, this.a, this.b, { pen: t.pen, color: t.color, width: Math.max(1, t.widths[t.pen]) });
  }

  move(points: InputPt[]): void {
    const p = points[points.length - 1];
    this.b = { x: p.x, y: p.y };
    drawStroke(this.s.wetContext(), this.shape());
  }

  up(last: InputPt | null): void {
    if (last) this.b = { x: last.x, y: last.y };
    this.s.clearWet();
    if (Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) * this.s.view.scale < 6) return;
    const st = this.shape();
    this.s.commitPage(addItems(this.s.page, { strokes: [st] }), strokeBounds(st));
  }

  cancel(): void {
    this.s.clearWet();
  }
}

// ------------------------------------------------------------------ text

class TextSession implements ToolSession {
  private start: InputPt;

  constructor(
    private s: InkSurface,
    first: InputPt,
    readonly pen: boolean,
  ) {
    this.start = first;
  }

  move(): void {}

  up(last: InputPt | null): void {
    const p = last ?? this.start;
    if (Math.hypot(p.cx - this.start.cx, p.cy - this.start.cy) > 16) return;
    const page = this.s.page;
    const hit = [...page.texts].reverse().find((t) => containsPoint(inflate(textBounds(t), 6 / this.s.view.scale), p));
    if (hit) this.s.textEditor.edit(hit);
    else if (containsPoint({ x: 0, y: 0, w: page.w, h: page.h }, p)) this.s.textEditor.create({ x: p.x, y: p.y - this.s.tools.textSize * 0.65 });
  }

  cancel(): void {}
}

