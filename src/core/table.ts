import type { ExElement } from "../types/excalidraw";
import type { SceneLine, TextItem } from "./classify";
import type { OcrWord } from "./ocrTypes";
import {
  absolutePoints,
  bottom,
  center,
  containsPoint,
  containsRect,
  distanceToSegment,
  elementRect,
  inflate,
  median,
  polylineLength,
  right,
  union,
  unionAll,
  UnionFind,
  verticalOverlapRatio,
  type Pt,
  type Rect,
} from "./geometry";

/**
 * Hand-drawn tables: long straight horizontal and vertical lines that cross each other
 * form a grid, and the handwriting in its cells becomes a Markdown table instead of a
 * picture. Rows come from the drawn row lines; where only the header is ruled off (a
 * "T-chart" or a table of values), every line of handwriting is a row.
 *
 * Pure functions, unit tested.
 */

export interface TableWord {
  text: string;
  confidence: number;
}

export interface TableItem {
  rect: Rect;
  elementIds: string[];
  /** rows → cells → words. The first row is the header; all rows have the same number of cells. */
  rows: TableWord[][][];
}

export interface TableContext {
  /** Strokes (and line shapes) that may be lines of a table. */
  candidates: ReadonlyArray<ExElement>;
  /** The other drawing parts: a big one inside a grid makes it a diagram rather than a table. */
  others: ReadonlyArray<ExElement>;
  strokeRects: ReadonlyMap<string, Rect>;
  /** Median height of the recognised lines. */
  medianH: number;
  /** Grids in such areas (diagram frames) are left alone. */
  skip?: (r: Rect) => boolean;
}

export interface TableResult {
  tables: TableItem[];
  /** The lines and text elements that are not part of a table. */
  lines: SceneLine[];
  texts: TextItem[];
  /** Elements that belong to a table now: its lines, small marks in it and the handwriting in it. */
  claimed: Set<string>;
  /** The table lines themselves. */
  gridIds: Set<string>;
}

interface Rule {
  id: string;
  horizontal: boolean;
  pts: Pt[];
  rect: Rect;
  /** Median position across the line: y of a horizontal line, x of a vertical one. */
  pos: number;
}

const MAX_TILT = (20 * Math.PI) / 180;
/** Words that are a table line read as a character. */
const VERTICAL_CHARS_RE = /^[|│┃¦‖lI1!/\\()[\]{}]+$/u;
const HORIZONTAL_CHARS_RE = /^[_\-–—−=~.]+$/u;
const PIPES_RE = /[|│┃¦‖]/gu;

const compact = (text: string): string => text.replace(/\s+/g, "");

/** A long, straight, roughly horizontal or vertical stroke. */
function ruleOf(el: ExElement, minLen: number): Rule | null {
  const pts = absolutePoints(el);
  if (pts.length < 2) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  if (chord < minLen) return null;
  const angle = Math.abs(Math.atan2(b.y - a.y, b.x - a.x));
  const fromHorizontal = Math.min(angle, Math.PI - angle);
  const horizontal = fromHorizontal <= Math.PI / 4;
  if ((horizontal ? fromHorizontal : Math.PI / 2 - fromHorizontal) > MAX_TILT) return null;
  if (polylineLength(pts) > 1.25 * chord) return null;
  let deviation = 0;
  for (const p of pts) deviation = Math.max(deviation, distanceToSegment(p, a, b));
  if (deviation > 0.12 * chord) return null;
  return { id: el.id, horizontal, pts, rect: elementRect(el), pos: median(pts.map((p) => (horizontal ? p.y : p.x))) };
}

