import { requestUrl, type RequestUrlResponse } from "obsidian";
import { azureErrorMessage, normalizeEndpoint, parseAzureV3, parseAzureV4, readV3Status } from "../core/azureParse";
import type { OcrResult } from "../core/ocrTypes";

/**
 * Azure AI Vision OCR client. Uses Obsidian's `requestUrl`, which works on
 * desktop and mobile (no CORS issues).
 */

export type ApiVersion = "v4" | "v3.2";

export interface AzureConfig {
  endpoint: string;
  key: string;
  api: ApiVersion;
  language: string;
  timeoutMs: number;
}

/** No network (or the request could not be sent). Retry later. */
export class OfflineError extends Error {
  constructor(message = "No internet connection") {
    super(message);
    this.name = "OfflineError";
  }
}

export class AzureHttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs: number | null,
    /** Errors that will not go away by retrying (bad key, bad endpoint …). */
    public permanent: boolean,
  ) {
    super(message);
    this.name = "AzureHttpError";
  }
}

const NETWORK_ERROR_RE = /ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_NETWORK|ERR_CONNECTION|ERR_ADDRESS|ERR_TIMED_OUT|net::|Failed to fetch|NetworkError|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up|timed out|Network request failed|Unable to resolve host/i;

export function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine !== false;
}

function header(res: RequestUrlResponse, name: string): string | null {
  const headers = res.headers ?? {};
  const want = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === want) return headers[k];
  return null;
}

function safeJson(res: RequestUrlResponse): unknown {
  try {
    return res.json;
  } catch {
    try {
      return JSON.parse(res.text);
    } catch {
      return null;
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new OfflineError("The request timed out")), ms);
    p.then(
      (v) => {
        window.clearTimeout(t);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function send(params: Parameters<typeof requestUrl>[0], timeoutMs: number): Promise<RequestUrlResponse> {
  if (!isOnline()) throw new OfflineError();
  try {
    const req = typeof params === "string" ? { url: params, throw: false } : { ...params, throw: false };
    return await withTimeout(requestUrl(req), timeoutMs);
  } catch (e) {
    if (e instanceof OfflineError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (!isOnline() || NETWORK_ERROR_RE.test(msg)) throw new OfflineError(msg);
    throw new AzureHttpError(msg, 0, null, false);
  }
}

function errorFor(res: RequestUrlResponse): AzureHttpError {
  const json = safeJson(res);
  const retryAfter = header(res, "retry-after");
  const retryMs = retryAfter && /^\d+$/.test(retryAfter) ? parseInt(retryAfter, 10) * 1000 : null;
  const permanent = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 415;
  return new AzureHttpError(azureErrorMessage(json, res.status), res.status, retryMs, permanent);
}

async function recognizeV4(png: ArrayBuffer, cfg: AzureConfig): Promise<OcrResult> {
  const url = `${normalizeEndpoint(cfg.endpoint)}/computervision/imageanalysis:analyze?features=read&model-version=latest&api-version=2024-02-01`;
  const res = await send(
    {
      url,
      method: "POST",
      contentType: "application/octet-stream",
      headers: { "Ocp-Apim-Subscription-Key": cfg.key },
      body: png,
    },
    cfg.timeoutMs,
  );
  if (res.status < 200 || res.status >= 300) throw errorFor(res);
  return parseAzureV4(safeJson(res));
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function recognizeV3(png: ArrayBuffer, cfg: AzureConfig): Promise<OcrResult> {
  const lang = cfg.language ? `&language=${encodeURIComponent(cfg.language)}` : "";
  const url = `${normalizeEndpoint(cfg.endpoint)}/vision/v3.2/read/analyze?readingOrder=natural${lang}`;
  const started = Date.now();
  const res = await send(
    {
      url,
      method: "POST",
      contentType: "application/octet-stream",
      headers: { "Ocp-Apim-Subscription-Key": cfg.key },
      body: png,
    },
    cfg.timeoutMs,
  );
  if (res.status !== 202 && (res.status < 200 || res.status >= 300)) throw errorFor(res);
  const op = header(res, "operation-location");
  if (!op) throw new AzureHttpError("Azure did not return an operation location", res.status, null, false);
  let delay = 500;
  while (Date.now() - started < cfg.timeoutMs) {
    await sleep(delay);
    delay = Math.min(1500, delay + 250);
    const poll = await send({ url: op, method: "GET", headers: { "Ocp-Apim-Subscription-Key": cfg.key } }, cfg.timeoutMs);
    if (poll.status === 429) {
      await sleep(1500);
      continue;
    }
    if (poll.status < 200 || poll.status >= 300) throw errorFor(poll);
    const json = safeJson(poll);
    const status = readV3Status(json);
    if (status === "succeeded") return parseAzureV3(json);
    if (status === "failed") throw new AzureHttpError("Azure could not read the image", poll.status, null, false);
  }
  throw new OfflineError("Azure took too long to answer");
}

export async function recognize(png: ArrayBuffer, cfg: AzureConfig): Promise<OcrResult> {
  if (!cfg.endpoint || !cfg.key) throw new AzureHttpError("Handwriting recognition is not set up", 0, null, true);
  return cfg.api === "v4" ? recognizeV4(png, cfg) : recognizeV3(png, cfg);
}

/** Errors meaning "this API version is not available for this resource/region". */
export function isApiUnavailable(e: unknown): boolean {
  if (!(e instanceof AzureHttpError)) return false;
  if (e.status === 404) return true;
  return /NotSupported|not supported|InvalidRequest.*(feature|region)|Resource not found|unsupported/i.test(e.message);
}

/** A tiny white PNG with the word "Test" drawn in black, used for the connection test. */
export async function testImagePng(): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 120;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000000";
  ctx.font = "bold 64px sans-serif";
  ctx.fillText("Hello", 40, 85);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not create test image");
  return blob.arrayBuffer();
}
