import { App, TFile, WorkspaceLeaf, type View } from "obsidian";
import type { ExElement } from "../types/excalidraw";

/**
 * All access to the Excalidraw plugin goes through this file.
 * Excalidraw is built into Ink Notebook (see bundledExcalidraw.ts), but the
 * user's own Excalidraw plugin is used instead when it is enabled, so this may
 * be any Excalidraw version. The Excalidraw plugin exposes "ExcalidrawAutomate"
 * (EA) for scripting; we only use documented EA methods and guard every call
 * so that a different Excalidraw version degrades gracefully instead of
 * breaking Ink Notebook.
 */

export const EXCALIDRAW_PLUGIN_ID = "obsidian-excalidraw-plugin";
export const EXCALIDRAW_VIEW_TYPE = "excalidraw";
export const MIN_EXCALIDRAW_VERSION = "2.0.0";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** The parts of ExcalidrawView we use. */
export interface ExcalidrawViewLike extends View {
  file: TFile | null;
  excalidrawAPI?: Any;
  semaphores?: { viewloaded?: boolean; viewunload?: boolean; justLoaded?: boolean } | null;
  /** true once the drawing has been loaded into the canvas */
  isLoaded?: boolean;
  /** set when Excalidraw has finished loading embedded images (0 = not yet) */
  lastSceneLoadTime?: number;
  forceSave?: (silent?: boolean, waitIfBusy?: boolean) => Promise<void>;
  save?: (preventReload?: boolean, forcesave?: boolean) => Promise<void>;
  getViewElements?: () => readonly ExElement[];
}

/** The parts of ExcalidrawAutomate we use. */
export interface EA {
  style: Record<string, Any>;
  canvas: Record<string, Any>;
  targetView: ExcalidrawViewLike | null;
  reset(): void;
  clear(): void;
  destroy?(): void;
  setView(view?: Any, show?: boolean): ExcalidrawViewLike | null;
  getViewElements(): readonly ExElement[];
  getElement(id: string): ExElement & Record<string, Any>;
  getElements(): Array<ExElement & Record<string, Any>>;
  copyViewElementsToEAforEditing(elements: readonly ExElement[], copyImages?: boolean): void;
  addElementsToView(
    repositionToCursor?: boolean,
    save?: boolean,
    newElementsOnTop?: boolean,
    shouldRestoreElements?: boolean,
    captureUpdate?: string,
  ): Promise<boolean>;
  deleteViewElements(elements: readonly ExElement[]): boolean;
  addRect(x: number, y: number, w: number, h: number, id?: string): string;
  addText(x: number, y: number, text: string, formatting?: Record<string, Any>, id?: string): string;
  addImage(x: number, y: number, file: TFile | string, scale?: boolean, anchor?: boolean): Promise<string>;
  wrapText?(text: string, lineLen: number): string;
  refreshTextElementSize?(id: string): void;
  getSceneFromFile(file: TFile): Promise<{ elements: ExElement[]; appState: Any } | null>;
  create(params: Record<string, Any>): Promise<string>;
  createViewPNG?(options: Record<string, Any>): Promise<Blob | undefined>;
  viewZoomToElements?(select: boolean, elements: readonly ExElement[]): void;
  isExcalidrawFile?(f: TFile): boolean;
  verifyMinimumPluginVersion?(v: string): boolean;
  generateElementId?(): string;
}

interface ExcalidrawPluginLike {
  ea?: EA & { getAPI(view?: Any): EA };
  settings?: Record<string, Any>;
  saveSettings?: () => Promise<void>;
  isExcalidrawFile?: (f: TFile) => boolean;
  manifest?: { version?: string };
}

export function getExcalidrawPlugin(app: App): ExcalidrawPluginLike | null {
  const plugins = (app as Any).plugins;
  const p = plugins?.plugins?.[EXCALIDRAW_PLUGIN_ID] ?? plugins?.getPlugin?.(EXCALIDRAW_PLUGIN_ID);
  return p ?? null;
}

export function isExcalidrawReady(app: App): boolean {
  const p = getExcalidrawPlugin(app);
  return !!p?.ea && typeof p.ea.getAPI === "function";
}

