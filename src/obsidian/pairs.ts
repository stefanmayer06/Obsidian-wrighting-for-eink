import { App, normalizePath, TAbstractFile, TFile, TFolder } from "obsidian";
import { parseNote, renderRegion } from "../core/transcript";
import { INK_FRONTMATTER_KEY, serializeInkFile, withInkFrontmatter } from "../core/ink/codec";
import { EMPTY_META, type InkDoc } from "../core/ink/model";
import { cleanSubfolder, homeFolder, inkFolderOf, joinPath, pairPaths, parentPath, partnerTarget } from "../core/folders";

/**
 * An "ink page" is a pair of files:
 *   - the drawing      `Attachments/Name.ink.md` (frontmatter `ink-notebook: 1`, `ink-text: "[[Folder/Name]]"`)
 *   - the text page    `Name.md`  (frontmatter `ink-drawing: "[[Folder/Attachments/Name.ink]]"`)
 * The drawing sits in the ink subfolder of the text page's folder (or next to it).
 * The frontmatter links use full paths – names like "Week 1" repeat across folders –
 * make the pair visible in the graph/backlinks and let us find the partner after renames.
 */

export const FM_TEXT_TO_DRAWING = "ink-drawing";
export const FM_DRAWING_TO_TEXT = "ink-text";
export const FM_PDF = "ink-pdf";

export type PageRole = "ink" | "text";

export interface PagePair {
  drawing: TFile;
  text: TFile | null;
}

function linkFromFrontmatter(value: unknown): string | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string") return null;
  const m = /^\s*!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/.exec(v);
  if (m) return m[1].trim();
  const plain = v.trim();
  return plain ? plain : null;
}

export const INK_SUFFIX = ".ink.md";

export function drawingBaseName(file: TFile): string {
  return file.basename.replace(/\.ink$/i, "");
}

/** Is this the path of an ink page file (by its name)? */
export function isInkPath(path: string): boolean {
  return path.toLowerCase().endsWith(INK_SUFFIX);
}

/** Folder path of a file ("" for the vault root). */
function folderOf(file: TAbstractFile): string {
  const p = file.parent?.path ?? "";
  return p === "/" ? "" : p;
}

export class PairManager {
  constructor(
    private app: App,
    private inkSubfolder: () => string = () => "",
  ) {}

  private get sub(): string {
    return cleanSubfolder(this.inkSubfolder());
  }

  private fileAt(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
    return f instanceof TFile ? f : null;
  }

  private resolve(link: string | null, from: TFile): TFile | null {
    if (!link) return null;
    const f = this.app.metadataCache.getFirstLinkpathDest(link, from.path);
    return f instanceof TFile ? f : null;
  }

  /** An ink page file: `Name.ink.md`, or any note with the `ink-notebook` property. */
  isDrawing(file: TFile | null | undefined): file is TFile {
    if (!file || !(file instanceof TFile) || file.extension !== "md") return false;
    if (isInkPath(file.path)) return true;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return !!fm && fm[INK_FRONTMATTER_KEY] !== undefined;
  }

  /** A markdown file that is the text side of an ink page. */
  isTextPage(file: TFile | null | undefined): file is TFile {
    if (!file || file.extension !== "md" || this.isDrawing(file)) return false;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return !!fm && fm[FM_TEXT_TO_DRAWING] !== undefined;
  }

  /** The drawing for a text page (if it still exists). */
  drawingFor(text: TFile): TFile | null {
    const fm = this.app.metadataCache.getFileCache(text)?.frontmatter;
    const viaLink = this.resolve(linkFromFrontmatter(fm?.[FM_TEXT_TO_DRAWING]), text);
    if (viaLink && this.isDrawing(viaLink)) return viaLink;
    // convention fallback: Name.ink.md next to the text page or in its ink subfolder
    const folder = folderOf(text);
    for (const dir of this.sub ? [folder, joinPath(folder, this.sub)] : [folder]) {
      const candidate = this.fileAt(joinPath(dir, `${text.basename}${INK_SUFFIX}`));
      if (candidate && this.isDrawing(candidate)) return candidate;
    }
    return null;
  }

