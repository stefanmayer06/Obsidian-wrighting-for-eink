import { decompressFromBase64 } from "lz-string";
import { DEFAULT_PAPER, normalizePaperSpec, paperSize } from "../paper";
import { elementRect, absolutePoints } from "../geometry";
import { getInkData, type SceneElement } from "../scene";
import { emptyPage, makeStroke, q, qp, type Figure, type ImageItem, type InkFile, type Page, type Region, type Stroke, type TextBox } from "./model";
import { shapeFromDrag } from "./shapes";

/**
 * Converts ink pages made by earlier versions of Ink Notebook (which were
 * Excalidraw drawings) into notebooks: paper, PDF and image pages become pages;
 * strokes, shapes, text and images move onto the page they were on; the
 * diagram areas and handwritten links of the text page are kept.
 */

/** The Excalidraw scene stored in an `.excalidraw.md` file (plain or compressed JSON). */
export function readExcalidrawScene(md: string): { elements: SceneElement[]; files: Map<string, string> } | null {
  let json: string | null = null;
  const compressed = /```compressed-json\n([\s\S]*?)```/.exec(md);
  if (compressed) json = decompressFromBase64(compressed[1].replace(/[\r\n]/g, ""));
  else {
    const plain = /```json\n([\s\S]*?)```/.exec(md);
    if (plain) json = plain[1];
  }
  if (!json) return null;
  let scene: { elements?: unknown };
  try {
    scene = JSON.parse(json) as { elements?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(scene.elements)) return null;
  // "## Embedded Files" maps image file ids to vault paths
  const files = new Map<string, string>();
  const section = /## Embedded Files\n([\s\S]*?)(?:\n##|\n%%|$)/.exec(md);
  if (section) {
    for (const line of section[1].split("\n")) {
      const m = /^([A-Za-z0-9_-]+):\s*!?\[\[([^\]|#]+)/.exec(line.trim());
      if (m) files.set(m[1], m[2].trim());
    }
  }
  return { elements: (scene.elements as SceneElement[]).filter((e) => e && !e.isDeleted), files };
}

interface PageSlot {
  page: Page;
  x: number;
  y: number;
  strokes: Stroke[];
  texts: TextBox[];
  images: ImageItem[];
  figures: Figure[];
}

const PAGE_ROLES = new Set(["paper", "pdf-page", "image-page"]);

/** Visual width of an Excalidraw freedraw/line in page units. */
function widthOf(el: SceneElement): number {
  return Math.max(0.8, Math.round((el.strokeWidth ?? 1) * 1.8 * 10) / 10);
}

function colorOf(el: SceneElement): string {
  const c = el.strokeColor ?? "#000000";
  return /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : /^#[0-9a-f]{3}$/i.test(c) ? `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toLowerCase() : "#000000";
}

export function excalidrawToInk(elements: ReadonlyArray<SceneElement>, files: ReadonlyMap<string, string>): InkFile {
  // 1. the pages, top to bottom
  const slots: PageSlot[] = [];
  const pageEls = elements.filter((e) => PAGE_ROLES.has(getInkData(e)?.role ?? "")).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const el of pageEls) {
    const d = getInkData(el);
    const w = Math.max(10, Math.round(el.width));
    const h = Math.max(10, Math.round(el.height));
    let page: Page;
    if (d?.role === "pdf-page" && d.pdf) page = emptyPage({ kind: "pdf", path: d.pdf, page: d.page ?? 1 }, w, h);
    else if (d?.role === "image-page" && d.image) page = emptyPage({ kind: "image", path: d.image }, w, h);
    else page = emptyPage({ kind: "paper", paper: normalizePaperSpec(d?.paper ?? DEFAULT_PAPER) }, w, h);
    slots.push({ page: { ...page, id: el.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || page.id }, x: el.x, y: el.y, strokes: [], texts: [], images: [], figures: [] });
  }
  const content = elements.filter((e) => {
    const role = getInkData(e)?.role;
    return !PAGE_ROLES.has(role ?? "") && role !== "page-border" && role !== "typed" && role !== "region" && (e.opacity ?? 100) > 0;
  });
  if (slots.length === 0) {
    // a plain drawing: one page big enough for everything
    const rects = content.map((e) => elementRect(e));
    const minX = Math.min(0, ...rects.map((r) => r.x)) - 40;
    const minY = Math.min(0, ...rects.map((r) => r.y)) - 40;
    const maxX = Math.max(0, ...rects.map((r) => r.x + r.w));
    const maxY = Math.max(0, ...rects.map((r) => r.y + r.h));
    const size = paperSize(DEFAULT_PAPER);
    const page = emptyPage({ kind: "paper", paper: { ...DEFAULT_PAPER, style: "blank" } }, Math.max(size.width, Math.ceil(maxX - minX + 40)), Math.max(size.height, Math.ceil(maxY - minY + 40)));
    slots.push({ page, x: minX, y: minY, strokes: [], texts: [], images: [], figures: [] });
  }
  const slotFor = (el: SceneElement): PageSlot => {
    const r = elementRect(el);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    let best = slots[0];
    let bestD = Infinity;
    for (const s of slots) {
      const dx = Math.max(s.x - cx, 0, cx - (s.x + s.page.w));
      const dy = Math.max(s.y - cy, 0, cy - (s.y + s.page.h));
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  };

  // 2. the content, moved onto its page
  const handLinks: Record<string, string> = {};
  for (const el of content) {
    const slot = slotFor(el);
    const ox = slot.x;
    const oy = slot.y;
    const id = el.id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || undefined;
    if (el.type === "freedraw" || el.type === "line" || el.type === "arrow") {
      const pts = absolutePoints(el);
      if (pts.length === 0) continue;
      const pressures = el.pressures && el.pressures.length === pts.length ? el.pressures : null;
      const arr = new Float32Array(pts.length * 3);
      pts.forEach((p, i) => {
        arr[i * 3] = q(p.x - ox);
        arr[i * 3 + 1] = q(p.y - oy);
        arr[i * 3 + 2] = qp(pressures ? pressures[i] : 0.5);
      });
      const poly = el.type !== "freedraw";
      const stroke = makeStroke({
        id,
        pen: el.opacity !== undefined && el.opacity < 70 ? "marker" : "ballpoint",
        color: colorOf(el),
        width: widthOf(el),
        pts: arr,
        poly,
        arrow: el.type === "arrow" && (el as { endArrowhead?: unknown }).endArrowhead !== null,
      });
      slot.strokes.push(stroke);
      const mark = el.customData?.inkNotebookLink;
      if (typeof mark === "string" && el.link === mark) handLinks[stroke.id] = mark;
      continue;
    }
    if (el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond") {
      if (colorOf(el) === "#000000" && el.strokeColor === "transparent") continue;
      const kind = el.type === "rectangle" ? "rect" : el.type === "ellipse" ? "ellipse" : "diamond";
      const s = shapeFromDrag(kind, { x: el.x - ox, y: el.y - oy }, { x: el.x - ox + el.width, y: el.y - oy + el.height }, { pen: "ballpoint", color: colorOf(el), width: widthOf(el) });
      slot.strokes.push(id ? { ...s, id } : s);
      continue;
    }
    if (el.type === "text" && !el.containerId) {
      const text = el.rawText ?? el.originalText ?? el.text ?? "";
      if (!text.trim()) continue;
      slot.texts.push({ id: id ?? `t${slot.texts.length}`, x: q(el.x - ox), y: q(el.y - oy), w: Math.max(40, q(el.width + 8)), h: Math.max(10, q(el.height)), text, size: el.fontSize ?? 20, color: colorOf(el) });
      continue;
    }
    if (el.type === "image") {
      const src = files.get((el as { fileId?: string }).fileId ?? "");
      if (!src) continue;
      slot.images.push({ id: id ?? `i${slot.images.length}`, x: q(el.x - ox), y: q(el.y - oy), w: q(el.width), h: q(el.height), src });
      continue;
    }
    if ((el.type === "frame" || el.type === "magicframe") && /^\s*(diagram|figure|fig\.?|sketch|drawing|chart)/i.test(el.name ?? "")) {
      slot.figures.push({ id: id ?? `f${slot.figures.length}`, x: q(el.x - ox), y: q(el.y - oy), w: q(el.width), h: q(el.height) });
    }
  }

  // 3. diagram areas of the text page (their ids are kept, so the text page finds them)
  const regions: Region[] = [];
  for (const el of elements) {
    if (getInkData(el)?.role !== "region") continue;
    const slot = slotFor(el);
    regions.push({ id: el.id, page: slot.page.id, x: q(el.x - slot.x), y: q(el.y - slot.y), w: q(el.width), h: q(el.height) });
  }

  const pages = slots.map((s) => ({ ...s.page, strokes: s.strokes, texts: s.texts, images: s.images, figures: s.figures }));
  return { doc: { pages }, meta: { regions, handLinks } };
}
