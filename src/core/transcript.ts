import { normalizeForHash, shortHash } from "./hash";
import type { TranscriptBlock } from "./layout";

/**
 * The handwriting transcript lives in a managed region of the text page:
 *
 *   %% ink-notebook:start %%
 *   …generated blocks (separated by blank lines)…
 *   %% ink-notebook:end v1 <state> %%
 *
 * Everything outside the region belongs to the user ("typed notes").
 * Inside the region, the user may still edit freely: corrections, deletions
 * and insertions are detected by comparing against the state saved in the end
 * marker, and are preserved when the transcript is regenerated.
 */

export const START_MARKER = "%% ink-notebook:start %%";
export const END_MARKER_PREFIX = "%% ink-notebook:end";

const START_RE = /^%%\s*ink-notebook:start\b.*%%\s*$/;
const END_RE = /^%%\s*ink-notebook:end\b(.*?)%%\s*$/;

export interface StateEntry {
  key: string;
  /** Hash of the generated Markdown for this key ("" for user insertions). */
  gen: string;
  /** Hash of what was written, or "-" if the user deleted the block. */
  emit: string;
}

export interface ParsedNote {
  /** Frontmatter including its --- fences and trailing newline, or "". */
  frontmatter: string;
  /** Text between frontmatter and region start (or the whole body if there is no region). */
  before: string;
  /** Text inside the region (between the marker lines). */
  inner: string;
  /** Text after the region end marker. */
  after: string;
  /** The region exactly as it appears in the note (marker lines included), or "". */
  regionRaw: string;
  hasRegion: boolean;
  /** Markers exist but are out of order / duplicated. */
  damaged: boolean;
  state: StateEntry[] | null;
}

export function blockHash(md: string): string {
  return shortHash(normalizeForHash(md), 6);
}

export function encodeState(entries: ReadonlyArray<StateEntry>): string {
  return entries.map((e) => `${e.key}.${e.gen || "_"}.${e.emit}`).join(" ");
}

export function decodeState(text: string): StateEntry[] | null {
  const t = text.trim();
  if (!t.startsWith("v1")) return null;
  const body = t.slice(2).trim();
  if (!body) return [];
  const out: StateEntry[] = [];
  for (const part of body.split(/\s+/)) {
    const m = /^([A-Za-z0-9_-]+)\.([0-9a-f]+|_)\.([0-9a-f]+|-)$/.exec(part);
    if (!m) return null;
    out.push({ key: m[1], gen: m[2] === "_" ? "" : m[2], emit: m[3] });
  }
  return out;
}

export function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  const text = md.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { frontmatter: "", body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { frontmatter: "", body: text };
  let close = end + 4;
  // the closing fence must be a full line
  if (text.length > close && text[close] !== "\n") return { frontmatter: "", body: text };
  if (text[close] === "\n") close++;
  return { frontmatter: text.slice(0, close), body: text.slice(close) };
}

export function parseNote(md: string): ParsedNote {
  const { frontmatter, body } = splitFrontmatter(md);
  const lines = body.split("\n");
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((l, i) => {
    if (START_RE.test(l.trim())) starts.push(i);
    else if (END_RE.test(l.trim())) ends.push(i);
  });
  if (starts.length === 0 && ends.length === 0) {
    return { frontmatter, before: body, inner: "", after: "", regionRaw: "", hasRegion: false, damaged: false, state: null };
  }
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    return { frontmatter, before: body, inner: "", after: "", regionRaw: "", hasRegion: false, damaged: true, state: null };
  }
  const s = starts[0];
  const e = ends[0];
  const m = END_RE.exec(lines[e].trim());
  return {
    frontmatter,
    before: lines.slice(0, s).join("\n"),
    inner: lines.slice(s + 1, e).join("\n"),
    after: lines.slice(e + 1).join("\n"),
    regionRaw: lines.slice(s, e + 1).join("\n"),
    hasRegion: true,
    damaged: false,
    state: m ? decodeState(m[1]) : null,
  };
}

