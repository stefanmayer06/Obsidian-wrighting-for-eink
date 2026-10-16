import type { ExElement } from "../types/excalidraw";
import type { SceneLine } from "./classify";
import type { OcrWord } from "./ocrTypes";
import {
  absolutePoints,
  center,
  containsPoint,
  convexHull,
  distance,
  distanceToOutline,
  elementRect,
  GridIndex,
  inflate,
  insideConvex,
  polygonArea,
  polygonPerimeter,
  rectFromPoints,
  resample,
  right,
  unionAll,
  verticalOverlapRatio,
  type Pt,
  type Rect,
} from "./geometry";

/**
 * Hand-drawn checkboxes: a small square drawn in front of a line of handwriting turns the
 * line into a Markdown task ("- [ ] …"), and a tick or cross drawn into the box makes it a
 * done task ("- [x] …").
 *
 * OCR does not read drawn boxes (or reads them as "D", "O", "口" …), so they are
 * recognised from the shape of the strokes. Pure functions, unit tested.
 */

export interface BoxShape {
  rect: Rect;
  hull: Pt[];
  /** Share of the strokes lying on the outline (1 = a clean outline). */
  quality: number;
}

/** Above this isoperimetric quotient a shape is round (circle 1.0, square 0.785). */
const ROUNDNESS_MAX = 0.88;
const MAX_CANDIDATES = 6;
const DONE_MARK_RE = /^(?:\[[xX✓✔]\]|[☑☒✅✓✔])$/u;
const BULLET_WORD_RE = /^[-–—•·*]$/u;

const compact = (text: string): string => text.replace(/\s+/g, "");

/**
 * Do these strokes (as point lists) draw a box: a closed, hollow outline of a square,
 * rectangle or parallelogram? Circles, letters like "D" or "O", triangles, scribbles and
 * open shapes ("L", "[") are rejected.
 */
export function analyseBox(polylines: ReadonlyArray<ReadonlyArray<Pt>>): BoxShape | null {
  const rect = rectFromPoints(polylines.flat());
  if (!rect) return null;
  const minSide = Math.min(rect.w, rect.h);
  const maxSide = Math.max(rect.w, rect.h);
  if (!(minSide > 0) || minSide < 0.55 * maxSide) return null;
  const pts = polylines.flatMap((pl) => resample(pl, maxSide / 48));
  if (pts.length < 12) return null;
  const hull = convexHull(pts);
  if (hull.length < 4) return null;
  const hullArea = polygonArea(hull);
  const perimeter = polygonPerimeter(hull);
  if (!(perimeter > 0) || (4 * Math.PI * hullArea) / (perimeter * perimeter) > ROUNDNESS_MAX) return null;
  // four distinct corners that span (almost) the whole shape
  const extreme = (f: (p: Pt) => number) => hull.reduce((best, p) => (f(p) > f(best) ? p : best));
  const corners = [extreme((p) => -p.x - p.y), extreme((p) => p.x - p.y), extreme((p) => p.x + p.y), extreme((p) => p.y - p.x)];
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) if (distance(corners[i], corners[j]) < 0.35 * minSide) return null;
  }
  if (polygonArea(corners) < 0.85 * hullArea) return null;
  // an outline, not a filled scribble (a tick inside is tested separately)
  const quality = pts.filter((p) => distanceToOutline(p, hull) <= 0.13 * minSide).length / pts.length;
  if (quality < 0.85) return null;
  // closed: the strokes go all the way round
  const reach = 0.15 * minSide;
  const samples = resample([...hull, hull[0]], perimeter / 64);
  const covered = samples.filter((s) => pts.some((p) => distance(p, s) <= reach)).length;
  if (covered < 0.9 * samples.length) return null;
  return { rect, hull, quality };
}

/** Does a stroke reach into the box (a tick, a cross, a filled box)? */
export function entersBox(points: ReadonlyArray<Pt>, box: BoxShape): boolean {
  const c = center(box.rect);
  const inner = box.hull.map((p) => ({ x: c.x + (p.x - c.x) * 0.75, y: c.y + (p.y - c.y) * 0.75 }));
  const pts = resample(points, Math.max(box.rect.w, box.rect.h) / 48);
  const inside = pts.filter((p) => insideConvex(p, inner)).length;
  return inside >= 3 && inside >= 0.15 * pts.length;
}

export interface CheckboxContext {
  /** Recognised strokes (handwriting included: OCR sometimes reads a box as a letter). */
  strokes: ReadonlyArray<ExElement>;
  strokeRects: ReadonlyMap<string, Rect>;
  textStrokeIds: ReadonlySet<string>;
  /** Lines in such areas (diagram frames) are left alone. */
  skip?: (r: Rect) => boolean;
}

