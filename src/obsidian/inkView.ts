import { Menu, moment, Notice, normalizePath, Scope, setIcon, TextFileView, TFile, type WorkspaceLeaf } from "obsidian";
import type InkNotebookPlugin from "../main";
import { inkDataOf, InkParseError, parseInkFile, serializeInkFile } from "../core/ink/codec";
import type { InkFile, InkMeta, PageBackground } from "../core/ink/model";
import { paperLabel, paperSize } from "../core/paper";
import { joinPath } from "../core/folders";
import { InkSurface } from "../ink/surface";
import { Toolbar, type ToolbarPosition } from "../ink/ui/toolbar";
import { Popover, type MenuSection } from "../ink/ui/popover";
import type { SelectionAction, SurfaceSettings } from "../ink/types";
import { einkActive } from "./einkMode";
import { ConfirmModal, FilePickModal, NotePickModal } from "./modals";
import { PaperPickerModal } from "./paperPicker";
import { PageOverviewModal } from "./pageOverview";
import { NotesPanel } from "./notesPanel";
import { drawingBaseName } from "./pairs";

export const INK_VIEW_TYPE = "ink-notebook";

export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"];

/** Save this long after the first unsaved change… */
const SAVE_DELAY_MS = 2000;
/** …once the pen has rested this long… */
const PEN_IDLE_MS = 400;
/** …but after this long, at the next lift of the pen, even while writing on. */
const SAVE_MAX_WAIT_MS = 10000;

/**
 * The ink page: a notebook of handwritten pages in the style of the Boox
 * Notes app, stored in a Markdown file (see core/ink/codec.ts).
 */
