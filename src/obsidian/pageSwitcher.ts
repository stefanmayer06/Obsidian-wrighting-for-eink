import { MarkdownView, Notice, normalizePath, TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import type InkNotebookPlugin from "../main";
import { normalizePaperSpec, paperFileName, paperLabel, paperSize, paperSvg, type PaperSpec } from "../core/paper";
import { collectPages, elementsBelow, PAGE_GAP, pageAt, planPageInsert, type PagePosition, type PageRef } from "../core/pages";
import { cleanSubfolder, homeFolder, isInkSubfolder, joinPath } from "../core/folders";
import { bottom, elementRect } from "../core/geometry";
import { getInkData, INK_CUSTOM_DATA_KEY, type ExElement, type InkCustomData } from "../types/excalidraw";
import {
  ExcalidrawMissingError,
  findExcalidrawView,
  getEA,
  isExcalidrawReady,
  isExcalidrawView,
  release,
  saveView,
  viewElements,
  waitForExcalidrawView,
  EXCALIDRAW_VIEW_TYPE,
  type EA,
  type ExcalidrawViewLike,
} from "./excalidrawBridge";
import { FM_DRAWING_TO_TEXT } from "./pairs";
import { TextPromptModal } from "./modals";
import { PaperPickerModal } from "./paperPicker";

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

  /**
   * Folders for a new page: the text page goes into `textFolder`, the drawing and
   * its paper into `inkFolder` (the ink subfolder of `textFolder`, or the same folder).
   * `context` is a folder path, a folder, or a file whose folder counts as "current".
   */
  pageFolders(context?: TAbstractFile | string | null): { textFolder: string; inkFolder: string } {
    const s = this.plugin.settings;
    const sub = cleanSubfolder(s.inkSubfolder);
    const fixed = joinPath(s.folder || "Ink");
    let home: string;
    if (typeof context === "string") home = joinPath(context);
    else if (context instanceof TFolder) home = joinPath(context.path);
    else if (s.pageLocation === "current") {
      const file = context instanceof TFile ? context : this.app.workspace.getActiveFile();
      home = file ? this.homeFolderOf(file) : fixed;
    } else home = fixed;
    return { textFolder: home, inkFolder: sub ? joinPath(home, sub) : home };
  }

  /** The folder a file "lives in" for new pages (never an ink subfolder). */
  private homeFolderOf(file: TFile): string {
    const pairs = this.plugin.pairs;
    const text = pairs.isDrawing(file) ? pairs.textFor(file) : null;
    return homeFolder(joinPath((text ?? file).parent?.path ?? ""), cleanSubfolder(this.plugin.settings.inkSubfolder));
  }

  /** Where the paper SVGs for drawings in `drawingFolder` are kept. */
  paperFolderFor(drawingFolder: string): string {
    const folder = joinPath(drawingFolder);
    return isInkSubfolder(folder, cleanSubfolder(this.plugin.settings.inkSubfolder)) ? folder : joinPath(folder, "assets");
  }

  /** Make sure the SVG for a paper exists in `folder`; returns it. */
  async ensurePaperFile(spec: PaperSpec, folder: string): Promise<TFile> {
    await this.plugin.pairs.ensureFolder(folder);
    const path = normalizePath(joinPath(folder, paperFileName(spec)));
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) return existing;
    try {
      return await this.app.vault.create(path, paperSvg(spec));
    } catch (e) {
      // created concurrently (e.g. by sync)
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) return f;
      throw e;
    }
  }

  /** Add a paper page to an EA workbench at the given position. */
  async addPaper(ea: EA, spec: PaperSpec, x: number, y: number, paperFolder: string): Promise<string | null> {
    const file = await this.ensurePaperFile(spec, paperFolder);
    const id = await ea.addImage(x, y, file, false, false);
    if (!id) return null;
    const { width, height } = paperSize(spec);
    const el = ea.getElement(id);
    el.width = width;
    el.height = height;
    el.locked = true;
    el.customData = { ...(el.customData ?? {}), [INK_CUSTOM_DATA_KEY]: { role: "paper", paper: { ...spec } } satisfies InkCustomData };
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

  private async rememberPaper(spec: PaperSpec): Promise<void> {
    this.plugin.settings.paper = { ...spec };
    await this.plugin.saveSettings();
  }

  /**
   * Create a new ink page (drawing + text page).
   * `build` can add content (e.g. PDF pages) to the EA workbench before the file is written.
   * Without `paper` or `build`, the paper picker opens (if enabled in the settings).
   */
  async createPage(opts: {
    name?: string;
    /** Folder for the text page (the drawing goes into its ink subfolder). */
    folder?: string;
    /** A file or folder that counts as "current" for choosing the folder. */
    context?: TAbstractFile | null;
    paper?: PaperSpec;
    open?: boolean;
    leaf?: WorkspaceLeaf;
    extraTextFrontmatter?: Record<string, string>;
    build?: (ea: EA, folders: { textFolder: string; inkFolder: string }) => Promise<void>;
  } = {}): Promise<{ drawing: TFile; text: TFile } | null> {
    if (!this.requireExcalidraw()) return null;
    const settings = this.plugin.settings;
    // decide the folder first: the picker modal changes the active leaf on some platforms
    const { textFolder, inkFolder } = this.pageFolders(opts.folder ?? opts.context ?? null);
    let name0: string | null = opts.name ?? null;
    let paper = opts.paper ?? null;
    if (!opts.build && !paper && settings.askForPaper) {
      const choice = await PaperPickerModal.pick(this.app, {
        mode: "new",
        initial: settings.paper,
        name: !opts.name && settings.askForPageName ? this.defaultPageName() : undefined,
      });
      if (!choice) return null;
      paper = choice.spec;
      if (choice.name) name0 = choice.name;
      if (choice.makeDefault) await this.rememberPaper(choice.spec);
    }
    name0 ??= await this.choosePageName();
    if (!name0) return null;
    await this.plugin.pairs.ensureFolder(textFolder);
    await this.plugin.pairs.ensureFolder(inkFolder);
    const name = this.plugin.pairs.uniqueBaseName(textFolder, inkFolder, name0);
    const textPath = normalizePath(joinPath(textFolder, `${name}.md`));

    const ea = getEA(this.app);
    let drawingPath: string;
    try {
      ea.reset();
      ea.canvas.theme = "light";
      ea.canvas.viewBackgroundColor = "#ffffff";
      ea.style.strokeColor = "#1e1e1e";
      ea.style.strokeWidth = 1;
      ea.style.roughness = 0;
      if (opts.build) await opts.build(ea, { textFolder, inkFolder });
      else await this.addPaper(ea, paper ?? settings.paper, 0, 0, this.paperFolderFor(inkFolder));
      drawingPath = await ea.create({
        filename: name,
        foldername: inkFolder || "/",
        silent: true,
        frontmatterKeys: {
          "excalidraw-plugin": "parsed",
          [FM_DRAWING_TO_TEXT]: JSON.stringify(`[[${textPath.replace(/\.md$/, "")}]]`),
        },
      });
    } finally {
      release(ea);
    }
    const drawing = await this.waitForFile(drawingPath);
    if (!drawing) throw new Error(`The drawing ${drawingPath} was not created`);
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

  // ------------------------------------------------------------------ pages of an ink page

  private inkView(leaf: WorkspaceLeaf): ExcalidrawViewLike | null {
    if (!this.requireExcalidraw()) return null;
    const view = leaf.view;
    if (!isExcalidrawView(view) || !view.file) {
      new Notice("Open the ink page first.");
      return null;
    }
    return view;
  }

  /** The page in the middle of the screen. */
  private currentPage(view: ExcalidrawViewLike, pages: PageRef[]): PageRef | null {
    const st = view.excalidrawAPI?.getAppState?.();
    if (!st || pages.length === 0) return pages[pages.length - 1] ?? null;
    const zoom = st.zoom?.value || 1;
    return pageAt(pages, { x: st.width / 2 / zoom - st.scrollX, y: st.height / 2 / zoom - st.scrollY });
  }

  /** Paper of the page on screen (or the last paper page), to suggest for a new page. */
  private suggestedPaper(pages: PageRef[], current: PageRef | null): PaperSpec {
    const lastPaper = [...pages].reverse().find((p) => p.paper)?.paper;
    return current?.paper ?? lastPaper ?? this.plugin.settings.paper;
  }

  /** "Add a page": choose paper and position, then add it. */
  async addPageInteractive(leaf: WorkspaceLeaf): Promise<void> {
    const view = this.inkView(leaf);
    if (!view) return;
    const pages = collectPages(viewElements(view));
    const choice = await PaperPickerModal.pick(this.app, {
      mode: "add",
      initial: this.suggestedPaper(pages, this.currentPage(view, pages)),
      canInsert: pages.length > 0,
    });
    if (!choice) return;
    if (choice.makeDefault) await this.rememberPaper(choice.spec);
    await this.addPaperPage(leaf, { spec: choice.spec, position: choice.position });
  }

  /**
   * Add a paper page after/before the page on screen or at the end. Pages (and
   * writing) below the new page move down to make room.
   */
  async addPaperPage(leaf: WorkspaceLeaf, opts: { spec?: PaperSpec; position?: PagePosition } = {}): Promise<void> {
    const view = this.inkView(leaf);
    if (!view?.file) return;
    const els = viewElements(view);
    const pages = collectPages(els);
    const current = this.currentPage(view, pages);
    const spec = normalizePaperSpec(opts.spec ?? this.suggestedPaper(pages, current));
    const { height } = paperSize(spec);
    const content = els.filter((e) => !getInkData(e));
    const contentBottom = content.length > 0 ? Math.max(...content.map((e) => bottom(elementRect(e)))) : null;
    const plan = planPageInsert(pages, current, opts.position ?? "end", height, contentBottom);
    const moving = plan.threshold === null ? new Set<string>() : elementsBelow(els, plan.threshold);
    const ea = getEA(this.app, view);
    try {
      this.shiftOnWorkbench(ea, els, moving, plan.shift);
      const id = await this.addPaper(ea, spec, plan.x, plan.y, this.paperFolderFor(view.file.parent?.path ?? ""));
      if (!id) return;
      await ea.addElementsToView(false, true, false);
      const added = ea.getViewElements().filter((e) => e.id === id);
      if (added.length > 0) ea.viewZoomToElements?.(false, added);
      new Notice(moving.size > 0 ? "Page inserted." : "New page added.");
    } finally {
      release(ea);
    }
  }

  /** "Change paper": swap the template of the page on screen (writing stays). */
  async changePaperInteractive(leaf: WorkspaceLeaf): Promise<void> {
    const view = this.inkView(leaf);
    if (!view) return;
    const pages = collectPages(viewElements(view));
    const current = this.currentPage(view, pages);
    if (!current || current.role !== "paper") {
      new Notice(current ? "This page is a PDF page or an image – its background can't be changed." : "This ink page has no paper pages yet – add one first.");
      return;
    }
    const choice = await PaperPickerModal.pick(this.app, { mode: "change", initial: this.suggestedPaper(pages, current) });
    if (!choice) return;
    if (choice.makeDefault) await this.rememberPaper(choice.spec);
    await this.changePaper(leaf, choice.spec, current.id);
  }

  async changePaper(leaf: WorkspaceLeaf, spec: PaperSpec, pageId?: string): Promise<void> {
    const view = this.inkView(leaf);
    if (!view?.file) return;
    const els = viewElements(view);
    const pages = collectPages(els);
    const page = pageId ? pages.find((p) => p.id === pageId) : this.currentPage(view, pages);
    const old = page && els.find((e) => e.id === page.id);
    if (!page || !old || page.role !== "paper") return;
    const size = paperSize(spec);
    // a page that gets taller/shorter (orientation) moves the pages below it
    const next = pages[pages.findIndex((p) => p.id === page.id) + 1];
    const space = next ? Math.max(0, next.rect.y - bottom(page.rect)) : PAGE_GAP;
    const shift = size.height - page.rect.h;
    const moving = shift !== 0 ? elementsBelow(els, bottom(page.rect) + Math.min(space, PAGE_GAP) / 2) : new Set<string>();
    const ea = getEA(this.app, view);
    try {
      this.shiftOnWorkbench(ea, els, moving, shift);
      ea.copyViewElementsToEAforEditing([old]);
      ea.getElement(old.id).isDeleted = true;
      const id = await this.addPaper(ea, spec, page.rect.x, page.rect.y, this.paperFolderFor(view.file.parent?.path ?? ""));
      if (!id) return;
      await ea.addElementsToView(false, true, false);
      new Notice(`Paper changed to ${paperLabel(spec)}.`);
    } finally {
      release(ea);
    }
  }

  /** Put the elements in `ids` on the workbench, moved down by `dy` (they keep their place in the stacking order). */
  private shiftOnWorkbench(ea: EA, els: ReadonlyArray<ExElement>, ids: ReadonlySet<string>, dy: number): void {
    if (ids.size === 0 || dy === 0) return;
    const moving = els.filter((e) => ids.has(e.id));
    ea.copyViewElementsToEAforEditing(moving);
    for (const e of moving) ea.getElement(e.id).y = e.y + dy;
  }
}
