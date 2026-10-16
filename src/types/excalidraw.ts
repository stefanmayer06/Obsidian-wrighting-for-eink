/**
 * Minimal structural typings for the parts of the Excalidraw plugin
 * (obsidian-excalidraw-plugin) that Ink Notebook uses.
 *
 * We deliberately do not depend on the plugin's own typings package: it is
 * very large, changes often and would tie this plugin to one exact version.
 * Everything here is accessed defensively at runtime (see excalidrawBridge.ts).
 */

export type Point = readonly [number, number];

/** The subset of Excalidraw element fields we read or write. */
export interface ExElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  isDeleted?: boolean;
  locked?: boolean;
  opacity?: number;
  strokeWidth?: number;
  strokeColor?: string;
  backgroundColor?: string;
  points?: ReadonlyArray<Point>;
  pressures?: ReadonlyArray<number>;
  simulatePressure?: boolean;
  text?: string;
  originalText?: string;
  rawText?: string;
  fontSize?: number;
  fontFamily?: number;
  containerId?: string | null;
  frameId?: string | null;
  frameRole?: string | null;
  groupIds?: ReadonlyArray<string>;
  boundElements?: ReadonlyArray<{ id: string; type: string }> | null;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  link?: string | null;
  name?: string | null;
  fileId?: string | null;
  version?: number;
  customData?: Record<string, unknown>;
}

/** Ink Notebook metadata stored in `element.customData.inkNotebook`. */
export type InkRole = "region" | "typed" | "paper" | "pdf-page" | "image-page" | "page-border";

export interface InkCustomData {
  role: InkRole;
  /** For typed cards: hash of the text that was last synced from the text page. */
  syncedHash?: string;
  /** For pdf pages: vault path of the PDF and 1-based page number. */
  pdf?: string;
  page?: number;
  /** For image pages: vault path of the annotated image. */
  image?: string;
  /** Page size in PDF points (pdf pages) or pixels (image pages). */
  sourceWidth?: number;
  sourceHeight?: number;
  /** For region rectangles: what the region is used for. */
  kind?: "diagram";
  /** For paper pages: the template (style, spacing, colour, orientation). */
  paper?: { style: string; spacing: string; color: string; orientation: string };
}

export const INK_CUSTOM_DATA_KEY = "inkNotebook";

export function getInkData(el: ExElement): InkCustomData | undefined {
  const data = el.customData?.[INK_CUSTOM_DATA_KEY];
  if (data && typeof data === "object" && typeof (data as InkCustomData).role === "string") {
    return data as InkCustomData;
  }
  return undefined;
}

/** Text of a text element as typed by the user (with [[links]] preserved). */
export function elementText(el: ExElement): string {
  return el.rawText ?? el.originalText ?? el.text ?? "";
}