/** Split region content into blocks separated by blank lines. Fenced code stays together. */
export function splitBlocks(inner: string): string[] {
  const blocks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  for (const line of inner.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (cur.length > 0) blocks.push(cur.join("\n"));
      cur = [];
    } else {
      cur.push(line.replace(/\s+$/, ""));
    }
  }
  if (cur.length > 0) blocks.push(cur.join("\n"));
  return blocks.map((b) => b.trim()).filter((b) => b.length > 0);
}

/** Longest common subsequence of two hash sequences; returns matched index pairs. */
function lcsPairs(a: ReadonlyArray<string>, b: ReadonlyArray<string>): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

export interface MergeResult {
  blocks: string[];
  state: StateEntry[];
  /** Number of user edits that were preserved (for diagnostics/notices). */
  preservedEdits: number;
}

const USER_PREFIX = "u";

/**
 * Merge newly generated blocks with the current region content, preserving the
 * user's corrections, deletions and insertions.
 */
export function mergeTranscript(
  currentInner: string,
  prevState: ReadonlyArray<StateEntry> | null,
  generated: ReadonlyArray<TranscriptBlock>,
): MergeResult {
  const cur = splitBlocks(currentInner);
  const curHashes = cur.map(blockHash);
  const prev = (prevState ?? []).filter((e) => e.emit !== "-");
  const prevDeleted = new Set((prevState ?? []).filter((e) => e.emit === "-").map((e) => e.key));

  // Generated keys may collide in pathological cases (same content twice) – make them unique.
  const seen = new Map<string, number>();
  const gen = generated.map((g) => {
    const n = seen.get(g.key) ?? 0;
    seen.set(g.key, n + 1);
    return n === 0 ? g : { key: `${g.key}${n}`, md: g.md };
  });
  const genKeys = new Set(gen.map((g) => g.key));

  const corrected = new Map<string, string>();
  const deleted = new Set<string>(prevDeleted);
  /** user blocks keyed by the key of the block they follow ("" = start) */
  const insertions = new Map<string, string[]>();
  const addInsertion = (anchor: string, text: string) => {
    const list = insertions.get(anchor) ?? [];
    list.push(text);
    insertions.set(anchor, list);
  };

  // 1. anchor exact matches (block unchanged since we wrote it)
  const pairs = lcsPairs(
    prev.map((e) => e.emit),
    curHashes,
  );
  const matchedPrev = new Set(pairs.map((p) => p[0]));
  const matchedCur = new Set(pairs.map((p) => p[1]));

  // Effective anchor of each previous entry: itself if it is a generated key, otherwise the
  // anchor of the generated key it followed.
  const anchorOfPrev: string[] = [];
  let lastGen = "";
  for (const e of prev) {
    if (!e.key.startsWith(USER_PREFIX)) lastGen = e.key;
    anchorOfPrev.push(e.key.startsWith(USER_PREFIX) ? lastGen : e.key);
  }

  // matched entries: user blocks stay as insertions; corrections stay corrected
  pairs.forEach(([pi, ci]) => {
    const e = prev[pi];
    if (e.key.startsWith(USER_PREFIX)) addInsertion(anchorOfPrev[pi], cur[ci]);
    else if (e.gen && e.gen !== e.emit) corrected.set(e.key, cur[ci]);
  });

  // 2. gaps between anchors: pair unmatched previous entries with unmatched current blocks
  const boundaries: Array<[number, number]> = [[-1, -1], ...pairs, [prev.length, cur.length]];
  for (let b = 0; b + 1 < boundaries.length; b++) {
    const [p0, c0] = boundaries[b];
    const [p1, c1] = boundaries[b + 1];
    const gapPrev: number[] = [];
    const gapCur: number[] = [];
    for (let i = p0 + 1; i < p1; i++) if (!matchedPrev.has(i)) gapPrev.push(i);
    for (let j = c0 + 1; j < c1; j++) if (!matchedCur.has(j)) gapCur.push(j);
    const pairCount = Math.min(gapPrev.length, gapCur.length);
    for (let k = 0; k < pairCount; k++) {
      const e = prev[gapPrev[k]];
      const text = cur[gapCur[k]];
      if (e.key.startsWith(USER_PREFIX)) addInsertion(anchorOfPrev[gapPrev[k]], text);
      else corrected.set(e.key, text);
    }
    for (let k = pairCount; k < gapPrev.length; k++) {
      const e = prev[gapPrev[k]];
      if (!e.key.startsWith(USER_PREFIX)) deleted.add(e.key);
    }
    const anchor = gapPrev.length > 0 ? anchorOfPrev[gapPrev[gapPrev.length - 1]] : p0 >= 0 ? anchorOfPrev[p0] : "";
    for (let k = pairCount; k < gapCur.length; k++) {
      const text = cur[gapCur[k]];
      // Without saved state, blocks identical to newly generated ones are not user insertions.
      if (!prevState && gen.some((g) => blockHash(g.md) === blockHash(text))) continue;
      addInsertion(anchor, text);
    }
  }

  // 3. emit
  const prevOrder = (prevState ?? []).map((e) => e.key);
  const resolveAnchor = (anchor: string): string => {
    if (anchor === "" || genKeys.has(anchor)) return anchor;
    // walk back through the previous order to the closest key that still exists
    const idx = prevOrder.indexOf(anchor);
    for (let i = idx - 1; i >= 0; i--) {
      const k = prevOrder[i];
      if (!k.startsWith(USER_PREFIX) && genKeys.has(k)) return k;
    }
    return "";
  };
  const resolvedInsertions = new Map<string, string[]>();
  for (const [anchor, texts] of insertions) {
    const a = resolveAnchor(anchor);
    resolvedInsertions.set(a, [...(resolvedInsertions.get(a) ?? []), ...texts]);
  }

  const blocks: string[] = [];
  const state: StateEntry[] = [];
  let preservedEdits = 0;
  const emitUser = (anchor: string) => {
    for (const text of resolvedInsertions.get(anchor) ?? []) {
      const h = blockHash(text);
      blocks.push(text);
      state.push({ key: `${USER_PREFIX}${h}`, gen: "", emit: h });
      preservedEdits++;
    }
  };
  emitUser("");
  for (const g of gen) {
    const genHash = blockHash(g.md);
    if (deleted.has(g.key)) {
      state.push({ key: g.key, gen: genHash, emit: "-" });
      preservedEdits++;
    } else if (corrected.has(g.key)) {
      const text = corrected.get(g.key) as string;
      blocks.push(text);
      state.push({ key: g.key, gen: genHash, emit: blockHash(text) });
      preservedEdits++;
    } else {
      blocks.push(g.md.trim());
      state.push({ key: g.key, gen: genHash, emit: genHash });
    }
    emitUser(g.key);
  }
  return { blocks, state, preservedEdits };
}

