import type { SceneLine } from "./classify";
import { center, containsPoint, inflate, unionAll, type Rect } from "./geometry";

/**
 * Handwritten [[links]] made clickable on the ink page: the first stroke of a
 * recognised link carries the link (shown as a small link button next to it).
 */

export interface LinkTarget {
  strokeId: string;
  link: string;
}

// "[[x]]", "[ [x] ]", "[[x]" and "[x]]" – the same tolerance as normalizeWikilinks.
// (No lookbehind: older iOS WebViews cannot parse it.) The third form may start with
// one extra character before "[", which is skipped below.
const LINK_RE = /\[\s*\[\s*([^[\]\n]+?)\s*\]\s*\]|\[\[([^[\]\n]+?)\](?!\])|(^|[^[])\[([^[\]\n]+?)\]\]/g;

/** Find the stroke that should carry each handwritten link. */
export function findHandwrittenLinks(lines: ReadonlyArray<SceneLine>, strokeRects: ReadonlyMap<string, Rect>): LinkTarget[] {
  const out: LinkTarget[] = [];
  const used = new Set<string>();
  for (const line of lines) {
    if (line.words.length === 0 || !line.text.includes("[") || line.strokeIds.length === 0) continue;
    // character ranges of the words in the joined text
    let text = "";
    const ranges: Array<{ start: number; end: number; box: Rect }> = [];
    for (const w of line.words) {
      if (text) text += " ";
      ranges.push({ start: text.length, end: text.length + w.text.length, box: w.box });
      text += w.text;
    }
    LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LINK_RE.exec(text))) {
      const target = (m[1] ?? m[2] ?? m[4] ?? "").trim();
      if (!target) continue;
      const start = m.index + (m[4] !== undefined ? (m[3] ?? "").length : 0);
      const end = m.index + m[0].length;
      const boxes = ranges.filter((r) => r.start < end && r.end > start).map((r) => r.box);
      const area = unionAll(boxes);
      if (!area) continue;
      const zone = inflate(area, Math.max(3, area.h * 0.2));
      const carriers = line.strokeIds
        .filter((id) => !used.has(id))
        .map((id) => ({ id, r: strokeRects.get(id) }))
        .filter((s): s is { id: string; r: Rect } => !!s.r && containsPoint(zone, center(s.r)))
        .sort((a, b) => a.r.x - b.r.x);
      if (carriers.length === 0) continue;
      used.add(carriers[0].id);
      out.push({ strokeId: carriers[0].id, link: `[[${target}]]` });
    }
  }
  return out;
}
