import { debounce, Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, type WorkspaceLeaf } from "obsidian";
import { loadSettings, type InkSettings } from "./settings";
import { PairManager } from "./obsidian/pairs";
import { OcrService } from "./obsidian/ocrService";
import { SyncEngine } from "./obsidian/syncEngine";
import { BookmarkManager } from "./obsidian/bookmarks";
import { PageSwitcher } from "./obsidian/pageSwitcher";
import { InkSettingTab } from "./obsidian/settingsTab";
import { SetupWizard } from "./obsidian/setupWizard";
import { applyEinkClasses, einkActive, removeEinkClasses } from "./obsidian/einkMode";
import { isOnline } from "./obsidian/azureClient";
import {
  EXCALIDRAW_VIEW_TYPE,
  findExcalidrawView,
  getEA,
  isExcalidrawReady,
  isExcalidrawView,
  release,
  viewElements,
} from "./obsidian/excalidrawBridge";
import { BundledExcalidraw } from "./obsidian/bundledExcalidraw";
import { annotateImage, annotatePdf, exportAnnotatedImage, exportAnnotatedPdf, findPdfPages } from "./obsidian/pdfAnnotate";
import { getInkData } from "./types/excalidraw";
import { elementRect, unionAll } from "./core/geometry";
import { transcriptEditorExtension } from "./obsidian/editorExtension";
import { classifyScene } from "./core/classify";
import { planOcrUnits } from "./core/rasterPlan";
import { layoutTranscript } from "./core/layout";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"];

export default class InkNotebookPlugin extends Plugin {
  settings!: InkSettings;
  pairs!: PairManager;
  ocr!: OcrService;
  sync!: SyncEngine;
  bookmarks!: BookmarkManager;
  switcher!: PageSwitcher;
  /** The Excalidraw built into Ink Notebook (idle when the user's own Excalidraw plugin is enabled). */
  excalidraw!: BundledExcalidraw;

  private openDrawings = new Set<string>();
  private queueRunning = false;
  private typedTimers = new Map<string, number>();
  private inkTimers = new Map<string, number>();
  private missingNoticeShown = false;

