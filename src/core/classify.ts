import { elementText, getInkData, type ExElement } from "../types/excalidraw";
import {
  absolutePoints,
  area,
  bottom,
  center,
  clusterRects,
  containsPoint,
  elementRect,
  GridIndex,
  inflate,
  intersection,
  intersects,
  median,
  union,
  unionAll,
  type Rect,
} from "./geometry";
import type { OcrLine } from "./ocrTypes";

/**
 * Classification of an Excalidraw scene into the parts of a text page:
 * handwritten lines (via OCR), typed text elements, diagrams and pages.
 *
 * Pure function – no Obsidian or DOM dependencies – so it can be unit tested.
 */

export interface ClassifyOptions {
  /** Words below this confidence are not used to decide that a stroke is handwriting. */
  minWordConfidence: number;
  /** Fraction of a stroke's points that must lie on recognised words for it to count as handwriting. */
  textPointRatio: number;
  /** Strokes/shapes closer than this (scene units) belong to the same diagram. */
  diagramGap: number;
  /** Diagrams smaller than this (scene units) are treated as noise (dots, underlines…). */
  minDiagramSize: number;
  /** Margin used when deciding that a recognised line is a label inside a diagram. */
  labelMargin: number;
}

export const DEFAULT_CLASSIFY_OPTIONS: ClassifyOptions = {
  minWordConfidence: 0.35,
  textPointRatio: 0.6,
  diagramGap: 30,
  minDiagramSize: 60,
  labelMargin: 12,
};

export type PageKind = "paper" | "pdf" | "image" | "frame";

export interface PageInfo {
  /** Element id of the page (paper/pdf image, image, frame). */
  id: string;
  kind: PageKind;
  rect: Rect;
  title?: string;
  pdfPath?: string;
  pdfPage?: number;
  imagePath?: string;
}

/** A recognised line in scene coordinates, with the strokes that make it up. */
export interface SceneLine extends OcrLine {
  strokeIds: string[];
}

export interface TextItem {
  id: string;
  text: string;
  rect: Rect;
  fontSize?: number;
}

export interface DiagramItem {
  rect: Rect;
  elementIds: string[];
  labels: string[];
  /** Set when the user marked a frame as diagram (frame name starts with "Diagram"/"Figure"/"Sketch"). */
  frameId?: string;
  frameName?: string;
  /** A long thin hand-drawn line, rendered as a Markdown horizontal rule. */
  isRule?: boolean;
}

export interface PendingInk {
  rect: Rect;
  strokeIds: string[];
}

export interface ClassifiedScene {
  pages: PageInfo[];
  lines: SceneLine[];
  texts: TextItem[];
  diagrams: DiagramItem[];
  /** Strokes that have not been recognised yet (OCR pending/offline/not configured). */
  pendingInk: PendingInk[];
  textStrokeIds: Set<string>;
  /** Tiny marks ignored as noise. */
  noiseStrokeIds: string[];
}

const FRAME_TYPES = new Set(["frame", "magicframe"]);
const DIAGRAM_FRAME_RE = /^\s*(diagram|figure|fig\.?|sketch|drawing|chart|flow ?chart|skizze|zeichnung|abbildung|grafik)\b/i;

export function isDiagramFrameName(name: string | null | undefined): boolean {
  return !!name && DIAGRAM_FRAME_RE.test(name);
}

function frameTitle(name: string | null | undefined): string | undefined {
  const n = (name ?? "").trim();
  if (!n || /^frame(\s*\d+)?$/i.test(n)) return undefined;
  return n;
}

function parsePdfLink(link: string | null | undefined): { path: string; page: number } | null {
  if (!link) return null;
  const m = /^\[*([^\]#|]+\.pdf)#page=(\d+)/i.exec(link.trim());
  return m ? { path: m[1], page: parseInt(m[2], 10) } : null;
}

interface WordRef {
  lineIndex: number;
  /** padded box used for hit testing */
  box: Rect;
  /** the box as recognised */
  core: Rect;
}

function distanceToRect(r: Rect, p: { x: number; y: number }): number {
  const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w));
  const dy = Math.max(r.y - p.y, 0, p.y - (r.y + r.h));
  return Math.hypot(dx, dy);
}

