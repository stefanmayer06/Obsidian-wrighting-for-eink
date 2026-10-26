import type { SceneElement } from "./scene";
import type { SceneLine, TextItem } from "./classify";
import type { OcrWord } from "./ocrTypes";
import {
  absolutePoints,
  bottom,
  center,
  containsPoint,
  containsRect,
  distance,
  elementRect,
  inflate,
  median,
  polylineLength,
  rectFromPoints,
  right,
  simplifyIndices,
  straightLineDirection,
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
  /** A placeholder for writing in the cell that OCR could not read. */
  unread?: boolean;
}

export interface TableItem {
  rect: Rect;
  elementIds: string[];
  /** rows → cells → words. The first row is the header; all rows have the same number of cells. */
  rows: TableWord[][][];
}

export interface TableContext {
  /** Strokes (and line shapes) that may be lines of a table. */
  candidates: ReadonlyArray<SceneElement>;
  /** The other drawing parts: a big one inside a grid makes it a diagram rather than a table. */
  others: ReadonlyArray<SceneElement>;
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
  /** The strokes that draw this line: a line may be drawn in pieces, a stroke may draw several lines. */
  ids: string[];
  horizontal: boolean;
  /** Points ordered along the line. */
  pts: Pt[];
  rect: Rect;
  /** Median position across the line: y of a horizontal line, x of a vertical one. */
  pos: number;
}

/** Words that are a table line read as a character. */
const VERTICAL_CHARS_RE = /^[|│┃¦‖lI1!/\\()[\]{}]+$/u;
const HORIZONTAL_CHARS_RE = /^[_\-–—−=~.]+$/u;
const PIPES_RE = /[|│┃¦‖]/gu;

const compact = (text: string): string => text.replace(/\s+/g, "");

/**
 * The straight table lines a stroke draws: the whole stroke, or each side when it turns
 * corners (a border drawn in one go, "Γ", "L", "⊔"). Handwriting and curves draw none.
 */
export function strokeLines(pts: ReadonlyArray<Pt>, minLen: number, lineHeight: number): Array<{ horizontal: boolean; pts: Pt[] }> {
  const whole = straightLineDirection(pts, minLen);
  if (whole) return [{ horizontal: whole === "h", pts: [...pts] }];
  const total = polylineLength(pts);
  if (total < 2 * minLen) return [];
  const minPiece = Math.max(40, 1.2 * lineHeight);
  const corners = simplifyIndices(pts, Math.max(6, 0.3 * lineHeight));
  const out: Array<{ horizontal: boolean; pts: Pt[] }> = [];
  let loose = 0;
  for (let k = 1; k < corners.length; k++) {
    const piece = pts.slice(corners[k - 1], corners[k] + 1);
    const dir = straightLineDirection(piece, minPiece);
    if (dir) out.push({ horizontal: dir === "h", pts: piece });
    else if (distance(piece[0], piece[piece.length - 1]) < minPiece) loose += polylineLength(piece);
    else return []; // a long piece that is no table line: a drawing
  }
  return out.length >= 2 && loose <= 0.2 * total ? out : [];
}

function makeRule(ids: string[], horizontal: boolean, pts: Pt[]): Rule {
  const along = (p: Pt) => (horizontal ? p.x : p.y);
  const ordered = along(pts[0]) <= along(pts[pts.length - 1]) ? pts : [...pts].reverse();
  return {
    ids,
    horizontal,
    pts: ordered,
    rect: rectFromPoints(ordered) ?? { x: ordered[0].x, y: ordered[0].y, w: 0, h: 0 },
    pos: median(ordered.map((p) => (horizontal ? p.y : p.x))),
  };
}

