import type { ExElement } from "../src/types/excalidraw";
import type { OcrLine, OcrWord } from "../src/core/ocrTypes";
import type { Rect } from "../src/core/geometry";

let version = 1;

/** A zig-zag freedraw stroke filling the given box (like a handwritten word). */
export function stroke(id: string, x: number, y: number, w: number, h: number, extra: Partial<ExElement> = {}): ExElement {
  const points: Array<[number, number]> = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    points.push([(w * i) / n, i % 2 === 0 ? 0 : h]);
  }
  return { id, type: "freedraw", x, y, width: w, height: h, points, strokeWidth: 1, version: version++, ...extra };
}

/** A hand-drawn rectangle outline as a single freedraw stroke. */
export function boxStroke(id: string, x: number, y: number, w: number, h: number): ExElement {
  const pts: Array<[number, number]> = [];
  const steps = 20;
  for (let i = 0; i <= steps; i++) pts.push([(w * i) / steps, 0]);
  for (let i = 0; i <= steps; i++) pts.push([w, (h * i) / steps]);
  for (let i = steps; i >= 0; i--) pts.push([(w * i) / steps, h]);
  for (let i = steps; i >= 0; i--) pts.push([0, (h * i) / steps]);
  return { id, type: "freedraw", x, y, width: w, height: h, points: pts, strokeWidth: 1, version: version++ };
}

export function shape(id: string, type: string, x: number, y: number, w: number, h: number, extra: Partial<ExElement> = {}): ExElement {
  return { id, type, x, y, width: w, height: h, version: version++, ...extra };
}

export function textEl(id: string, text: string, x: number, y: number, w = 200, h = 25, extra: Partial<ExElement> = {}): ExElement {
  return { id, type: "text", x, y, width: w, height: h, text, originalText: text, rawText: text, fontSize: 20, version: version++, ...extra };
}

export function word(text: string, box: Rect, confidence = 0.95): OcrWord {
  return { text, box, confidence };
}

/** OCR line whose words are laid out evenly across the box. */
export function line(text: string, box: Rect, confidence = 0.95): OcrLine {
  const parts = text.split(/\s+/).filter(Boolean);
  const ww = box.w / Math.max(1, parts.length);
  return {
    text,
    box,
    words: parts.map((p, i) => word(p, { x: box.x + i * ww, y: box.y, w: ww * 0.9, h: box.h }, confidence)),
  };
}
