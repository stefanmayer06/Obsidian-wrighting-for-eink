import type { LicenseCheck, RecognizeReply } from "./handler.ts";

/** Polar license keys: https://polar.sh/docs/features/benefits/license-keys */
export function polarValidator(opts: {
  apiUrl: string;
  organizationId: string;
  /** Only accept keys of this License Keys benefit (optional). */
  benefitId?: string;
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
}): (key: string) => Promise<LicenseCheck | null> {
  const fetchFn = opts.fetchFn ?? fetch;
  const url = `${opts.apiUrl.replace(/\/+$/, "")}/v1/customer-portal/license-keys/validate`;
  return async (key) => {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ key, organization_id: opts.organizationId, ...(opts.benefitId ? { benefit_id: opts.benefitId } : {}) }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (e) {
      opts.log?.(`Polar unreachable: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    // 404: unknown, revoked, disabled or expired key
    if (res.status === 404) return { active: false };
    if (res.status === 422) {
      // a malformed key – or a wrong POLAR_ORGANIZATION_ID / POLAR_BENEFIT_ID
      opts.log?.(`Polar rejected the validation request (422): ${(await res.text()).slice(0, 300)}`);
      return { active: false };
    }
    if (!res.ok) {
      opts.log?.(`Polar answered ${res.status}`);
      return null;
    }
    const body = (await safeJson(res)) as { id?: unknown; status?: unknown; expires_at?: unknown } | null;
    if (body?.status !== "granted" || typeof body.id !== "string") return { active: false };
    return { active: true, licenseId: body.id, expiresAt: typeof body.expires_at === "string" ? body.expires_at : null };
  };
}

/** Azure AI Vision read (OCR), with the same API versions the plugin supports. */
export function azureRecognizer(opts: {
  endpoint: string;
  key: string;
  api: "v4" | "v3.2";
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): (image: ArrayBuffer, language: string) => Promise<RecognizeReply> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const base = opts.endpoint.trim().replace(/\/+$/, "");
  const headers = { "Ocp-Apim-Subscription-Key": opts.key, "Content-Type": "application/octet-stream" };

  if (opts.api === "v4") {
    return async (image) => {
      const res = await fetchFn(`${base}/computervision/imageanalysis:analyze?features=read&model-version=latest&api-version=2024-02-01`, {
        method: "POST",
        headers,
        body: image,
        signal: AbortSignal.timeout(30_000),
      });
      return { status: res.status, body: await safeJson(res), api: "v4", retryAfter: res.headers.get("retry-after") };
    };
  }

  return async (image, language) => {
    const lang = language ? `&language=${encodeURIComponent(language)}` : "";
    const res = await fetchFn(`${base}/vision/v3.2/read/analyze?readingOrder=natural${lang}`, {
      method: "POST",
      headers,
      body: image,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status !== 202) return { status: res.status, body: await safeJson(res), api: "v3.2", retryAfter: res.headers.get("retry-after") };
    const operation = res.headers.get("operation-location");
    if (!operation) throw new Error("Azure returned no operation location");
    const started = Date.now();
    let delay = 400;
    while (Date.now() - started < 40_000) {
      await sleep(delay);
      delay = Math.min(1500, delay + 250);
      const poll = await fetchFn(operation, { headers: { "Ocp-Apim-Subscription-Key": opts.key }, signal: AbortSignal.timeout(10_000) });
      if (poll.status === 429) continue;
      const body = await safeJson(poll);
      if (!poll.ok) return { status: poll.status, body, api: "v3.2" };
      const state = (body as { status?: unknown } | null)?.status;
      if (state === "succeeded") return { status: 200, body, api: "v3.2" };
      if (state === "failed") return { status: 422, body: { error: { code: "ReadFailed", message: "The image could not be read." } }, api: "v3.2" };
    }
    throw new Error("Azure took too long to answer");
  };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}