/** Join the pieces of a line drawn in several strokes (pen lifted at a crossing). */
function mergeCollinear(rules: ReadonlyArray<Rule>, lineHeight: number, tol: number): Rule[] {
  const out: Rule[] = [];
  for (const horizontal of [true, false]) {
    const start = (r: Rule) => (horizontal ? r.rect.x : r.rect.y);
    const end = (r: Rule) => (horizontal ? right(r.rect) : bottom(r.rect));
    const groups: Rule[][] = [];
    for (const r of rules.filter((x) => x.horizontal === horizontal).sort((a, b) => start(a) - start(b))) {
      const g = groups.find((members) =>
        members.some((m) => Math.abs(m.pos - r.pos) <= Math.max(8, 0.4 * lineHeight) && start(r) <= end(m) + tol && start(m) <= end(r) + tol),
      );
      if (g) g.push(r);
      else groups.push([r]);
    }
    for (const g of groups) {
      out.push(g.length === 1 ? g[0] : makeRule(g.flatMap((r) => r.ids), horizontal, g.flatMap((r) => r.pts)));
    }
  }
  return out;
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
  /** Writing OCR could not read. */
  unread?: boolean;
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

  // Other strokes in the grid: writing that OCR could not read stays cell content (shown as
  // "?"), marks on the lines belong to them; a curve or anything else running across the
  // lines, or a shape, makes the grid a diagram.
  const ruleIds = new Set(members.flatMap((m) => m.ids));
  const marks: string[] = [];
  const unread: Rect[] = [];
  const markArea = inflate(area, 0.5 * H);
  const across = Math.max(8, 0.35 * H);
  const lineNear = (r: Rect, margin: number) =>
    vs.some((v) => {
      const x = crossAt(v, center(r).y);
      return r.x < x - margin && right(r) > x + margin && bottom(r) > v.rect.y && r.y < bottom(v.rect);
    }) ||
    hs.some((h) => {
      const y = crossAt(h, center(r).x);
      return r.y < y - margin && bottom(r) > y + margin && right(r) > h.rect.x && r.x < right(h.rect);
    });
  for (const el of ctx.others) {
    if (ruleIds.has(el.id)) continue;
    const r = ctx.strokeRects.get(el.id) ?? elementRect(el);
    if (!containsPoint(markArea, center(r))) continue;
    if ((el.type !== "freedraw" && el.type !== "line") || lineNear(r, across)) return null;
    marks.push(el.id);
    if (Math.max(r.w, r.h) >= 0.4 * H && !lineNear(r, -0.15 * H)) unread.push(r);
  }

  // the handwriting and typed text in the cells
  const entries: Entry[] = [];
  const claimed: string[] = [...ruleIds, ...marks];
  const keptLines: SceneLine[] = [];
  const addEntry = (box: Rect, text: string | null, confidence: number) => {
    if (text) entries.push({ col: colAt(center(box)), band: bandAt(center(box)), box, text, confidence });
  };
  /** Strokes of a line that no word covers: OCR's line box spans cells it did not read. */
  const unreadStrokes = (line: SceneLine, ids: ReadonlyArray<string>) => {
    const boxes = line.words.map((w) => inflate(w.box, Math.max(4, w.box.h * 0.2), Math.max(4, w.box.h * 0.35)));
    for (const id of ids) {
      const r = ctx.strokeRects.get(id);
      if (!r || boxes.some((b) => containsPoint(b, center(r)))) continue;
      if (Math.max(r.w, r.h) >= 0.4 * H && !lineNear(r, -0.15 * H)) unread.push(r);
    }
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
      unreadStrokes(line, line.strokeIds);
      claimed.push(...line.strokeIds);
      continue;
    }
    // the line runs out of the table: keep the part outside
    const inIds = line.strokeIds.filter((id) => {
      const r = ctx.strokeRects.get(id);
      return !!r && inArea(r);
    });
    unreadStrokes(line, inIds);
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
  const bandRows = (es: ReadonlyArray<Entry>, split: boolean): Entry[][] => {
    const words = es.filter((e) => !e.unread);
    const rows = split ? textRows(words) : words.length > 0 ? [words] : [];
    // unread writing goes into the row it sits in, or into a row of its own
    for (const u of es.filter((e) => e.unread)) {
      const cy = center(u.box).y;
      let best: Entry[] | null = null;
      let bestD = split ? H : Infinity;
      for (const row of rows) {
        const box = unionAll(row.map((e) => e.box)) as Rect;
        const d = Math.max(0, box.y - cy, cy - bottom(box));
        if (d <= bestD) {
          best = row;
          bestD = d;
        }
      }
      if (best) best.push(u);
      else rows.push([u]);
    }
    return rows.sort((a, b) => Math.min(...a.map((e) => e.box.y)) - Math.min(...b.map((e) => e.box.y)));
  };
  const toRow = (es: ReadonlyArray<Entry>): TableWord[][] =>
    Array.from({ length: colCount }, (_, col) => {
      const inCell = es.filter((e) => e.col === col);
      const read = inCell.filter((e) => !e.unread);
      if (read.length === 0) return inCell.length > 0 ? [{ text: "?", confidence: 0, unread: true }] : [];
      return textRows(read)
        .flat()
        .map((e) => ({ text: e.text, confidence: e.confidence }));
    });
  for (const r of unread) entries.push({ col: colAt(center(r)), band: bandAt(center(r)), box: r, text: "?", confidence: 0, unread: true });
  const bands = [...new Set(entries.map((e) => e.band))].sort((a, b) => a - b);
  const rows: TableWord[][][] = [];
  if (bands.length >= 2) {
    rows.push(...bandRows(entries.filter((e) => e.band === bands[0]), false).map(toRow));
    for (const band of bands.slice(1)) rows.push(...bandRows(entries.filter((e) => e.band === band), true).map(toRow));
  } else {
    rows.push(...bandRows(entries, true).map(toRow));
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
  const minLen = Math.max(60, 2.2 * H);
  const rules = mergeCollinear(
    ctx.candidates.flatMap((el) => strokeLines(absolutePoints(el), minLen, H).map((l) => makeRule([el.id], l.horizontal, l.pts))),
    H,
    tol,
  );
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
      rules[i].ids.forEach((id) => result.gridIds.add(id));
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
