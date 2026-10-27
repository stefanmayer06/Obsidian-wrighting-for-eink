import { MarkdownView, Notice, normalizePath, TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import type InkNotebookPlugin from "../main";
import { normalizePaperSpec, type PaperSpec } from "../core/paper";
import { cleanSubfolder, homeFolder, inkFolderOf, isInkSubfolder, joinPath } from "../core/folders";
import { newDoc, EMPTY_META, type InkDoc } from "../core/ink/model";
import { INK_FRONTMATTER_KEY, serializeInkFile, withInkFrontmatter } from "../core/ink/codec";
import { FM_DRAWING_TO_TEXT, INK_SUFFIX } from "./pairs";
import { FolderPickModal, TextPromptModal } from "./modals";
import { PaperPickerModal } from "./paperPicker";
import { findInkView, INK_VIEW_TYPE, InkView } from "./inkView";

/**
 * Page flipping and page creation – the user-facing workflows.
 */
export class PageSwitcher {
  constructor(private plugin: InkNotebookPlugin) {}

  private get app() {
    return this.plugin.app;
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
    if (info.role === "ink") await this.toText(leaf, info.pair.drawing);
    else await this.toInk(leaf, info.pair.drawing);
  }

  /** Ink → text: transcribe (bounded by a timeout), then show the text page. */
  async toText(leaf: WorkspaceLeaf, drawing: TFile | null): Promise<void> {
    if (!drawing) return;
    const view = leaf.view instanceof InkView && leaf.view.file?.path === drawing.path ? leaf.view : findInkView(this.plugin, drawing);
    this.plugin.setBusy(drawing, true);
    let slowNotice: Notice | null = null;
    const slowTimer = window.setTimeout(() => {
      slowNotice = new Notice("Transcribing handwriting…", 0);
    }, 1200);
    let textFile: TFile | null = null;
    try {
      if (view) await view.save();
      const result = await this.plugin.sync.syncInkToText(drawing, { network: true, createText: true });
      textFile = result.text;
      if (result.pending > 0 && (result.status === "partial" || result.status === "error")) {
        // the service was too slow (or hiccuped): keep going in the background and update the page soon
        window.setTimeout(() => void this.plugin.processQueue(), 4000);
      }
    } catch (e) {
      this.reportError("Could not update the text page", e);
      textFile = this.plugin.pairs.textFor(drawing);
    } finally {
      window.clearTimeout(slowTimer);
      (slowNotice as Notice | null)?.hide();
      this.plugin.setBusy(drawing, false);
    }
    if (!textFile) return;
    await leaf.setViewState({ type: "markdown", state: this.markdownState(textFile.path), active: true });
    this.plugin.bookmarks.refresh(leaf);
  }

  /** Text → ink: save the note and open the ink page. */
  async toInk(leaf: WorkspaceLeaf, drawing: TFile): Promise<void> {
    if (leaf.view instanceof MarkdownView) {
      try {
        await leaf.view.save();
      } catch {
        /* ignore */
      }
    }
    await leaf.setViewState({ type: INK_VIEW_TYPE, state: { file: drawing.path }, active: true });
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
      try {
        await this.plugin.sync.syncInkToText(info.pair.drawing, { network: true });
      } catch (e) {
        console.warn("Ink Notebook: transcription failed", e);
      }
      await other.setViewState({ type: "markdown", state: this.markdownState(text.path) });
    } else {
      await other.setViewState({ type: INK_VIEW_TYPE, state: { file: info.pair.drawing.path } });
    }
  }

  async transcribeNow(drawing: TFile, resetEdits: boolean): Promise<void> {
    const notice = new Notice("Transcribing handwriting…", 0);
    try {
      await findInkView(this.plugin, drawing)?.save();
      const r = await this.plugin.sync.syncInkToText(drawing, { network: true, resetEdits, createText: true, timeoutMs: 120000 });
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
    console.error(`Ink Notebook: ${prefix}`, e);
    new Notice(`Ink Notebook: ${prefix}: ${e instanceof Error ? e.message : String(e)}`, 8000);
  }

  // ------------------------------------------------------------------ creating pages

  /**
   * Folders for a new page: the text page goes into `textFolder`, the ink file
   * into `inkFolder` (the ink subfolder of `textFolder`, or the same folder).
   * `context` is a folder path, a folder, or a file whose folder counts as "current".
   */
  pageFolders(context?: TAbstractFile | string | null): { textFolder: string; inkFolder: string } {
    const s = this.plugin.settings;
    const sub = cleanSubfolder(s.inkSubfolder);
    const fixed = joinPath(s.folder || "Ink");
    let home: string;
    if (typeof context === "string") home = joinPath(context);
    else if (context instanceof TFolder) home = joinPath(context.path);
    else if (s.pageLocation !== "fixed") {
      // "current", and the suggestion when asking
      const file = context instanceof TFile ? context : this.app.workspace.getActiveFile();
      home = file ? this.homeFolderOf(file) : fixed;
    } else home = fixed;
    return { textFolder: home, inkFolder: inkFolderOf(home, sub) };
  }

  /** Ink subfolders are not offered as places for new pages. */
  private hideInkFolders(): (path: string) => boolean {
    const sub = cleanSubfolder(this.plugin.settings.inkSubfolder);
    return (path) => isInkSubfolder(path, sub);
  }

  /** The folder a file "lives in" for new pages (never an ink subfolder). */
  private homeFolderOf(file: TFile): string {
    const pairs = this.plugin.pairs;
    const text = pairs.isDrawing(file) ? pairs.textFor(file) : null;
    return homeFolder(joinPath((text ?? file).parent?.path ?? ""), cleanSubfolder(this.plugin.settings.inkSubfolder));
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
   * Create a new ink page (ink file + text page).
   * `doc` gives the pages (e.g. PDF pages); otherwise one page of the chosen
   * paper (the paper picker opens if enabled in the settings).
   */
  async createPage(opts: {
    name?: string;
    /** Folder for the text page (the ink file goes into its ink subfolder). */
    folder?: string;
    /** A file or folder that counts as "current" for choosing the folder. */
    context?: TAbstractFile | null;
    paper?: PaperSpec;
    doc?: InkDoc;
    open?: boolean;
    leaf?: WorkspaceLeaf;
    extraTextFrontmatter?: Record<string, string | string[]>;
    /** Typed notes for the text page (above the transcript). */
    textBody?: string;
  } = {}): Promise<{ drawing: TFile; text: TFile } | null> {
    const settings = this.plugin.settings;
    // decide the folder first: the picker modal changes the active leaf on some platforms
    let { textFolder } = this.pageFolders(opts.folder ?? opts.context ?? null);
    let name0: string | null = opts.name ?? null;
    let paper = opts.paper ? normalizePaperSpec(opts.paper) : null;
    if (!opts.doc && !paper && settings.askForPaper) {
      const choice = await PaperPickerModal.pick(this.app, {
        mode: "new",
        initial: settings.paper,
        name: !opts.name && settings.askForPageName ? this.defaultPageName() : undefined,
        folder: textFolder,
        hideFolder: this.hideInkFolders(),
      });
      if (!choice) return null;
      paper = choice.spec;
      if (choice.name) name0 = choice.name;
      if (choice.folder !== undefined) textFolder = choice.folder;
      if (choice.makeDefault) {
        settings.paper = { ...choice.spec };
        await this.plugin.saveSettings();
      }
    } else if (!opts.doc && opts.folder === undefined && settings.pageLocation === "ask") {
      const picked = await FolderPickModal.pick(this.app, { initial: textFolder, hide: this.hideInkFolders() });
      if (picked === null) return null;
      textFolder = picked;
    }
    const inkFolder = inkFolderOf(textFolder, cleanSubfolder(settings.inkSubfolder));
    name0 ??= await this.choosePageName();
    if (!name0) return null;
    await this.plugin.pairs.ensureFolder(textFolder);
    await this.plugin.pairs.ensureFolder(inkFolder);
    const name = this.plugin.pairs.uniqueBaseName(textFolder, inkFolder, name0);
    const textPath = normalizePath(joinPath(textFolder, `${name}.md`));
    const drawingPath = normalizePath(joinPath(inkFolder, `${name}${INK_SUFFIX}`));
    const doc = opts.doc ?? newDoc(paper ?? settings.paper);
    const fm = withInkFrontmatter("", { [FM_DRAWING_TO_TEXT]: JSON.stringify(`[[${textPath.replace(/\.md$/, "")}]]`) });
    const drawing = await this.app.vault.create(drawingPath, serializeInkFile(fm, { doc, meta: EMPTY_META }));
    const text = await this.app.vault.create(textPath, this.plugin.pairs.textPageContent(drawing, textPath, opts.extraTextFrontmatter, opts.textBody));
    if (opts.open !== false) {
      const leaf = opts.leaf ?? this.app.workspace.getLeaf(false);
      await leaf.setViewState({ type: INK_VIEW_TYPE, state: { file: drawing.path }, active: true });
      this.plugin.bookmarks.refresh(leaf);
    }
    return { drawing, text };
  }

  // ------------------------------------------------------------------ drawing on a note that exists

  private attaching = new Map<string, Promise<TFile | null>>();

  /**
   * Turn on drawing for a normal note: it gets an ink page next to it (see
   * PairManager.attachDrawing), which opens in `leaf` unless `open` is false.
   * `askPaper`: show the paper picker (if it is on in the settings).
   */
  addInkToNote(note: TFile, opts: { open?: boolean; leaf?: WorkspaceLeaf; askPaper?: boolean } = {}): Promise<TFile | null> {
    const running = this.attaching.get(note.path);
    if (running) return running;
    const job = this.doAddInk(note, opts).finally(() => this.attaching.delete(note.path));
    this.attaching.set(note.path, job);
    return job;
  }

  private async doAddInk(note: TFile, opts: { open?: boolean; leaf?: WorkspaceLeaf; askPaper?: boolean }): Promise<TFile | null> {
    const settings = this.plugin.settings;
    let paper = settings.paper;
    if (opts.askPaper && settings.askForPaper) {
      const choice = await PaperPickerModal.pick(this.app, { mode: "attach", initial: paper });
      if (!choice) return null;
      paper = choice.spec;
      if (choice.makeDefault) {
        settings.paper = { ...choice.spec };
        await this.plugin.saveSettings();
      }
    }
    // what is typed in the open note is written first: the note gets new properties
    const editing = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (editing?.file?.path === note.path) {
      try {
        await editing.save();
      } catch {
        /* ignore */
      }
    }
    const drawing = await this.plugin.pairs.attachDrawing(note, newDoc(paper));
    this.plugin.bookmarks.refreshAll();
    if (opts.open !== false) {
      const leaf = opts.leaf ?? this.app.workspace.getLeaf(false);
      await leaf.setViewState({ type: INK_VIEW_TYPE, state: { file: drawing.path }, active: true });
      this.plugin.bookmarks.refresh(leaf);
    }
    return drawing;
  }

  /**
   * A note that got the ink-notebook property but has text in it: it stays a
   * normal note with its text (the property goes) and gets an ink page.
   */
  async keepTextAndAddInk(note: TFile, leaf: WorkspaceLeaf): Promise<void> {
    const settled = this.plugin.pairs.metadataSettled(note);
    await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
      delete fm[INK_FRONTMATTER_KEY];
    });
    await settled;
    await this.addInkToNote(note, { leaf });
  }
}
