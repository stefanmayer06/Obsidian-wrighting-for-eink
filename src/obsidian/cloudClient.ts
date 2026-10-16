import type { RequestUrlResponse } from "obsidian";
import { cloudError, isPermanentCloudError, parseCloudInfo, parseCloudResult, parseCloudStatus, type CloudInfo, type CloudStatus } from "../core/cloud";
import type { OcrResult } from "../core/ocrTypes";
import { AzureHttpError, header, safeJson, send } from "./azureClient";

/** Client for Ink Notebook Cloud (see src/core/cloud.ts and supabase/functions/ocr). */

export interface CloudConfig {
  endpoint: string;
  licenseKey: string;
  language: string;
  timeoutMs: number;
}

function errorFor(res: RequestUrlResponse): AzureHttpError {
  const { code, message } = cloudError(safeJson(res), res.status);
  const retryAfter = header(res, "retry-after");
  const retryMs = retryAfter && /^\d+$/.test(retryAfter) ? parseInt(retryAfter, 10) * 1000 : null;
  return new AzureHttpError(message, res.status, retryMs, isPermanentCloudError(res.status, code));
}

export async function recognizeCloud(png: ArrayBuffer, cfg: CloudConfig): Promise<OcrResult> {
  if (!cfg.licenseKey) throw new AzureHttpError("Enter your Ink Notebook Cloud license key in the settings", 0, null, true);
  const lang = cfg.language ? `?language=${encodeURIComponent(cfg.language)}` : "";
  const res = await send(
    {
      url: `${cfg.endpoint}/recognize${lang}`,
      method: "POST",
      contentType: "application/octet-stream",
      headers: { "X-License-Key": cfg.licenseKey },
      body: png,
    },
    cfg.timeoutMs,
  );
  if (res.status < 200 || res.status >= 300) throw errorFor(res);
  return parseCloudResult(header(res, "x-ink-api"), safeJson(res));
}

/** Subscription state and this month's usage (does not use up a recognition). */
export async function fetchCloudStatus(cfg: CloudConfig): Promise<CloudStatus> {
  const res = await send({ url: `${cfg.endpoint}/status`, method: "GET", headers: { "X-License-Key": cfg.licenseKey } }, cfg.timeoutMs);
  if (res.status < 200 || res.status >= 300) throw errorFor(res);
  const status = parseCloudStatus(safeJson(res));
  if (!status) throw new AzureHttpError("Unexpected answer from Ink Notebook Cloud", res.status, null, false);
  return status;
}

let infoCache: { endpoint: string; info: Promise<CloudInfo | null> } | null = null;

/** What the service offers. Cached for the session; null (and not cached) when it could not be reached. */
export function getCloudInfo(endpoint: string): Promise<CloudInfo | null> {
  if (infoCache?.endpoint === endpoint) return infoCache.info;
  const info: Promise<CloudInfo | null> = send({ url: `${endpoint}/info`, method: "GET" }, 10000)
    .then((res) => (res.status === 200 ? parseCloudInfo(safeJson(res)) : null))
    .catch(() => null)
    .then((result) => {
      if (!result && infoCache?.info === info) infoCache = null;
      return result;
    });
  infoCache = { endpoint, info };
  return info;
}
