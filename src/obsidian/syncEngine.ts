import { App, Notice, TFile } from "obsidian";
import { classifyScene, DEFAULT_CLASSIFY_OPTIONS } from "../core/classify";
import { cardPosition } from "../core/placement";
import { DEFAULT_LAYOUT_OPTIONS, layoutTranscript, type TranscriptBlock } from "../core/layout";
import { isInkStroke, planOcrUnits } from "../core/rasterPlan";
import { planRegions, type RegionPlan } from "../core/regions";
import { mergeTranscript, parseNote, stripMarkers, writeRegion } from "../core/transcript";
import { applyTypedNotes, decideTypedSync, extractTypedNotes, typedHash } from "../core/typedNotes";
import { classifyOptionsFor, isOcrConfigured, type InkSettings } from "../settings";
import { elementText, getInkData, INK_CUSTOM_DATA_KEY, type ExElement, type InkCustomData } from "../types/excalidraw";
import {
  findExcalidrawView,
  getEA,
  isViewReady,
  isViewSettled,
  newElementId,
  NO_UNDO,
  readSceneFromFile,
  release,
  saveView,
  viewElements,
  type EA,
  type ExcalidrawViewLike,
} from "./excalidrawBridge";
import { findHandwrittenLinks, LINK_MARK_KEY, planLinkUpdates, type LinkPlan } from "../core/links";
import { elementRect } from "../core/geometry";
import type { OcrService, OcrStatus } from "./ocrService";
import type { PairManager } from "./pairs";

/**
 * Keeps the two sides of an ink page in sync:
 *   ink → text: handwriting is recognised and written into the transcript region
 *   text → ink: typed notes are mirrored onto the drawing as a text card
 */

export type PageState = "idle" | "working" | "pending" | "offline" | "error" | "not-configured";

export interface PageStatus {
  state: PageState;
  message?: string;
  updated: number;
}

export interface InkToTextOptions {
  /** The open drawing to update; `null` = read the file only; omitted = find a settled open view. */
  view?: ExcalidrawViewLike | null;
  /** Allow requests to Azure. */
  network: boolean;
  /** Discard edits made inside the transcript region. */
  resetEdits?: boolean;
  /** Give up on OCR requests after this many ms (unrecognised ink is shown as an image). */
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
  /**
   * drawing path -> typed-notes hash at the last sync, when it could not be stored on
   * the card (drawing not open). Takes precedence over the card's syncedHash.
   */
  private typedBase = new Map<string, string>();

  private baseHash(drawingPath: string, card: ExElement | undefined): string | undefined {
    return this.typedBase.get(drawingPath) ?? (card ? getInkData(card)?.syncedHash : undefined);
  }

  /** Record the typed-notes base, on the card if the drawing is open, otherwise in memory. */
  private async setBase(drawing: TFile, view: ExcalidrawViewLike | null, card: ExElement | undefined, hash: string): Promise<void> {
    if (view && card && view.file?.path === drawing.path) {
      await this.updateCardHash(view, card.id, hash);
      this.typedBase.delete(drawing.path);
    } else {
      this.typedBase.set(drawing.path, hash);
    }
  }
  readonly status = new Map<string, PageStatus>();
  onStatusChange: () => void = () => {};

  constructor(
    private app: App,
    private pairs: PairManager,
    private ocr: OcrService,
    private getSettings: () => InkSettings,
    private queue: { add(path: string): void; remove(path: string): void },
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
    const m = this.lastComplete.get(drawing.path);
    return m !== undefined && drawing.stat.mtime <= m;
  }

  forget(path: string): void {
    this.lastComplete.delete(path);
    this.status.delete(path);
  }

