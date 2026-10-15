import type { DiagramItem } from "./classify";
import { area, inflate, intersection, type Rect } from "./geometry";

/**
 * Diagram embeds use `![[drawing#^area=<id>]]`, which needs an element whose
 * bounding box is the diagram area. We keep one invisible, locked rectangle
 * ("region") per diagram in the drawing and update it as the diagram changes.
 */

export interface ExistingRegion {
  id: string;
  rect: Rect;
}

export interface RegionPlan {
  /** Reference per diagram, e.g. "area=abc" or "frame=xyz". Missing => cannot embed yet. */
  refs: Map<DiagramItem, string>;
  create: Array<{ id: string; rect: Rect }>;
  update: Array<{ id: string; rect: Rect }>;
  remove: string[];
}

export const REGION_PADDING = 8;

function iou(a: Rect, b: Rect): number {
  const inter = intersection(a, b);
  if (!inter) return 0;
  const i = area(inter);
  const u = area(a) + area(b) - i;
  return u > 0 ? i / u : 0;
}

/** Overlap relative to the smaller rect – tolerant to a diagram growing a lot. */
function overlapOfSmaller(a: Rect, b: Rect): number {
  const inter = intersection(a, b);
  if (!inter) return 0;
  const m = Math.min(area(a), area(b));
  return m > 0 ? area(inter) / m : 0;
}

function differs(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) > 1 || Math.abs(a.y - b.y) > 1 || Math.abs(a.w - b.w) > 1 || Math.abs(a.h - b.h) > 1;
}

/**
 * Match diagrams to existing regions.
 * @param canModify when false (drawing not open), only existing regions are reused.
 */
export function planRegions(
  diagrams: ReadonlyArray<DiagramItem>,
  existing: ReadonlyArray<ExistingRegion>,
  canModify: boolean,
  newId: () => string,
): RegionPlan {
  const refs = new Map<DiagramItem, string>();
  const create: RegionPlan["create"] = [];
  const update: RegionPlan["update"] = [];
  const targets = diagrams.filter((d) => {
    if (d.frameId) {
      refs.set(d, `frame=${d.frameId}`);
      return false;
    }
    return !d.isRule;
  });

  const candidates: Array<{ d: DiagramItem; r: ExistingRegion; score: number }> = [];
  for (const d of targets) {
    const want = inflate(d.rect, REGION_PADDING);
    for (const r of existing) {
      const score = Math.max(iou(want, r.rect), overlapOfSmaller(want, r.rect) * 0.8);
      if (score >= 0.3) candidates.push({ d, r, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const usedDiagrams = new Set<DiagramItem>();
  const usedRegions = new Set<string>();
  for (const c of candidates) {
    if (usedDiagrams.has(c.d) || usedRegions.has(c.r.id)) continue;
    usedDiagrams.add(c.d);
    usedRegions.add(c.r.id);
    refs.set(c.d, `area=${c.r.id}`);
    const want = inflate(c.d.rect, REGION_PADDING);
    if (canModify && differs(want, c.r.rect)) update.push({ id: c.r.id, rect: want });
  }
  if (canModify) {
    for (const d of targets) {
      if (usedDiagrams.has(d)) continue;
      const id = newId();
      create.push({ id, rect: inflate(d.rect, REGION_PADDING) });
      refs.set(d, `area=${id}`);
    }
  }
  const remove = canModify ? existing.filter((r) => !usedRegions.has(r.id)).map((r) => r.id) : [];
  return { refs, create, update, remove };
}
