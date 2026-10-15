import type { ExElement } from "../types/excalidraw";
import { absolutePoints, bottom, clusterRects, elementRect, unionAll, type Pt, type Rect } from "./geometry";
import { shortHash } from "./hash";

/**
 * Planning of OCR images: which strokes go into which image, at which scale,
 * and how to map image pixels back to scene coordinates.
 */

export interface RasterLimits {
  /** Longest image side in pixels. Azure accepts up to 10000 (v3.2) / 16000 (v4). */
  maxSide: number;
  /** Preferred upscale for small handwriting. */
  maxScale: number;
  /** Below this scale handwriting becomes unreadable, so we split instead. */
  minScale: number;
  /** Padding around strokes, in pixels. */
  padding: number;
  /** Azure needs at least 50x50 pixels. */
  minSide: number;
}

export const DEFAULT_RASTER_LIMITS: RasterLimits = {
  maxSide: 4000,
  maxScale: 2,
  minScale: 0.6,
  padding: 24,
  minSide: 64,
};

export interface RenderPlan {
  /** Scene rectangle covered (without padding). */
  scene: Rect;
  scale: number;
  padding: number;
  /** Final image size in pixels. */
  width: number;
  height: number;
}

export function makeRenderPlan(scene: Rect, limits: RasterLimits = DEFAULT_RASTER_LIMITS): RenderPlan {
  const longest = Math.max(scene.w, scene.h, 1);
  const fit = (limits.maxSide - 2 * limits.padding) / longest;
  const scale = Math.max(0.05, Math.min(limits.maxScale, fit));
  const width = Math.max(limits.minSide, Math.ceil(scene.w * scale + 2 * limits.padding));
  const height = Math.max(limits.minSide, Math.ceil(scene.h * scale + 2 * limits.padding));
  return { scene, scale, padding: limits.padding, width, height };
}

export function sceneToImage(plan: RenderPlan, p: Pt): Pt {
  return {
    x: (p.x - plan.scene.x) * plan.scale + plan.padding,
    y: (p.y - plan.scene.y) * plan.scale + plan.padding,
  };
}

export function imageRectToScene(plan: RenderPlan, r: Rect): Rect {
  return {
    x: (r.x - plan.padding) / plan.scale + plan.scene.x,
    y: (r.y - plan.padding) / plan.scale + plan.scene.y,
    w: r.w / plan.scale,
    h: r.h / plan.scale,
  };
}

/** A group of strokes that is sent to OCR as one image. */
export interface OcrUnit {
  /** Stable cache key derived from the strokes' ids and versions. */
  key: string;
  elementIds: string[];
  plan: RenderPlan;
}

/** Signature of a stroke for caching: changes whenever the stroke changes. */
export function strokeSignature(el: ExElement): string {
  const pts = el.points ?? [];
  const last = pts.length > 0 ? pts[pts.length - 1] : [0, 0];
  return `${el.id}:${el.version ?? 0}:${Math.round(el.x)}:${Math.round(el.y)}:${pts.length}:${Math.round(last[0])}:${Math.round(last[1])}:${el.angle ?? 0}`;
}

/** Elements that can contain handwriting. */
export function isInkStroke(el: ExElement): boolean {
  return el.type === "freedraw" && !el.isDeleted && (el.points?.length ?? 0) > 0 && (el.opacity ?? 100) > 0;
}

/**
 * Split strokes into OCR units. Strokes far apart (more than `unitGap`) form
 * separate units so a change in one area does not re-OCR the whole page.
 * Units that would need a too-small scale are split into horizontal bands.
 */
export function planOcrUnits(
  strokes: ReadonlyArray<ExElement>,
  unitGap: number,
  limits: RasterLimits = DEFAULT_RASTER_LIMITS,
): OcrUnit[] {
  const rects = strokes.map((s) => elementRect(s));
  const groups = clusterRects(rects, unitGap);
  const units: OcrUnit[] = [];
  const pushUnit = (idx: number[]) => {
    const r = unionAll(idx.map((i) => rects[i]));
    if (!r) return;
    const ids = idx.map((i) => strokes[i].id);
    const sig = idx
      .map((i) => strokeSignature(strokes[i]))
      .sort()
      .join("|");
    units.push({ key: shortHash(sig, 8) + shortHash(`${sig}#`, 8), elementIds: ids, plan: makeRenderPlan(r, limits) });
  };
  const maxSceneSide = (limits.maxSide - 2 * limits.padding) / limits.minScale;
  for (const g of groups) {
    const r = unionAll(g.map((i) => rects[i]));
    if (!r) continue;
    if (Math.max(r.w, r.h) <= maxSceneSide) {
      pushUnit(g);
      continue;
    }
    // Too large: cut into bands. Strokes are assigned by their centre.
    const vertical = r.h >= r.w;
    const sorted = [...g].sort((a, b) =>
      vertical ? rects[a].y + rects[a].h / 2 - (rects[b].y + rects[b].h / 2) : rects[a].x + rects[a].w / 2 - (rects[b].x + rects[b].w / 2),
    );
    let band: number[] = [];
    let bandStart = vertical ? rects[sorted[0]].y : rects[sorted[0]].x;
    for (const i of sorted) {
      const end = vertical ? bottom(rects[i]) : rects[i].x + rects[i].w;
      if (band.length > 0 && end - bandStart > maxSceneSide * 0.9) {
        pushUnit(band);
        band = [];
        bandStart = vertical ? rects[i].y : rects[i].x;
      }
      band.push(i);
    }
    if (band.length > 0) pushUnit(band);
  }
  return units;
}

/** Visual stroke width (in scene units) used when rendering a freedraw element for OCR. */
export function renderStrokeWidth(el: ExElement): number {
  const sw = el.strokeWidth ?? 1;
  // Excalidraw renders freedraw with perfect-freehand using size = strokeWidth * 4.25,
  // which averages to roughly half of that once pressure thinning is applied.
  return Math.max(1.5, sw * 2.2);
}

/** Polyline points of a stroke in image pixel space. */
export function strokeImagePoints(plan: RenderPlan, el: ExElement): Pt[] {
  return absolutePoints(el).map((p) => sceneToImage(plan, p));
}
