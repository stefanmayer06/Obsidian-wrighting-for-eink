/**
 * Ink Notebook Cloud: handwriting recognition for subscribers.
 *
 *   GET  …/ocr/info        public: is the service offered, where to subscribe
 *   GET  …/ocr/status      X-License-Key → subscription state and this month's usage
 *   POST …/ocr/recognize   X-License-Key + PNG/JPEG body → Azure AI Vision read result
 *
 * Images are forwarded to Azure and never stored. License keys are stored only
 * as SHA-256 hashes; usage is counted per Polar license id, which stays the
 * same when a customer rotates the key.
 *
 * This file has no Deno or Supabase imports, so the unit tests run it in Node;
 * index.ts wires in the database, Polar and Azure.
 */

export interface Config {
  monthlyLimit: number;
  checkoutUrl: string;
  portalUrl: string;
  privacyUrl: string;
  /** Azure and Polar are configured, so recognition can work. */
  ready: boolean;
}

export interface LicenseRow {
  licenseId: string | null;
  status: "active" | "inactive";
  expiresAt: string | null;
  checkedAt: string;
}

export interface Store {
  getLicense(keyHash: string): Promise<LicenseRow | null>;
  saveLicense(keyHash: string, row: LicenseRow): Promise<void>;
  /** Count one request this month; null when the limit is already reached. */
  useRequest(licenseId: string, limit: number): Promise<number | null>;
  giveBackRequest(licenseId: string): Promise<void>;
  requestsThisMonth(licenseId: string): Promise<number>;
}

/** What the payment provider says about a key. */
export type LicenseCheck = { active: true; licenseId: string; expiresAt: string | null } | { active: false };

export interface RecognizeReply {
  status: number;
  body: unknown;
  api: "v4" | "v3.2";
  retryAfter?: string | null;
}

export interface Deps {
  config: Config;
  store: Store;
  /** null when the payment provider could not be asked. */
  validateLicense(key: string): Promise<LicenseCheck | null>;
  recognize(image: ArrayBuffer, language: string): Promise<RecognizeReply>;
  now?: () => number;
  log?: (message: string) => void;
}

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long a positive / negative answer from Polar is trusted. */
const RECHECK_ACTIVE_MS = 6 * HOUR;
const RECHECK_INACTIVE_MS = 10 * MINUTE;
/** While Polar is unreachable, a recent "active" keeps working this long. */
const GRACE_MS = 72 * HOUR;
const KEY_RE = /^[A-Za-z0-9_-]{8,200}$/;
const LANGUAGE_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;

