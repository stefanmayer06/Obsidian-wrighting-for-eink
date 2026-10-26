import { App, Notice, TFile } from "obsidian";
import { classifyScene, DEFAULT_CLASSIFY_OPTIONS } from "../core/classify";
import { DEFAULT_LAYOUT_OPTIONS, layoutTranscript, type TranscriptBlock } from "../core/layout";
import { isInkStroke, planOcrUnits } from "../core/rasterPlan";
import { planRegions } from "../core/regions";
import { mergeTranscript, parseNote, stripMarkers, writeRegion } from "../core/transcript";
import { classifyOptionsFor, isOcrConfigured, type InkSettings } from "../settings";
import { getInkData } from "../core/scene";
import { findHandwrittenLinks } from "../core/links";
import { elementRect } from "../core/geometry";
import { newId, type InkFile, type InkMeta } from "../core/ink/model";
import { parseInkFile, serializeInkFile } from "../core/ink/codec";
import { inkScene, regionsFromScene } from "../core/ink/scene";
import type { OcrService, OcrStatus } from "./ocrService";
import type { PairManager } from "./pairs";
import type { InkView } from "./inkView";

/**
 * Turns the handwriting of an ink page into its text page: strokes are
 * recognised (OCR), classified into writing, tables, checkboxes and drawings,
 * and laid out as Markdown in the transcript region. Drawings get a diagram
 * area in the notebook, which the text page shows live (`ink-figure` blocks);
 * handwritten [[links]] become tappable on the ink page.
 */

export type PageState = "idle" | "working" | "pending" | "offline" | "error" | "not-configured";

export interface PageStatus {
  state: PageState;
  message?: string;
  updated: number;
}

export interface InkToTextOptions {
  /** Allow requests to the recognition service. */
  network: boolean;
  /** Discard edits made inside the transcript region. */
  resetEdits?: boolean;
  /** Give up on OCR requests after this many ms (unrecognised ink is shown as a picture). */
  timeoutMs?: number;
  /** Create the text page if it does not exist. */
  createText?: boolean;
}

export interface InkToTextResult {
  text: TFile | null;
  status: OcrStatus;
  pending: number;
  changed: boolean;
  preservedEdits: number;
}

export class SyncEngine {
  private locks = new Map<string, Promise<unknown>>();
  /** drawing path -> drawing mtime at the last complete (nothing pending) sync */
  private lastComplete = new Map<string, number>();
  /** drawing path -> the notebook version that was last fully synced (open views) */
  private lastDoc = new Map<string, unknown>();
  readonly status = new Map<string, PageStatus>();
  onStatusChange: () => void = () => {};

  constructor(
    private app: App,
    private pairs: PairManager,
    private ocr: OcrService,
    private getSettings: () => InkSettings,
    private queue: { add(path: string): void; remove(path: string): void },
    private findView: (drawing: TFile) => InkView | null,
  ) {}

  /** Run tasks for the same drawing one after another. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(key, next);
    const cleanup = () => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private setStatus(path: string, state: PageState, message?: string): void {
    this.status.set(path, { state, message, updated: Date.now() });
    try {
      this.onStatusChange();
    } catch (e) {
      console.error(e);
    }
  }

  /** True if the drawing has not changed since it was last fully synced. */
  isUpToDate(drawing: TFile): boolean {
    const live = this.findView(drawing)?.inkFile;
    if (live) return this.lastDoc.get(drawing.path) === live.doc;
    const m = this.lastComplete.get(drawing.path);
    return m !== undefined && drawing.stat.mtime <= m;
  }

  forget(path: string): void {
    this.lastComplete.delete(path);
    this.lastDoc.delete(path);
    this.status.delete(path);
  }

  statusOf(path: string): PageStatus | undefined {
    return this.status.get(path);
  }

  /** The notebook: from the open view (with unsaved changes) or from the file. */
  async readInk(drawing: TFile): Promise<InkFile> {
    const live = this.findView(drawing)?.inkFile;
    if (live) return live;
    return parseInkFile(await this.app.vault.read(drawing));
  }

  /** Store new metadata (diagram areas, handwritten links) in the notebook, without an undo step. */
  private async writeMeta(drawing: TFile, meta: InkMeta): Promise<void> {
    const view = this.findView(drawing);
    if (view?.inkFile) {
      view.setMeta(meta);
      return;
    }
    await this.app.vault.process(drawing, (data) => {
      const f = parseInkFile(data);
      return serializeInkFile(f.frontmatter, { doc: f.doc, meta });
    });
  }

  // ------------------------------------------------------------------ ink → text

  syncInkToText(drawing: TFile, opts: InkToTextOptions): Promise<InkToTextResult> {
    return this.withLock(drawing.path, () => this.doInkToText(drawing, opts));
  }