/** Position of a line across its direction at `t` along it: y at x = t (horizontal), x at y = t (vertical). */
function crossAt(r: Rule, t: number): number {
  const along = (p: Pt) => (r.horizontal ? p.x : p.y);
  const across = (p: Pt) => (r.horizontal ? p.y : p.x);
  const hits: number[] = [];
  let lo = r.pts[0];
  let hi = r.pts[0];
  for (let i = 0; i < r.pts.length; i++) {
    const q = r.pts[i];
    if (along(q) < along(lo)) lo = q;
    if (along(q) > along(hi)) hi = q;
    if (i === 0) continue;
    const p = r.pts[i - 1];
    const a0 = along(p);
    const a1 = along(q);
    if (t < Math.min(a0, a1) || t > Math.max(a0, a1)) continue;
    const u = a1 === a0 ? 0 : (t - a0) / (a1 - a0);
    hits.push(across(p) + u * (across(q) - across(p)));
  }
  if (hits.length > 0) return median(hits);
  return t < along(lo) ? across(lo) : across(hi);
}

/** Where a horizontal and a vertical line cross (or nearly touch), or null. */
function crossing(h: Rule, v: Rule, tol: number): Pt | null {
  let y = crossAt(h, v.pos);
  const x = crossAt(v, y);
  y = crossAt(h, x);
  if (x < h.rect.x - tol || x > right(h.rect) + tol) return null;
  if (y < v.rect.y - tol || y > bottom(v.rect) + tol) return null;
  return { x, y };
}

interface Entry {
  col: number;
  band: number;
  box: Rect;
  text: string;
  confidence: number;
}

/** Group boxes into rows of text (top to bottom), each row left to right. */
function textRows<T extends { box: Rect }>(items: ReadonlyArray<T>): T[][] {
  const sorted = [...items].sort((a, b) => center(a.box).y - center(b.box).y);
  const rows: Array<{ box: Rect; items: T[] }> = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row && verticalOverlapRatio(row.box, it.box) >= 0.4) {
      row.items.push(it);
      row.box = union(row.box, it.box);
    } else {
      rows.push({ box: it.box, items: [it] });
    }
  }
  return rows.map((r) => r.items.sort((a, b) => a.box.x - b.box.x));
}

interface Grid {
  table: TableItem;
  lines: SceneLine[];
  texts: TextItem[];
  claimed: string[];
}