  statusOf(path: string): PageStatus | undefined {
    return this.status.get(path);
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
    try {
      // `view: null` means "file only" (background work must not touch a drawing that is
      // still loading); `undefined` means "use the open drawing if there is a settled one".
      let view = opts.view === undefined ? findExcalidrawView(this.app, drawing, true) : opts.view;
      // a view that is still loading (or shows another file) is not used: read the file instead
      if (view && !(view.file?.path === drawing.path && isViewReady(view) && isViewSettled(view))) view = null;
      const elements = view ? viewElements(view) : await readSceneFromFile(this.app, drawing);
      if (!elements) throw new Error("The drawing could not be read");

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

      // the OCR await can be long: the view may have closed or switched to another drawing
      const canModify = !!view && view.file?.path === drawing.path && isViewReady(view);
      const liveView = canModify ? view : null;

      // 3. diagram regions (only modifiable while the drawing is open)
      const existingRegions = elements
        .filter((e) => getInkData(e)?.role === "region")
        .map((e) => ({ id: e.id, rect: { x: e.x, y: e.y, w: e.width, h: e.height } }));
      const plan = planRegions(classified.diagrams, existingRegions, canModify, newElementId);

      // 3b. handwritten [[links]] become clickable on the ink page
      let linkPlan: LinkPlan = { set: [], clear: [] };
      if (liveView && settings.linkHandwriting) {
        const rects = new Map(strokes.map((s) => [s.id, elementRect(s)] as const));
        const wanted = findHandwrittenLinks(classified.lines, rects);
        const current = strokes.map((s) => {
          const mark = s.customData?.[LINK_MARK_KEY];
          return { id: s.id, link: s.link, ours: typeof mark === "string" ? mark : undefined };
        });
        linkPlan = planLinkUpdates(wanted, current);
      }
      if (liveView && (plan.create.length > 0 || plan.update.length > 0 || plan.remove.length > 0 || linkPlan.set.length > 0 || linkPlan.clear.length > 0)) {
        await this.applyDrawingUpdates(liveView, plan, linkPlan);
      }

      // 4. typed notes: copy edits made on the card to the text page (3-way, see decideTypedSync)
      const before = await this.app.vault.read(text);
      let pulledTyped: string | null = null;
      let newBase: string | null = null;
      const card = settings.syncTypedNotes ? elements.find((e) => getInkData(e)?.role === "typed") : undefined;
      if (card) {
        const cardText = elementText(card);
        const cardHash = typedHash(cardText);
        const action = decideTypedSync(cardHash, typedHash(extractTypedNotes(before)), this.baseHash(drawing.path, card));
        if (action === "pull") {
          pulledTyped = cardText;
          newBase = cardHash;
        } else if (action === "mark") {
          newBase = cardHash;
        }
        // push/conflict: the text page wins; the card is updated by the next text → ink sync
      }

      // 5. layout
      const blocks = layoutTranscript(classified, (d) => plan.refs.get(d) ?? null, {
        ...DEFAULT_LAYOUT_OPTIONS,
        drawingLink: this.pairs.linkText(drawing, text.path),
        linkFor: (path) => {
          const f = this.app.vault.getAbstractFileByPath(path);
          return f instanceof TFile ? this.pairs.linkText(f, text?.path ?? "") : path;
        },
        highlightThreshold: settings.highlightUncertain ? settings.uncertainThreshold : 0,
      });
      const hasPendingInk = classified.pendingInk.length > 0;
      const status = statusBlock(outcome.status, hasPendingInk, outcome.error, isOcrConfigured(settings));
      if (status) blocks.unshift(status);

      // 6. write the text page (only if something changed)
      let preservedEdits = 0;
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
        let out = writeRegion(src, merged.blocks, merged.state);
        if (pulledTyped !== null) out = applyTypedNotes(out, pulledTyped);
        return out;
      };
      const after = compute(before);
      let changed = false;
      if (after !== before) {
        await this.app.vault.process(text, (cur) => (cur === before ? after : compute(cur)));
        changed = true;
      }

      // 7. remember the new typed-notes base
      if (newBase !== null) await this.setBase(drawing, liveView, card, newBase);

      // 8. offline queue + status
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
      if (pending === 0) this.lastComplete.set(drawing.path, drawing.stat.mtime);
      else this.lastComplete.delete(drawing.path);
      return { text, status: outcome.status, pending, changed, preservedEdits };
    } catch (e) {
      this.setStatus(drawing.path, "error", e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  /**
   * Add/replace elements without an undo step and persist them. Excalidraw does
   * not mark the drawing dirty for changes outside the undo history, so the
   * drawing is force-saved explicitly.
   */
  private async commit(ea: EA, view: ExcalidrawViewLike, onTop: boolean, restore = false): Promise<void> {
    await ea.addElementsToView(false, false, onTop, restore, NO_UNDO);
    await saveView(view);
  }

  /** Region rectangles and handwritten links, applied in one batch. */
  private async applyDrawingUpdates(view: ExcalidrawViewLike, plan: RegionPlan, links: LinkPlan): Promise<void> {
    const ea = getEA(this.app, view);
    try {
      const byId = new Map(viewElements(view).map((e) => [e.id, e] as const));
      const removals = plan.remove.map((id) => byId.get(id)).filter((e): e is ExElement => !!e);
      if (removals.length > 0) ea.deleteViewElements(removals);
      const linkIds = [...links.set.map((l) => l.strokeId), ...links.clear].filter((id) => byId.has(id));
      if (linkIds.length > 0) {
        ea.copyViewElementsToEAforEditing([...new Set(linkIds)].map((id) => byId.get(id) as ExElement));
        for (const l of links.set) {
          if (!byId.has(l.strokeId)) continue;
          const m = ea.getElement(l.strokeId);
          m.link = l.link;
          m.customData = { ...(m.customData ?? {}), [LINK_MARK_KEY]: l.link };
        }
        for (const id of links.clear) {
          if (!byId.has(id)) continue;
          const m = ea.getElement(id);
          m.link = null;
          const cd = { ...(m.customData ?? {}) };
          delete cd[LINK_MARK_KEY];
          m.customData = cd;
        }
      }
      const updates = plan.update.filter((u) => byId.has(u.id));
      if (updates.length > 0) {
        ea.copyViewElementsToEAforEditing(updates.map((u) => byId.get(u.id) as ExElement));
        for (const u of updates) {
          const m = ea.getElement(u.id);
          m.x = u.rect.x;
          m.y = u.rect.y;
          m.width = u.rect.w;
          m.height = u.rect.h;
        }
      }
      for (const c of plan.create) {
        ea.style.strokeColor = "transparent";
        ea.style.backgroundColor = "transparent";
        ea.style.strokeWidth = 1;
        ea.style.roughness = 0;
        ea.style.opacity = 100;
        ea.addRect(c.rect.x, c.rect.y, c.rect.w, c.rect.h, c.id);
        const m = ea.getElement(c.id);
        m.locked = true;
        m.customData = { ...(m.customData ?? {}), [INK_CUSTOM_DATA_KEY]: { role: "region", kind: "diagram" } satisfies InkCustomData };
      }
      if (updates.length > 0 || plan.create.length > 0 || linkIds.length > 0) await this.commit(ea, view, false);
      else if (removals.length > 0) await saveView(view);
    } finally {
      release(ea);
    }
  }

  private async updateCardHash(view: ExcalidrawViewLike, cardId: string, hash: string): Promise<void> {
    const ea = getEA(this.app, view);
    try {
      const card = viewElements(view).find((e) => e.id === cardId);
      if (!card) return;
      ea.copyViewElementsToEAforEditing([card]);
      const m = ea.getElement(cardId);
      const data = getInkData(card) ?? { role: "typed" };
      m.customData = { ...(m.customData ?? {}), [INK_CUSTOM_DATA_KEY]: { ...data, syncedHash: hash } };
      await this.commit(ea, view, true);
    } finally {
      release(ea);
    }
  }

  // ------------------------------------------------------------------ text → ink

  syncTextToInk(text: TFile, drawing: TFile, view: ExcalidrawViewLike): Promise<boolean> {
    return this.withLock(drawing.path, () => this.doTextToInk(text, drawing, view));
  }

  private async doTextToInk(text: TFile, drawing: TFile, view: ExcalidrawViewLike): Promise<boolean> {
    const settings = this.getSettings();
    if (!settings.syncTypedNotes || view.file?.path !== drawing.path) return false;
    const md = await this.app.vault.read(text);
    if (view.file?.path !== drawing.path || !isViewReady(view)) return false;
    const typed = extractTypedNotes(md);
    const hash = typedHash(typed);
    const elements = viewElements(view);
    const card = elements.find((e) => getInkData(e)?.role === "typed");
    const cardText = card ? elementText(card) : null;
    const action = decideTypedSync(cardText === null ? null : typedHash(cardText), hash, this.baseHash(drawing.path, card));

    switch (action) {
      case "none":
        return false;
      case "mark":
        await this.setBase(drawing, view, card, hash);
        return false;
      case "pull": {
        // only the card changed (e.g. edited on the drawing, then the app was closed)
        const pulled = cardText ?? "";
        await this.app.vault.process(text, (cur) => applyTypedNotes(cur, pulled));
        await this.setBase(drawing, view, card, typedHash(pulled));
        return false;
      }
      case "conflict":
        new Notice("Ink Notebook: typed notes were changed on both pages – the text page version was kept.", 6000);
        break;
      default:
        break;
    }

    // push: the text page wins
    this.typedBase.delete(drawing.path);
    if (!card) {
      if (!typed) return false;
      await this.createCard(view, elements, typed, hash);
      return true;
    }
    const ea = getEA(this.app, view);
    try {
      if (!typed) {
        ea.deleteViewElements([card]);
        await saveView(view);
        return true;
      }
      ea.copyViewElementsToEAforEditing([card]);
      const m = ea.getElement(card.id);
      m.text = typed;
      m.originalText = typed;
      m.rawText = typed;
      m.customData = { ...(m.customData ?? {}), [INK_CUSTOM_DATA_KEY]: { role: "typed", syncedHash: hash } satisfies InkCustomData };
      // let Excalidraw re-wrap the text to the card width
      await this.commit(ea, view, true, true);
      return true;
    } finally {
      release(ea);
    }
  }

  /** Does the typed card on the drawing show the text page's typed notes? */
  async typedCardInSync(text: TFile, view: ExcalidrawViewLike): Promise<boolean> {
    const typed = extractTypedNotes(await this.app.vault.read(text));
    const card = viewElements(view).find((e) => getInkData(e)?.role === "typed");
    if (!card) return !typed;
    return typedHash(elementText(card)) === typedHash(typed);
  }

  private async createCard(view: ExcalidrawViewLike, elements: ExElement[], typed: string, hash: string): Promise<void> {
    const settings = this.getSettings();
    const pos = cardPosition(elements, settings.typedWidth);
    const ea = getEA(this.app, view);
    try {
      ea.style.strokeColor = "#1e1e1e";
      ea.style.backgroundColor = "transparent";
      ea.style.fontFamily = settings.typedFontFamily;
      ea.style.fontSize = settings.typedFontSize;
      ea.style.textAlign = "left";
      ea.style.opacity = 100;
      const id = ea.addText(pos.x, pos.y, typed, { width: pos.width, autoResize: false });
      const m = ea.getElement(id);
      m.customData = { ...(m.customData ?? {}), [INK_CUSTOM_DATA_KEY]: { role: "typed", syncedHash: hash } satisfies InkCustomData };
      await this.commit(ea, view, true, true);
    } finally {
      release(ea);
    }
  }
}

function statusBlock(status: OcrStatus, hasPendingInk: boolean, error: string | undefined, configured: boolean): TranscriptBlock | null {
  if (!hasPendingInk) return null;
  if (!configured || status === "not-configured") {
    return {
      key: "status",
      md: "> [!ink-status] ✍️ Handwriting is shown as an image\n> Set up handwriting recognition in *Settings → Ink Notebook* to turn it into searchable text.",
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
    md: "> [!ink-status] ✍️ Transcription in progress\n> Some handwriting is still being recognised and is shown as an image for now.",
  };
}
