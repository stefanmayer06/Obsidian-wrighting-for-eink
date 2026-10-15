import type { ClassifiedScene, DiagramItem, PageInfo, PendingInk, SceneLine, TextItem } from "./classify";
import { pageIndexFor } from "./classify";
import { center, median, verticalOverlapRatio, type Rect } from "./geometry";
import { shortHash } from "./hash";
import {
  classifyLine,
  commentSafe,
  formatLine,
  joinParagraphLines,
  lineTextWithHighlights,
  normalizeWikilinks,
} from "./markdownFormat";

/**
 * Turns a classified scene into ordered Markdown blocks for the text page.
 * Each block has a stable key so user edits can be preserved (see transcript.ts).
 */

export interface TranscriptBlock {
  key: string;
  md: string;
}

export interface LayoutOptions {
  /** Link text of the drawing, used for embeds (e.g. "Notes/My page.excalidraw"). */
  drawingLink: string;
  /** Words below this confidence are highlighted with ==…== (0 disables). */
  highlightThreshold: number;
  /** A single short line this much taller than the median line becomes a heading. */
  headingRatio: number;
  /** Lines closer than this many line heights are joined into one paragraph. */
  paragraphGapRatio: number;
  diagramMinWidth: number;
  diagramMaxWidth: number;
  /** Link text for a vault path (used for PDF page headings). */
  linkFor: (path: string) => string;
}

export const DEFAULT_LAYOUT_OPTIONS: Omit<LayoutOptions, "drawingLink" | "linkFor"> = {
  highlightThreshold: 0,
  headingRatio: 1.6,
  paragraphGapRatio: 0.9,
  diagramMinWidth: 160,
  diagramMaxWidth: 720,
};

/** How a diagram can be embedded: `area=<id>` / `frame=<id>`, or null if no reference exists yet. */
export type DiagramRefResolver = (d: DiagramItem) => string | null;

type Item =
  | { kind: "line"; rect: Rect; line: SceneLine }
  | { kind: "text"; rect: Rect; text: TextItem }
  | { kind: "diagram"; rect: Rect; diagram: DiagramItem }
  | { kind: "pending"; rect: Rect; pending: PendingInk };

interface Section {
  page: PageInfo | null;
  items: Item[];
}

function embedWidth(d: DiagramItem, opts: LayoutOptions): number {
  return Math.round(Math.min(opts.diagramMaxWidth, Math.max(opts.diagramMinWidth, d.rect.w)));
}

function lineKey(lines: ReadonlyArray<SceneLine>, prefix: string): string {
  const ids = lines.flatMap((l) => l.strokeIds).sort();
  const basis = ids.length > 0 ? ids.join(",") : lines.map((l) => `${l.text}@${Math.round(l.box.x)},${Math.round(l.box.y)}`).join("|");
  return prefix + shortHash(basis, 8);
}

function stripHighlightsInLinks(md: string): string {
  return md.replace(/\[\[([^\]]*)\]\]/g, (_m, inner: string) => `[[${inner.replace(/==/g, "")}]]`);
}

function cleanLine(text: string): string {
  return stripHighlightsInLinks(normalizeWikilinks(text));
}

/** Build a page embed for pending/unknown ink. */
function pageEmbed(page: PageInfo | null, opts: LayoutOptions): string {
  if (!page) return `![[${opts.drawingLink}]]`;
  const ref = page.kind === "frame" ? `frame=${page.id}` : `area=${page.id}`;
  return `![[${opts.drawingLink}#^${ref}|${opts.diagramMaxWidth}]]`;
}

function sectionHeading(page: PageInfo, opts: LayoutOptions): string | null {
  if (page.kind === "pdf" && page.pdfPath && page.pdfPage) {
    return `### [[${opts.linkFor(page.pdfPath)}#page=${page.pdfPage}|Page ${page.pdfPage}]]`;
  }
  if (page.kind === "frame" && page.title) return `### ${page.title}`;
  return null;
}

function sortItems(items: Item[]): Item[] {
  // Primary order: vertical centre; items on the same row (overlapping vertically) go left to right.
  const sorted = [...items].sort((a, b) => center(a.rect).y - center(b.rect).y || a.rect.x - b.rect.x);
  const rows: Item[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    const rowable = it.kind === "line" || it.kind === "text";
    if (row && rowable && row.every((r) => r.kind === "line" || r.kind === "text")) {
      const ref = row[row.length - 1];
      if (verticalOverlapRatio(ref.rect, it.rect) >= 0.6) {
        row.push(it);
        continue;
      }
    }
    rows.push([it]);
  }
  return rows.flatMap((r) => r.sort((a, b) => a.rect.x - b.rect.x));
}