function buildGrid(
  members: ReadonlyArray<Rule>,
  lines: ReadonlyArray<SceneLine>,
  texts: ReadonlyArray<TextItem>,
  ctx: TableContext,
  H: number,
  tol: number,
): Grid | null {
  const hs = members.filter((m) => m.horizontal).sort((a, b) => a.pos - b.pos);
  const vs = members.filter((m) => !m.horizontal).sort((a, b) => a.pos - b.pos);
  const ext = unionAll(members.map((m) => m.rect));
  if (!ext || hs.length === 0 || vs.length === 0) return null;

  // Is there a column left of the first vertical line, a row above the first horizontal one …?
  const leftOpen = vs[0].pos - ext.x >= 0.8 * H;
  const rightOpen = right(ext) - vs[vs.length - 1].pos >= 0.8 * H;
  const topOpen = hs[0].pos - ext.y >= 0.6 * H;
  const colCount = vs.length - 1 + (leftOpen ? 1 : 0) + (rightOpen ? 1 : 0);
  if (colCount < 2) return null;
  // a "T-chart": the column headings are written above its only horizontal line
  const headerAbove = !topOpen && hs.length === 1;
  if (hs.length === 1 && vs.length === 1) {
    // one cross: a T-chart (the line near the top) – not coordinate axes or a plus sign
    const c = crossing(hs[0], vs[0], tol) ?? { x: vs[0].pos, y: hs[0].pos };
    const up = c.y - vs[0].rect.y;
    const down = bottom(vs[0].rect) - c.y;
    if (down < H || up > Math.max(1.5 * H, 0.4 * down)) return null;
  }

  const top = headerAbove ? ext.y - 1.4 * H : ext.y;
  const area: Rect = { x: ext.x, y: top, w: ext.w, h: bottom(ext) - top };
  const inArea = (b: Rect) => containsPoint(inflate(area, 0.5 * b.h, 0.35 * b.h), center(b));
  if (ctx.skip?.(area)) return null;

  const colAt = (p: Pt) => {
    let k = leftOpen ? 0 : -1;
    for (const v of vs) if (crossAt(v, p.y) < p.x) k++;
    return Math.max(0, Math.min(colCount - 1, k));
  };
  const bandAt = (p: Pt) => {
    let k = 0;
    for (const h of hs) if (crossAt(h, p.x) < p.y) k++;
    return k;
  };
  /** The word without the table lines OCR read into it ("|", "l", "—" …); null if nothing is left. */
  const cleanWord = (w: OcrWord): string | null => {
    const c = center(w.box);
    const onV = vs.some((v) => {
      const x = crossAt(v, c.y);
      return x >= w.box.x - 4 && x <= right(w.box) + 4;
    });
    const onH = hs.some((h) => {
      const y = crossAt(h, c.x);
      return y >= w.box.y - 4 && y <= bottom(w.box) + 4;
    });
    let text = w.text;
    if (onV) {
      if (w.box.h > 2.5 * H) return null;
      if (VERTICAL_CHARS_RE.test(compact(text)) && w.box.h >= 1.5 * w.box.w) return null;
      text = text.replace(PIPES_RE, "");
    }
    if (onH && HORIZONTAL_CHARS_RE.test(compact(text)) && w.box.w >= 1.5 * w.box.h) return null;
    text = text.replace(/\s+/g, " ").trim();
    return text || null;
  };

  // drawings inside the grid: small marks belong to it, anything bigger makes it a diagram
  const ruleIds = new Set(members.map((m) => m.id));
  const marks: string[] = [];
  const markArea = inflate(area, 0.5 * H);
  for (const el of ctx.others) {
    if (ruleIds.has(el.id)) continue;
    const r = ctx.strokeRects.get(el.id) ?? elementRect(el);
    if (!containsPoint(markArea, center(r))) continue;
    if ((el.type !== "freedraw" && el.type !== "line") || Math.max(r.w, r.h) > 1.5 * H) return null;
    marks.push(el.id);
  }

  // the handwriting and typed text in the cells
  const entries: Entry[] = [];
  const claimed: string[] = [...ruleIds, ...marks];
  const keptLines: SceneLine[] = [];
  const addEntry = (box: Rect, text: string | null, confidence: number) => {
    if (text) entries.push({ col: colAt(center(box)), band: bandAt(center(box)), box, text, confidence });
  };
  for (const line of lines) {
    if (line.words.length === 0) {
      if (!inArea(line.box)) keptLines.push(line);
      else {
        addEntry(line.box, line.text.replace(PIPES_RE, "").trim(), 1);
        claimed.push(...line.strokeIds);
      }
      continue;
    }
    const inside = line.words.filter((w) => inArea(w.box));
    if (inside.length === 0) {
      keptLines.push(line);
      continue;
    }
    inside.forEach((w) => addEntry(w.box, cleanWord(w), w.confidence));
    const outside = line.words.filter((w) => !inArea(w.box));
    if (outside.length === 0) {
      claimed.push(...line.strokeIds);
      continue;
    }
    // the line runs out of the table: keep the part outside
    const inIds = line.strokeIds.filter((id) => {
      const r = ctx.strokeRects.get(id);
      return !!r && inArea(r);
    });
    claimed.push(...inIds);
    keptLines.push({
      ...line,
      text: outside.map((w) => w.text).join(" "),
      words: outside,
      box: unionAll(outside.map((w) => w.box)) ?? line.box,
      strokeIds: line.strokeIds.filter((id) => !inIds.includes(id)),
    });
  }
  const keptTexts: TextItem[] = [];
  for (const t of texts) {
    if (!inArea(t.rect)) {
      keptTexts.push(t);
      continue;
    }
    addEntry(t.rect, t.text.replace(/\s+/g, " ").trim(), 1);
    claimed.push(t.id);
  }
  if (new Set(entries.map((e) => `${e.col}:${e.band}`)).size < 2) return null;

  // rows: the first ruled-off band is the header; below it every line of handwriting is a row
  const toRow = (es: ReadonlyArray<Entry>): TableWord[][] =>
    Array.from({ length: colCount }, (_, col) =>
      textRows(es.filter((e) => e.col === col))
        .flat()
        .map((e) => ({ text: e.text, confidence: e.confidence })),
    );
  const bands = [...new Set(entries.map((e) => e.band))].sort((a, b) => a - b);
  const rows: TableWord[][][] = [];
  if (bands.length >= 2) {
    rows.push(toRow(entries.filter((e) => e.band === bands[0])));
    for (const band of bands.slice(1)) for (const r of textRows(entries.filter((e) => e.band === band))) rows.push(toRow(r));
  } else {
    for (const r of textRows(entries)) rows.push(toRow(r));
  }

  const rect = unionAll([ext, ...entries.map((e) => e.box)]) ?? ext;
  return {
    table: { rect, elementIds: [...new Set(claimed)], rows },
    lines: keptLines,
    texts: keptTexts,
    claimed,
  };
}

