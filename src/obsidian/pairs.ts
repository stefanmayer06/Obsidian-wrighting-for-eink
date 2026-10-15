import { App, normalizePath, TAbstractFile, TFile, TFolder } from "obsidian";
import { isExcalidrawFile } from "./excalidrawBridge";
import { renderRegion } from "../core/transcript";

/**
 * An "ink page" is a pair of files:
 *   - the drawing      `Name.excalidraw.md` (frontmatter `ink-text: "[[Name]]"`)
 *   - the text page    `Name.md`            (frontmatter `ink-drawing: "[[Name.excalidraw]]"`)
 * The frontmatter links make the pair visible in the graph/backlinks and let
 * us find the partner even after renames.
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

export function drawingBaseName(file: TFile): string {
  return file.basename.replace(/\.excalidraw$/i, "");
}

export class PairManager {
  constructor(private app: App) {}

  private resolve(link: string | null, from: TFile): TFile | null {
    if (!link) return null;
    const f = this.app.metadataCache.getFirstLinkpathDest(link, from.path);
    return f instanceof TFile ? f : null;
  }

  isDrawing(file: TFile | null | undefined): file is TFile {
    return !!file && isExcalidrawFile(this.app, file);
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
    // convention fallback: same folder, Name.excalidraw.md
    const candidate = this.app.vault.getAbstractFileByPath(normalizePath(`${text.parent?.path ?? ""}/${text.basename}.excalidraw.md`));
    return candidate instanceof TFile && this.isDrawing(candidate) ? candidate : null;
  }

  /** The text page for a drawing (if any). */
  textFor(drawing: TFile): TFile | null {
    const fm = this.app.metadataCache.getFileCache(drawing)?.frontmatter;
    const viaLink = this.resolve(linkFromFrontmatter(fm?.[FM_DRAWING_TO_TEXT]), drawing);
    if (viaLink && viaLink.extension === "md" && !this.isDrawing(viaLink)) return viaLink;
    const candidate = this.app.vault.getAbstractFileByPath(normalizePath(`${drawing.parent?.path ?? ""}/${drawingBaseName(drawing)}.md`));
    if (candidate instanceof TFile && this.isTextPage(candidate)) {
      const back = this.drawingFor(candidate);
      if (back?.path === drawing.path) return candidate;
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

  linkText(file: TFile, sourcePath: string): string {
    return this.app.metadataCache.fileToLinktext(file, sourcePath, true);
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

  /** A base name that is free for both the drawing and the text page. */
  uniqueBaseName(folder: string, base: string): string {
    const clean = base.replace(/[\\/:*?"<>|#^[\]]/g, "-").trim() || "Ink page";
    let name = clean;
    let n = 2;
    const exists = (nm: string) =>
      !!this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${nm}.md`)) ||
      !!this.app.vault.getAbstractFileByPath(normalizePath(`${folder}/${nm}.excalidraw.md`));
    while (exists(name)) name = `${clean} ${n++}`;
    return name;
  }

  /** Initial content of a text page. */
  textPageContent(drawing: TFile, textPath: string, extraFrontmatter: Record<string, string> = {}): string {
    const link = this.linkText(drawing, textPath);
    const extra = Object.entries(extraFrontmatter)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}\n`)
      .join("");
    return `---\n${FM_TEXT_TO_DRAWING}: ${JSON.stringify(`[[${link}]]`)}\n${extra}---\n${renderRegion([], [])}\n\n`;
  }

  /** Create the text page for an existing drawing (and link the drawing back). */
  async createTextPage(drawing: TFile, extraFrontmatter: Record<string, string> = {}): Promise<TFile> {
    const existing = this.textFor(drawing);
    if (existing) return existing;
    const folder = drawing.parent?.path ?? "";
    let base = drawingBaseName(drawing);
    let path = normalizePath(`${folder}/${base}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      base = `${drawingBaseName(drawing)} (text${n > 2 ? " " + n : ""})`;
      path = normalizePath(`${folder}/${base}.md`);
      n++;
    }
    const text = await this.app.vault.create(path, this.textPageContent(drawing, path, extraFrontmatter));
    await this.linkDrawingToText(drawing, text);
    return text;
  }

  private async setLink(file: TFile, key: string, target: TFile): Promise<void> {
    const value = `[[${this.linkText(target, file.path)}]]`;
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
   * Keep names in sync: renaming/moving one side renames the other, and the
   * frontmatter links are refreshed in both files.
   */
  async onRename(file: TAbstractFile, oldPath: string, keepNamesInSync: boolean): Promise<void> {
    if (!(file instanceof TFile) || this.renaming.has(file.path)) return;
    const oldBase = oldPath.split("/").pop()?.replace(/\.md$/i, "") ?? "";
    const oldFolder = oldPath.includes("/") ? oldPath.slice(0, oldPath.lastIndexOf("/")) : "";
    const pairInfo = this.pairOf(file);
    if (!pairInfo) return;
    const { drawing, text } = pairInfo.pair;
    if (!text) return;
    const partner = pairInfo.role === "ink" ? text : drawing;
    if (keepNamesInSync) {
      const partnerBase = pairInfo.role === "ink" ? partner.basename : drawingBaseName(partner);
      const oldPlainBase = oldBase.replace(/\.excalidraw$/i, "");
      const partnerFolder = partner.parent?.path ?? "";
      if (partnerBase === oldPlainBase && partnerFolder === (oldFolder || (partner.parent?.path ?? ""))) {
        const newPlain = pairInfo.role === "ink" ? drawingBaseName(file) : file.basename;
        const folder = file.parent?.path ?? "";
        const target = normalizePath(`${folder}/${newPlain}${pairInfo.role === "ink" ? "" : ".excalidraw"}.md`);
        if (target !== partner.path && !this.app.vault.getAbstractFileByPath(target)) {
          this.renaming.add(target);
          try {
            await this.app.fileManager.renameFile(partner, target);
          } finally {
            window.setTimeout(() => this.renaming.delete(target), 2000);
          }
        }
      }
    }
    // refresh links (Obsidian may not update frontmatter links if auto-update is off)
    await this.linkTextToDrawing(text, drawing);
    await this.linkDrawingToText(drawing, text);
  }
}
