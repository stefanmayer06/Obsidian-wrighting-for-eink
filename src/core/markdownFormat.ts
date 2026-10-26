import type { OcrLine } from "./ocrTypes";

/**
 * Turning recognised handwriting into clean Markdown.
 * Everything here is deliberately conservative: when in doubt we keep the
 * recognised text as it is rather than guessing structure.
 */

/** Repair wiki links that OCR commonly breaks: "[ [Page] ]", "[[Page]", "[Page]]". */
export function normalizeWikilinks(text: string): string {
  let t = text;
  // "[ [ Page ] ]" -> "[[Page]]"
  t = t.replace(/\[\s*\[\s*([^[\]\n]+?)\s*\]\s*\]/g, "[[$1]]");
  // "[[Page]" (missing closing bracket, not followed by another ])
  t = t.replace(/\[\[([^[\]\n]+?)\](?!\])/g, "[[$1]]");
  // "[Page]]" (missing opening bracket, not preceded by another [)
  t = t.replace(/(^|[^[])\[([^[\]\n]+?)\]\]/g, "$1[[$2]]");
  // Fix the double-open introduced when both brackets were already right: "[[[Page]]" -> "[[Page]]"
  t = t.replace(/\[{3,}/g, "[[").replace(/\]{3,}/g, "]]");
  // OCR sometimes reads "|" inside links as "l" or "I" – leave untouched (ambiguous).
  return t;
}

export type LineKind =
  | { kind: "bullet"; text: string }
  | { kind: "number"; n: number; text: string }
  | { kind: "task"; done: boolean; text: string }
  | { kind: "plain"; text: string };

const BULLET_RE = /^\s*(?:[-–—•·∙●▪◦*>»→]|->)\s+(.+)$/u;
const NUMBER_RE = /^\s*(\d{1,3})\s*[.)]\s+(.+)$/;
const TASK_OPEN_RE = /^\s*(?:\[\s?\]|☐|□|❏|◻)\s*(.+)$/u;
const TASK_DONE_RE = /^\s*(?:\[\s?[xX✓✔]\s?\]|☑|☒|✅|✓|✔)\s*(.+)$/u;

export function classifyLine(text: string): LineKind {
  const t = text.trim();
  let m = TASK_DONE_RE.exec(t);
  if (m) return { kind: "task", done: true, text: m[1].trim() };
  m = TASK_OPEN_RE.exec(t);
  if (m) return { kind: "task", done: false, text: m[1].trim() };
  m = NUMBER_RE.exec(t);
  if (m) return { kind: "number", n: parseInt(m[1], 10), text: m[2].trim() };
  m = BULLET_RE.exec(t);
  if (m) return { kind: "bullet", text: m[1].trim() };
  return { kind: "plain", text: t };
}

export function isListLike(text: string): boolean {
  return classifyLine(text).kind !== "plain";
}

/**
 * Escape characters that would unintentionally change the meaning of a
 * recognised plain line in Markdown (e.g. a line starting with "1." or "#"
 * followed by a space is fine to keep, but a leading "=" or "|" could create
 * setext headings or tables).
 */
export function escapePlainLine(text: string): string {
  let t = text;
  if (/^(={2,}|-{3,})\s*$/.test(t)) t = `\\${t}`;
  if (/^\|/.test(t)) t = `\\${t}`;
  return t;
}

/** A word, highlighted with ==…== if its confidence is below the threshold (0 disables). */
export function wordWithHighlight(word: { text: string; confidence: number }, threshold: number): string {
  if (threshold <= 0 || word.confidence >= threshold || !/^[\p{L}\p{N}'’-]+[.,;:!?]?$/u.test(word.text)) return word.text;
  const m = /^(.*?)([.,;:!?]?)$/u.exec(word.text);
  const core = m ? m[1] : word.text;
  const punct = m ? m[2] : "";
  return core ? `==${core}==${punct}` : word.text;
}

/** Highlight words below the confidence threshold with ==…== marks. */
export function lineTextWithHighlights(line: OcrLine, threshold: number): string {
  if (threshold <= 0 || line.words.length === 0) return line.text;
  const joined = line.words.map((w) => w.text).join(" ");
  // Only rebuild from words when they reproduce the line (modulo spaces).
  if (joined.replace(/\s+/g, "") !== line.text.replace(/\s+/g, "")) return line.text;
  const parts = line.words.map((w) => wordWithHighlight(w, threshold));
  return parts.some((p, i) => p !== line.words[i].text) ? parts.join(" ") : line.text;
}

/** Join wrapped handwriting lines into one paragraph. */
export function joinParagraphLines(lines: ReadonlyArray<string>): string {
  let out = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) {
      out = line;
      continue;
    }
    // "Bei-" + "spiel" -> "Bei-spiel" (keep the hyphen; removing it would break real compounds)
    if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(line)) out += line;
    else out += ` ${line}`;
  }
  return out;
}

/** Format a list/task/plain line into Markdown. */
export function formatLine(kind: LineKind): string {
  switch (kind.kind) {
    case "bullet":
      return `- ${kind.text}`;
    case "number":
      return `${kind.n}. ${kind.text}`;
    case "task":
      return `- [${kind.done ? "x" : " "}] ${kind.text}`;
    default:
      return escapePlainLine(kind.text);
  }
}
