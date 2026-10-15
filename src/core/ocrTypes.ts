import type { Rect } from "./geometry";

/** A recognised word. Coordinates are in the coordinate space of the owning result. */
export interface OcrWord {
  text: string;
  confidence: number;
  box: Rect;
}

/** A recognised line of text. */
export interface OcrLine {
  text: string;
  box: Rect;
  words: OcrWord[];
}

/** Provider-independent OCR result. */
export interface OcrResult {
  lines: OcrLine[];
  /** Image size the coordinates refer to (if known). */
  width?: number;
  height?: number;
  /** Which API produced this result (for diagnostics). */
  provider?: string;
}

/** Map every coordinate of an OCR result with the given rectangle transform. */
export function mapOcrResult(result: OcrResult, mapRect: (r: Rect) => Rect): OcrResult {
  return {
    ...result,
    lines: result.lines.map((line) => ({
      text: line.text,
      box: mapRect(line.box),
      words: line.words.map((w) => ({ text: w.text, confidence: w.confidence, box: mapRect(w.box) })),
    })),
  };
}