export function layoutTranscript(
  scene: ClassifiedScene,
  resolveDiagram: DiagramRefResolver,
  opts: LayoutOptions,
): TranscriptBlock[] {
  const pages = [...scene.pages].sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  const sections: Section[] = pages.map((p) => ({ page: p, items: [] }));
  const loose: Section = { page: null, items: [] };
  const place = (it: Item) => {
    const idx = pageIndexFor(pages, it.rect);
    (idx >= 0 ? sections[idx] : loose).items.push(it);
  };
  scene.lines.forEach((line) => place({ kind: "line", rect: line.box, line }));
  scene.texts.forEach((text) => place({ kind: "text", rect: text.rect, text }));
  scene.diagrams.forEach((diagram) => place({ kind: "diagram", rect: diagram.rect, diagram }));
  scene.pendingInk.forEach((pending) => place({ kind: "pending", rect: pending.rect, pending }));

  const allSections = sections.filter((s) => s.items.length > 0);
  if (loose.items.length > 0) {
    const looseTop = Math.min(...loose.items.map((i) => i.rect.y));
    const firstPageTop = allSections.length > 0 && allSections[0].page ? allSections[0].page.rect.y : Infinity;
    if (looseTop < firstPageTop) allSections.unshift(loose);
    else allSections.push(loose);
  }

  const medianH = median(scene.lines.map((l) => l.box.h)) || 30;
  const enoughLinesForHeadings = scene.lines.length >= 3;
  const blocks: TranscriptBlock[] = [];

  for (const section of allSections) {
    if (section.page) {
      const heading = sectionHeading(section.page, opts);
      if (heading) blocks.push({ key: `h${shortHash(section.page.id, 8)}`, md: heading });
    }
    const items = sortItems(section.items);
    let pendingEmbedded = false;
    let i = 0;
    while (i < items.length) {
      const it = items[i];
      if (it.kind === "text") {
        const text = it.text.text.replace(/\r\n/g, "\n").trim();
        blocks.push({ key: `t${shortHash(`${it.text.id}\n${text}`, 8)}`, md: text });
        i++;
        continue;
      }
      if (it.kind === "diagram") {
        const d = it.diagram;
        if (d.isRule) {
          blocks.push({ key: `r${shortHash(d.elementIds.slice().sort().join(","), 8)}`, md: "---" });
          i++;
          continue;
        }
        const ref = resolveDiagram(d);
        const labels = d.labels.length > 0 ? `\n%% ${commentSafe(d.labels.join(" · "))} %%` : "";
        if (ref) {
          blocks.push({
            key: `d${shortHash(ref, 8)}`,
            md: `![[${opts.drawingLink}#^${ref}|${embedWidth(d, opts)}]]${labels}`,
          });
        } else if (!pendingEmbedded) {
          // No region reference available yet: show the page (or drawing) instead.
          pendingEmbedded = true;
          blocks.push({ key: `e${shortHash(section.page?.id ?? "drawing", 8)}`, md: pageEmbed(section.page, opts) + labels });
        }
        i++;
        continue;
      }
      if (it.kind === "pending") {
        if (!pendingEmbedded) {
          pendingEmbedded = true;
          blocks.push({ key: `e${shortHash(section.page?.id ?? "drawing", 8)}`, md: pageEmbed(section.page, opts) });
        }
        i++;
        continue;
      }

      // ---- handwriting lines: build a paragraph, list or heading ----
      const run: SceneLine[] = [it.line];
      const isList = classifyLine(it.line.text).kind !== "plain";
      let lastListX = it.line.box.x;
      let j = i + 1;
      while (j < items.length && items[j].kind === "line") {
        const prev = run[run.length - 1];
        const next = (items[j] as { line: SceneLine }).line;
        const sameRow = verticalOverlapRatio(prev.box, next.box) >= 0.6;
        const gap = next.box.y - (prev.box.y + prev.box.h);
        const aligned = next.box.x >= prev.box.x - 2.5 * medianH && next.box.x <= prev.box.x + 6 * medianH;
        const nextList = classifyLine(next.text).kind !== "plain";
        const nextIsTall = enoughLinesForHeadings && next.box.h >= opts.headingRatio * medianH;
        const prevIsTall = enoughLinesForHeadings && prev.box.h >= opts.headingRatio * medianH;
        const close = sameRow || (gap <= opts.paragraphGapRatio * medianH && aligned);
        if (!close || prevIsTall || nextIsTall) break;
        if (isList) {
          // Lists: list lines start new items; indented plain lines continue the current item.
          if (nextList) lastListX = next.box.x;
          else if (!(sameRow || next.box.x > lastListX + 0.6 * medianH)) break;
        } else if (nextList) {
          break;
        }
        run.push(next);
        j++;
      }
      blocks.push(renderLineRun(run, medianH, enoughLinesForHeadings, opts));
      i = j;
    }
  }
  return blocks;
}

function renderLineRun(run: SceneLine[], medianH: number, headingsAllowed: boolean, opts: LayoutOptions): TranscriptBlock {
  const texts = run.map((l) => lineTextWithHighlights(l, opts.highlightThreshold));
  const first = classifyLine(run[0].text);
  if (first.kind !== "plain") {
    // A list: list lines start items, other lines continue the previous item.
    const items: string[] = [];
    run.forEach((line, idx) => {
      const kind = classifyLine(texts[idx]);
      if (kind.kind !== "plain" || items.length === 0) items.push(formatLine(kind));
      else items[items.length - 1] = joinParagraphLines([items[items.length - 1], kind.text]);
    });
    return { key: lineKey(run, "l"), md: cleanLine(items.join("\n")) };
  }
  const joined = joinParagraphLines(texts.map((t) => t.trim()));
  if (headingsAllowed && run.length === 1 && run[0].box.h >= opts.headingRatio * medianH && joined.length <= 80) {
    const level = run[0].box.h >= opts.headingRatio * 1.5 * medianH ? "#" : "##";
    return { key: lineKey(run, "p"), md: `${level} ${cleanLine(joined.replace(/^#+\s*/, ""))}` };
  }
  return { key: lineKey(run, "p"), md: cleanLine(formatLine({ kind: "plain", text: joined })) };
}
