import { Notice, normalizePath, TFile, type WorkspaceLeaf } from "obsidian";
import type InkNotebookPlugin from "../main";
import {
  ArxivError,
  arxivApiUrl,
  arxivIdFrom,
  arxivSearchQuery,
  baseArxivId,
  paperFileName,
  paperFrontmatter,
  paperNoteBody,
  parseArxivFeed,
  parseHfPapers,
  type Paper,
  type PaperPage,
} from "../core/arxiv";
import { joinPath, parentPath } from "../core/folders";
import { send } from "./azureClient";
import { FM_PDF, FM_TEXT_TO_DRAWING } from "./pairs";
import { addPdfPages, pdfPages, pickPages } from "./pdfAnnotate";
import { INK_VIEW_TYPE, type InkView } from "./inkView";

/**
 * Papers from arXiv: search arXiv, list popular papers (the trending list of
 * Hugging Face Papers), and import a paper – its PDF becomes the pages of an
 * ink page to write on, with a text page holding title, authors and abstract.
 */

export const PAPERS_PER_PAGE = 20;
/** arXiv asks API users to wait 3 seconds between requests. */
const ARXIV_SPACING_MS = 3000;

export class PaperService {
  /** Where papers come from (replaced by the end-to-end tests). */
  readonly endpoints = {
    arxivApi: "https://export.arxiv.org/api/query",
    arxivSite: "https://arxiv.org",
    popular: "https://huggingface.co/api/daily_papers",
  };
  private lastArxiv = 0;

  constructor(private plugin: InkNotebookPlugin) {}

  private async get(url: string, what: string, timeoutMs = 30000) {
    let res;
    try {
      res = await send({ url }, timeoutMs);
    } catch (e) {
      throw new ArxivError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status >= 400) throw new ArxivError(`${what} (the server answered ${res.status})`);
    return res;
  }

  /** Papers matching what the user typed (words, "phrases", au:/ti:/cat: fields, or an arXiv id or link). */
  async search(text: string, start: number): Promise<PaperPage> {
    if (!arxivIdFrom(text) && !arxivSearchQuery(text)) return { total: 0, papers: [] };
    const wait = this.lastArxiv + ARXIV_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
    this.lastArxiv = Date.now();
    const res = await this.get(arxivApiUrl(this.endpoints.arxivApi, text, start, PAPERS_PER_PAGE), "arXiv could not be searched");
    return parseArxivFeed(res.text);
  }

  /** Page `page` (from 0) of the papers trending on Hugging Face Papers. */
  async popular(page: number): Promise<Paper[]> {
    const res = await this.get(`${this.endpoints.popular}?sort=trending&limit=${PAPERS_PER_PAGE}&p=${page}`, "Popular papers could not be loaded");
    let data: unknown;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new ArxivError("Popular papers could not be loaded (unexpected answer).");
    }
    return parseHfPapers(data, this.endpoints.arxivSite);
  }

  /** The PDF of a paper. */
  async pdf(paper: Paper): Promise<ArrayBuffer> {
    const res = await this.get(paper.pdfUrl, "The PDF could not be downloaded", 180000);
    const data = res.arrayBuffer;
    const head = new Uint8Array(data, 0, Math.min(5, data.byteLength));
    if (String.fromCharCode(...head) !== "%PDF-") throw new ArxivError("arXiv did not send a PDF for this paper – try again in a minute.");
    return data;
  }

  /** Text pages of papers imported before, by arXiv id without version. */
  imported(): Map<string, TFile> {
    const out = new Map<string, TFile>();
    const cache = this.plugin.app.metadataCache;
    for (const f of this.plugin.app.vault.getMarkdownFiles()) {
      const fm = cache.getFileCache(f)?.frontmatter;
      if (!fm || typeof fm.arxiv !== "string" || fm[FM_TEXT_TO_DRAWING] === undefined) continue;
      out.set(baseArxivId(fm.arxiv), f);
    }
    return out;
  }
}

/** Open the ink page of an imported paper. */
export async function openImported(plugin: InkNotebookPlugin, text: TFile, leaf?: WorkspaceLeaf): Promise<void> {
  const drawing = plugin.pairs.drawingFor(text);
  const target = leaf ?? plugin.app.workspace.getLeaf(false);
  if (drawing) await target.setViewState({ type: INK_VIEW_TYPE, state: { file: drawing.path }, active: true });
  else await target.openFile(text);
}

async function savePdf(plugin: InkNotebookPlugin, folder: string, name: string, data: ArrayBuffer): Promise<TFile> {
  await plugin.pairs.ensureFolder(folder);
  let path = normalizePath(joinPath(folder, `${name}.pdf`));
  for (let n = 2; plugin.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(joinPath(folder, `${name} ${n}.pdf`));
  return plugin.app.vault.createBinary(path, data);
}

/**
 * Import a paper: download its PDF and make an ink page of its pages (with a
 * text page holding title, authors and abstract), or – with `into` – add its
 * pages to that ink page. Resolves to false if the user cancelled.
 */
export async function importPaper(plugin: InkNotebookPlugin, paper: Paper, opts: { into?: InkView | null; leaf?: WorkspaceLeaf } = {}): Promise<boolean> {
  const data = await plugin.papers.pdf(paper);
  const name = paperFileName(paper.title);
  const into = opts.into?.file ? opts.into : null;

  if (into?.file) {
    // next to the notebook it goes into
    const pdf = await savePdf(plugin, parentPath(into.file.path), name, data);
    if (await addPdfPages(plugin, into, pdf)) return true;
    await plugin.app.vault.delete(pdf);
    return false;
  }

  const { textFolder, inkFolder } = plugin.switcher.pageFolders(plugin.settings.papersFolder || "Papers");
  await plugin.pairs.ensureFolder(textFolder);
  const base = plugin.pairs.uniqueBaseName(textFolder, inkFolder, name, [".pdf"]);
  const pdf = await savePdf(plugin, inkFolder, base, data);
  let created = null;
  try {
    const picked = await pickPages(plugin, pdf);
    if (picked) {
      created = await plugin.switcher.createPage({
        name: base,
        folder: textFolder,
        doc: { pages: pdfPages(pdf, picked.pages, picked.sizes) },
        leaf: opts.leaf,
        extraTextFrontmatter: { ...paperFrontmatter(paper), [FM_PDF]: `[[${pdf.path}]]` },
        textBody: paperNoteBody(paper),
      });
    }
  } finally {
    // cancelled or failed: don't leave the download behind
    if (!created) await plugin.app.vault.delete(pdf).catch(() => undefined);
  }
  if (!created) return false;
  new Notice(`"${paper.title}" is ready – write on its pages.`, 5000);
  return true;
}