  async onload(): Promise<void> {
    this.settings = loadSettings(await this.loadData());
    this.excalidraw = new BundledExcalidraw(this);
    await this.excalidraw.ensure();
    this.pairs = new PairManager(this.app, () => this.settings.inkSubfolder);
    this.ocr = new OcrService(
      this.app.vault.adapter,
      `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/ocr-cache.json`,
      () => this.settings,
      () => this.saveSettings(),
    );
    this.sync = new SyncEngine(this.app, this.pairs, this.ocr, () => this.settings, {
      add: (p) => this.queueAdd(p),
      remove: (p) => this.queueRemove(p),
    });
    this.bookmarks = new BookmarkManager(this);
    this.switcher = new PageSwitcher(this);
    const refreshBookmarks = debounce(() => this.bookmarks.refreshAll(), 80, true);
    this.sync.onStatusChange = () => refreshBookmarks();

    applyEinkClasses(this.settings);
    this.addSettingTab(new InkSettingTab(this.app, this));
    this.registerEditorExtension(transcriptEditorExtension());

    this.addRibbonIcon("pencil-line", "New ink page", () => void this.switcher.createPage().catch((e) => this.switcher.reportError("Could not create the page", e)));
    this.registerCommands();
    this.registerFileMenus();

    // ---- workspace & vault events ----
    const onLayout = debounce(
      () => {
        // the user's own Excalidraw plugin may have been disabled: the built-in one takes over
        void this.excalidraw.ensure();
        this.bookmarks.refreshAll();
        this.detectClosedDrawings();
      },
      60,
      true,
    );
    this.registerEvent(this.app.workspace.on("layout-change", onLayout));
    this.registerEvent(this.app.workspace.on("active-leaf-change", onLayout));
    this.registerEvent(this.app.workspace.on("file-open", onLayout));
    this.registerEvent(this.app.workspace.on("file-open", (file) => this.refreshStaleTextPage(file)));
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.pairs.isTextPage(file) || this.pairs.isDrawing(file)) refreshBookmarks();
      }),
    );
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => void this.onRename(file, oldPath)));
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.queueRemove(file.path);
        this.sync.forget(file.path);
        refreshBookmarks();
      }),
    );
    this.registerEvent(this.app.vault.on("modify", (file) => this.onModify(file)));
    this.registerDomEvent(window, "online", () => {
      window.setTimeout(() => void this.processQueue(), 2000);
    });
    this.registerInterval(window.setInterval(() => void this.processQueue(), 5 * 60 * 1000));

    this.app.workspace.onLayoutReady(() => void this.onLayoutReady());
  }

  onunload(): void {
    this.bookmarks?.removeAll();
    removeEinkClasses();
    for (const t of this.typedTimers.values()) window.clearTimeout(t);
    for (const t of this.inkTimers.values()) window.clearTimeout(t);
    void this.ocr?.flush();
    this.excalidraw?.unload();
  }

  private async onLayoutReady(): Promise<void> {
    await this.ocr.loadCache();
    this.bookmarks.refreshAll();
    this.detectClosedDrawings();
    if (!this.settings.setupDone) {
      // give the user's own Excalidraw plugin (if any) a moment to finish loading before checking
      window.setTimeout(() => new SetupWizard(this).open(), 1200);
    } else if (!isExcalidrawReady(this.app)) {
      window.setTimeout(() => {
        if (!isExcalidrawReady(this.app)) this.showExcalidrawMissing();
      }, 4000);
    }
    window.setTimeout(() => void this.processQueue(), 8000);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private saveSettingsSoon = debounce(() => void this.saveSettings(), 1000, true);

  openSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  showExcalidrawMissing(): void {
    // e.g. the user's own Excalidraw plugin was just disabled: start the built-in one
    if (!this.excalidraw.error && this.excalidraw.canStart()) {
      void this.excalidraw.ensure().then((ok) => (ok ? new Notice("Excalidraw is ready – please try again.") : this.showExcalidrawMissing()));
      return;
    }
    if (this.missingNoticeShown) return;
    this.missingNoticeShown = true;
    window.setTimeout(() => (this.missingNoticeShown = false), 10000);
    const frag = document.createDocumentFragment();
    frag.appendText(`Ink Notebook: ${this.excalidraw.describe().text} `);
    const a = frag.createEl("a", { text: "Open setup", href: "#" });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      new SetupWizard(this).open();
    });
    new Notice(frag, 10000);
  }

  /** Pure core functions, exposed for troubleshooting from the developer console. */
  readonly internals = { classifyScene, planOcrUnits, layoutTranscript };

  // ------------------------------------------------------------------ public actions

  annotatePdf(file?: TFile | null): Promise<void> {
    return annotatePdf(this, file ?? null);
  }

  annotateImage(file?: TFile | null): Promise<void> {
    return annotateImage(this, file ?? null);
  }

  exportAnnotatedPdf(leaf?: WorkspaceLeaf | null): Promise<void> {
    return exportAnnotatedPdf(this, leaf ?? null);
  }

  exportAnnotatedImage(leaf?: WorkspaceLeaf | null): Promise<void> {
    return exportAnnotatedImage(this, leaf ?? null);
  }

  // ------------------------------------------------------------------ queue

  private queueAdd(path: string): void {
    if (!this.settings.queue.includes(path)) {
      this.settings.queue.push(path);
      this.saveSettingsSoon();
    }
  }

  private queueRemove(path: string): void {
    const i = this.settings.queue.indexOf(path);
    if (i >= 0) {
      this.settings.queue.splice(i, 1);
      this.saveSettingsSoon();
    }
  }

  /** Transcribe pages that could not be transcribed earlier (offline, errors). */
  async processQueue(verbose = false): Promise<void> {
    if (this.queueRunning) return;
    if (this.settings.queue.length === 0) {
      if (verbose) new Notice("No pages are waiting for transcription.");
      return;
    }
    if (!isOnline()) {
      if (verbose) new Notice("You are offline – the pages will be transcribed when you are back online.");
      return;
    }
    if (!isExcalidrawReady(this.app)) return;
    this.queueRunning = true;
    let done = 0;
    try {
      for (const path of [...this.settings.queue]) {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || !this.pairs.isDrawing(file)) {
          this.queueRemove(path);
          continue;
        }
        try {
          const r = await this.sync.syncInkToText(file, { view: findExcalidrawView(this.app, file), network: true });
          if (r.text && r.pending === 0) done++;
          if (r.status === "offline") break;
        } catch (e) {
          console.warn("Ink Notebook: queued transcription failed", path, e);
        }
      }
    } finally {
      this.queueRunning = false;
    }
    if (verbose || done > 0) new Notice(`Ink Notebook: transcribed ${done} waiting page${done === 1 ? "" : "s"}.`);
  }

  // ------------------------------------------------------------------ events

  private async onRename(file: TAbstractFile, oldPath: string): Promise<void> {
    const i = this.settings.queue.indexOf(oldPath);
    if (i >= 0) {
      this.settings.queue[i] = file.path;
      this.saveSettingsSoon();
    }
    if (this.openDrawings.delete(oldPath)) this.openDrawings.add(file.path);
    // wait for the metadata cache to pick up the new path
    window.setTimeout(async () => {
      try {
        await this.pairs.onRename(file, oldPath, this.settings.keepNamesInSync);
      } catch (e) {
        console.warn("Ink Notebook: rename sync failed", e);
      }
      this.bookmarks.refreshAll();
    }, 300);
  }

  private onModify(file: TAbstractFile): void {
    if (!(file instanceof TFile) || file.extension !== "md") return;
    // typed notes → drawing (only when the drawing is open somewhere)
    if (this.settings.syncTypedNotes && this.pairs.isTextPage(file)) {
      const drawing = this.pairs.drawingFor(file);
      if (!drawing) return;
      const prev = this.typedTimers.get(file.path);
      if (prev) window.clearTimeout(prev);
      this.typedTimers.set(
        file.path,
        window.setTimeout(() => {
          this.typedTimers.delete(file.path);
          const view = findExcalidrawView(this.app, drawing);
          if (view) void this.sync.syncTextToInk(file, drawing, view).catch((e) => console.warn("Ink Notebook: typed notes sync failed", e));
        }, 1500),
      );
      return;
    }
    // drawing saved → text page (optional, while writing)
    if (this.settings.autoTranscribe && this.pairs.isDrawing(file) && this.pairs.textFor(file)) {
      const prev = this.inkTimers.get(file.path);
      if (prev) window.clearTimeout(prev);
      this.inkTimers.set(
        file.path,
        window.setTimeout(() => {
          this.inkTimers.delete(file.path);
          const view = findExcalidrawView(this.app, file);
          if (view) void this.sync.syncInkToText(file, { view, network: true }).catch((e) => console.warn("Ink Notebook: auto transcription failed", e));
        }, 6000),
      );
    }
  }

  /**
   * Opening a text page whose drawing changed after the transcript was written
   * (e.g. synced from another device) refreshes it in the background.
   */
  private refreshStaleTextPage(file: TFile | null): void {
    if (!file || !this.pairs.isTextPage(file)) return;
    const drawing = this.pairs.drawingFor(file);
    if (!drawing || drawing.stat.mtime <= file.stat.mtime + 2000) return;
    if (findExcalidrawView(this.app, drawing)) return; // the open drawing syncs itself
    if (this.sync.isUpToDate(drawing)) return;
    window.setTimeout(() => {
      void this.sync.syncInkToText(drawing, { view: null, network: true }).catch((e) => console.warn("Ink Notebook: refresh failed", e));
    }, 500);
  }

  /** When a drawing is closed (navigated away) update its text page in the background. */
  private detectClosedDrawings(): void {
    const now = new Set<string>();
    for (const leaf of this.app.workspace.getLeavesOfType(EXCALIDRAW_VIEW_TYPE)) {
      const f = (leaf.view as { file?: TFile | null }).file;
      if (f) now.add(f.path);
    }
    const closed = [...this.openDrawings].filter((p) => !now.has(p));
    this.openDrawings = now;
    for (const path of closed) {
      window.setTimeout(() => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile) || !this.pairs.isDrawing(file) || !this.pairs.textFor(file)) return;
        if (findExcalidrawView(this.app, file)) return; // reopened meanwhile
        if (this.sync.isUpToDate(file)) return; // e.g. just synced by flipping the bookmark
        void this.sync.syncInkToText(file, { view: null, network: true }).catch((e) => console.warn("Ink Notebook: background sync failed", e));
      }, 1500);
    }
  }

  // ------------------------------------------------------------------ commands

  private activeLeafFile(): { leaf: WorkspaceLeaf; file: TFile } | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const file = (leaf?.view as { file?: TFile | null } | undefined)?.file;
    return leaf && file instanceof TFile ? { leaf, file } : null;
  }

  private registerCommands(): void {
    const run = (p: Promise<unknown>, what: string) => void p.catch((e) => this.switcher.reportError(what, e));

    this.addCommand({
      id: "new-page",
      name: "New ink page",
      icon: "pencil-line",
      callback: () => run(this.switcher.createPage(), "Could not create the page"),
    });
    this.addCommand({
      id: "flip-page",
      name: "Flip between ink and text page",
      icon: "book-open",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        if (!a || !this.pairs.pairOf(a.file)) return false;
        if (!checking) run(this.switcher.flip(a.leaf), "Could not flip the page");
        return true;
      },
    });
    this.addCommand({
      id: "transcribe-now",
      name: "Transcribe handwriting now",
      icon: "refresh-cw",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        const info = a && this.pairs.pairOf(a.file);
        if (!info) return false;
        if (!checking) run(this.switcher.transcribeNow(info.pair.drawing, false), "Transcription failed");
        return true;
      },
    });
    this.addCommand({
      id: "retranscribe",
      name: "Re-transcribe from scratch (discard edits in the transcript)",
      icon: "rotate-ccw",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        const info = a && this.pairs.pairOf(a.file);
        if (!info) return false;
        if (!checking) run(this.switcher.transcribeNow(info.pair.drawing, true), "Transcription failed");
        return true;
      },
    });
    this.addCommand({
      id: "side-by-side",
      name: "Open ink and text page side by side",
      icon: "columns",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        if (!a || !this.pairs.pairOf(a.file)) return false;
        if (!checking) run(this.switcher.openSideBySide(a.leaf), "Could not open the pages");
        return true;
      },
    });
    this.addCommand({
      id: "create-text-page",
      name: "Create a text page for this drawing",
      icon: "file-plus",
      checkCallback: (checking) => {
        const a = this.activeLeafFile();
        if (!a || !this.pairs.isDrawing(a.file) || this.pairs.textFor(a.file)) return false;
        if (!checking) run(this.switcher.toText(a.leaf, a.file), "Could not create the text page");
        return true;
      },
    });
    this.addCommand({
      id: "add-paper-page",
      name: "Add a page… (choose paper and position)",
      icon: "file-plus-2",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (!leaf || !isExcalidrawView(leaf.view)) return false;
        if (!checking) run(this.switcher.addPageInteractive(leaf), "Could not add a page");
        return true;
      },
    });
    this.addCommand({
      id: "add-page-after",
      name: "Add a page after this one (same paper)",
      icon: "file-plus-2",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (!leaf || !isExcalidrawView(leaf.view)) return false;
        if (!checking) run(this.switcher.addPaperPage(leaf, { position: "after" }), "Could not add a page");
        return true;
      },
    });
    this.addCommand({
      id: "change-paper",
      name: "Change the paper of this page…",
      icon: "layout-template",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (!leaf || !isExcalidrawView(leaf.view)) return false;
        if (!checking) run(this.switcher.changePaperInteractive(leaf), "Could not change the paper");
        return true;
      },
    });
    this.addCommand({
      id: "mark-diagram",
      name: "Turn the selection into a diagram (embedded as a picture on the text page)",
      icon: "frame",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        if (!leaf || !isExcalidrawView(leaf.view)) return false;
        if (!checking) run(this.markSelectionAsDiagram(leaf), "Could not create the diagram frame");
        return true;
      },
    });
    this.addCommand({
      id: "annotate-pdf",
      name: "Annotate a PDF…",
      icon: "file-text",
      callback: () => run(this.annotatePdf(), "Could not annotate the PDF"),
    });
    this.addCommand({
      id: "annotate-image",
      name: "Annotate an image…",
      icon: "image",
      callback: () => run(this.annotateImage(), "Could not annotate the image"),
    });
    this.addCommand({
      id: "export-annotated-pdf",
      name: "Export annotated PDF",
      icon: "download",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const v = leaf?.view;
        if (!isExcalidrawView(v) || !v.file) return false;
        if (findPdfPages(this, viewElements(v), v.file.path).length === 0) return false;
        if (!checking) run(this.exportAnnotatedPdf(leaf), "Export failed");
        return true;
      },
    });
    this.addCommand({
      id: "export-annotated-image",
      name: "Export annotated image",
      icon: "download",
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const v = leaf?.view;
        if (!isExcalidrawView(v)) return false;
        if (!viewElements(v).some((e) => getInkData(e)?.role === "image-page")) return false;
        if (!checking) run(this.exportAnnotatedImage(leaf), "Export failed");
        return true;
      },
    });
    this.addCommand({
      id: "process-queue",
      name: "Transcribe pages waiting for a connection",
      icon: "cloud-upload",
      callback: () => run(this.processQueue(true), "Transcription failed"),
    });
    this.addCommand({
      id: "toggle-eink",
      name: "Toggle e-ink optimisations",
      icon: "monitor",
      callback: async () => {
        this.settings.einkMode = einkActive(this.settings) ? "off" : "on";
        applyEinkClasses(this.settings);
        await this.saveSettings();
        new Notice(`E-ink optimisations ${einkActive(this.settings) ? "on" : "off"}.`);
      },
    });
    this.addCommand({
      id: "open-setup",
      name: "Open setup assistant",
      icon: "wand",
      callback: () => new SetupWizard(this).open(),
    });
  }

  private registerFileMenus(): void {
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFolder) {
          menu.addItem((i) =>
            i
              .setTitle("New ink page")
              .setIcon("pencil-line")
              .onClick(() => void this.switcher.createPage({ folder: file.path }).catch((e) => this.switcher.reportError("Could not create the page", e))),
          );
          return;
        }
        if (!(file instanceof TFile)) return;
        const ext = file.extension.toLowerCase();
        if (ext === "pdf") {
          menu.addItem((i) =>
            i
              .setTitle("Annotate with Ink Notebook")
              .setIcon("pencil-line")
              .onClick(() => void this.annotatePdf(file)),
          );
        } else if (IMAGE_EXTENSIONS.includes(ext)) {
          menu.addItem((i) =>
            i
              .setTitle("Annotate with Ink Notebook")
              .setIcon("pencil-line")
              .onClick(() => void this.annotateImage(file)),
          );
        } else if (this.pairs.isDrawing(file) && !this.pairs.textFor(file)) {
          menu.addItem((i) =>
            i
              .setTitle("Create text page (Ink Notebook)")
              .setIcon("file-text")
              .onClick(async () => {
                try {
                  await this.pairs.createTextPage(file);
                  await this.sync.syncInkToText(file, { view: findExcalidrawView(this.app, file), network: true });
                  this.bookmarks.refreshAll();
                } catch (e) {
                  this.switcher.reportError("Could not create the text page", e);
                }
              }),
          );
        }
      }),
    );
  }

  /** Wrap the selected elements in a frame named "Diagram" (always embedded as a picture). */
  private async markSelectionAsDiagram(leaf: WorkspaceLeaf): Promise<void> {
    const view = leaf.view;
    if (!isExcalidrawView(view)) return;
    const api = view.excalidrawAPI;
    const selectedIds = Object.keys(api?.getAppState?.()?.selectedElementIds ?? {});
    const selected = viewElements(view).filter((e) => selectedIds.includes(e.id));
    if (selected.length === 0) {
      new Notice("Select the strokes of your drawing first (lasso or selection tool).");
      return;
    }
    const box = unionAll(selected.map((e) => elementRect(e)));
    if (!box) return;
    const ea = getEA(this.app, view) as ReturnType<typeof getEA> & {
      addFrame?: (x: number, y: number, w: number, h: number, name?: string) => string;
      addElementsToFrame?: (frameId: string, ids: string[]) => void;
    };
    try {
      if (!ea.addFrame || !ea.addElementsToFrame) {
        new Notice("This needs a newer version of the Excalidraw plugin.");
        return;
      }
      ea.copyViewElementsToEAforEditing(selected);
      const pad = 16;
      const frameId = ea.addFrame(box.x - pad, box.y - pad, box.w + 2 * pad, box.h + 2 * pad, "Diagram");
      ea.addElementsToFrame(frameId, selected.map((e) => e.id));
      await ea.addElementsToView(false, true, false);
      new Notice("Marked as diagram – it will appear as a picture on the text page.");
    } finally {
      release(ea);
    }
  }
}
