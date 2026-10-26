import { MarkdownRenderChild, TFile, type MarkdownPostProcessorContext } from "obsidian";
import type InkNotebookPlugin from "../main";
import type { Rect } from "../core/geometry";
import { parseInkFile } from "../core/ink/codec";
import type { InkFile, Page } from "../core/ink/model";
import { drawPage } from "../ink/render";
import { INK_VIEW_TYPE } from "./inkView";

/**
 * `ink-figure` blocks on the text page show part of an ink page – a diagram,
 * a figure the user marked, or a whole page of handwriting that is not
 * transcribed yet – drawn live from the notebook:
 *
 *   ```ink-figure
 *   area: <region id>          (or "frame: <figure id>", "page: <page id>")
 *   file: Notes/Attachments/Week 1.ink.md
 *   width: 600
 *   labels: Start · End
 *   ```
 *
 * Tapping the figure opens the ink page there. `ink-notebook` blocks (inside
 * an ink file) show its pages when the file is embedded or read as Markdown.
 */

export interface FigureSpec {
  kind: "area" | "frame" | "page";
  id: string;
  file?: string;
  width?: number;
  labels?: string;
}

export function parseFigure(source: string): FigureSpec | null {
  const map = new Map<string, string>();
  for (const line of source.split("\n")) {
    const m = /^\s*([a-z]+)\s*:\s*(.*?)\s*$/i.exec(line);
    if (m) map.set(m[1].toLowerCase(), m[2]);
  }
  const kind = (["area", "frame", "page"] as const).find((k) => map.has(k));
  if (!kind) return null;
  const width = parseInt(map.get("width") ?? "", 10);
  return { kind, id: map.get(kind) ?? "", file: map.get("file") || undefined, width: Number.isFinite(width) ? width : undefined, labels: map.get("labels") };
}

/** Parsed notebooks of files that are not open, by path (with the mtime they were read at). */
const fileCache = new Map<string, { mtime: number; ink: InkFile }>();

async function loadInk(plugin: InkNotebookPlugin, file: TFile): Promise<InkFile> {
  const live = plugin.liveInk(file);
  if (live) return live;
  const hit = fileCache.get(file.path);
  if (hit && hit.mtime === file.stat.mtime) return hit.ink;
  const ink = parseInkFile(await plugin.app.vault.cachedRead(file));
  fileCache.set(file.path, { mtime: file.stat.mtime, ink });
  if (fileCache.size > 30) fileCache.delete(fileCache.keys().next().value as string);
  return ink;
}

/** The part of the notebook a figure shows. */
function locate(ink: InkFile, spec: FigureSpec): { page: Page; rect: Rect; index: number; whole: boolean } | null {
  const pages = ink.doc.pages;
  if (spec.kind === "page") {
    const index = spec.id ? pages.findIndex((p) => p.id === spec.id) : 0;
    const page = pages[index];
    return page ? { page, rect: { x: 0, y: 0, w: page.w, h: page.h }, index, whole: true } : null;
  }
  if (spec.kind === "area") {
    const r = ink.meta.regions.find((x) => x.id === spec.id);
    if (!r) return null;
    const index = pages.findIndex((p) => p.id === r.page);
    return index >= 0 ? { page: pages[index], rect: { x: r.x, y: r.y, w: r.w, h: r.h }, index, whole: false } : null;
  }
  for (let index = 0; index < pages.length; index++) {
    const f = pages[index].figures.find((x) => x.id === spec.id);
    if (f) return { page: pages[index], rect: { x: f.x, y: f.y, w: f.w, h: f.h }, index, whole: false };
  }
  return null;
}

class FigureChild extends MarkdownRenderChild {
  private timer: number | null = null;
  private drawingPath: string | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private lastWidth = 0;

  constructor(
    el: HTMLElement,
    private plugin: InkNotebookPlugin,
    private spec: FigureSpec,
    private sourcePath: string,
  ) {
    super(el);
  }