  /** The text page for a drawing (if any). */
  textFor(drawing: TFile): TFile | null {
    const fm = this.app.metadataCache.getFileCache(drawing)?.frontmatter;
    const viaLink = this.resolve(linkFromFrontmatter(fm?.[FM_DRAWING_TO_TEXT]), drawing);
    if (viaLink && viaLink.extension === "md" && !this.isDrawing(viaLink)) return viaLink;
    // convention fallback: Name.md next to the drawing, or in the home folder of its ink subfolder
    const folder = folderOf(drawing);
    const home = homeFolder(folder, this.sub);
    for (const dir of home !== folder ? [folder, home] : [folder]) {
      const candidate = this.fileAt(joinPath(dir, `${drawingBaseName(drawing)}.md`));
      if (candidate && this.isTextPage(candidate) && this.drawingFor(candidate)?.path === drawing.path) return candidate;
    }
    return null;
  }

  /** Is this drawing explicitly part of an ink page? */
  isInkDrawing(drawing: TFile): boolean {
    const fm = this.app.metadataCache.getFileCache(drawing)?.frontmatter;
    return !!fm && fm[FM_DRAWING_TO_TEXT] !== undefined;
  }

  pairOf(file: TFile): { role: PageRole; pair: PagePair } | null {
    if (this.isDrawing(file)) return { role: "ink", pair: { drawing: file, text: this.textFor(file) } };
    if (this.isTextPage(file)) {
      const d = this.drawingFor(file);
      return d ? { role: "text", pair: { drawing: d, text: file } } : null;
    }
    return null;
  }

  /**
   * Link text for `file` used from `sourcePath`: the short form for a file next to the
   * source, the full path otherwise (a short "Week 1" link could resolve to another folder).
   */
  linkText(file: TFile, sourcePath: string): string {
    if (parentPath(file.path) === parentPath(sourcePath)) return this.app.metadataCache.fileToLinktext(file, sourcePath, true);
    return pairLink(file);
  }

