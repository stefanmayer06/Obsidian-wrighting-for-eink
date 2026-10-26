import { loadPdfJs, TFile, type App } from "obsidian";
import type { ImageSource } from "../ink/render";

/**
 * Pictures for the ink pages, from the vault: inserted images, annotated
 * images and PDF pages (rendered with Obsidian's PDF.js at the resolution the
 * page is shown at). Loading is asynchronous; listeners are told when
 * something arrived so the pages can be redrawn.
 */

interface PdfEntry {
  doc: Promise<PdfDoc>;
  used: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type PdfDoc = any;

interface RenderedPage {
  canvas: HTMLCanvasElement;
  width: number;
  used: number;
}

const MAX_PDF_PAGES = 14;
const MAX_PDF_WIDTH = 3200;

export class VaultImages implements ImageSource {
  private images = new Map<string, HTMLImageElement | "loading" | "error">();
  private pdfs = new Map<string, PdfEntry>();
  private pages = new Map<string, RenderedPage>();
  private rendering = new Set<string>();
  private queue: Array<() => Promise<void>> = [];
  private busy = false;
  private listeners = new Set<() => void>();

  constructor(private app: App) {}

  /** Call `fn` whenever a picture finished loading. Returns an unsubscribe function. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private ready(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        console.error(e);
      }
    }
  }

  /** Forget a file (it changed or was deleted). */
  invalidate(path: string): void {
    this.images.delete(path);
    if (this.pdfs.delete(path)) {
      for (const key of [...this.pages.keys()]) if (key.startsWith(`${path}#`)) this.pages.delete(key);
    }
  }

  clear(): void {
    this.images.clear();
    this.pdfs.clear();
    this.pages.clear();
  }

  image(path: string): CanvasImageSource | null {
    const hit = this.images.get(path);
    if (hit instanceof HTMLImageElement) return hit;
    if (hit) return null;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      this.images.set(path, "error");
      return null;
    }
    this.images.set(path, "loading");
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      this.images.set(path, img);
      this.ready();
    };
    img.onerror = () => this.images.set(path, "error");
    img.src = this.app.vault.getResourcePath(file);
    return null;
  }

  /** Natural size of an image in the vault (for inserting it). */
  async imageSize(path: string): Promise<{ w: number; h: number } | null> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return null;
    const img = new Image();
    img.src = this.app.vault.getResourcePath(file);
    try {
      await img.decode();
      this.images.set(path, img);
      return { w: img.naturalWidth || 400, h: img.naturalHeight || 300 };
    } catch {
      return null;
    }
  }

  pdfPage(path: string, page: number, pixelWidth: number): CanvasImageSource | null {
    const key = `${path}#${page}`;
    const want = Math.min(MAX_PDF_WIDTH, Math.max(200, Math.ceil(pixelWidth)));
    const hit = this.pages.get(key);
    if (hit) hit.used = Date.now();
    // good enough (or already rendering a better one): use what is there
    if ((!hit || hit.width < want * 0.85) && !this.rendering.has(key)) {
      // render at a little more than needed so small zoom changes do not re-render
      this.enqueue(key, () => this.renderPage(path, page, Math.min(MAX_PDF_WIDTH, Math.ceil(want * 1.25))));
    }
    return hit?.canvas ?? null;
  }

  /** PDF page sizes in points, for creating pages. */
  async pdfInfo(file: TFile, pages?: number[]): Promise<{ count: number; sizes: Map<number, { w: number; h: number }> }> {
    const doc = await this.pdf(file.path);
    const sizes = new Map<number, { w: number; h: number }>();
    for (const n of pages ?? Array.from({ length: doc.numPages as number }, (_, i) => i + 1)) {
      const p = await doc.getPage(n);
      const vp = p.getViewport({ scale: 1 });
      sizes.set(n, { w: vp.width, h: vp.height });
    }
    return { count: doc.numPages as number, sizes };
  }

  private pdf(path: string): Promise<PdfDoc> {
    let entry = this.pdfs.get(path);
    if (!entry) {
      const doc = (async () => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`PDF not found: ${path}`);
        const pdfjs = await loadPdfJs();
        const data = new Uint8Array(await this.app.vault.readBinary(file));
        return pdfjs.getDocument({ data }).promise;
      })();
      entry = { doc, used: Date.now() };
      this.pdfs.set(path, entry);
      doc.catch(() => this.pdfs.delete(path));
    }
    entry.used = Date.now();
    return entry.doc;
  }

  private enqueue(key: string, job: () => Promise<void>): void {
    this.rendering.add(key);
    this.queue.push(async () => {
      try {
        await job();
      } catch (e) {
        console.warn("Ink Notebook: could not render a PDF page", e);
      } finally {
        this.rendering.delete(key);
      }
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (job) await job();
      }
    } finally {
      this.busy = false;
    }
  }

  private async renderPage(path: string, pageNo: number, width: number): Promise<void> {
    const doc = await this.pdf(path);
    const page = await doc.getPage(pageNo);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: width / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    page.cleanup?.();
    this.pages.set(`${path}#${pageNo}`, { canvas, width: canvas.width, used: Date.now() });
    // keep memory in check on tablets
    if (this.pages.size > MAX_PDF_PAGES) {
      const oldest = [...this.pages.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, this.pages.size - MAX_PDF_PAGES);
      for (const [k] of oldest) this.pages.delete(k);
    }
    this.ready();
  }
}