  private async doInkToText(drawing: TFile, opts: InkToTextOptions): Promise<InkToTextResult> {
    const settings = this.getSettings();
    let text = this.pairs.textFor(drawing);
    if (!text) {
      if (!opts.createText) {
        this.queue.remove(drawing.path);
        return { text: null, status: "ok", pending: 0, changed: false, preservedEdits: 0 };
      }
      text = await this.pairs.createTextPage(drawing);
    }
    this.setStatus(drawing.path, "working");
    const mtimeAtStart = drawing.stat.mtime;
    try {
      const ink = await this.readInk(drawing);
      const { elements, offsets } = inkScene(ink.doc, ink.meta);

      // 1. handwriting recognition
      const strokes = elements.filter((e) => isInkStroke(e) && !getInkData(e));
      const units = planOcrUnits(strokes, 150);
      const byId = new Map(elements.map((e) => [e.id, e] as const));
      const outcome = await this.ocr.recognizeUnits(units, byId, {
        network: opts.network,
        deadline: Date.now() + (opts.timeoutMs ?? settings.transcribeTimeoutSec * 1000),
      });

      // 2. classify the scene
      const classified = classifyScene(elements, outcome.lines, outcome.pendingIds, {
        ...DEFAULT_CLASSIFY_OPTIONS,
        ...classifyOptionsFor(settings),
      });

      // 3. diagram areas and handwritten links (stored in the notebook, not undoable)
      const existing = elements
        .filter((e) => getInkData(e)?.role === "region")
        .map((e) => ({ id: e.id, rect: { x: e.x, y: e.y, w: e.width, h: e.height } }));
      const plan = planRegions(classified.diagrams, existing, true, () => newId());
      const regions = regionsFromScene(ink.doc, offsets, ink.meta.regions, plan);
      const handLinks: Record<string, string> = {};
      if (settings.linkHandwriting) {
        const rects = new Map(strokes.map((s) => [s.id, elementRect(s)] as const));
        for (const l of findHandwrittenLinks(classified.lines, rects)) handLinks[l.strokeId] = l.link;
        // links on handwriting still waiting for recognition stay as they were
        for (const [id, link] of Object.entries(ink.meta.handLinks)) if (outcome.pendingIds.has(id)) handLinks[id] = link;
      }
      const meta: InkMeta = { regions, handLinks };
      if (JSON.stringify(meta) !== JSON.stringify(ink.meta)) await this.writeMeta(drawing, meta);

      // 4. layout
      const blocks = layoutTranscript(classified, (d) => plan.refs.get(d) ?? null, {
        ...DEFAULT_LAYOUT_OPTIONS,
        drawingPath: drawing.path,
        linkFor: (path) => {
          const f = this.app.vault.getAbstractFileByPath(path);
          return f instanceof TFile ? this.pairs.linkText(f, text?.path ?? "") : path;
        },
        highlightThreshold: settings.highlightUncertain ? settings.uncertainThreshold : 0,
      });
      const hasPendingInk = classified.pendingInk.length > 0;
      const status = statusBlock(outcome.status, hasPendingInk, outcome.error, isOcrConfigured(settings));
      if (status) blocks.unshift(status);

      // 5. write the text page (only if something changed)
      let preservedEdits = 0;
      const before = await this.app.vault.read(text);
      const compute = (md: string): string => {
        let src = md;
        let parsed = parseNote(src);
        if (parsed.damaged) {
          src = stripMarkers(src);
          parsed = parseNote(src);
          new Notice("Ink Notebook: the transcript markers on the text page were damaged and have been rebuilt.");
        }
        const merged = mergeTranscript(opts.resetEdits ? "" : parsed.inner, opts.resetEdits ? [] : parsed.state, blocks, {
          keepMissing: !opts.resetEdits && outcome.pendingIds.size > 0,
        });
        preservedEdits = merged.preservedEdits;
        return writeRegion(src, merged.blocks, merged.state);
      };
      const after = compute(before);
      let changed = false;
      if (after !== before) {
        await this.app.vault.process(text, (cur) => (cur === before ? after : compute(cur)));
        changed = true;
      }

      // 6. offline queue + status
      const pending = outcome.pendingIds.size;
      if (pending > 0 && isOcrConfigured(settings) && outcome.status !== "not-configured") this.queue.add(drawing.path);
      else this.queue.remove(drawing.path);
      const state: PageState =
        pending === 0
          ? "idle"
          : outcome.status === "offline"
            ? "offline"
            : outcome.status === "error"
              ? "error"
              : outcome.status === "not-configured"
                ? "not-configured"
                : "pending";
      this.setStatus(drawing.path, state, outcome.error);
      if (pending === 0) {
        this.lastComplete.set(drawing.path, Math.max(mtimeAtStart, drawing.stat.mtime));
        this.lastDoc.set(drawing.path, ink.doc);
      } else {
        this.lastComplete.delete(drawing.path);
        this.lastDoc.delete(drawing.path);
      }
      return { text, status: outcome.status, pending, changed, preservedEdits };
    } catch (e) {
      this.setStatus(drawing.path, "error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }
}

function statusBlock(status: OcrStatus, hasPendingInk: boolean, error: string | undefined, configured: boolean): TranscriptBlock | null {
  if (!hasPendingInk) return null;
  if (!configured || status === "not-configured") {
    return {
      key: "status",
      md: "> [!ink-status] ✍️ Handwriting is shown as a picture\n> Set up handwriting recognition in *Settings → Ink Notebook* to turn it into searchable text.",
    };
  }
  if (status === "offline") {
    return {
      key: "status",
      md: "> [!ink-status] ✍️ Waiting for a connection\n> Your handwriting will be transcribed automatically when you are online again.",
    };
  }
  if (status === "error") {
    return {
      key: "status",
      md: `> [!ink-status] ✍️ Handwriting recognition failed\n> ${(error ?? "Unknown error").replace(/\n/g, " ")} – it will be retried automatically.`,
    };
  }
  return {
    key: "status",
    md: "> [!ink-status] ✍️ Transcription in progress\n> Some handwriting is still being recognised and is shown as a picture for now.",
  };
}