type License = { state: "active"; licenseId: string } | { state: "inactive" } | { state: "unavailable" };

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const route = new URL(req.url).pathname.replace(/\/+$/, "").split("/").pop();
  try {
    if (route === "info" && req.method === "GET") return info(deps.config);
    if (route === "status" && req.method === "GET") return await status(req, deps);
    if (route === "recognize" && req.method === "POST") return await recognize(req, deps);
    return fail(404, "not_found", "Unknown request.");
  } catch (e) {
    deps.log?.(`unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    return fail(500, "internal", "Something went wrong on the Ink Notebook server. It will be retried automatically.");
  }
}

function info(c: Config): Response {
  return json(
    200,
    {
      available: c.ready && !!c.checkoutUrl,
      monthlyLimit: c.monthlyLimit,
      checkoutUrl: c.checkoutUrl,
      portalUrl: c.portalUrl,
      privacyUrl: c.privacyUrl,
    },
    { "Cache-Control": "public, max-age=300" },
  );
}

async function status(req: Request, deps: Deps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const lic = await licenseFrom(req, deps, now);
  if (lic instanceof Response) return lic;
  const used = await deps.store.requestsThisMonth(lic.licenseId);
  return json(200, { active: true, used, limit: deps.config.monthlyLimit, resetsAt: new Date(nextMonth(now)).toISOString() });
}

async function recognize(req: Request, deps: Deps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const lic = await licenseFrom(req, deps, now);
  if (lic instanceof Response) return lic;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_IMAGE_BYTES) return fail(413, "image_too_large", "The image is too large.");
  const image = await req.arrayBuffer();
  if (image.byteLength > MAX_IMAGE_BYTES) return fail(413, "image_too_large", "The image is too large.");
  if (!isPngOrJpeg(new Uint8Array(image))) return fail(415, "unsupported_image", "Only PNG and JPEG images can be recognised.");
  const language = new URL(req.url).searchParams.get("language") ?? "";

  const limit = deps.config.monthlyLimit;
  const used = await deps.store.useRequest(lic.licenseId, limit);
  if (used === null) {
    return fail(
      429,
      "quota_exceeded",
      `You have used all ${limit.toLocaleString("en-US")} recognitions for this month. They renew on ${dayLabel(nextMonth(now))}.`,
      { "X-Ink-Usage": String(limit), "X-Ink-Limit": String(limit) },
    );
  }

  let reply: RecognizeReply;
  try {
    reply = await deps.recognize(image, LANGUAGE_RE.test(language) ? language : "");
  } catch (e) {
    await deps.store.giveBackRequest(lic.licenseId);
    deps.log?.(`Azure unreachable: ${e instanceof Error ? e.message : String(e)}`);
    return unavailable();
  }
  if (reply.status >= 200 && reply.status < 300) {
    return json(200, reply.body, { "X-Ink-Api": reply.api, "X-Ink-Usage": String(used), "X-Ink-Limit": String(limit) });
  }
  await deps.store.giveBackRequest(lic.licenseId);
  if (reply.status === 429) {
    const retry = reply.retryAfter && /^\d+$/.test(reply.retryAfter) ? reply.retryAfter : "10";
    return fail(429, "busy", "The recognition service is busy. Trying again shortly.", { "Retry-After": retry });
  }
  if (reply.status === 400 || reply.status === 422) {
    return fail(422, "unreadable_image", azureMessage(reply.body) || "The image could not be read.");
  }
  deps.log?.(`Azure answered ${reply.status}: ${azureMessage(reply.body)}`);
  return unavailable();
}

/** The license behind the request's key, or the error response to send. */
async function licenseFrom(req: Request, deps: Deps, now: number): Promise<{ licenseId: string } | Response> {
  if (!deps.config.ready) return fail(503, "not_available", "Ink Notebook Cloud is not available right now.");
  const key = (req.headers.get("x-license-key") ?? "").trim();
  if (!key) return fail(401, "missing_license", "Enter your license key in Settings → Ink Notebook.");
  if (!KEY_RE.test(key)) return fail(401, "invalid_license", "This license key is not valid. Please check it in Settings → Ink Notebook.");
  const lic = await resolveLicense(key, deps, now);
  if (lic.state === "unavailable") {
    return fail(503, "license_check_failed", "Your subscription could not be checked right now. It will be retried automatically.", { "Retry-After": "60" });
  }
  if (lic.state === "inactive") {
    return fail(403, "inactive_license", "This license key is not active. Check the key, or renew your subscription.");
  }
  return { licenseId: lic.licenseId };
}

async function resolveLicense(key: string, deps: Deps, now: number): Promise<License> {
  const keyHash = await sha256Hex(key);
  const row = await deps.store.getLicense(keyHash);
  const expired = !!row?.expiresAt && Date.parse(row.expiresAt) <= now;
  const age = row ? now - Date.parse(row.checkedAt) : Infinity;
  if (row && !expired) {
    if (row.status === "active" && row.licenseId && age < RECHECK_ACTIVE_MS) return { state: "active", licenseId: row.licenseId };
    if (row.status === "inactive" && age < RECHECK_INACTIVE_MS) return { state: "inactive" };
  }

  const check = await deps.validateLicense(key);
  if (!check) {
    if (row?.status === "active" && row.licenseId && !expired && age < GRACE_MS) return { state: "active", licenseId: row.licenseId };
    return { state: "unavailable" };
  }
  if (check.active && !(check.expiresAt && Date.parse(check.expiresAt) <= now)) {
    await deps.store.saveLicense(keyHash, { licenseId: check.licenseId, status: "active", expiresAt: check.expiresAt, checkedAt: new Date(now).toISOString() });
    return { state: "active", licenseId: check.licenseId };
  }
  // Keys that were never active are not stored.
  if (row) await deps.store.saveLicense(keyHash, { ...row, status: "inactive", checkedAt: new Date(now).toISOString() });
  return { state: "inactive" };
}

function unavailable(): Response {
  return fail(502, "recognition_unavailable", "Handwriting recognition is temporarily unavailable. It will be retried automatically.");
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
}

function fail(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message } }, headers);
}

function isPngOrJpeg(b: Uint8Array): boolean {
  const png = b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  const jpeg = b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return png || jpeg;
}

function azureMessage(body: unknown): string {
  const err = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  return typeof err?.message === "string" ? err.message : "";
}

/** Start of the next month (UTC), when the allowance renews. */
function nextMonth(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

function dayLabel(t: number): string {
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
