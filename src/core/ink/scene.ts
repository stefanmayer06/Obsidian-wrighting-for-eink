import type { Rect } from "../geometry";
import { INK_CUSTOM_DATA_KEY, type InkCustomData, type Point, type SceneElement } from "../scene";
import { strokePointBounds } from "./geom";
import { isMarker } from "./pens";
import type { InkDoc, InkMeta, Page, Region, Stroke } from "./model";

/**
 * The recognition pipeline (OCR planning, classification, layout) works on a
 * flat scene. This turns a notebook into one: pages are stacked top to bottom
 * with a gap, and every item becomes an element in those scene coordinates.
 *
 *  - handwriting → "freedraw" (highlighter strokes are left out: they mark, they don't write)
 *  - straight shapes → "line"/"arrow", closed shapes → "rectangle"
 *  - text boxes and link chips → "text" ([[links]] stay links)
 *  - images → "image"; figures → frames named "Diagram"; diagram areas → regions
 */

export const SCENE_PAGE_GAP = 80;

export interface InkScene {
  elements: SceneElement[];
  /** Top of each page in scene coordinates. */
  offsets: Map<string, number>;
}

export function pageOffsets(doc: InkDoc): Map<string, number> {
  const out = new Map<string, number>();
  let y = 0;
  for (const p of doc.pages) {
    out.set(p.id, y);
    y += p.h + SCENE_PAGE_GAP;
  }
  return out;
}

function pageRole(p: Page): InkCustomData {
  if (p.bg.kind === "pdf") return { role: "pdf-page", pdf: p.bg.path, page: p.bg.page };
  if (p.bg.kind === "image") return { role: "image-page", image: p.bg.path };
  return { role: "paper", paper: { ...p.bg.paper } };
}

function strokeElement(s: Stroke, dy: number): SceneElement | null {
  const n = Math.floor(s.pts.length / 3);
  if (n === 0 || isMarker(s)) return null;
  const box = strokePointBounds(s);
  const x0 = s.pts[0];
  const y0 = s.pts[1];
  if (s.poly && s.closed) {
    return { id: s.id, type: "rectangle", x: box.x, y: box.y + dy, width: box.w, height: box.h, strokeWidth: s.width, strokeColor: s.color, version: 1 };
  }
  const points: Point[] = [];
  const pressures: number[] = [];
  for (let i = 0; i < n; i++) {
    points.push([s.pts[i * 3] - x0, s.pts[i * 3 + 1] - y0]);
    pressures.push(s.pts[i * 3 + 2]);
  }
  return {
    id: s.id,
    type: s.poly ? (s.arrow ? "arrow" : "line") : "freedraw",
    x: x0,
    y: y0 + dy,
    width: box.w,
    height: box.h,
    points,
    pressures,
    strokeWidth: s.width,
    strokeColor: s.color,
    version: 1,
  };
}

export function inkScene(doc: InkDoc, meta: InkMeta): InkScene {
  const offsets = pageOffsets(doc);
  const elements: SceneElement[] = [];
  for (const p of doc.pages) {
    const dy = offsets.get(p.id) ?? 0;
    elements.push({
      id: p.id,
      type: "image",
      x: 0,
      y: dy,
      width: p.w,
      height: p.h,
      locked: true,
      customData: { [INK_CUSTOM_DATA_KEY]: pageRole(p) },
    });
    for (const img of p.images) elements.push({ id: img.id, type: "image", x: img.x, y: img.y + dy, width: img.w, height: img.h });
    for (const s of p.strokes) {
      const el = strokeElement(s, dy);
      if (el) elements.push(el);
    }
    for (const t of p.texts) {
      if (!t.text.trim()) continue;
      elements.push({ id: t.id, type: "text", x: t.x, y: t.y + dy, width: t.w, height: t.h, text: t.text, rawText: t.text, fontSize: t.size });
    }
    for (const l of p.links) {
      const text = `[[${l.target}]]`;
      elements.push({ id: l.id, type: "text", x: l.x, y: l.y + dy, width: 200, height: 34, text, rawText: text, fontSize: 20 });
    }
    for (const f of p.figures) elements.push({ id: f.id, type: "frame", name: "Diagram", x: f.x, y: f.y + dy, width: f.w, height: f.h });
  }
  for (const r of meta.regions) {
    const dy = offsets.get(r.page);
    if (dy === undefined) continue;
    elements.push({
      id: r.id,
      type: "rectangle",
      x: r.x,
      y: r.y + dy,
      width: r.w,
      height: r.h,
      locked: true,
      customData: { [INK_CUSTOM_DATA_KEY]: { role: "region", kind: "diagram" } satisfies InkCustomData },
    });
  }
  return { elements, offsets };
}

/** The page a scene rectangle belongs to (by its centre, else the nearest page) and the rectangle in page coordinates. */
export function toPageRect(doc: InkDoc, offsets: Map<string, number>, r: Rect): { page: string; rect: Rect } | null {
  const cy = r.y + r.h / 2;
  let best: Page | null = null;
  let bestD = Infinity;
  for (const p of doc.pages) {
    const top = offsets.get(p.id) ?? 0;
    const d = cy < top ? top - cy : cy > top + p.h ? cy - top - p.h : 0;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  if (!best) return null;
  const top = offsets.get(best.id) ?? 0;
  return { page: best.id, rect: { x: r.x, y: r.y - top, w: r.w, h: r.h } };
}

/** Diagram areas planned in scene coordinates, as stored regions. */
export function regionsFromScene(
  doc: InkDoc,
  offsets: Map<string, number>,
  existing: readonly Region[],
  plan: { create: Array<{ id: string; rect: Rect }>; update: Array<{ id: string; rect: Rect }>; remove: string[] },
): Region[] {
  const removed = new Set(plan.remove);
  const updates = new Map(plan.update.map((u) => [u.id, u.rect] as const));
  const out: Region[] = [];
  const add = (id: string, rect: Rect) => {
    const pr = toPageRect(doc, offsets, rect);
    if (pr) out.push({ id, page: pr.page, x: round(pr.rect.x), y: round(pr.rect.y), w: round(pr.rect.w), h: round(pr.rect.h) });
  };
  for (const r of existing) {
    if (removed.has(r.id)) continue;
    const u = updates.get(r.id);
    if (u) add(r.id, u);
    else if (offsets.has(r.page)) out.push(r);
  }
  for (const c of plan.create) add(c.id, c.rect);
  return out;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
