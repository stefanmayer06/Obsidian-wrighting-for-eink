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

/** A freedraw stroke through the given points (densified like real pen input). */
export function poly(id: string, pts: ReadonlyArray<[number, number]>, extra: Partial<ExElement> = {}): ExElement {
  const dense: Array<[number, number]> = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      dense.push(pts[0]);
      continue;
    }
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 3));
    for (let k = 1; k <= n; k++) dense.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  const [ox, oy] = dense[0];
  const xs = dense.map((p) => p[0]);
  const ys = dense.map((p) => p[1]);
  return {
    id,
    type: "freedraw",
    x: ox,
    y: oy,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
    points: dense.map(([x, y]) => [x - ox, y - oy] as [number, number]),
    strokeWidth: 1,
    version: version++,
    ...extra,
  };
}

/** OCR line from explicit words (text + box). */
export function wordsLine(words: ReadonlyArray<[string, Rect]>, confidence = 0.95): OcrLine {
  const boxes = words.map((w) => w[1]);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const r = Math.max(...boxes.map((b) => b.x + b.w));
  const btm = Math.max(...boxes.map((b) => b.y + b.h));
  return {
    text: words.map((w) => w[0]).join(" "),
    box: { x, y, w: r - x, h: btm - y },
    words: words.map(([text, box]) => word(text, box, confidence)),
  };
}
