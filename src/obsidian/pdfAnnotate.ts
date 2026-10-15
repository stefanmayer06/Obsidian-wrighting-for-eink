import { loadPdfJs, Notice, normalizePath, TFile, type WorkspaceLeaf } from "obsidian";
import { PDFDocument } from "pdf-lib";
import type InkNotebookPlugin from "../main";
import { area, elementRect, intersection, intersects, type Rect } from "../core/geometry";
import { displayedSize, normalizeRotation, parsePageRange, unrotateTransform } from "../core/pdfMath";
import { getInkData, INK_CUSTOM_DATA_KEY, type ExElement, type InkCustomData } from "../types/excalidraw";
import { getEA, isExcalidrawView, release, viewElements, type ExcalidrawViewLike } from "./excalidrawBridge";
import { FilePickModal, PdfImportModal } from "./modals";
import { FM_PDF } from "./pairs";

/**
 * Annotating PDFs and images, like in the Boox Notes app:
 *  - "Annotate PDF" puts the PDF pages on an ink page as locked backgrounds
 *    (linked to the original PDF, nothing is copied).
 *  - "Export annotated PDF" writes a new PDF: the original pages (text stays
 *    selectable) with your ink drawn on top.
 */

const PAGE_GAP = 40;

interface PdfPageRef {
  element: ExElement;
  rect: Rect;
  pdfPath: string;
  page: number;
}

function parsePdfLink(link: string | null | undefined): { path: string; page: number } | null {
  if (!link) return null;
  const m = /^\[*([^\]#|]+\.pdf)#page=(\d+)/i.exec(link.trim());
  return m ? { path: m[1], page: parseInt(m[2], 10) } : null;
}

/** Find PDF pages on an ink page (ours, and Excalidraw's own "Import PDF" marker frames). */
export function findPdfPages(plugin: InkNotebookPlugin, elements: ReadonlyArray<ExElement>, sourcePath: string): PdfPageRef[] {
  const pages: PdfPageRef[] = [];
  for (const el of elements) {
    const data = getInkData(el);
    if (data?.role === "pdf-page" && data.pdf && data.page) {
      pages.push({ element: el, rect: elementRect(el), pdfPath: data.pdf, page: data.page });
    } else if ((el.type === "frame" || el.type === "magicframe") && el.frameRole === "marker") {
      const link = parsePdfLink(el.link);
      if (!link) continue;
      const file = plugin.app.metadataCache.getFirstLinkpathDest(link.path, sourcePath);
      if (file) pages.push({ element: el, rect: elementRect(el), pdfPath: file.path, page: link.page });
    }
  }
  return pages.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
}

interface PdfInfo {
  count: number;
  sizes: Map<number, { w: number; h: number }>;
}

async function readPdfInfo(plugin: InkNotebookPlugin, file: TFile, pages?: number[]): Promise<PdfInfo> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await plugin.app.vault.readBinary(file));
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    const sizes = new Map<number, { w: number; h: number }>();
    const wanted = pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1);
    for (const n of wanted) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      sizes.set(n, { w: vp.width, h: vp.height });
      page.cleanup?.();
    }
    return { count: doc.numPages, sizes };
  } finally {
    await doc.destroy?.();
  }
}

async function pdfPageCount(plugin: InkNotebookPlugin, file: TFile): Promise<number> {
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await plugin.app.vault.readBinary(file));
  const doc = await pdfjs.getDocument({ data }).promise;
  try {
    return doc.numPages as number;
  } finally {
    await doc.destroy?.();
  }
}

