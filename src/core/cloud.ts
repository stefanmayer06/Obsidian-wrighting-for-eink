import { parseAzureV3, parseAzureV4 } from "./azureParse";
import type { OcrResult } from "./ocrTypes";

/**
 * Ink Notebook Cloud: handwriting recognition by subscription (no Azure
 * account needed). The server lives in supabase/functions/ocr; it checks the
 * license key, counts usage and forwards the image to Azure AI Vision.
 */

export const CLOUD_ENDPOINT = "https://qbqbrchglnowdbagrrjr.supabase.co/functions/v1/ocr";

export interface CloudInfo {
  /** The service is offered (set up and open for subscriptions). */
  available: boolean;
  monthlyLimit: number;
  checkoutUrl: string;
  portalUrl: string;
  privacyUrl: string;
}

export interface CloudStatus {
  used: number;
  limit: number;
  /** When the monthly allowance renews (ISO date). */
  resetsAt: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Only https links are opened from the server's answer. */
function httpsUrl(v: unknown): string {
  return typeof v === "string" && /^https:\/\/\S+$/i.test(v) ? v : "";
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export function parseCloudInfo(json: unknown): CloudInfo | null {
  if (!isObj(json) || typeof json.available !== "boolean") return null;
  const checkoutUrl = httpsUrl(json.checkoutUrl);
  return {
    available: json.available && !!checkoutUrl,
    monthlyLimit: count(json.monthlyLimit),
    checkoutUrl,
    portalUrl: httpsUrl(json.portalUrl),
    privacyUrl: httpsUrl(json.privacyUrl),
  };
}

export function parseCloudStatus(json: unknown): CloudStatus | null {
  if (!isObj(json) || json.active !== true) return null;
  return { used: count(json.used), limit: count(json.limit), resetsAt: typeof json.resetsAt === "string" ? json.resetsAt : "" };
}

/** The recognition result: Azure's answer, passed through by the server. */
export function parseCloudResult(api: string | null, json: unknown): OcrResult {
  return api === "v3.2" ? parseAzureV3(json) : parseAzureV4(json);
}

export interface CloudError {
  code: string;
  message: string;
}

export function cloudError(json: unknown, status: number): CloudError {
  const err = isObj(json) && isObj(json.error) ? json.error : {};
  const code = typeof err.code === "string" ? err.code : "";
  const message = typeof err.message === "string" && err.message ? err.message : `Ink Notebook Cloud request failed (HTTP ${status})`;
  return { code, message };
}

/** Errors that retrying will not fix until the user acts (key, subscription, allowance). */
export function isPermanentCloudError(status: number, code: string): boolean {
  return status === 401 || status === 403 || status === 413 || status === 415 || status === 422 || code === "quota_exceeded";
}

export function formatCloudStatus(s: CloudStatus): string {
  const used = `${s.used.toLocaleString()} of ${s.limit.toLocaleString()} recognitions used this month`;
  const t = Date.parse(s.resetsAt);
  if (!Number.isFinite(t)) return used;
  const day = new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "long", timeZone: "UTC" });
  return `${used} (renews ${day})`;
}