  async ensureFolder(path: string): Promise<void> {
    const p = normalizePath(path);
    if (!p || p === "/" || p === ".") return;
    const existing = this.app.vault.getAbstractFileByPath(p);
    if (existing instanceof TFolder) return;
    if (existing) throw new Error(`"${p}" exists and is not a folder`);
    const parts = p.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          // created concurrently
          if (!(this.app.vault.getAbstractFileByPath(cur) instanceof TFolder)) throw e;
        }
      }
    }
  }

  /** A base name that is free for both the text page (in `textFolder`) and the drawing (in `inkFolder`). */
  /** A name not used by a text page or ink file yet (nor by `Name<ext>` in the ink folder for each of `alsoFree`). */
  uniqueBaseName(textFolder: string, inkFolder: string, base: string, alsoFree: ReadonlyArray<string> = []): string {
    const clean = base.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "Ink page";
    let name = clean;
    let n = 2;
    const taken = (folder: string, file: string) => !!this.app.vault.getAbstractFileByPath(normalizePath(joinPath(folder, file)));
    const exists = (nm: string) =>
      taken(textFolder, `${nm}.md`) ||
      taken(inkFolder, `${nm}${INK_SUFFIX}`) ||
      taken(inkFolder, `${nm}.md`) ||
      alsoFree.some((ext) => taken(inkFolder, `${nm}${ext}`));
    while (exists(name)) name = `${clean} ${n++}`;
    return name;
  }

  /** Initial content of a text page. */
  /** `body` (typed notes) goes above the handwriting transcript. */
  textPageContent(drawing: TFile, textPath: string, extraFrontmatter: Record<string, string | string[]> = {}, body = ""): string {
    const link = pairLink(drawing);
    // JSON is valid YAML: strings stay strings, arrays become list properties
    const extra = Object.entries(extraFrontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`)
      .join("");
    const top = body.trim() ? `${body.trim()}\n\n` : "";
    return `---\n${FM_TEXT_TO_DRAWING}: ${JSON.stringify(`[[${link}]]`)}\n${extra}---\n${top}${renderRegion([], [])}\n\n`;
  }

  /** A normal note: neither an ink page nor the text page of one. */
  isPlainNote(file: TFile | null | undefined): boolean {
    return !!file && file.extension === "md" && !this.isDrawing(file) && !this.isTextPage(file);
  }

  /** A note that can get an ink page: a normal note, or a text page whose ink page is gone. */
  canAddInk(file: TFile | null | undefined): boolean {
    return !!file && file.extension === "md" && !this.pairOf(file);
  }

  /**
   * Create the text page for an existing drawing (and link the drawing back).
   * The two files get the same name: `Name.md` in the home folder and
   * `Name.ink.md` in its ink subfolder.
   */
  async createTextPage(drawing: TFile, extraFrontmatter: Record<string, string> = {}): Promise<TFile> {
    const existing = this.textFor(drawing);
    if (existing) return existing;
    const name = drawingBaseName(drawing);
    // a drawing in an ink subfolder gets its text page in the folder above
    const folder = homeFolder(folderOf(drawing), this.sub);
    // a note that is the drawing itself ("Week 1.md" with the ink-notebook property)
    // moves into the ink subfolder as "Week 1.ink.md", so the text page can have its name
    // (and the links to "Week 1" lead to it)
    if (!isInkPath(drawing.path)) await this.moveTo(drawing, joinPath(inkFolderOf(folder, this.sub), `${name}${INK_SUFFIX}`), false);
    let path = normalizePath(joinPath(folder, `${name}.md`));
    const there = this.fileAt(path);
    if (there && there.path !== drawing.path && this.isPlainNote(there)) {
      // a normal note of that name becomes the text page: what is written in it stays
      await this.makeTextPage(there, drawing);
      await this.linkDrawingToText(drawing, there);
      return there;
    }
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = normalizePath(joinPath(folder, `${name} (text${n > 2 ? " " + n : ""}).md`));
      n++;
    }
    const text = await this.app.vault.create(path, this.textPageContent(drawing, path, extraFrontmatter));
    await this.linkDrawingToText(drawing, text);
    return text;
  }

  /**
   * Turn on drawing for a normal note: it gets an ink page `Name.ink.md` in its
   * ink subfolder, linked both ways (an ink file of that name that belongs to no
   * other page is used). The note keeps what is written in it; the transcript of
   * the handwriting goes below.
   */
  async attachDrawing(note: TFile, doc: InkDoc): Promise<TFile> {
    if (this.pairOf(note)?.role === "ink") throw new Error(`"${note.basename}" is an ink page itself`);
    const linked = this.isTextPage(note) ? this.drawingFor(note) : null;
    if (linked) return linked;
    const inkFolder = inkFolderOf(folderOf(note), this.sub);
    await this.ensureFolder(inkFolder);
    let drawing: TFile | null = null;
    let path = "";
    for (let n = 1; ; n++) {
      path = normalizePath(joinPath(inkFolder, `${note.basename}${n > 1 ? ` ${n}` : ""}${INK_SUFFIX}`));
      const f = this.app.vault.getAbstractFileByPath(path);
      if (!f) break;
      if (f instanceof TFile && this.isDrawing(f) && [null, note.path].includes(this.textFor(f)?.path ?? null)) {
        drawing = f;
        break;
      }
    }
    if (drawing) await this.linkDrawingToText(drawing, note);
    else {
      const fm = withInkFrontmatter("", { [FM_DRAWING_TO_TEXT]: JSON.stringify(`[[${pairLink(note)}]]`) });
      drawing = await this.app.vault.create(path, serializeInkFile(fm, { doc, meta: EMPTY_META }));
    }
    await this.makeTextPage(note, drawing);
    return drawing;
  }

  /** Link a note to its drawing and give it the (empty) transcript region below what is written in it. */
  private async makeTextPage(note: TFile, drawing: TFile): Promise<void> {
    const settled = this.metadataSettled(note);
    await this.linkTextToDrawing(note, drawing);
    await this.app.vault.process(note, (md) => (parseNote(md).hasRegion ? md : `${md.replace(/\s+$/, "")}${md.trim() ? "\n\n" : ""}${renderRegion([], [])}\n`));
    await settled;
  }

  /** Resolves when the metadata cache has read `file` again (or after a moment). */
  metadataSettled(file: TFile, timeoutMs = 2000): Promise<void> {
    return new Promise((resolve) => {
      const cache = this.app.metadataCache;
      const done = () => {
        window.clearTimeout(timer);
        cache.offref(ref);
        resolve();
      };
      const ref = cache.on("changed", (f) => {
        if (f.path === file.path) done();
      });
      const timer = window.setTimeout(done, timeoutMs);
    });
  }

  /**
   * The renames that make an ink page's files match (see pairPaths): the drawing
   * first, as it may have the name the text page should get. Empty when they match.
   */
  tidyPlan(drawing: TFile): Array<{ file: TFile; to: string }> {
    const text = this.textFor(drawing);
    if (!text) return [];
    const want = pairPaths({ textPath: text.path, drawingPath: drawing.path, sub: this.sub });
    const plan: Array<{ file: TFile; to: string }> = [];
    if (normalizePath(want.drawing) !== drawing.path) plan.push({ file: drawing, to: normalizePath(want.drawing) });
    if (normalizePath(want.text) !== text.path) plan.push({ file: text, to: normalizePath(want.text) });
    return plan;
  }

  /** Rename/move an ink page's files so that they match. Returns how many files moved. */
  async tidy(drawing: TFile): Promise<number> {
    const text = this.textFor(drawing);
    // links to a drawing named like a note ("2026-10-27") mean that note: they stay, and lead to the text page
    const keepLinks = !isInkPath(drawing.path);
    let moved = 0;
    for (const { file, to } of this.tidyPlan(drawing)) {
      if (file.path !== to && (await this.moveTo(file, to, !(keepLinks && file === drawing)))) moved++;
    }
    if (text && moved > 0) {
      await this.linkTextToDrawing(text, drawing);
      await this.linkDrawingToText(drawing, text);
    }
    return moved;
  }

  /**
   * Rename/move one file of a pair without the rename handler moving its
   * partner. `updateLinks` false: links to the old name are left as they are.
   * False if the place is taken.
   */
  private async moveTo(file: TFile, target: string, updateLinks = true): Promise<boolean> {
    const to = normalizePath(target);
    if (file.path === to) return true;
    if (this.app.vault.getAbstractFileByPath(to)) return false;
    await this.ensureFolder(parentPath(to));
    this.renaming.add(to);
    try {
      if (updateLinks) await this.app.fileManager.renameFile(file, to);
      else await this.app.vault.rename(file, to);
    } finally {
      window.setTimeout(() => this.renaming.delete(to), 2000);
    }
    return true;
  }

  private async setLink(file: TFile, key: string, target: TFile): Promise<void> {
    const value = `[[${pairLink(target)}]]`;
    const current = this.app.metadataCache.getFileCache(file)?.frontmatter?.[key];
    if (current === value) return;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      fm[key] = value;
    });
  }

  async linkDrawingToText(drawing: TFile, text: TFile): Promise<void> {
    await this.setLink(drawing, FM_DRAWING_TO_TEXT, text);
  }

  async linkTextToDrawing(text: TFile, drawing: TFile): Promise<void> {
    await this.setLink(text, FM_TEXT_TO_DRAWING, drawing);
  }

  private renaming = new Set<string>();

  /**
   * Keep names in sync: renaming/moving one side renames/moves the other (keeping
   * the drawing in the ink subfolder of the text page's folder), and the
   * frontmatter links are refreshed in both files.
   */
  async onRename(file: TAbstractFile, oldPath: string, keepNamesInSync: boolean): Promise<void> {
    if (!(file instanceof TFile) || this.renaming.has(file.path)) return;
    const pairInfo = this.pairOf(file);
    if (!pairInfo) return;
    const { drawing, text } = pairInfo.pair;
    if (!text) return;
    const partner = pairInfo.role === "ink" ? text : drawing;
    if (keepNamesInSync) {
      const found = partnerTarget({ role: pairInfo.role, oldPath, newPath: file.path, partnerPath: partner.path });
      const target = found ? normalizePath(found) : null;
      if (target && target !== partner.path && !this.app.vault.getAbstractFileByPath(target)) {
        this.renaming.add(target);
        try {
          await this.ensureFolder(parentPath(target));
          await this.app.fileManager.renameFile(partner, target);
        } finally {
          window.setTimeout(() => this.renaming.delete(target), 2000);
        }
      }
    }
    // refresh links (Obsidian may not update frontmatter links if auto-update is off)
    await this.linkTextToDrawing(text, drawing);
    await this.linkDrawingToText(drawing, text);
  }
}

/** Unambiguous link text for a pair link: the full vault path (without ".md"). */
export function pairLink(file: TFile): string {
  return file.extension === "md" ? file.path.slice(0, -3) : file.path;
}