export async function annotatePdf(plugin: InkNotebookPlugin, file?: TFile | null, leaf?: WorkspaceLeaf): Promise<void> {
  const pdf = file ?? (await FilePickModal.pick(plugin.app, ["pdf"], "Choose a PDF to annotate…"));
  if (!pdf) return;
  let notice: Notice | null = new Notice(`Opening "${pdf.basename}"…`, 0);
  try {
    const count = await pdfPageCount(plugin, pdf);
    const limit = plugin.settings.pdfMaxPagesWithoutAsking;
    let range = "all";
    if (count > limit) {
      notice.hide();
      notice = null;
      const answer = await PdfImportModal.ask(plugin.app, pdf.basename, count, `1-${limit}`);
      if (answer === null) return;
      range = answer;
      notice = new Notice(`Preparing pages of "${pdf.basename}"…`, 0);
    }
    const pages = parsePageRange(range, count);
    if (pages.length === 0) {
      new Notice("No pages selected.");
      return;
    }
    const info = await readPdfInfo(plugin, pdf, pages);
    const width = plugin.settings.pdfPageWidth;
    const link = plugin.app.metadataCache.fileToLinktext(pdf, plugin.settings.folder || "", true);
    const created = await plugin.switcher.createPage({
      name: `${pdf.basename} (annotated)`,
      leaf,
      extraTextFrontmatter: { [FM_PDF]: `[[${link}]]` },
      build: async (ea) => {
        let y = 0;
        let i = 0;
        for (const n of pages) {
          i++;
          notice?.setMessage(`Adding page ${n} (${i} of ${pages.length})…`);
          const size = info.sizes.get(n) ?? { w: 595, h: 842 };
          const id = await ea.addImage(0, y, `${pdf.path}#page=${n}`, false, false);
          if (!id) throw new Error(`Page ${n} could not be rendered`);
          const el = ea.getElement(id);
          const h = Math.round((width * size.h) / size.w);
          el.width = width;
          el.height = h;
          el.locked = true;
          el.customData = {
            ...(el.customData ?? {}),
            [INK_CUSTOM_DATA_KEY]: { role: "pdf-page", pdf: pdf.path, page: n, sourceWidth: size.w, sourceHeight: size.h } satisfies InkCustomData,
          };
          // a thin, locked border so the white page stands out on the white canvas
          ea.style.strokeColor = "#9e9e9e";
          ea.style.backgroundColor = "transparent";
          ea.style.strokeWidth = 1;
          ea.style.roughness = 0;
          ea.style.strokeStyle = "solid";
          const borderId = ea.addRect(0, y, width, h);
          const border = ea.getElement(borderId);
          border.locked = true;
          border.roundness = null;
          border.customData = { ...(border.customData ?? {}), [INK_CUSTOM_DATA_KEY]: { role: "page-border" } satisfies InkCustomData };
          y += h + PAGE_GAP;
        }
      },
    });
    if (created) new Notice(`Ready – write on the pages. Use "Export annotated PDF" to save a copy with your notes.`, 6000);
  } catch (e) {
    plugin.switcher.reportError("Could not open the PDF for annotation", e);
  } finally {
    notice?.hide();
  }
}

export async function annotateImage(plugin: InkNotebookPlugin, file?: TFile | null, leaf?: WorkspaceLeaf): Promise<void> {
  const img = file ?? (await FilePickModal.pick(plugin.app, ["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"], "Choose an image to annotate…"));
  if (!img) return;
  try {
    await plugin.switcher.createPage({
      name: `${img.basename} (annotated)`,
      leaf,
      build: async (ea) => {
        const id = await ea.addImage(0, 0, img, false, false);
        if (!id) throw new Error("The image could not be loaded");
        const el = ea.getElement(id);
        const maxW = 1400;
        if (el.width > maxW) {
          el.height = Math.round((el.height * maxW) / el.width);
          el.width = maxW;
        }
        el.locked = true;
        el.customData = {
          ...(el.customData ?? {}),
          [INK_CUSTOM_DATA_KEY]: { role: "image-page", image: img.path, sourceWidth: el.width, sourceHeight: el.height } satisfies InkCustomData,
        };
      },
    });
  } catch (e) {
    plugin.switcher.reportError("Could not open the image for annotation", e);
  }
}

/** Elements drawn on top of a page (everything except page backgrounds and our helpers). */
function overlayFor(elements: ReadonlyArray<ExElement>, page: Rect, pageIds: Set<string>): ExElement[] {
  return elements.filter((e) => {
    if (e.isDeleted || pageIds.has(e.id)) return false;
    const role = getInkData(e)?.role;
    if (role === "region" || role === "paper" || role === "pdf-page" || role === "image-page" || role === "page-border") return false;
    if ((e.type === "frame" || e.type === "magicframe") && e.frameRole === "marker") return false;
    const r = elementRect(e);
    if (!intersects(r, page)) return false;
    // page-sized images/boxes (e.g. from Excalidraw's own PDF import) are backgrounds
    const inter = intersection(r, page);
    if (inter && area(inter) >= 0.85 * area(page) && (e.type === "image" || (e.type === "rectangle" && e.locked))) return false;
    return true;
  });
}

async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
  if (!blob) throw new Error("Could not encode image");
  return new Uint8Array(await blob.arrayBuffer());
}

function activeExcalidrawView(plugin: InkNotebookPlugin, leaf?: WorkspaceLeaf | null): ExcalidrawViewLike | null {
  const v = (leaf ?? plugin.app.workspace.getMostRecentLeaf())?.view;
  if (isExcalidrawView(v)) return v;
  return null;
}

async function writeBinary(plugin: InkNotebookPlugin, path: string, data: ArrayBuffer): Promise<TFile> {
  const existing = plugin.app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) {
    await plugin.app.vault.modifyBinary(existing, data);
    return existing;
  }
  return plugin.app.vault.createBinary(path, data);
}