/** Render the full region (markers included). */
export function renderRegion(blocks: ReadonlyArray<string>, state: ReadonlyArray<StateEntry>): string {
  const body = blocks.join("\n\n");
  const end = `${END_MARKER_PREFIX} v1${state.length > 0 ? " " + encodeState(state) : ""} %%`;
  return `${START_MARKER}\n${body}${body ? "\n" : ""}${end}`;
}

function trimBlankEdges(text: string): string {
  return text.replace(/^\s*\n/, "").replace(/\n\s*$/, "");
}

/**
 * Replace (or create) the region in a note.
 * New regions are inserted at the top of the body (after frontmatter).
 */
export function writeRegion(md: string, blocks: ReadonlyArray<string>, state: ReadonlyArray<StateEntry>): string {
  const parsed = parseNote(md);
  const region = renderRegion(blocks, state);
  if (parsed.hasRegion) {
    const before = parsed.before;
    const after = parsed.after;
    return `${parsed.frontmatter}${before}${before && !before.endsWith("\n") ? "\n" : ""}${region}\n${after}`;
  }
  // No (valid) region: put it at the top; keep the existing body below as typed notes.
  const body = trimBlankEdges(parsed.before);
  return `${parsed.frontmatter}${region}\n\n${body}${body ? "\n" : ""}`;
}

/**
 * Remove any broken marker lines so that a damaged note can get a fresh region
 * without losing the user's text.
 */
export function stripMarkers(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => !START_RE.test(l.trim()) && !END_RE.test(l.trim()))
    .join("\n");
}