  onload(): void {
    this.containerEl.addClass("ink-figure");
    void this.render();
    const later = () => {
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.render(), 400);
    };
    this.registerEvent(this.plugin.app.vault.on("modify", (f) => f.path === this.drawingPath && later()));
    this.register(this.plugin.onInkChange((path) => path === this.drawingPath && later()));
    this.register(this.plugin.images.subscribe(() => later()));
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        const w = this.containerEl.clientWidth;
        if (Math.abs(w - this.lastWidth) > 8) later();
      });
      this.resizeObserver.observe(this.containerEl);
    }
  }

  onunload(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.resizeObserver?.disconnect();
  }

  private drawing(): TFile | null {
    const app = this.plugin.app;
    if (this.spec.file) {
      const f = app.vault.getAbstractFileByPath(this.spec.file);
      if (f instanceof TFile) return f;
    }
    const src = app.vault.getAbstractFileByPath(this.sourcePath);
    if (src instanceof TFile) {
      if (this.plugin.pairs.isDrawing(src)) return src;
      return this.plugin.pairs.drawingFor(src);
    }
    return null;
  }

  private message(text: string): void {
    this.containerEl.empty();
    this.containerEl.createDiv({ cls: "ink-figure-missing", text });
  }

  async render(): Promise<void> {
    const file = this.drawing();
    this.drawingPath = file?.path ?? null;
    if (!file) return this.message("✍ Drawing not found");
    let ink: InkFile;
    try {
      ink = await loadInk(this.plugin, file);
    } catch {
      return this.message("✍ The ink page could not be read");
    }
    const where = locate(ink, this.spec);
    if (!where) return this.message("✍ This drawing is no longer on the ink page");
    const { page, rect } = where;
    const avail = Math.max(120, this.containerEl.clientWidth || this.spec.width || 600);
    const cssW = Math.min(this.spec.width ?? avail, avail, Math.max(rect.w, 160) * 1.6);
    this.lastWidth = this.containerEl.clientWidth;
    const k = cssW / Math.max(1, rect.w);
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const canvas = createEl("canvas", { cls: "ink-figure-canvas" });
    canvas.width = Math.max(1, Math.round(rect.w * k * dpr));
    canvas.height = Math.max(1, Math.round(rect.h * k * dpr));
    canvas.style.width = `${Math.round(rect.w * k)}px`;
    canvas.setAttr("role", "img");
    canvas.setAttr("aria-label", this.spec.labels ? `Drawing: ${this.spec.labels}` : "Drawing from the ink page");
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const s = k * dpr;
    ctx.setTransform(s, 0, 0, s, -rect.x * s, -rect.y * s);
    drawPage(ctx, page, {
      images: this.plugin.images,
      pixelScale: s,
      clip: rect,
      background: where.whole || page.bg.kind !== "paper",
      lines: where.whole,
      chrome: false,
    });
    canvas.addEventListener("click", () => void this.open(file, where.index));
    this.containerEl.empty();
    this.containerEl.appendChild(canvas);
    this.containerEl.title = "Open the ink page";
  }

  private async open(file: TFile, index: number): Promise<void> {
    this.plugin.lastPage.set(file.path, index);
    const leaf = this.plugin.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: INK_VIEW_TYPE, state: { file: file.path }, active: true });
  }
}

/** Pages of an ink file shown as Markdown (embeds, reading view of the raw file). */
class PreviewChild extends MarkdownRenderChild {
  constructor(
    el: HTMLElement,
    private plugin: InkNotebookPlugin,
    private sourcePath: string,
  ) {
    super(el);
  }

  onload(): void {
    void this.render();
    this.registerEvent(this.plugin.app.vault.on("modify", (f) => f.path === this.sourcePath && void this.render()));
  }

  private async render(): Promise<void> {
    const el = this.containerEl;
    const file = this.plugin.app.vault.getAbstractFileByPath(this.sourcePath);
    if (!(file instanceof TFile)) return;
    let ink: InkFile;
    try {
      ink = await loadInk(this.plugin, file);
    } catch {
      return;
    }
    el.empty();
    el.addClass("ink-preview");
    const row = el.createDiv({ cls: "ink-preview-pages" });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ink.doc.pages.slice(0, 6).forEach((page, i) => {
      const k = (200 * dpr) / page.w;
      const c = row.createEl("canvas", { cls: "ink-preview-page" });
      c.width = Math.round(page.w * k);
      c.height = Math.round(page.h * k);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(k, 0, 0, k, 0, 0);
      drawPage(ctx, page, { images: this.plugin.images, pixelScale: k, handLinks: ink.meta.handLinks });
      c.addEventListener("click", () => {
        this.plugin.lastPage.set(file.path, i);
        void this.plugin.app.workspace.getLeaf(false).setViewState({ type: INK_VIEW_TYPE, state: { file: file.path }, active: true });
      });
    });
    if (ink.doc.pages.length > 6) el.createDiv({ cls: "ink-preview-more", text: `+ ${ink.doc.pages.length - 6} more pages` });
  }
}

export function registerFigureBlocks(plugin: InkNotebookPlugin): void {
  plugin.registerMarkdownCodeBlockProcessor("ink-figure", (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    const spec = parseFigure(source);
    if (!spec) {
      el.createDiv({ cls: "ink-figure-missing", text: "✍ Unknown drawing" });
      return;
    }
    ctx.addChild(new FigureChild(el, plugin, spec, ctx.sourcePath));
  });
  plugin.registerMarkdownCodeBlockProcessor("ink-notebook", (_source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
    ctx.addChild(new PreviewChild(el, plugin, ctx.sourcePath));
  });
}