/**
 * Classify the scene. `ocrLines` are recognised lines in *scene* coordinates for
 * all strokes that are not in `pendingStrokeIds`.
 */
export function classifyScene(
  elements: ReadonlyArray<ExElement>,
  ocrLines: ReadonlyArray<OcrLine>,
  pendingStrokeIds: ReadonlySet<string>,
  opts: ClassifyOptions = DEFAULT_CLASSIFY_OPTIONS,
): ClassifiedScene {
  const pages: PageInfo[] = [];
  const diagramFrames: { el: ExElement; rect: Rect }[] = [];
  const strokes: ExElement[] = [];
  const shapes: ExElement[] = [];
  const textEls: ExElement[] = [];
  const boundTextByContainer = new Map<string, string[]>();
  const elementById = new Map<string, ExElement>();

  for (const el of elements) {
    if (!el || el.isDeleted) continue;
    elementById.set(el.id, el);
    const role = getInkData(el)?.role;
    if (role === "region" || role === "typed" || role === "page-border") continue;
    if (role === "paper" || role === "pdf-page" || role === "image-page") {
      const data = getInkData(el);
      pages.push({
        id: el.id,
        kind: role === "paper" ? "paper" : role === "pdf-page" ? "pdf" : "image",
        rect: elementRect(el),
        pdfPath: data?.pdf,
        pdfPage: data?.page,
        imagePath: data?.image,
      });
      continue;
    }
    if (FRAME_TYPES.has(el.type)) {
      if (el.frameRole === "marker") {
        // Excalidraw's own "Import PDF" marks each page with a marker frame linking to the page.
        const pdf = parsePdfLink(el.link);
        if (pdf) pages.push({ id: el.id, kind: "pdf", rect: elementRect(el), pdfPath: pdf.path, pdfPage: pdf.page });
        continue;
      }
      if (isDiagramFrameName(el.name)) diagramFrames.push({ el, rect: elementRect(el) });
      else pages.push({ id: el.id, kind: "frame", rect: elementRect(el), title: frameTitle(el.name) });
      continue;
    }
    if ((el.opacity ?? 100) <= 0) continue;
    if (el.type === "text") {
      if (el.containerId) {
        const list = boundTextByContainer.get(el.containerId) ?? [];
        list.push(elementText(el));
        boundTextByContainer.set(el.containerId, list);
      } else if (elementText(el).trim()) {
        textEls.push(el);
      }
      continue;
    }
    if (el.type === "freedraw") {
      if ((el.points?.length ?? 0) > 0) strokes.push(el);
      continue;
    }
    if (el.type === "selection") continue;
    shapes.push(el);
  }

  // Locked shapes/images that fill a page are page backgrounds (e.g. Excalidraw's PDF import box).
  const isPageBackground = (el: ExElement, r: Rect): boolean => {
    for (const p of pages) {
      const inter = intersection(p.rect, r);
      if (inter && area(inter) >= 0.85 * area(p.rect) && area(r) <= 1.2 * area(p.rect)) return true;
    }
    return el.type === "image" && !!el.locked && area(r) > 360000;
  };
  const shapeParts = shapes.filter((el) => !isPageBackground(el, elementRect(el)));

  // ----- 1. Which strokes are handwriting? ---------------------------------------------
  const lineHeights = ocrLines.map((l) => l.box.h).filter((h) => h > 0);
  const medianH = median(lineHeights) || 30;
  const usableLines: OcrLine[] = ocrLines.filter((l) => {
    const text = l.text.trim();
    if (!text) return false;
    if (l.words.length > 0 && l.words.every((w) => w.confidence < opts.minWordConfidence)) return false;
    // A huge "O" or "->" is a drawing that OCR tried to read.
    if (ocrLines.length >= 3 && text.replace(/\s/g, "").length <= 3 && l.box.h > 2.5 * medianH) return false;
    return true;
  });

  const wordIndex = new GridIndex<WordRef>(Math.max(40, medianH * 2));
  const lineIndex = new GridIndex<WordRef>(Math.max(40, medianH * 2));
  const wordHeights = usableLines.flatMap((l) => l.words.map((w) => w.box.h)).filter((h) => h > 0);
  const medianWordH = median(wordHeights) || medianH;
  usableLines.forEach((line, li) => {
    // a "word" much taller than the others is a drawing OCR tried to read – ignore it
    const words = line.words.filter(
      (w) => w.confidence >= opts.minWordConfidence && !(wordHeights.length >= 3 && w.box.h > 3 * medianWordH),
    );
    const boxes = words.length > 0 ? words.map((w) => w.box) : line.words.length === 0 ? [line.box] : [];
    for (const b of boxes) {
      const padX = Math.max(4, b.h * 0.2);
      const padY = Math.max(4, b.h * 0.35);
      const box = inflate(b, padX, padY);
      wordIndex.insert(box, { lineIndex: li, box, core: b });
    }
    if (boxes.length > 0 && line.box.h <= 3 * medianH) {
      const box = inflate(line.box, Math.max(4, line.box.h * 0.2), Math.max(4, line.box.h * 0.35));
      lineIndex.insert(box, { lineIndex: li, box, core: line.box });
    }
  });

  const textStrokeIds = new Set<string>();
  const strokesOfLine: string[][] = usableLines.map(() => []);
  const strokeRects = new Map<string, Rect>();
  const nonTextStrokes: ExElement[] = [];
  const pendingStrokes: ExElement[] = [];

  for (const s of strokes) {
    const r = elementRect(s);
    strokeRects.set(s.id, r);
    if (pendingStrokeIds.has(s.id)) {
      pendingStrokes.push(s);
      continue;
    }
    const candidates = wordIndex.query(r);
    if (candidates.length === 0 && lineIndex.query(r).length === 0) {
      nonTextStrokes.push(s);
      continue;
    }
    const pts = absolutePoints(s);
    const step = Math.max(1, Math.floor(pts.length / 64));
    let total = 0;
    const hitsPerLine = new Map<number, number>();
    let hits = 0;
    for (let i = 0; i < pts.length; i += step) {
      total++;
      // the point belongs to the closest recognised word whose padded box contains it
      let hitLine = -1;
      let bestDist = Infinity;
      for (const c of candidates) {
        if (!containsPoint(c.box, pts[i])) continue;
        const d = distanceToRect(c.core, pts[i]);
        if (d < bestDist) {
          bestDist = d;
          hitLine = c.lineIndex;
        }
      }
      if (hitLine >= 0) {
        hits++;
        hitsPerLine.set(hitLine, (hitsPerLine.get(hitLine) ?? 0) + 1);
      }
    }
    // Dots and tiny marks (i-dots, punctuation) count when their centre is on a word.
    const tiny = r.w <= medianH * 0.4 && r.h <= medianH * 0.4;
    const ratio = total > 0 ? hits / total : 0;
    // Fallback for tight word boxes: a normal-sized stroke lying almost entirely on a recognised line.
    let onLine = false;
    if (ratio < opts.textPointRatio && r.h <= 2 * medianH) {
      const lineCands = lineIndex.query(r);
      if (lineCands.length > 0) {
        let inLine = 0;
        let n = 0;
        for (let i = 0; i < pts.length; i += step) {
          n++;
          if (lineCands.some((c) => containsPoint(c.box, pts[i]))) inLine++;
        }
        onLine = n > 0 && inLine / n >= 0.85;
        if (onLine && hitsPerLine.size === 0) hitsPerLine.set(lineCands[0].lineIndex, 1);
      }
    }
    if (ratio >= opts.textPointRatio || (tiny && hits > 0) || onLine) {
      textStrokeIds.add(s.id);
      let best = -1;
      let bestHits = -1;
      for (const [li, h] of hitsPerLine) {
        if (h > bestHits) {
          best = li;
          bestHits = h;
        }
      }
      if (best >= 0) strokesOfLine[best].push(s.id);
    } else {
      nonTextStrokes.push(s);
    }
  }

  const sceneLines: SceneLine[] = usableLines.map((l, i) => ({ ...l, strokeIds: strokesOfLine[i] }));

  // ----- 2. Explicit diagram frames ---------------------------------------------------------
  const diagrams: DiagramItem[] = [];
  const claimed = new Set<string>();
  for (const f of diagramFrames) {
    const members = [...nonTextStrokes, ...shapeParts, ...strokes.filter((s) => textStrokeIds.has(s.id))].filter(
      (el) => el.frameId === f.el.id || containsPoint(f.rect, center(strokeRects.get(el.id) ?? elementRect(el))),
    );
    members.forEach((m) => claimed.add(m.id));
    diagrams.push({
      rect: f.rect,
      elementIds: members.map((m) => m.id),
      labels: [],
      frameId: f.el.id,
      frameName: frameTitle(f.el.name) ?? f.el.name ?? undefined,
    });
  }

  // ----- 3. Automatic diagram clustering ---------------------------------------------------
  const parts = [...nonTextStrokes, ...shapeParts].filter((el) => !claimed.has(el.id));
  const partRects = parts.map((el) => strokeRects.get(el.id) ?? elementRect(el));
  const groups = clusterRects(partRects, opts.diagramGap);
  const noiseStrokeIds: string[] = [];
  for (const g of groups) {
    const rect = unionAll(g.map((i) => partRects[i]));
    if (!rect) continue;
    const els = g.map((i) => parts[i]);
    const hasShape = els.some((el) => el.type !== "freedraw");
    const big =
      (rect.w >= opts.minDiagramSize && rect.h >= opts.minDiagramSize * 0.5) || Math.max(rect.w, rect.h) > opts.minDiagramSize * 2.5;
    if (!hasShape && !big) {
      els.forEach((el) => noiseStrokeIds.push(el.id));
      continue;
    }
    const isRule = !hasShape && rect.w >= 300 && rect.h <= Math.max(12, rect.w * 0.04);
    diagrams.push({ rect, elementIds: els.map((e) => e.id), labels: [], isRule: isRule || undefined });
  }

  // ----- 4. Absorb labels into diagrams and merge overlapping diagrams ------------------------
  let remainingLines = sceneLines.slice();
  let remainingTexts: TextItem[] = textEls.map((el) => ({
    id: el.id,
    text: elementText(el),
    rect: elementRect(el),
    fontSize: el.fontSize,
  }));
  const labelLines = new Map<DiagramItem, SceneLine[]>();
  const labelTexts = new Map<DiagramItem, TextItem[]>();
  // Labels are searched in the diagram's own area (not the area grown by earlier labels),
  // otherwise a diagram could swallow the paragraph below it line by line.
  const zones = new Map<DiagramItem, Rect>();
  for (const d of diagrams) zones.set(d, inflate(d.rect, opts.labelMargin));

  for (let iter = 0; iter < 6; iter++) {
    let changed = false;
    for (const d of diagrams) {
      if (d.isRule) continue;
      const zone = zones.get(d) ?? inflate(d.rect, opts.labelMargin);
      const keepLines: SceneLine[] = [];
      for (const l of remainingLines) {
        if (containsPoint(zone, center(l.box))) {
          const list = labelLines.get(d) ?? [];
          list.push(l);
          labelLines.set(d, list);
          if (!d.frameId) d.rect = union(d.rect, l.box);
          d.elementIds.push(...l.strokeIds);
          changed = true;
        } else keepLines.push(l);
      }
      remainingLines = keepLines;
      const keepTexts: TextItem[] = [];
      for (const t of remainingTexts) {
        if (containsPoint(zone, center(t.rect))) {
          const list = labelTexts.get(d) ?? [];
          list.push(t);
          labelTexts.set(d, list);
          if (!d.frameId) d.rect = union(d.rect, t.rect);
          d.elementIds.push(t.id);
          changed = true;
        } else keepTexts.push(t);
      }
      remainingTexts = keepTexts;
    }
    // merge overlapping automatic diagrams
    for (let i = 0; i < diagrams.length; i++) {
      for (let j = i + 1; j < diagrams.length; j++) {
        const a = diagrams[i];
        const b = diagrams[j];
        if (a.frameId || b.frameId || a.isRule || b.isRule) continue;
        if (!intersects(a.rect, b.rect)) continue;
        a.rect = union(a.rect, b.rect);
        zones.set(a, union(zones.get(a) ?? a.rect, zones.get(b) ?? b.rect));
        a.elementIds.push(...b.elementIds);
        labelLines.set(a, [...(labelLines.get(a) ?? []), ...(labelLines.get(b) ?? [])]);
        labelTexts.set(a, [...(labelTexts.get(a) ?? []), ...(labelTexts.get(b) ?? [])]);
        labelLines.delete(b);
        labelTexts.delete(b);
        diagrams.splice(j, 1);
        j--;
        changed = true;
      }
    }
    if (!changed) break;
  }

  for (const d of diagrams) {
    const labels: { y: number; x: number; text: string }[] = [];
    for (const l of labelLines.get(d) ?? []) labels.push({ y: l.box.y, x: l.box.x, text: l.text });
    for (const t of labelTexts.get(d) ?? []) labels.push({ y: t.rect.y, x: t.rect.x, text: t.text });
    for (const id of d.elementIds) {
      for (const bound of boundTextByContainer.get(id) ?? []) {
        const el = elementById.get(id);
        labels.push({ y: el?.y ?? 0, x: el?.x ?? 0, text: bound });
      }
    }
    labels.sort((a, b) => a.y - b.y || a.x - b.x);
    d.labels = labels.map((l) => l.text.replace(/\s+/g, " ").trim()).filter(Boolean);
    d.elementIds = [...new Set(d.elementIds)];
  }

  // ----- 5. Pending (not yet recognised) ink -------------------------------------------------
  const pendingInk: PendingInk[] = [];
  if (pendingStrokes.length > 0) {
    const pRects = pendingStrokes.map((s) => strokeRects.get(s.id) ?? elementRect(s));
    const pg = clusterRects(pRects, 200);
    for (const g of pg) {
      const rect = unionAll(g.map((i) => pRects[i]));
      if (rect) pendingInk.push({ rect, strokeIds: g.map((i) => pendingStrokes[i].id) });
    }
  }

  return {
    pages,
    lines: remainingLines,
    texts: remainingTexts,
    diagrams,
    pendingInk,
    textStrokeIds,
    noiseStrokeIds,
  };
}

/** Index of the smallest page containing the point, or -1. */
export function pageIndexFor(pages: ReadonlyArray<PageInfo>, r: Rect): number {
  const c = center(r);
  let best = -1;
  let bestArea = Infinity;
  pages.forEach((p, i) => {
    if (containsPoint(p.rect, c) && area(p.rect) < bestArea) {
      best = i;
      bestArea = area(p.rect);
    }
  });
  return best;
}

/** Bottom-most y of the given rects (used to place new content below existing content). */
export function contentBottom(rects: ReadonlyArray<Rect>): number {
  return rects.reduce((acc, r) => Math.max(acc, bottom(r)), -Infinity);
}
