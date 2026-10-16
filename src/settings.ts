import { DEFAULT_PAPER, isPaperStyle, normalizePaperSpec, type PaperSpec } from "./core/paper";
import { cleanSubfolder } from "./core/folders";

export type AzureApi = "auto" | "v4" | "v3.2";
export type EinkMode = "auto" | "on" | "off";
export type BookmarkPosition = "top" | "middle" | "bottom";
export type TextViewMode = "reading" | "editing" | "keep";
export type DiagramSensitivity = "low" | "normal" | "high";
/** current: the folder of the note you are in; fixed: always `folder`. */
export type PageLocation = "current" | "fixed";

export interface InkSettings {
  /** Setup wizard completed (or dismissed). */
  setupDone: boolean;

  // ---- pages ----
  pageLocation: PageLocation;
  /** Folder for new pages when pageLocation is "fixed" (and when no note is open). */
  folder: string;
  /** Subfolder (of the text page's folder) for the drawings and paper files; "" = next to the text page. */
  inkSubfolder: string;
  /** Paper for new pages. */
  paper: PaperSpec;
  /** Show the paper picker when creating a page. */
  askForPaper: boolean;
  textViewMode: TextViewMode;
  askForPageName: boolean;
  keepNamesInSync: boolean;

  // ---- handwriting recognition ----
  azureEndpoint: string;
  azureKey: string;
  azureApi: AzureApi;
  /** API detected by "auto" (remembered so we do not probe every time). */
  azureDetectedApi: "" | "v4" | "v3.2";
  azureLanguage: string;
  requestsPerMinute: number;
  transcribeTimeoutSec: number;
  autoTranscribe: boolean;
  highlightUncertain: boolean;
  uncertainThreshold: number;
  diagramSensitivity: DiagramSensitivity;
  /** Make handwritten [[links]] clickable on the ink page. */
  linkHandwriting: boolean;

  // ---- typed notes ----
  syncTypedNotes: boolean;
  typedFontFamily: number;
  typedFontSize: number;
  typedWidth: number;

  // ---- display ----
  einkMode: EinkMode;
  bookmarkPosition: BookmarkPosition;
  showBookmarkOnAllDrawings: boolean;
  largeTouchTargets: boolean;

  // ---- pdf ----
  pdfPageWidth: number;
  pdfMaxPagesWithoutAsking: number;

  // ---- internal ----
  /** Drawing paths waiting for handwriting recognition (offline queue). */
  queue: string[];
}

export const DEFAULT_SETTINGS: InkSettings = {
  setupDone: false,
  pageLocation: "current",
  folder: "Ink",
  inkSubfolder: "Attachments",
  paper: DEFAULT_PAPER,
  askForPaper: true,
  textViewMode: "reading",
  askForPageName: false,
  keepNamesInSync: true,

  azureEndpoint: "",
  azureKey: "",
  azureApi: "auto",
  azureDetectedApi: "",
  azureLanguage: "",
  requestsPerMinute: 18,
  transcribeTimeoutSec: 15,
  autoTranscribe: false,
  highlightUncertain: true,
  uncertainThreshold: 0.6,
  diagramSensitivity: "normal",
  linkHandwriting: true,

  syncTypedNotes: true,
  typedFontFamily: 6,
  typedFontSize: 20,
  typedWidth: 560,

  einkMode: "auto",
  bookmarkPosition: "top",
  showBookmarkOnAllDrawings: true,
  largeTouchTargets: true,

  pdfPageWidth: 1000,
  pdfMaxPagesWithoutAsking: 30,

  queue: [],
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function numberIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

/** Merge stored data with defaults, validating every field (corrupt data must never break the plugin). */
export function loadSettings(raw: unknown): InkSettings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    setupDone: bool(r.setupDone, d.setupDone),
    pageLocation: oneOf(r.pageLocation, ["current", "fixed"] as const, d.pageLocation),
    folder: str(r.folder, d.folder).replace(/^\/+|\/+$/g, ""),
    inkSubfolder: cleanSubfolder(str(r.inkSubfolder, d.inkSubfolder)),
    // older versions stored only the style
    paper: normalizePaperSpec(r.paper ?? (isPaperStyle(r.paperStyle) ? { style: r.paperStyle } : undefined), d.paper),
    askForPaper: bool(r.askForPaper, d.askForPaper),
    textViewMode: oneOf(r.textViewMode, ["reading", "editing", "keep"] as const, d.textViewMode),
    askForPageName: bool(r.askForPageName, d.askForPageName),
    keepNamesInSync: bool(r.keepNamesInSync, d.keepNamesInSync),

    azureEndpoint: str(r.azureEndpoint, d.azureEndpoint).trim(),
    azureKey: str(r.azureKey, d.azureKey).trim(),
    azureApi: oneOf(r.azureApi, ["auto", "v4", "v3.2"] as const, d.azureApi),
    azureDetectedApi: oneOf(r.azureDetectedApi, ["", "v4", "v3.2"] as const, d.azureDetectedApi),
    azureLanguage: str(r.azureLanguage, d.azureLanguage).trim(),
    requestsPerMinute: numberIn(r.requestsPerMinute, 1, 600, d.requestsPerMinute),
    transcribeTimeoutSec: numberIn(r.transcribeTimeoutSec, 3, 120, d.transcribeTimeoutSec),
    autoTranscribe: bool(r.autoTranscribe, d.autoTranscribe),
    highlightUncertain: bool(r.highlightUncertain, d.highlightUncertain),
    uncertainThreshold: numberIn(r.uncertainThreshold, 0, 1, d.uncertainThreshold),
    diagramSensitivity: oneOf(r.diagramSensitivity, ["low", "normal", "high"] as const, d.diagramSensitivity),
    linkHandwriting: bool(r.linkHandwriting, d.linkHandwriting),

    syncTypedNotes: bool(r.syncTypedNotes, d.syncTypedNotes),
    typedFontFamily: numberIn(r.typedFontFamily, 1, 10, d.typedFontFamily),
    typedFontSize: numberIn(r.typedFontSize, 8, 72, d.typedFontSize),
    typedWidth: numberIn(r.typedWidth, 200, 2000, d.typedWidth),

    einkMode: oneOf(r.einkMode, ["auto", "on", "off"] as const, d.einkMode),
    bookmarkPosition: oneOf(r.bookmarkPosition, ["top", "middle", "bottom"] as const, d.bookmarkPosition),
    showBookmarkOnAllDrawings: bool(r.showBookmarkOnAllDrawings, d.showBookmarkOnAllDrawings),
    largeTouchTargets: bool(r.largeTouchTargets, d.largeTouchTargets),

    pdfPageWidth: numberIn(r.pdfPageWidth, 300, 4000, d.pdfPageWidth),
    pdfMaxPagesWithoutAsking: numberIn(r.pdfMaxPagesWithoutAsking, 1, 1000, d.pdfMaxPagesWithoutAsking),

    queue: Array.isArray(r.queue) ? r.queue.filter((q): q is string => typeof q === "string").slice(0, 500) : [],
  };
}

export function isOcrConfigured(s: InkSettings): boolean {
  return !!s.azureEndpoint && !!s.azureKey;
}

export function classifyOptionsFor(s: InkSettings): { diagramGap: number; minDiagramSize: number } {
  switch (s.diagramSensitivity) {
    case "low":
      return { diagramGap: 20, minDiagramSize: 110 };
    case "high":
      return { diagramGap: 45, minDiagramSize: 40 };
    default:
      return { diagramGap: 30, minDiagramSize: 60 };
  }
}
