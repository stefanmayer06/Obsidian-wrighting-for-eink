/**
 * The "scene": a flat list of elements that the recognition pipeline
 * (OCR planning, classification, layout) works on. An ink notebook is turned
 * into a scene by `inkScene` (core/ink/scene.ts): its pages are stacked top to
 * bottom and every stroke, shape, text box and image becomes one element in
 * those shared scene coordinates.
 *
 * The element shape is deliberately simple and generic: linear elements
 * ("freedraw" for handwriting, "line"/"arrow" for shapes) store their points
 * relative to (x, y); everything else is a box.
 */

export type Point = readonly [number, number];

export interface SceneElement {
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
  text?: string;
  originalText?: string;
  rawText?: string;
  fontSize?: number;
  containerId?: string | null;
  frameId?: string | null;
  frameRole?: string | null;
  groupIds?: ReadonlyArray<string>;
  startBinding?: { elementId: string } | null;
  endBinding?: { elementId: string } | null;
  link?: string | null;
  name?: string | null;
  version?: number;
  customData?: Record<string, unknown>;
}

/** Ink Notebook metadata stored in `element.customData.inkNotebook`. */
export type InkRole = "region" | "typed" | "paper" | "pdf-page" | "image-page" | "page-border";

export interface InkCustomData {
  role: InkRole;
  /** For pdf pages: vault path of the PDF and 1-based page number. */
  pdf?: string;
  page?: number;
  /** For image pages: vault path of the annotated image. */
  image?: string;
  /** For region rectangles: what the region is used for. */
  kind?: "diagram";
  /** For paper pages: the template (style, spacing, colour, orientation). */
  paper?: { style: string; spacing: string; color: string; orientation: string };
}

export const INK_CUSTOM_DATA_KEY = "inkNotebook";

export function getInkData(el: SceneElement): InkCustomData | undefined {
  const data = el.customData?.[INK_CUSTOM_DATA_KEY];
  if (data && typeof data === "object" && typeof (data as InkCustomData).role === "string") {
    return data as InkCustomData;
  }
  return undefined;
}

/** Text of a text element as typed by the user (with [[links]] preserved). */
export function elementText(el: SceneElement): string {
  return el.rawText ?? el.originalText ?? el.text ?? "";
}
