import { App, normalizePath, TAbstractFile, TFile, TFolder } from "obsidian";
import { renderRegion } from "../core/transcript";
import { INK_FRONTMATTER_KEY } from "../core/ink/codec";
import { cleanSubfolder, homeFolder, joinPath, parentPath, partnerTarget } from "../core/folders";

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

  /** Create the text page for an existing drawing (and link the drawing back). */
  async createTextPage(drawing: TFile, extraFrontmatter: Record<string, string> = {}): Promise<TFile> {
    const existing = this.textFor(drawing);
    if (existing) return existing;
    // a drawing in an ink subfolder gets its text page in the folder above
    const folder = homeFolder(folderOf(drawing), this.sub);
    let base = drawingBaseName(drawing);
    let path = normalizePath(joinPath(folder, `${base}.md`));
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      base = `${drawingBaseName(drawing)} (text${n > 2 ? " " + n : ""})`;
      path = normalizePath(joinPath(folder, `${base}.md`));
      n++;
    }
    const text = await this.app.vault.create(path, this.textPageContent(drawing, path, extraFrontmatter));
    await this.linkDrawingToText(drawing, text);
    return text;
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
