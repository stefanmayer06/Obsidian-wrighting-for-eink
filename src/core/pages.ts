import { getInkData, type ExElement } from "../types/excalidraw";
import { bottom, elementRect, type Pt, type Rect, UnionFind } from "./geometry";
import { normalizePaperSpec, type PaperSpec } from "./paper";

/**
 * Pages of an ink page (paper, PDF pages, annotated images) stacked top to bottom,
 * and the maths for inserting a page between them, GoodNotes style.
 */

export type PageRole = "paper" | "pdf-page" | "image-page";

export interface PageRef {
  id: string;
  rect: Rect;
  role: PageRole;
  /** Paper template of a paper page (if it was recorded). */
  paper?: PaperSpec;
}

/** Vertical gap between paper pages. */
export const PAGE_GAP = 80;

export type PagePosition = "after" | "before" | "end";

export function collectPages(elements: ReadonlyArray<ExElement>): PageRef[] {
  const pages: PageRef[] = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    const data = getInkData(el);
    if (data?.role !== "paper" && data?.role !== "pdf-page" && data?.role !== "image-page") continue;
    const page: PageRef = { id: el.id, rect: elementRect(el), role: data.role };
    if (data.role === "paper" && data.paper) page.paper = normalizePaperSpec(data.paper);
    pages.push(page);
  }
  return pages.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

/** The page containing `p`, otherwise the closest one. */
export function pageAt(pages: ReadonlyArray<PageRef>, p: Pt): PageRef | null {
  let best: PageRef | null = null;
  let bestD = Infinity;
  for (const page of pages) {
    const r = page.rect;
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
    const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
    const d = Math.hypot(dx, dy);
    if (d < bestD) {
      bestD = d;
      best = page;
    }
  }
  return best;
}

export interface InsertPlan {
  /** Where the new page goes. */
  x: number;
  y: number;
  /** Everything whose top is at or below this line moves down by `shift` (null: nothing moves). */
  threshold: number | null;
  shift: number;
}

/**
 * Where a new page of `height` goes relative to `current` (the page on screen),
 * and how far the pages (and writing) below it have to move to make room.
 */
export function planPageInsert(
  pages: ReadonlyArray<PageRef>,
  current: PageRef | null,
  position: PagePosition,
  height: number,
  contentBottom: number | null,
  gap = PAGE_GAP,
): InsertPlan {
  if (pages.length === 0) {
    return { x: 0, y: contentBottom === null ? 0 : contentBottom + gap, threshold: null, shift: 0 };
  }
  const x = Math.min(...pages.map((p) => p.rect.x));
  const last = pages.reduce((a, b) => (bottom(b.rect) > bottom(a.rect) ? b : a));
  const cur = current ?? last;
  const i = pages.findIndex((p) => p.id === cur.id);
  if (position === "end" || (position === "after" && cur.id === last.id)) {
    return { x, y: bottom(last.rect) + gap, threshold: null, shift: 0 };
  }
  const shift = height + gap;
  if (position === "after") {
    const next = pages[i + 1];
    const space = next ? Math.max(0, next.rect.y - bottom(cur.rect)) : gap;
    return { x: cur.rect.x, y: bottom(cur.rect) + gap, threshold: bottom(cur.rect) + Math.min(space, gap) / 2, shift };
  }
  const prev = i > 0 ? pages[i - 1] : null;
  const space = prev ? Math.max(0, cur.rect.y - bottom(prev.rect)) : gap;
  return { x: cur.rect.x, y: cur.rect.y, threshold: cur.rect.y - Math.min(space, gap) / 2, shift };
}

/**
 * Ids of the elements that move when everything from `threshold` down shifts.
 * Things that belong together move together: groups, text in its container,
 * frames with their children and arrows with what they are bound to.
 */
export function elementsBelow(elements: ReadonlyArray<ExElement>, threshold: number): Set<string> {
  const live = elements.filter((e) => !e.isDeleted);
  const index = new Map<string, number>();
  live.forEach((e, i) => index.set(e.id, i));
  const uf = new UnionFind(live.length);
  const byGroup = new Map<string, number>();
  const join = (i: number, id: string | null | undefined) => {
    const j = id ? index.get(id) : undefined;
    if (j !== undefined) uf.union(i, j);
  };
  live.forEach((e, i) => {
    for (const g of e.groupIds ?? []) {
      const first = byGroup.get(g);
      if (first === undefined) byGroup.set(g, i);
      else uf.union(i, first);
    }
    join(i, e.containerId);
    join(i, e.frameId);
    join(i, e.startBinding?.elementId);
    join(i, e.endBinding?.elementId);
  });
  const out = new Set<string>();
  for (const group of uf.groups()) {
    const top = Math.min(...group.map((i) => elementRect(live[i]).y));
    if (top >= threshold) for (const i of group) out.add(live[i].id);
  }
  return out;
}