export async function exportAnnotatedPdf(plugin: InkNotebookPlugin, leaf?: WorkspaceLeaf | null): Promise<void> {
  const view = activeExcalidrawView(plugin, leaf);
  if (!view?.file) {
    new Notice("Open the annotated ink page first, then run this command again.");
    return;
  }
  const elements = viewElements(view);
  const pages = findPdfPages(plugin, elements, view.file.path);
  if (pages.length === 0) {
    new Notice("This ink page has no PDF pages. Use \"Annotate PDF\" to start one.");
    return;
  }
  const ea = getEA(plugin.app, view);
  if (typeof ea.createViewPNG !== "function") {
    release(ea);
    new Notice("Exporting needs a newer version of the Excalidraw plugin (2.20 or later). Please update Excalidraw.", 8000);
    return;
  }
  const notice = new Notice("Exporting annotated PDF…", 0);
  try {
    const pageIds = new Set(pages.map((p) => p.element.id));
    const byPdf = new Map<string, PdfPageRef[]>();
    for (const p of pages) byPdf.set(p.pdfPath, [...(byPdf.get(p.pdfPath) ?? []), p]);
    const written: TFile[] = [];
    for (const [pdfPath, refs] of byPdf) {
      const src = plugin.app.vault.getAbstractFileByPath(pdfPath);
      if (!(src instanceof TFile)) {
        new Notice(`The PDF "${pdfPath}" was not found – skipped.`);
        continue;
      }
      const doc = await PDFDocument.load(await plugin.app.vault.readBinary(src), { ignoreEncryption: true, updateMetadata: false });
      let annotated = 0;
      for (const ref of refs) {
        if (ref.page < 1 || ref.page > doc.getPageCount()) continue;
        const overlay = overlayFor(elements, ref.rect, pageIds);
        if (overlay.length === 0) continue;
        notice.setMessage(`Exporting page ${ref.page}…`);
        const page = doc.getPage(ref.page - 1);
        const crop = page.getCropBox();
        const rotation = normalizeRotation(page.getRotation().angle);
        const disp = displayedSize(crop.width, crop.height, rotation);
        // ~150 dpi, capped to keep memory reasonable on tablets
        const targetW = Math.min(2400, Math.max(600, disp.width * 2.1));
        const scale = targetW / Math.max(1, ref.rect.w);
        const blob = await ea.createViewPNG({
          elementsOverride: overlay,
          exportArea: { x: ref.rect.x, y: ref.rect.y, width: ref.rect.w, height: ref.rect.h },
          withBackground: false,
          padding: 0,
          scale,
          theme: "light",
        });
        if (!blob) continue;
        const img = await blobToImage(blob);
        const k = img.width / disp.width;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(crop.width * k));
        canvas.height = Math.max(1, Math.round(crop.height * k));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas is not available");
        const t = unrotateTransform(canvas.width, canvas.height, rotation);
        ctx.translate(t.tx, t.ty);
        ctx.rotate(t.angle);
        ctx.drawImage(img, 0, 0, img.width, img.height);
        const png = await doc.embedPng(await canvasPng(canvas));
        page.drawImage(png, { x: crop.x, y: crop.y, width: crop.width, height: crop.height });
        annotated++;
      }
      if (annotated === 0) {
        new Notice(`No ink on the pages of "${src.basename}" yet – nothing to export.`);
        continue;
      }
      const bytes = await doc.save();
      const folder = view.file.parent?.path ?? "";
      const out = normalizePath(`${folder}/${src.basename} (annotated).pdf`);
      written.push(await writeBinary(plugin, out, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    }
    notice.hide();
    if (written.length > 0) {
      new Notice(`Saved ${written.map((f) => f.path).join(", ")}`, 8000);
      await plugin.app.workspace.getLeaf("tab").openFile(written[0]);
    }
  } catch (e) {
    notice.hide();
    plugin.switcher.reportError("Export failed", e);
  } finally {
    release(ea);
  }
}

export async function exportAnnotatedImage(plugin: InkNotebookPlugin, leaf?: WorkspaceLeaf | null): Promise<void> {
  const view = activeExcalidrawView(plugin, leaf);
  if (!view?.file) {
    new Notice("Open the annotated ink page first.");
    return;
  }
  const elements = viewElements(view);
  const pageEl = elements.find((e) => getInkData(e)?.role === "image-page");
  if (!pageEl) {
    new Notice("This ink page has no annotated image.");
    return;
  }
  const ea = getEA(plugin.app, view);
  try {
    if (typeof ea.createViewPNG !== "function") {
      new Notice("Exporting needs a newer version of the Excalidraw plugin. Please update Excalidraw.");
      return;
    }
    const rect = elementRect(pageEl);
    const data = getInkData(pageEl);
    const scale = Math.max(1, (data?.sourceWidth ?? rect.w) / rect.w);
    const blob = await ea.createViewPNG({
      exportArea: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
      withBackground: true,
      padding: 0,
      scale,
      theme: "light",
    });
    if (!blob) throw new Error("Nothing was exported");
    const base = data?.image ? (data.image.split("/").pop() ?? "image").replace(/\.[^.]+$/, "") : view.file.basename;
    const out = normalizePath(`${view.file.parent?.path ?? ""}/${base} (annotated).png`);
    const file = await writeBinary(plugin, out, await blob.arrayBuffer());
    new Notice(`Saved ${file.path}`);
    await plugin.app.workspace.getLeaf("tab").openFile(file);
  } catch (e) {
    plugin.switcher.reportError("Export failed", e);
  } finally {
    release(ea);
  }
}