/** Find hand-drawn tables; lines and text elements in them are taken out of `lines`/`texts`. */
export function detectTables(lines: ReadonlyArray<SceneLine>, texts: ReadonlyArray<TextItem>, ctx: TableContext): TableResult {
  const H = ctx.medianH > 0 ? ctx.medianH : 30;
  const tol = Math.max(12, 0.6 * H);
  const rules = ctx.candidates.map((el) => ruleOf(el, Math.max(60, 2.2 * H))).filter((r): r is Rule => !!r);
  const result: TableResult = { tables: [], lines: [...lines], texts: [...texts], claimed: new Set(), gridIds: new Set() };
  if (!rules.some((r) => r.horizontal) || !rules.some((r) => !r.horizontal)) return result;

  const uf = new UnionFind(rules.length);
  rules.forEach((h, i) => {
    if (!h.horizontal) return;
    rules.forEach((v, j) => {
      if (!v.horizontal && crossing(h, v, tol)) uf.union(i, j);
    });
  });
  const groups = uf
    .groups()
    .filter((g) => g.some((i) => rules[i].horizontal) && g.some((i) => !rules[i].horizontal))
    .sort((a, b) => b.length - a.length);
  const used = new Set<number>();
  for (const g of groups) {
    if (g.some((i) => used.has(i))) continue;
    const ext = unionAll(g.map((i) => rules[i].rect));
    if (!ext) continue;
    // row and column lines that do not quite touch the others
    const zone = inflate(ext, tol);
    const extra = rules
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => !g.includes(i) && !used.has(i) && containsRect(zone, r.rect) && (r.horizontal ? r.rect.w >= 0.5 * ext.w : r.rect.h >= 0.5 * ext.h));
    const memberIdx = [...g, ...extra.map((e) => e.i)];
    const grid = buildGrid(memberIdx.map((i) => rules[i]), result.lines, result.texts, ctx, H, tol);
    if (!grid) continue;
    memberIdx.forEach((i) => {
      used.add(i);
      result.gridIds.add(rules[i].id);
    });
    result.tables.push(grid.table);
    result.lines = grid.lines;
    result.texts = grid.texts;
    grid.claimed.forEach((id) => result.claimed.add(id));
  }
  // table lines OCR took for handwriting are no part of any line any more
  if (result.gridIds.size > 0) {
    result.lines = result.lines.map((l) =>
      l.strokeIds.some((id) => result.gridIds.has(id)) ? { ...l, strokeIds: l.strokeIds.filter((id) => !result.gridIds.has(id)) } : l,
    );
  }
  return result;
}
