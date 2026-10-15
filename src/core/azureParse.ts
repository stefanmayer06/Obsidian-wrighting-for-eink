import { rectFromPoints, type Pt, type Rect } from "./geometry";
import type { OcrLine, OcrResult, OcrWord } from "./ocrTypes";

/**
 * Parsers for Azure AI Vision OCR responses.
 *
 * - "v4": Image Analysis 4.0 (`/computervision/imageanalysis:analyze?features=read`)
 * - "v3": Read API 3.2 (`/vision/v3.2/read/analyze` + polling `analyzeResults`)
 *
 * The parsers never throw on unexpected shapes; they skip anything malformed.
 */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function polygonFromV4(poly: unknown): Rect | null {
  if (!Array.isArray(poly)) return null;
  const pts: Pt[] = [];
  for (const p of poly) {
    if (isObj(p) && typeof p.x === "number" && typeof p.y === "number") pts.push({ x: p.x, y: p.y });
  }
  return rectFromPoints(pts);
}

function polygonFromFlat(box: unknown): Rect | null {
  if (!Array.isArray(box) || box.length < 4) return null;
  const pts: Pt[] = [];
  for (let i = 0; i + 1 < box.length; i += 2) {
    const x = box[i];
    const y = box[i + 1];
    if (typeof x === "number" && typeof y === "number") pts.push({ x, y });
  }
  return rectFromPoints(pts);
}

/** Parse an Image Analysis 4.0 response (`readResult.blocks[].lines[]`). */
export function parseAzureV4(json: unknown): OcrResult {
  const lines: OcrLine[] = [];
  const root = isObj(json) ? json : {};
  const readResult = isObj(root.readResult) ? root.readResult : {};
  const blocks = Array.isArray(readResult.blocks) ? readResult.blocks : [];
  for (const block of blocks) {
    if (!isObj(block) || !Array.isArray(block.lines)) continue;
    for (const line of block.lines) {
      if (!isObj(line)) continue;
      const box = polygonFromV4(line.boundingPolygon);
      const text = str(line.text).trim();
      if (!box || !text) continue;
      const words: OcrWord[] = [];
      if (Array.isArray(line.words)) {
        for (const w of line.words) {
          if (!isObj(w)) continue;
          const wb = polygonFromV4(w.boundingPolygon);
          const wt = str(w.text).trim();
          if (!wb || !wt) continue;
          words.push({ text: wt, confidence: num(w.confidence, 1), box: wb });
        }
      }
      lines.push({ text, box, words });
    }
  }
  const meta = isObj(root.metadata) ? root.metadata : {};
  return {
    lines,
    width: typeof meta.width === "number" ? meta.width : undefined,
    height: typeof meta.height === "number" ? meta.height : undefined,
    provider: "azure-v4",
  };
}

export type ReadV3Status = "notStarted" | "running" | "succeeded" | "failed" | "unknown";

export function readV3Status(json: unknown): ReadV3Status {
  if (!isObj(json)) return "unknown";
  const s = str(json.status);
  if (s === "notStarted" || s === "running" || s === "succeeded" || s === "failed") return s;
  return "unknown";
}

/** Parse a Read 3.2 `analyzeResults` response (`analyzeResult.readResults[].lines[]`). */
export function parseAzureV3(json: unknown): OcrResult {
  const lines: OcrLine[] = [];
  const root = isObj(json) ? json : {};
  const analyze = isObj(root.analyzeResult) ? root.analyzeResult : {};
  const pages = Array.isArray(analyze.readResults) ? analyze.readResults : [];
  let width: number | undefined;
  let height: number | undefined;
  for (const page of pages) {
    if (!isObj(page)) continue;
    if (width === undefined && typeof page.width === "number") width = page.width;
    if (height === undefined && typeof page.height === "number") height = page.height;
    if (!Array.isArray(page.lines)) continue;
    for (const line of page.lines) {
      if (!isObj(line)) continue;
      const box = polygonFromFlat(line.boundingBox);
      const text = str(line.text).trim();
      if (!box || !text) continue;
      const words: OcrWord[] = [];
      if (Array.isArray(line.words)) {
        for (const w of line.words) {
          if (!isObj(w)) continue;
          const wb = polygonFromFlat(w.boundingBox);
          const wt = str(w.text).trim();
          if (!wb || !wt) continue;
          words.push({ text: wt, confidence: num(w.confidence, 1), box: wb });
        }
      }
      lines.push({ text, box, words });
    }
  }
  return { lines, width, height, provider: "azure-v3.2" };
}

/** Extract a human readable error message from an Azure error body. */
export function azureErrorMessage(json: unknown, status: number): string {
  if (isObj(json)) {
    const err = isObj(json.error) ? json.error : json;
    const code = str(err.code);
    const message = str(err.message);
    const inner = isObj(err.innererror) ? str(err.innererror.message) : "";
    const text = [code, message || inner].filter(Boolean).join(": ");
    if (text) return text;
  }
  switch (status) {
    case 401:
      return "Access denied – check the Azure key (401)";
    case 403:
      return "Forbidden – the key is not allowed to use this resource (403)";
    case 404:
      return "Not found – check the Azure endpoint URL (404)";
    case 429:
      return "Too many requests – Azure rate limit reached (429)";
    default:
      return `Azure request failed (HTTP ${status})`;
  }
}

/** Normalise a user-entered endpoint: trims, adds https:// and removes trailing slashes/paths. */
export function normalizeEndpoint(input: string): string {
  let e = (input ?? "").trim();
  if (!e) return "";
  if (!/^https?:\/\//i.test(e)) e = `https://${e}`;
  try {
    const url = new URL(e);
    return `${url.protocol}//${url.host}`;
  } catch {
    return e.replace(/\/+$/, "");
  }
}
