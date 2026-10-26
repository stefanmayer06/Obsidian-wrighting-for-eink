/**
 * Papers from arXiv: reading the arXiv API (Atom) and the trending list of
 * Hugging Face Papers (JSON), turning what the user types into an arXiv
 * query, and the text page made for an imported paper. Pure functions – the
 * Obsidian side does the requests (obsidian/papers.ts).
 */

export interface Paper {
  /** arXiv id as given by the source, with version if any ("2405.03150v2"). */
  id: string;
  title: string;
  authors: string[];
  /** The abstract, on one line. */
  summary: string;
  /** Date of the first version, YYYY-MM-DD ("" if unknown). */
  published: string;
  categories: string[];
  absUrl: string;
  pdfUrl: string;
  /** Upvotes on Hugging Face Papers (only for the popular list). */
  upvotes?: number;
  comment?: string;
  journalRef?: string;
  doi?: string;
}

export interface PaperPage {
  /** Number of matching papers (arXiv), or -1 when unknown. */
  total: number;
  papers: Paper[];
}

export class ArxivError extends Error {}

// ------------------------------------------------------------------ ids

const NEW_ID = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;
const OLD_ID = /\b([a-z][a-z-]*(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/;

/** The id without its version ("2405.03150v2" → "2405.03150"). */
export function baseArxivId(id: string): string {
  return id.trim().replace(/v\d+$/, "");
}

/**
 * An arXiv id in what the user typed or pasted: "2405.03150", "arXiv:2405.03150v2",
 * "https://arxiv.org/abs/2405.03150", ".../pdf/2405.03150v2.pdf", "hep-th/9901001".
 * Null for anything else (a search).
 */
export function arxivIdFrom(text: string): string | null {
  const t = text.trim();
  const url = /^(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/i.exec(t);
  const candidate = url ? url[1] : t.replace(/^arxiv:\s*/i, "");
  for (const re of [NEW_ID, OLD_ID]) {
    const m = new RegExp(`^${re.source}$`).exec(candidate);
    if (m) return m[1] + (m[2] ?? "");
  }
  return null;
}

// ------------------------------------------------------------------ queries

const FIELD = /^(ti|au|abs|co|jr|cat|rn|id|all):/i;

/**
 * The arXiv `search_query` for what the user typed: every word must match
 * (anywhere in the paper's record); "quoted phrases" stay together, and
 * field prefixes (au:, ti:, cat:, …) are passed on as typed.
 */
export function arxivSearchQuery(text: string): string {
  const parts: string[] = [];
  const re = /(\w+:)?"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[2] !== undefined) {
      const phrase = m[2].replace(/[()]/g, " ").trim().replace(/\s+/g, " ");
      if (!phrase) continue;
      const field = m[1] && FIELD.test(m[1]) ? m[1].toLowerCase() : "all:";
      parts.push(`${field}"${phrase}"`);
    } else {
      const word = m[3];
      if (FIELD.test(word)) {
        const [field, ...rest] = word.split(":");
        const value = rest.join(":").replace(/[()"]/g, "");
        if (value) parts.push(`${field.toLowerCase()}:${value}`);
        continue;
      }
      const clean = word.replace(/[()"]/g, "").replace(/^[-–—:;,.]+|[:;,.]+$/g, "");
      if (!clean || /^(and|or|andnot)$/i.test(clean)) continue;
      parts.push(`all:${clean}`);
    }
  }
  return parts.join(" AND ");
}

/** URL of an arXiv API request for what the user typed (an id or a search). */
export function arxivApiUrl(base: string, text: string, start: number, max: number): string {
  const id = arxivIdFrom(text);
  const params = id
    ? `id_list=${encodeURIComponent(id)}`
    : `search_query=${encodeURIComponent(arxivSearchQuery(text))}&sortBy=relevance&sortOrder=descending`;
  return `${base}?${params}&start=${start}&max_results=${max}`;
}

// ------------------------------------------------------------------ the arXiv API (Atom)

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/** Text of the first <tag>, decoded and on one line. */
function field(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? oneLine(decode(m[1])) : "";
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[m[1]] = decode(m[3] ?? m[4] ?? "");
  return out;
}

/** Older answers link to http://arxiv.org/… */
const https = (url: string) => url.replace(/^http:\/\/(?=(?:[\w-]+\.)*arxiv\.org\/)/, "https://");

/** The papers of an arXiv API answer. Throws ArxivError when arXiv reports an error. */
export function parseArxivFeed(xml: string): PaperPage {
  const papers: Paper[] = [];
  for (const m of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const idUrl = field(e, "id");
    if (/\/api\/errors/.test(idUrl)) throw new ArxivError(`arXiv: ${field(e, "summary") || "the request was not understood"}`);
    const id = /arxiv\.org\/abs\/(.+)$/.exec(idUrl)?.[1] ?? idUrl;
    if (!id) continue;
    const links = [...e.matchAll(/<link\b([^>]*)>/g)].map((l) => attrs(l[1]));
    const pdf = links.find((l) => l.title === "pdf" || l.type === "application/pdf")?.href;
    const abs = links.find((l) => l.rel === "alternate")?.href;
    const categories = [...e.matchAll(/<category\b([^>]*)>/g)].map((c) => attrs(c[1]).term).filter(Boolean);
    const primary = /<arxiv:primary_category\b([^>]*)>/.exec(e);
    const primaryTerm = primary ? attrs(primary[1]).term : "";
    if (primaryTerm && categories[0] !== primaryTerm) {
      const i = categories.indexOf(primaryTerm);
      if (i > 0) categories.splice(i, 1);
      if (i !== 0) categories.unshift(primaryTerm);
    }
    papers.push({
      id,
      title: field(e, "title"),
      authors: [...e.matchAll(/<author\b[^>]*>[\s\S]*?<name>([\s\S]*?)<\/name>/g)].map((a) => oneLine(decode(a[1]))).filter(Boolean),
      summary: field(e, "summary"),
      published: field(e, "published").slice(0, 10),
      categories,
      absUrl: https(abs ?? `https://arxiv.org/abs/${id}`),
      pdfUrl: https(pdf ?? `https://arxiv.org/pdf/${id}`),
      comment: field(e, "arxiv:comment") || undefined,
      journalRef: field(e, "arxiv:journal_ref") || undefined,
      doi: field(e, "arxiv:doi") || undefined,
    });
  }
  const total = parseInt(field(xml, "opensearch:totalResults"), 10);
  return { total: Number.isFinite(total) ? total : papers.length, papers };
}

// ------------------------------------------------------------------ Hugging Face Papers (popular)

/** Papers of the Hugging Face "daily papers" API (the trending list); `site` is arXiv's web site. */
export function parseHfPapers(data: unknown, site = "https://arxiv.org"): Paper[] {
  if (!Array.isArray(data)) throw new ArxivError("The list of popular papers could not be read.");
  const out: Paper[] = [];
  for (const item of data) {
    const p = (item && typeof item === "object" && "paper" in item ? (item as { paper: unknown }).paper : item) as Record<string, unknown> | null;
    if (!p || typeof p !== "object") continue;
    const id = typeof p.id === "string" ? p.id : "";
    if (!arxivIdFrom(id)) continue;
    const top = item as Record<string, unknown>;
    const title = typeof p.title === "string" ? p.title : typeof top.title === "string" ? top.title : "";
    const summary = typeof p.summary === "string" ? p.summary : typeof top.summary === "string" ? top.summary : "";
    const authors = Array.isArray(p.authors)
      ? p.authors.map((a) => (a && typeof a === "object" && typeof (a as { name?: unknown }).name === "string" ? (a as { name: string }).name : "")).filter(Boolean)
      : [];
    out.push({
      id,
      title: oneLine(title),
      authors,
      summary: oneLine(summary),
      published: typeof p.publishedAt === "string" ? p.publishedAt.slice(0, 10) : "",
      categories: [],
      absUrl: `${site}/abs/${id}`,
      pdfUrl: `${site}/pdf/${id}`,
      upvotes: typeof p.upvotes === "number" ? p.upvotes : undefined,
    });
  }
  return out;
}

// ------------------------------------------------------------------ the imported paper

/** "Ada Lovelace, Alan Turing, Grace Hopper et al." */
export function shortAuthors(authors: ReadonlyArray<string>, max = 3): string {
  if (authors.length === 0) return "Unknown authors";
  if (authors.length <= max) return authors.join(", ");
  return `${authors.slice(0, max).join(", ")} et al.`;
}

/** A file name for a paper: its title without characters files cannot have, not too long. */
export function paperFileName(title: string): string {
  let name = oneLine(title)
    .replace(/\$([^$]*)\$/g, "$1")
    .replace(/\\[a-zA-Z]+\s*/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s*:\s*/g, " - ")
    .replace(/[\\/*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s-]+|[.\s]+$/g, "");
  if (name.length > 100) {
    const cut = name.slice(0, 100);
    const space = cut.lastIndexOf(" ");
    name = (space > 60 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "");
  }
  return name || "Paper";
}

/** Properties of the text page of an imported paper. */
export function paperFrontmatter(p: Paper): Record<string, string | string[]> {
  const fm: Record<string, string | string[]> = {
    title: p.title,
    authors: p.authors,
    arxiv: p.id,
    url: p.absUrl,
  };
  if (p.published) fm.published = p.published;
  if (p.categories.length) fm.categories = p.categories;
  if (p.doi) fm.doi = p.doi;
  return fm;
}

/** The start of the text page of an imported paper: who wrote it, where it is, the abstract. */
export function paperNoteBody(p: Paper): string {
  const facts = [shortAuthors(p.authors, 6), p.published, `[arXiv:${p.id}](${p.absUrl})`].filter(Boolean).join(" · ");
  const lines = [facts];
  if (p.journalRef) lines.push("", `*${p.journalRef}*`);
  // "<word" would start an HTML tag in Markdown; "p < 0.05" is fine as it is
  if (p.summary) lines.push("", "> [!abstract]- Abstract", `> ${p.summary.replace(/<(?=[a-zA-Z/!?])/g, "&lt;")}`);
  return lines.join("\n");
}