export function excalidrawVersion(app: App): string | null {
  const p = getExcalidrawPlugin(app);
  return p?.manifest?.version ?? (app as Any).plugins?.manifests?.[EXCALIDRAW_PLUGIN_ID]?.version ?? null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export class ExcalidrawMissingError extends Error {
  constructor(message = "The Excalidraw plugin is not installed or not enabled.") {
    super(message);
    this.name = "ExcalidrawMissingError";
  }
}

/** A fresh EA instance (call `release(ea)` afterwards). */
export function getEA(app: App, view?: ExcalidrawViewLike | null): EA {
  const p = getExcalidrawPlugin(app);
  if (!p?.ea || typeof p.ea.getAPI !== "function") throw new ExcalidrawMissingError();
  const ea = p.ea.getAPI(view ?? undefined);
  if (view) ea.setView(view);
  return ea;
}

export function release(ea: EA | null | undefined): void {
  try {
    ea?.destroy?.();
  } catch {
    /* ignore */
  }
}

export function isExcalidrawFile(app: App, file: TFile | null | undefined): boolean {
  if (!file || !(file instanceof TFile)) return false;
  if (file.extension === "excalidraw") return true;
  if (file.extension !== "md") return false;
  const p = getExcalidrawPlugin(app);
  try {
    if (p?.isExcalidrawFile) return p.isExcalidrawFile(file);
  } catch {
    /* fall through */
  }
  const fm = app.metadataCache.getFileCache(file)?.frontmatter;
  return !!fm && fm["excalidraw-plugin"] !== undefined;
}

export function isExcalidrawView(view: View | null | undefined): view is ExcalidrawViewLike {
  return !!view && view.getViewType() === EXCALIDRAW_VIEW_TYPE;
}

/**
 * Find an open, loaded Excalidraw view showing the file.
 * With `settled`, the view must also have finished loading its embedded images
 * (only then is it safe to change elements, see waitForExcalidrawView).
 */
export function findExcalidrawView(app: App, file: TFile, settled = false): ExcalidrawViewLike | null {
  for (const leaf of app.workspace.getLeavesOfType(EXCALIDRAW_VIEW_TYPE)) {
    const v = leaf.view;
    if (isExcalidrawView(v) && v.file?.path === file.path && isViewReady(v) && (!settled || isViewSettled(v))) return v;
  }
  return null;
}

export function isViewSettled(view: ExcalidrawViewLike): boolean {
  return !view.semaphores?.justLoaded && view.lastSceneLoadTime !== 0;
}

export function isViewReady(view: ExcalidrawViewLike): boolean {
  return !!view.excalidrawAPI && !!view.semaphores?.viewloaded && !view.semaphores?.viewunload && view.isLoaded !== false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));

/** Wait until the leaf shows a loaded Excalidraw view of `path`. */
export async function waitForExcalidrawView(leaf: WorkspaceLeaf, path: string, timeoutMs = 15000): Promise<ExcalidrawViewLike | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = leaf.view;
    if (isExcalidrawView(v) && v.file?.path === path && isViewReady(v)) {
      // Excalidraw clears "justLoaded" on the first change after the scene is in the canvas;
      // editing before that can be overwritten by the tail end of loading.
      const settle = Date.now();
      while (v.semaphores?.justLoaded && Date.now() - settle < 3000) await sleep(100);
      // When embedded images (paper, PDF pages) finish loading, Excalidraw refreshes the
      // scene; edits made before that can be lost, so wait for it (older versions: no field).
      while (v.lastSceneLoadTime === 0 && Date.now() - settle < 6000) await sleep(100);
      await sleep(300);
      return v;
    }
    await sleep(100);
  }
  return null;
}

/** Live (non-deleted) scene elements of a view. */
export function viewElements(view: ExcalidrawViewLike): ExElement[] {
  try {
    const els: readonly ExElement[] = view.excalidrawAPI?.getSceneElements?.() ?? view.getViewElements?.() ?? [];
    return els.filter((e) => !e.isDeleted);
  } catch {
    return [];
  }
}

export async function saveView(view: ExcalidrawViewLike): Promise<void> {
  try {
    if (view.forceSave) await view.forceSave(true, true);
    else if (view.save) await view.save(false, true);
  } catch (e) {
    console.warn("Ink Notebook: could not save drawing", e);
  }
}

/** Read a drawing's elements from disk (works when the drawing is not open). */
export async function readSceneFromFile(app: App, file: TFile): Promise<ExElement[] | null> {
  const ea = getEA(app);
  try {
    const scene = await ea.getSceneFromFile(file);
    return scene?.elements?.filter((e) => !e.isDeleted) ?? null;
  } finally {
    release(ea);
  }
}

/**
 * Excalidraw's "do not record in undo history" capture mode. Our helper changes
 * (diagram regions, the typed-notes card) should not be undone by the user's
 * next undo; older Excalidraw versions simply ignore the argument.
 */
export const NO_UNDO = "NEVER";

/** Random id compatible with Excalidraw ids. */
export function newElementId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let id = "";
  for (const b of bytes) id += chars[b % chars.length];
  return `ink${id}`;
}

/** Excalidraw pen settings that work well on e-ink tablets with a stylus. */
export const EINK_EXCALIDRAW_SETTINGS: Record<string, unknown> = {
  defaultPenMode: "always",
  penModeDoubleTapEraser: true,
  penModeSingleFingerPanning: true,
  penModeCrosshairVisible: false,
  dynamicStyling: "none",
  zoomToFitOnOpen: true,
};

export function excalidrawSettingsDiff(app: App): string[] {
  const p = getExcalidrawPlugin(app);
  const s = p?.settings;
  if (!s) return [];
  return Object.entries(EINK_EXCALIDRAW_SETTINGS)
    .filter(([k, v]) => k in s && s[k] !== v)
    .map(([k]) => k);
}

export async function applyEinkExcalidrawSettings(app: App): Promise<boolean> {
  const p = getExcalidrawPlugin(app);
  if (!p?.settings || !p.saveSettings) return false;
  for (const [k, v] of Object.entries(EINK_EXCALIDRAW_SETTINGS)) {
    if (k in p.settings) p.settings[k] = v;
  }
  await p.saveSettings();
  return true;
}