export interface CheckboxResult {
  lines: SceneLine[];
  /** Strokes that now belong to a task line (the boxes and their ticks). */
  claimed: Set<string>;
}

/** The word of a line whose (padded) box contains the point. */
function wordAt(line: SceneLine, p: Pt): OcrWord | undefined {
  let best: OcrWord | undefined;
  let bestD = Infinity;
  for (const w of line.words) {
    if (!containsPoint(inflate(w.box, Math.max(4, w.box.h * 0.2), Math.max(4, w.box.h * 0.35)), p)) continue;
    const d = distance(center(w.box), p);
    if (d < bestD) {
      best = w;
      bestD = d;
    }
  }
  return best;
}

const popcount = (n: number): number => {
  let c = 0;
  for (let m = n; m; m &= m - 1) c++;
  return c;
};

/**
 * Turn lines with a hand-drawn box in front of them into tasks. The task marker becomes
 * the first word of the line ("[ ]" / "[x]"), so the layout formats it like a written "[ ]".
 */
export function detectCheckboxes(lines: ReadonlyArray<SceneLine>, ctx: CheckboxContext): CheckboxResult {
  const out: Array<SceneLine | null> = [...lines];
  const claimed = new Set<string>();
  if (lines.length === 0 || ctx.strokes.length === 0) return { lines: [...lines], claimed };

  const rectOf = (s: ExElement) => ctx.strokeRects.get(s.id) ?? elementRect(s);
  const heights = lines.map((l) => l.box.h).filter((h) => h > 0);
  const index = new GridIndex<ExElement>(Math.max(40, 2 * (heights.length > 0 ? Math.min(...heights) : 30)));
  for (const s of ctx.strokes) index.insert(rectOf(s), s);
  const lineOf = new Map<string, number>();
  lines.forEach((l, i) => l.strokeIds.forEach((id) => lineOf.set(id, i)));
  const pointCache = new Map<string, Pt[]>();
  const pointsOf = (s: ExElement): Pt[] => {
    let p = pointCache.get(s.id);
    if (!p) pointCache.set(s.id, (p = absolutePoints(s)));
    return p;
  };
  /** The word a recognised stroke was read as. */
  const wordOfStroke = (s: ExElement): OcrWord | undefined => {
    const owner = lineOf.get(s.id);
    const ownerLine = owner === undefined ? null : out[owner];
    return ownerLine ? wordAt(ownerLine, center(rectOf(s))) : undefined;
  };

  const order = lines.map((_, i) => i).sort((a, b) => lines[a].box.y - lines[b].box.y || lines[a].box.x - lines[b].box.x);
  for (const li of order) {
    const line = out[li];
    if (!line) continue;
    const H = line.box.h;
    if (!(H > 0) || ctx.skip?.(line.box)) continue;
    const words = [...line.words].sort((a, b) => a.box.x - b.box.x);
    const first: OcrWord | undefined = words[0];
    const firstShort = words.length >= 2 && compact(first.text).length <= 3;
    const zoneLeft = line.box.x - 3.2 * H;
    const zoneRight = (firstShort ? right(first.box) : line.box.x) + 0.35 * H;
    const zone: Rect = { x: zoneLeft, y: line.box.y - 0.6 * H, w: zoneRight - zoneLeft, h: H * 2.2 };

    const isCandidate = (s: ExElement): boolean => {
      if (claimed.has(s.id)) return false;
      const r = rectOf(s);
      const size = Math.max(r.w, r.h);
      if (size > 2.8 * H || size < 0.3 * H || !containsPoint(zone, center(r))) return false;
      if (!ctx.textStrokeIds.has(s.id)) return true;
      // read as handwriting: only if OCR made a short "word" of it ("D", "口", "[x]" …)
      const w = wordOfStroke(s);
      if (!w || compact(w.text).length > 3 || !containsPoint(zone, center(w.box))) return false;
      return lineOf.get(s.id) !== li || w === first;
    };
    const lineStart = { x: line.box.x, y: line.box.y + H / 2 };
    const cands = index
      .query(zone)
      .filter(isCandidate)
      .sort((a, b) => distance(center(rectOf(a)), lineStart) - distance(center(rectOf(b)), lineStart))
      .slice(0, MAX_CANDIDATES);
    if (cands.length === 0) continue;

    // the strokes that draw the box: the cleanest outline, then the most strokes (a box in two strokes)
    let best: { box: BoxShape; mask: number } | null = null;
    for (let mask = 1; mask < 1 << cands.length; mask++) {
      const box = analyseBox(cands.filter((_, i) => mask & (1 << i)).map(pointsOf));
      if (!box) continue;
      if (
        !best ||
        box.quality > best.box.quality + 0.01 ||
        (box.quality >= best.box.quality - 0.01 && popcount(mask) > popcount(best.mask))
      ) {
        best = { box, mask };
      }
    }
    if (!best) continue;
    const found = best;
    const B = found.box.rect;
    if (verticalOverlapRatio(B, line.box) < 0.5 || B.h < 0.35 * H || B.h > 2.6 * H) continue;
    const boxIds = new Set(cands.filter((_, i) => found.mask & (1 << i)).map((s) => s.id));

    // words that are OCR's reading of the box or the tick
    const strip = inflate(B, 0.15 * B.h);
    // (as big as the box – a smaller word in it is a label)
    const isBoxWord = (w: OcrWord) =>
      compact(w.text).length <= 3 && containsPoint(strip, center(w.box)) && (w.box.h >= 0.6 * B.h || w.box.w >= 0.6 * B.w);
    const textWords = words.filter((w) => !isBoxWord(w));
    if (words.length > 0 && textWords.length === 0) continue;
    const textStart = textWords.length > 0 ? Math.min(...textWords.map((w) => w.box.x)) : line.box.x;
    if (B.x >= textStart || right(B) > textStart + 0.35 * H || textStart - right(B) > 3 * H) continue;

    // handwriting inside the box (a label in a diagram box) – not a checkbox
    const inBox = index.query(B).filter((s) => !boxIds.has(s.id) && !claimed.has(s.id));
    const labelInside = inBox.some((s) => {
      if (!ctx.textStrokeIds.has(s.id) || !containsPoint(B, center(rectOf(s)))) return false;
      const w = wordOfStroke(s);
      return !w || !isBoxWord(w);
    });
    if (labelInside) continue;

    const tickIds = inBox
      .filter((s) => {
        const r = rectOf(s);
        if (Math.max(r.w, r.h) < 0.25 * Math.min(B.w, B.h)) return false; // a dot is not a tick
        if (ctx.textStrokeIds.has(s.id)) {
          const w = wordOfStroke(s);
          if (!w || !isBoxWord(w)) return false; // handwriting next to the box
        }
        return entersBox(pointsOf(s), found.box);
      })
      .map((s) => s.id);
    const done = tickIds.length > 0 || words.some((w) => isBoxWord(w) && DONE_MARK_RE.test(compact(w.text)));

    // the task line: marker + the rest of the line
    const stripped = textWords.length < words.length;
    let rest = textWords;
    if (rest.length > 1 && BULLET_WORD_RE.test(rest[0].text.trim())) rest = rest.slice(1);
    const restText = (stripped || rest !== textWords ? rest.map((w) => w.text).join(" ") : line.text).trim();
    if (!restText) continue;
    const marker = done ? "[x]" : "[ ]";
    const textBox = stripped ? (unionAll(textWords.map((w) => w.box)) ?? line.box) : line.box;
    const left = Math.min(B.x, textBox.x);
    const ids = [...boxIds, ...tickIds];
    const idSet = new Set(ids);
    out[li] = {
      ...line,
      text: `${marker} ${restText}`,
      words: line.words.length > 0 ? [{ text: marker, confidence: 1, box: B }, ...rest] : [],
      box: { x: left, y: textBox.y, w: right(textBox) - left, h: textBox.h },
      strokeIds: [...line.strokeIds.filter((id) => !idSet.has(id)), ...ids],
    };

    // other lines that were OCR's reading of the box or tick
    for (let oi = 0; oi < out.length; oi++) {
      const other = out[oi];
      if (!other || oi === li) continue;
      const keep = other.words.filter((w) => !isBoxWord(w));
      const hasIds = other.strokeIds.some((id) => idSet.has(id));
      if (!hasIds && keep.length === other.words.length) continue;
      const strokeIds = other.strokeIds.filter((id) => !idSet.has(id));
      if ((other.words.length > 0 && keep.length === 0) || (other.words.length === 0 && strokeIds.length === 0)) {
        out[oi] = null;
      } else if (keep.length === other.words.length) {
        out[oi] = { ...other, strokeIds };
      } else {
        out[oi] = { ...other, text: keep.map((w) => w.text).join(" "), words: keep, box: unionAll(keep.map((w) => w.box)) ?? other.box, strokeIds };
      }
    }
    ids.forEach((id) => claimed.add(id));
  }
  return { lines: out.filter((l): l is SceneLine => !!l), claimed };
}