export class InkView extends TextFileView {
  surface!: InkSurface;
  toolbar!: Toolbar;
  private frontmatter = "";
  /** The file's text when it could not be read: it is kept unchanged. */
  private broken: string | null = null;
  /** Ink data part of the file as last loaded or saved. */
  private savedInk = "";
  private errorEl: HTMLElement | null = null;
  private notes: NotesPanel | null = null;
  private unsubscribe: (() => void) | null = null;
  private ready = false;
  /** File data that arrived before the view was ready. */
  private pending: { data: string; clear: boolean } | null = null;
  private saveTimer: number | null = null;
  /** When the oldest unsaved change was made. */
  private unsavedSince = 0;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: InkNotebookPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return INK_VIEW_TYPE;
  }

  getDisplayText(): string {
    return this.file ? drawingBaseName(this.file) : "Ink page";
  }

  getIcon(): string {
    return "pencil-line";
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "md";
  }

  // ------------------------------------------------------------------ lifecycle

  async onOpen(): Promise<void> {
    const content = this.contentEl;
    content.empty();
    content.addClass("ink-view-content");
    const plugin = this.plugin;
    this.surface = new InkSurface(content, {
      images: plugin.images,
      icon: (el, name) => setIcon(el, name),
      openLink: (target, newTab) => void this.app.workspace.openLinkText(target, this.file?.path ?? "", newTab),
      changed: () => this.onChanged(),
      pageChanged: (i, n) => {
        this.toolbar?.refreshPage(i, n);
        if (this.file) plugin.lastPage.set(this.file.path, i);
      },
      toolChanged: () => this.toolbar?.refreshTools(),
      historyChanged: (u, r) => this.toolbar?.refreshHistory(u, r),
      selectionActions: () => this.selectionActions(),
      notice: (m) => new Notice(m, 2500),
    });
    this.surface.tools = structuredClone(plugin.settings.tools);
    this.toolbar = new Toolbar(content, this.surface, {
      icon: (el, name) => setIcon(el, name),
      openPages: () => new PageOverviewModal(this.app, this).open(),
      insertMenu: () => this.insertMenu(),
      moreMenu: () => this.moreMenu(),
      toolsChanged: (state) => {
        plugin.settings.tools = structuredClone(state);
        plugin.saveSettingsSoon();
      },
      settingsChanged: (patch) => {
        Object.assign(plugin.settings, patch);
        plugin.saveSettingsSoon();
        plugin.applyInkSettings();
      },
      endButtons: () => this.endButtons(),
    });
    content.prepend(this.toolbar.el);
    this.applySettings();
    this.registerKeys();
    this.unsubscribe = plugin.images.subscribe(() => this.surface.queueRender());
    this.ready = true;
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.setViewData(p.data, p.clear);
    }
  }

  async onClose(): Promise<void> {
    this.cancelSave();
    Popover.closeAll();
    this.surface?.textEditor.commit();
    // FileView.onClose saves the file (onUnloadFile): do it while the notebook is still here
    await super.onClose();
    this.ready = false;
    this.unsubscribe?.();
    this.notes?.close();
    this.toolbar?.destroy();
    this.surface?.destroy();
  }

  /** Writing settings, e-ink look and toolbar position. */
  applySettings(): void {
    if (!this.surface) return;
    const s = this.plugin.settings;
    const eink = einkActive(s);
    const patch: Partial<SurfaceSettings> = {
      fingerDrawing: s.fingerDrawing,
      sideButton: s.sideButton,
      pressure: s.pressure,
      twoFingerUndo: s.twoFingerUndo,
      threeFingerRedo: s.threeFingerRedo,
      swipePages: s.swipePages,
      scribbleErase: s.scribbleErase,
      holdToShape: s.holdToShape,
      fit: s.fit,
      lowLatency: s.lowLatency,
      eink,
    };
    this.surface.setSettings(patch);
    const dark = document.body.hasClass("theme-dark");
    this.surface.setBackdrop(eink ? (dark ? "#000000" : "#ffffff") : dark ? "#262626" : "#e6e6e6");
    this.setToolbarPosition(s.toolbarPosition);
  }

  private setToolbarPosition(p: ToolbarPosition): void {
    this.contentEl.dataset.toolbar = p;
    this.toolbar.setPosition(p);
    this.toolbar.fit();
    this.surface.resize();
  }

  // ------------------------------------------------------------------ file data

  setViewData(data: string, clear: boolean): void {
    if (!this.ready) {
      this.pending = { data, clear: clear || !!this.pending?.clear };
      return;
    }
    const ink = inkDataOf(data);
    if (!clear && !this.broken && ink === this.savedInk) {
      // only the properties changed (e.g. the link to the text page): keep the notebook as it is
      this.frontmatter = parseFrontmatterOnly(data, this.frontmatter);
      return;
    }
    let parsed: (InkFile & { frontmatter: string }) | null = null;
    try {
      parsed = parseInkFile(data);
    } catch (e) {
      this.showBroken(data, e);
      return;
    }
    this.broken = null;
    this.errorEl?.remove();
    this.errorEl = null;
    this.frontmatter = parsed.frontmatter;
    this.savedInk = ink;
    const path = this.file?.path ?? "";
    const page = clear ? (this.plugin.lastPage.get(path) ?? 0) : this.surface.pageIndex;
    this.surface.load(parsed, { page, keepHistory: false });
    this.toolbar.renderEnd();
    this.notes?.setFile(this.file);
  }

  getViewData(): string {
    if (this.broken !== null) return this.broken;
    if (!this.ready) return this.pending?.data ?? this.data;
    const text = serializeInkFile(this.frontmatter, this.surface.file);
    this.savedInk = inkDataOf(text);
    return text;
  }

  /** Another file is about to be shown (setViewData follows): stop what is running. */
  clear(): void {
    this.cancelSave();
    if (!this.ready) return;
    this.surface.input.cancel();
    this.surface.textEditor.commit();
  }

  private showBroken(data: string, e: unknown): void {
    this.broken = data;
    this.errorEl?.remove();
    const box = this.contentEl.createDiv({ cls: "ink-broken ink-ui" });
    box.createEl("h3", { text: "This ink page could not be opened" });
    box.createEl("p", { text: e instanceof InkParseError ? e.message : String(e) });
    box.createEl("p", { text: "The file was not changed. You can open it as Markdown to look at it." });
    const b = box.createEl("button", { text: "Open as Markdown", cls: "mod-cta" });
    b.addEventListener("click", () => void this.plugin.openAsMarkdown(this.leaf));
    this.errorEl = box;
  }

  private onChanged(): void {
    this.saveSoon();
    if (this.file) this.plugin.inkChanged(this.file);
  }

  /**
   * Save a moment after a change – but not while the pen is writing: writing a
   * big notebook to its file takes a moment, and the pen should never wait.
   */
  private saveSoon(): void {
    if (this.saveTimer !== null) return;
    this.unsavedSince = performance.now();
    this.saveTimer = window.setTimeout(() => this.saveWhenIdle(), SAVE_DELAY_MS);
  }

  private saveWhenIdle(): void {
    this.saveTimer = null;
    if (!this.ready) return;
    const input = this.surface.input;
    const now = performance.now();
    const resting = now - input.lastActivity >= PEN_IDLE_MS || now - this.unsavedSince >= SAVE_MAX_WAIT_MS;
    if (input.busy || !resting) {
      this.saveTimer = window.setTimeout(() => this.saveWhenIdle(), input.busy ? 100 : PEN_IDLE_MS);
      return;
    }
    void this.save();
  }

  private cancelSave(): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  async save(clear?: boolean): Promise<void> {
    // saved now (flipping to the text page, closing): no need to save again later
    this.cancelSave();
    await super.save(clear);
  }

  /** Metadata for the text page (diagram areas, handwritten links): applied without an undo step. */
  setMeta(meta: InkMeta): void {
    if (!this.ready || this.broken !== null) return;
    this.surface.setMeta(meta);
    this.saveSoon();
  }

  /** Replace the notebook without an undo step (e.g. a picture it uses was renamed). */
  replaceQuietly(file: InkFile): void {
    if (!this.ready || this.broken !== null) return;
    this.surface.load(file, { page: this.surface.pageIndex, keepHistory: true });
    this.saveSoon();
  }

  get inkFile(): InkFile | null {
    return this.ready && this.broken === null ? this.surface.file : null;
  }

  // ------------------------------------------------------------------ keyboard

  private registerKeys(): void {
    const scope = new Scope(this.app.scope);
    this.scope = scope;
    const typing = () => {
      const a = document.activeElement;
      return a instanceof HTMLTextAreaElement || a instanceof HTMLInputElement || (a instanceof HTMLElement && a.isContentEditable);
    };
    const key = (mods: Array<"Mod" | "Shift" | "Alt">, k: string, fn: () => void) =>
      scope.register(mods, k, () => {
        if (typing()) return true;
        fn();
        return false;
      });
    const s = this.surface;
    const hasSel = () => !!s.selectionBounds();
    key(["Mod"], "z", () => s.undo());
    key(["Mod", "Shift"], "z", () => s.redo());
    key(["Mod"], "y", () => s.redo());
    key([], "Delete", () => s.deleteSelection());
    key([], "Backspace", () => s.deleteSelection());
    key([], "Escape", () => {
      if (Popover.current) Popover.closeAll();
      else s.setSelection({ strokes: new Set(), texts: new Set(), images: new Set(), links: new Set(), figures: new Set() });
    });
    key(["Mod"], "c", () => s.copySelection());
    key(["Mod"], "x", () => s.cutSelection());
    key(["Mod"], "v", () => s.paste());
    key(["Mod"], "d", () => s.duplicateSelection());
    key(["Mod"], "a", () => s.selectAll());
    key([], "PageDown", () => s.next());
    key([], "PageUp", () => s.prev());
    key([], "ArrowRight", () => !hasSel() && s.next());
    key([], "ArrowLeft", () => !hasSel() && s.prev());
    key(["Mod"], "=", () => s.zoomAt(1.25, s.width / 2, s.height / 2));
    key(["Mod"], "-", () => s.zoomAt(0.8, s.width / 2, s.height / 2));
    key(["Mod"], "0", () => s.resetZoom());
    const tool = (k: string, t: "pen" | "marker" | "eraser" | "lasso" | "shape" | "text") =>
      key([], k, () => {
        s.setTools({ tool: t });
        this.plugin.settings.tools = structuredClone(s.tools);
        this.plugin.saveSettingsSoon();
      });
    tool("p", "pen");
    tool("h", "marker");
    tool("e", "eraser");
    tool("l", "lasso");
    tool("s", "shape");
    tool("t", "text");
  }

  // ------------------------------------------------------------------ toolbar content

  private endButtons(): Array<{ id: string; icon: string; label: string; showLabel?: boolean; run(): void }> {
    const file = this.file;
    const st = file ? this.plugin.sync.statusOf(file.path) : undefined;
    const waiting = st && st.state !== "idle" ? (st.state === "working" ? " …" : st.state === "error" ? " !" : " ◦") : "";
    return [
      { id: "notes", icon: "sticky-note", label: "Typed notes", run: () => this.toggleNotes() },
      { id: "text", icon: "file-text", label: `Text${waiting}`, showLabel: true, run: () => void this.plugin.switcher.toText(this.leaf, file) },
    ];
  }

  refreshStatus(): void {
    if (this.ready) this.toolbar.renderEnd();
  }

  toggleNotes(): void {
    if (this.notes) {
      this.notes.close();
      this.notes = null;
      return;
    }
    this.notes = new NotesPanel(this.plugin, this.surface.el, this.file, () => (this.notes = null));
  }

  /** Called when the text page changed (typed notes). */
  textChanged(): void {
    this.notes?.refresh();
  }

  private selectionActions(): SelectionAction[] {
    const actions: SelectionAction[] = [];
    if (this.plugin.ocrConfigured()) {
      actions.push({ id: "totext", icon: "type", label: "To text", run: () => void this.plugin.selectionToText(this) });
    }
    return actions;
  }

  private insertMenu(): MenuSection[] {
    return [
      {
        title: "Insert",
        items: [
          { icon: "image", label: "Image from the vault…", run: () => void this.insertVaultImage() },
          { icon: "camera", label: "Image from this device…", run: () => this.insertDeviceImage() },
          { icon: "link", label: "Link to a note…", run: () => void this.insertLink() },
          {
            icon: "type",
            label: "Text box",
            hint: "Then tap the page where the text should go",
            run: () => {
              this.surface.setTools({ tool: "text" });
              this.toolbar.refreshTools();
            },
          },
          { icon: "file-text", label: "Pages from a PDF…", run: () => void this.plugin.appendPdfPages(this) },
          { icon: "graduation-cap", label: "Pages of a paper from arXiv…", run: () => this.plugin.openPaperSearch(this) },
        ],
      },
    ];
  }

  private moreMenu(): MenuSection[] {
    const s = this.surface;
    const page = s.page;
    const bg = page.bg;
    const settings = this.plugin.settings;
    const pos = (p: ToolbarPosition, label: string) => ({
      icon: "layout",
      label,
      checked: settings.toolbarPosition === p,
      run: () => {
        settings.toolbarPosition = p;
        this.plugin.saveSettingsSoon();
        this.plugin.applyInkSettings();
      },
    });
    const fit = (f: "page" | "width", label: string) => ({
      icon: f === "page" ? "maximize" : "move-horizontal",
      label,
      checked: settings.fit === f,
      run: () => {
        settings.fit = f;
        this.plugin.saveSettingsSoon();
        this.plugin.applyInkSettings();
      },
    });
    const drawing = this.file;
    const exportItems = [
      { icon: "image-down", label: "This page as an image", run: () => void this.plugin.exportPageImage(this) },
      { icon: "file-down", label: "The notebook as PDF", run: () => void this.plugin.exportNotebookPdf(this) },
    ];
    if (s.document.pages.some((p) => p.bg.kind === "pdf")) exportItems.push({ icon: "file-down", label: "Annotated PDF (the original pages with your ink)", run: () => void this.plugin.exportAnnotatedPdf(this) });
    return [
      {
        title: `Page ${s.pageIndex + 1} of ${s.pageCount}`,
        items: [
          { icon: "layout-template", label: "Paper of this page…", hint: bg.kind === "paper" ? paperLabel(bg.paper) : "A PDF page or picture", disabled: bg.kind !== "paper", run: () => void this.changePaper() },
          { icon: "file-plus-2", label: "Add a page…", hint: "Choose the paper and where it goes", run: () => void this.addPageInteractive() },
          { icon: "copy", label: "Duplicate this page", run: () => s.duplicatePage() },
          { icon: "trash-2", label: "Delete this page", danger: true, run: () => this.deletePage() },
          { icon: "layout-grid", label: "All pages", run: () => new PageOverviewModal(this.app, this).open() },
        ],
      },
      {
        title: "Text page",
        items: [
          { icon: "refresh-cw", label: "Transcribe handwriting now", run: () => drawing && void this.plugin.switcher.transcribeNow(drawing, false) },
          { icon: "rotate-ccw", label: "Re-transcribe from scratch", hint: "Discards edits made inside the transcript", run: () => drawing && void this.plugin.switcher.transcribeNow(drawing, true) },
          { icon: "columns-2", label: "Open the text page side by side", run: () => void this.plugin.switcher.openSideBySide(this.leaf) },
        ],
      },
      { title: "Export", items: exportItems },
      { title: "View", items: [fit("page", "Show the whole page"), fit("width", "Fit the page width"), pos("top", "Toolbar at the top"), pos("bottom", "Toolbar at the bottom"), pos("left", "Toolbar on the left"), pos("right", "Toolbar on the right")] },
      {
        items: [
          { icon: "settings", label: "Ink Notebook settings", run: () => this.plugin.openSettings() },
          { icon: "file-code", label: "Open as Markdown", run: () => void this.plugin.openAsMarkdown(this.leaf) },
        ],
      },
    ];
  }

  // ------------------------------------------------------------------ actions

  async addPageInteractive(): Promise<void> {
    const s = this.surface;
    const bg = s.page.bg;
    const initial = bg.kind === "paper" ? bg.paper : this.plugin.settings.paper;
    const choice = await PaperPickerModal.pick(this.app, { mode: "add", initial, canInsert: true });
    if (!choice) return;
    if (choice.makeDefault) {
      this.plugin.settings.paper = { ...choice.spec };
      await this.plugin.saveSettings();
    }
    s.addPage(choice.position, { kind: "paper", paper: choice.spec });
  }

  async changePaper(): Promise<void> {
    const s = this.surface;
    const bg = s.page.bg;
    if (bg.kind !== "paper") {
      new Notice("This page is a PDF page or a picture – its background can't be changed.");
      return;
    }
    const choice = await PaperPickerModal.pick(this.app, { mode: "change", initial: bg.paper });
    if (!choice) return;
    if (choice.makeDefault) {
      this.plugin.settings.paper = { ...choice.spec };
      await this.plugin.saveSettings();
    }
    const size = paperSize(choice.spec);
    const next: PageBackground = { kind: "paper", paper: choice.spec };
    s.setBackground(next, { w: size.width, h: size.height });
    new Notice(`Paper changed to ${paperLabel(choice.spec)}.`);
  }

  deletePage(index = this.surface.pageIndex): void {
    const s = this.surface;
    void ConfirmModal.ask(this.app, {
      title: s.pageCount > 1 ? `Delete page ${index + 1}?` : "Clear the only page?",
      text: "You can undo this.",
      confirm: s.pageCount > 1 ? "Delete page" : "Clear page",
      danger: true,
    }).then((ok) => ok && s.deletePage(index));
  }

  private async insertVaultImage(): Promise<void> {
    const file = await FilePickModal.pick(this.app, IMAGE_EXTENSIONS, "Choose an image…");
    if (!file) return;
    const size = await this.plugin.images.imageSize(file.path);
    this.surface.insertImage(file.path, size?.w ?? 400, size?.h ?? 300);
  }

  private insertDeviceImage(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      if (!f || !this.file) return;
      try {
        const ext = (/\.([a-z0-9]+)$/i.exec(f.name)?.[1] ?? "png").toLowerCase();
        const folder = this.file.parent?.path ?? "";
        const stamp = (moment as unknown as () => { format(f: string): string })().format("YYYYMMDDHHmmss");
        let path = normalizePath(joinPath(folder, `Image ${stamp}.${ext}`));
        for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(joinPath(folder, `Image ${stamp} ${n}.${ext}`));
        const created = await this.app.vault.createBinary(path, await f.arrayBuffer());
        const size = await this.plugin.images.imageSize(created.path);
        this.surface.insertImage(created.path, size?.w ?? 400, size?.h ?? 300);
      } catch (e) {
        this.plugin.switcher.reportError("Could not insert the image", e);
      }
    });
    input.click();
  }

  private async insertLink(): Promise<void> {
    const note = await NotePickModal.pick(this.app, (f) => !this.plugin.pairs.isDrawing(f));
    if (!note) return;
    this.surface.insertLink(this.app.metadataCache.fileToLinktext(note, this.file?.path ?? "", true));
  }

  // ------------------------------------------------------------------ pane menu

  onPaneMenu(menu: Menu, source: string): void {
    super.onPaneMenu(menu, source);
    menu.addItem((i) =>
      i
        .setTitle("Text page")
        .setIcon("file-text")
        .onClick(() => void this.plugin.switcher.toText(this.leaf, this.file)),
    );
    menu.addItem((i) =>
      i
        .setTitle("Open as Markdown")
        .setIcon("file-code")
        .onClick(() => void this.plugin.openAsMarkdown(this.leaf)),
    );
  }
}

/** The frontmatter of a file (without parsing the ink data). */
function parseFrontmatterOnly(data: string, fallback: string): string {
  const m = /^(?:﻿)?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(data);
  return m ? m[0].replace(/\r\n/g, "\n").replace(/\n?$/, "\n") : fallback;
}

/** The open ink view showing a file, if any. */
export function findInkView(plugin: InkNotebookPlugin, file: TFile): InkView | null {
  for (const leaf of plugin.app.workspace.getLeavesOfType(INK_VIEW_TYPE)) {
    const v = leaf.view;
    if (v instanceof InkView && v.file?.path === file.path && v.inkFile) return v;
  }
  return null;
}
