import { MarkdownView, Notice, normalizePath, TFile, type WorkspaceLeaf } from "obsidian";
import type InkNotebookPlugin from "../main";
import { PAGE_HEIGHT, PAGE_WIDTH, paperFileName, paperSvg, type PaperStyle } from "../core/paper";
import { INK_CUSTOM_DATA_KEY, type InkCustomData } from "../types/excalidraw";
import {
  ExcalidrawMissingError,
  findExcalidrawView,
  getEA,
  isExcalidrawReady,
  isExcalidrawView,
  release,
  saveView,
  waitForExcalidrawView,
  EXCALIDRAW_VIEW_TYPE,
  type EA,
} from "./excalidrawBridge";
import { FM_DRAWING_TO_TEXT } from "./pairs";
import { TextPromptModal } from "./modals";

/**
 * Page flipping and page creation – the user-facing workflows.
 */
export class PageSwitcher {
  constructor(private plugin: InkNotebookPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  private requireExcalidraw(): boolean {
    if (isExcalidrawReady(this.app)) return true;
    this.plugin.showExcalidrawMissing();
    return false;
  }

  private markdownState(path: string): Record<string, unknown> {
    const mode = this.plugin.settings.textViewMode;
    if (mode === "reading") return { file: path, mode: "preview" };
    if (mode === "editing") return { file: path, mode: "source", source: false };
    return { file: path };
  }

  /** Flip the page shown in `leaf` between ink and text. */
  async flip(leaf: WorkspaceLeaf): Promise<void> {
    const file = (leaf.view as { file?: TFile | null }).file;
    if (!(file instanceof TFile)) return;
    const info = this.plugin.pairs.pairOf(file);
    if (!info) {
      new Notice("This note is not an ink page.");
      return;
    }
    if (!this.requireExcalidraw()) return;
    if (info.role === "ink") await this.toText(leaf, info.pair.drawing);
    else if (info.pair.text) await this.toInk(leaf, info.pair.text, info.pair.drawing);
  }

  /** Ink → text: transcribe (bounded by a timeout), then show the text page. */
  async toText(leaf: WorkspaceLeaf, drawing: TFile): Promise<void> {
    const view = isExcalidrawView(leaf.view) && leaf.view.file?.path === drawing.path ? leaf.view : findExcalidrawView(this.app, drawing);
    this.plugin.bookmarks.setBusy(leaf, true);
    let slowNotice: Notice | null = null;
    const slowTimer = window.setTimeout(() => {
      slowNotice = new Notice("Transcribing handwriting…", 0);
    }, 1200);
    let textFile: TFile | null = null;
    try {
      if (view) await saveView(view);
      const result = await this.plugin.sync.syncInkToText(drawing, {
        view,
        network: true,
        createText: true,
      });
      textFile = result.text;
      if (result.pending > 0 && (result.status === "partial" || result.status === "error")) {
        // Azure was too slow (or hiccuped): keep going in the background and update the page soon
        window.setTimeout(() => void this.plugin.processQueue(), 4000);
      }
    } catch (e) {
      this.reportError("Could not update the text page", e);
      textFile = this.plugin.pairs.textFor(drawing);
    } finally {
      window.clearTimeout(slowTimer);
      (slowNotice as Notice | null)?.hide();
      this.plugin.bookmarks.setBusy(leaf, false);
    }
    if (!textFile) return;
    await leaf.setViewState({ type: "markdown", state: this.markdownState(textFile.path), active: true });
    this.plugin.bookmarks.refresh(leaf);
  }

  /** Text → ink: save the note, open the drawing, mirror typed notes onto it. */
  async toInk(leaf: WorkspaceLeaf, text: TFile, drawing: TFile): Promise<void> {
    if (leaf.view instanceof MarkdownView) {
      try {
        await leaf.view.save();
      } catch {
        /* ignore */
      }
    }
    await leaf.setViewState({ type: EXCALIDRAW_VIEW_TYPE, state: { file: drawing.path }, active: true });
    this.plugin.bookmarks.refresh(leaf);
    const view = await waitForExcalidrawView(leaf, drawing.path);
    if (!view) return;
    try {
      const changed = await this.plugin.sync.syncTextToInk(text, drawing, view);
      if (changed) {
        // make sure the change survived the end of Excalidraw's loading; re-apply once if not
        await new Promise((r) => window.setTimeout(r, 1200));
        if (leaf.view === view && view.file?.path === drawing.path && !(await this.plugin.sync.typedCardInSync(text, view))) {
          await this.plugin.sync.syncTextToInk(text, drawing, view);
        }
      }
    } catch (e) {
      this.reportError("Could not copy typed notes to the drawing", e);
    }
    this.plugin.bookmarks.refresh(leaf);
  }

  /** Open the partner page in a split next to `leaf`. */
  async openSideBySide(leaf: WorkspaceLeaf): Promise<void> {
    const file = (leaf.view as { file?: TFile | null }).file;
    if (!(file instanceof TFile)) return;
    const info = this.plugin.pairs.pairOf(file);
    if (!info) return;
    let text = info.pair.text;
    if (!text) text = await this.plugin.pairs.createTextPage(info.pair.drawing);
    const other = this.app.workspace.createLeafBySplit(leaf, "vertical");
    if (info.role === "ink") {
      await this.plugin.sync.syncInkToText(info.pair.drawing, { view: findExcalidrawView(this.app, info.pair.drawing), network: true });
      await other.setViewState({ type: "markdown", state: this.markdownState(text.path) });
    } else {
      await other.setViewState({ type: EXCALIDRAW_VIEW_TYPE, state: { file: info.pair.drawing.path } });
    }
  }

  async transcribeNow(drawing: TFile, resetEdits: boolean): Promise<void> {
    if (!this.requireExcalidraw()) return;
    const notice = new Notice("Transcribing handwriting…", 0);
    try {
      const view = findExcalidrawView(this.app, drawing);
      if (view) await saveView(view);
      const r = await this.plugin.sync.syncInkToText(drawing, { view, network: true, resetEdits, createText: true, timeoutMs: 120000 });
      notice.hide();
      if (r.pending > 0) {
        new Notice(
          r.status === "offline"
            ? "You are offline – the handwriting will be transcribed when you are back online."
            : r.status === "not-configured"
              ? "Handwriting recognition is not set up yet (Settings → Ink Notebook)."
              : `Some handwriting could not be transcribed yet (${this.plugin.ocr.lastErrorMessage ?? r.status}). It will be retried.`,
          8000,
        );
      } else {
        new Notice(r.changed ? "Text page updated." : "Text page is up to date.");
      }
    } catch (e) {
      notice.hide();
      this.reportError("Transcription failed", e);
    }
  }

  reportError(prefix: string, e: unknown): void {
    if (e instanceof ExcalidrawMissingError) {
      this.plugin.showExcalidrawMissing();
      return;
    }
    console.error(`Ink Notebook: ${prefix}`, e);
    new Notice(`Ink Notebook: ${prefix}: ${e instanceof Error ? e.message : String(e)}`, 8000);
  }

  // ------------------------------------------------------------------ creating pages

  /** Make sure the SVG for a paper style exists in the vault; returns it. */
  async ensurePaperFile(style: PaperStyle): Promise<TFile> {
    const folder = normalizePath(`${this.plugin.settings.folder || "Ink"}/assets`);
    await this.plugin.pairs.ensureFolder(folder);
    const path = normalizePath(`${folder}/${paperFileName(style)}`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    return this.app.vault.create(path, paperSvg(style));
  }

  /** Add a paper page to an EA workbench at the given position. */
  async addPaper(ea: EA, style: PaperStyle, x: number, y: number): Promise<string | null> {
    if (style === "blank") return null;
    const file = await this.ensurePaperFile(style);
    const id = await ea.addImage(x, y, file, false, false);
    if (!id) return null;
    const el = ea.getElement(id);
    el.width = PAGE_WIDTH;
    el.height = PAGE_HEIGHT;
    el.locked = true;
    el.customData = { ...(el.customData ?? {}), [INK_CUSTOM_DATA_KEY]: { role: "paper" } satisfies InkCustomData };
    return id;
  }

  defaultPageName(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `Ink ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  /** Ask for a page name if the user wants that, otherwise use a dated default. */
  async choosePageName(suggested?: string): Promise<string | null> {
    const name = suggested ?? this.defaultPageName();
    if (!this.plugin.settings.askForPageName) return name;
    return TextPromptModal.ask(this.app, "Name of the new ink page", name);
  }

  /**
   * Create a new ink page (drawing + text page).
   * `build` can add content (e.g. PDF pages) to the EA workbench before the file is written.
   */
  async createPage(opts: {
    name?: string;
    folder?: string;
    paper?: PaperStyle;
    open?: boolean;
    leaf?: WorkspaceLeaf;
    extraTextFrontmatter?: Record<string, string>;
    build?: (ea: EA) => Promise<void>;
  } = {}): Promise<{ drawing: TFile; text: TFile } | null> {
    if (!this.requireExcalidraw()) return null;
    const name0 = opts.name ?? (await this.choosePageName());
    if (!name0) return null;
    const folder = normalizePath(opts.folder ?? (this.plugin.settings.folder || "Ink"));
    await this.plugin.pairs.ensureFolder(folder);
    const name = this.plugin.pairs.uniqueBaseName(folder, name0);

    const ea = getEA(this.app);
    let drawingPath: string;
    try {
      ea.reset();
      ea.canvas.theme = "light";
      ea.canvas.viewBackgroundColor = "#ffffff";
      ea.style.strokeColor = "#1e1e1e";
      ea.style.strokeWidth = 1;
      ea.style.roughness = 0;
      if (opts.build) await opts.build(ea);
      else await this.addPaper(ea, opts.paper ?? this.plugin.settings.paperStyle, 0, 0);
      drawingPath = await ea.create({
        filename: name,
        foldername: folder,
        silent: true,
        frontmatterKeys: {
          "excalidraw-plugin": "parsed",
          [FM_DRAWING_TO_TEXT]: JSON.stringify(`[[${name}]]`),
        },
      });
    } finally {
      release(ea);
    }
    const drawing = await this.waitForFile(drawingPath);
    if (!drawing) throw new Error(`The drawing ${drawingPath} was not created`);
    const textPath = normalizePath(`${folder}/${name}.md`);
    const text = await this.app.vault.create(textPath, this.plugin.pairs.textPageContent(drawing, textPath, opts.extraTextFrontmatter));
    if (opts.open !== false) {
      const leaf = opts.leaf ?? this.app.workspace.getLeaf(false);
      await leaf.setViewState({ type: EXCALIDRAW_VIEW_TYPE, state: { file: drawing.path }, active: true });
      this.plugin.bookmarks.refresh(leaf);
    }
    return { drawing, text };
  }

  private async waitForFile(path: string): Promise<TFile | null> {
    for (let i = 0; i < 50; i++) {
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) return f;
      await new Promise((r) => window.setTimeout(r, 100));
    }
    return null;
  }

  /** Add another paper page below the existing pages of the open drawing. */
  async addPaperPage(leaf: WorkspaceLeaf): Promise<void> {
    if (!this.requireExcalidraw()) return;
    const view = leaf.view;
    if (!isExcalidrawView(view)) {
      new Notice("Open the ink page first.");
      return;
    }
    const style = this.plugin.settings.paperStyle === "blank" ? "lined" : this.plugin.settings.paperStyle;
    const ea = getEA(this.app, view);
    try {
      const els = ea.getViewElements().filter((e) => !e.isDeleted);
      const pages = els.filter((e) => {
        const role = (e.customData?.[INK_CUSTOM_DATA_KEY] as InkCustomData | undefined)?.role;
        return role === "paper" || role === "pdf-page" || role === "image-page";
      });
      const bottomY = (pages.length > 0 ? pages : els).reduce((acc, e) => Math.max(acc, e.y + e.height), 0);
      const x = pages.length > 0 ? Math.min(...pages.map((p) => p.x)) : 0;
      const id = await this.addPaper(ea, style, x, els.length > 0 ? bottomY + 80 : 0);
      if (!id) return;
      await ea.addElementsToView(false, true, false);
      const added = ea.getViewElements().filter((e) => e.id === id);
      if (added.length > 0) ea.viewZoomToElements?.(false, added);
      new Notice("New page added.");
    } finally {
      release(ea);
    }
  }
}
