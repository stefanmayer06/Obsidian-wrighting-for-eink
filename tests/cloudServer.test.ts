import { describe, expect, it } from "vitest";
import { handle, sha256Hex, type Deps, type LicenseCheck, type LicenseRow, type RecognizeReply, type Store } from "../supabase/functions/ocr/handler";
import { azureRecognizer, polarValidator } from "../supabase/functions/ocr/providers";

const KEY = "INK_3f1b8c2e-7d4a-4f5e-9a0b-1c2d3e4f5a6b";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);
const HOUR = 3600_000;
const AZURE_OK: RecognizeReply = { status: 200, body: { readResult: { blocks: [] } }, api: "v4" };

class MemoryStore implements Store {
  licenses = new Map<string, LicenseRow>();
  usage = new Map<string, number>();
  async getLicense(h: string) {
    return this.licenses.get(h) ?? null;
  }
  async saveLicense(h: string, row: LicenseRow) {
    this.licenses.set(h, { ...row });
  }
  async useRequest(id: string, limit: number) {
    const n = this.usage.get(id) ?? 0;
    if (n >= limit) return null;
    this.usage.set(id, n + 1);
    return n + 1;
  }
  async giveBackRequest(id: string) {
    this.usage.set(id, Math.max(0, (this.usage.get(id) ?? 0) - 1));
  }
  async requestsThisMonth(id: string) {
    return this.usage.get(id) ?? 0;
  }
}

function setup(over: Partial<Deps> = {}, polar: () => LicenseCheck | null = () => ({ active: true, licenseId: "lic_1", expiresAt: null })) {
  const store = new MemoryStore();
  const calls = { polar: 0, azure: 0 };
  let now = T0;
  const deps: Deps = {
    config: { monthlyLimit: 3, checkoutUrl: "https://buy.example/checkout", portalUrl: "https://example/portal", privacyUrl: "", ready: true },
    store,
    validateLicense: async () => {
      calls.polar++;
      return polar();
    },
    recognize: async () => {
      calls.azure++;
      return AZURE_OK;
    },
    now: () => now,
    ...over,
  };
  return { deps, store, calls, advance: (ms: number) => (now += ms) };
}

const recognizeReq = (key = KEY, body: Uint8Array<ArrayBuffer> = PNG) =>
  new Request("https://x.supabase.co/functions/v1/ocr/recognize?language=de", { method: "POST", headers: { "X-License-Key": key }, body });
const statusReq = (key = KEY) => new Request("https://x.supabase.co/functions/v1/ocr/status", { headers: { "X-License-Key": key } });
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe("cloud server", () => {
  it("info says whether the service is offered", async () => {
    const { deps } = setup();
    const info = await (await handle(new Request("https://x/functions/v1/ocr/info"), deps)).json();
    expect(info).toMatchObject({ available: true, monthlyLimit: 3, checkoutUrl: "https://buy.example/checkout" });
    const off = setup({ config: { ...deps.config, ready: false } });
    expect((await (await handle(new Request("https://x/functions/v1/ocr/info"), off.deps)).json()).available).toBe(false);
  });

  it("recognises with a valid key, passes the Azure result through and counts usage", async () => {
    const { deps, store } = setup();
    const res = await handle(recognizeReq(), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(AZURE_OK.body);
    expect(res.headers.get("x-ink-api")).toBe("v4");
    expect(res.headers.get("x-ink-usage")).toBe("1");
    expect(res.headers.get("x-ink-limit")).toBe("3");
    expect(store.usage.get("lic_1")).toBe(1);
    // the raw key is never stored
    expect([...store.licenses.keys()]).toEqual([await sha256Hex(KEY)]);
  });

  it("rejects missing, malformed and inactive keys without calling Azure", async () => {
    const { deps, calls, store } = setup({}, () => ({ active: false }));
    expect(await errorCode(await handle(recognizeReq(""), deps))).toBe("missing_license");
    expect(await errorCode(await handle(recognizeReq("bad key!"), deps))).toBe("invalid_license");
    const res = await handle(recognizeReq(), deps);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("inactive_license");
    expect(calls.azure).toBe(0);
    // unknown keys are not stored
    expect(store.licenses.size).toBe(0);
  });

  it("caches Polar's answer and re-checks after a while", async () => {
    const { deps, calls, advance } = setup();
    await handle(recognizeReq(), deps);
    await handle(recognizeReq(), deps);
    expect(calls.polar).toBe(1);
    advance(7 * HOUR);
    await handle(statusReq(), deps);
    expect(calls.polar).toBe(2);
  });

  it("stops working when the subscription ends", async () => {
    let active = true;
    const { deps, advance, store } = setup({}, () => (active ? { active: true, licenseId: "lic_1", expiresAt: null } : { active: false }));
    expect((await handle(recognizeReq(), deps)).status).toBe(200);
    active = false;
    advance(7 * HOUR);
    expect((await handle(recognizeReq(), deps)).status).toBe(403);
    expect([...store.licenses.values()][0].status).toBe("inactive");
  });

  it("treats an expiry date in the past as inactive", async () => {
    const { deps } = setup({}, () => ({ active: true, licenseId: "lic_1", expiresAt: new Date(T0 - 1000).toISOString() }));
    expect((await handle(recognizeReq(), deps)).status).toBe(403);
  });

  it("keeps a recently active key working while Polar is down, but not an unknown one", async () => {
    let up = true;
    const { deps, advance } = setup({}, () => (up ? { active: true, licenseId: "lic_1", expiresAt: null } : null));
    await handle(recognizeReq(), deps);
    up = false;
    advance(7 * HOUR);
    expect((await handle(recognizeReq(), deps)).status).toBe(200);
    advance(80 * HOUR);
    const late = await handle(recognizeReq(), deps);
    expect(late.status).toBe(503);
    expect(await errorCode(late)).toBe("license_check_failed");
    expect((await handle(recognizeReq("INK_never-seen-before-key"), deps)).status).toBe(503);
  });

  it("enforces the monthly limit per license, also across rotated keys", async () => {
    const { deps, calls } = setup();
    for (let i = 0; i < 3; i++) expect((await handle(recognizeReq(), deps)).status).toBe(200);
    const res = await handle(recognizeReq(), deps);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.message).toContain("1 November");
    // a rotated key belongs to the same Polar license
    expect((await handle(recognizeReq("INK_rotated-key-of-the-same-license"), deps)).status).toBe(429);
    expect(calls.azure).toBe(3);
  });

  it("gives the request back when Azure fails", async () => {
    let reply: RecognizeReply | Error = { status: 429, body: null, api: "v4", retryAfter: "7" };
    const { deps, store } = setup({
      recognize: async () => {
        if (reply instanceof Error) throw reply;
        return reply;
      },
    });
    const busy = await handle(recognizeReq(), deps);
    expect(busy.status).toBe(429);
    expect(busy.headers.get("retry-after")).toBe("7");
    expect(await errorCode(busy)).toBe("busy");
    reply = { status: 400, body: { error: { code: "InvalidImageSize", message: "Image is too small." } }, api: "v4" };
    const bad = await handle(recognizeReq(), deps);
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe("Image is too small.");
    reply = new Error("connect ECONNREFUSED");
    expect((await handle(recognizeReq(), deps)).status).toBe(502);
    expect(store.usage.get("lic_1")).toBe(0);
  });

  it("only accepts PNG and JPEG images", async () => {
    const { deps, calls } = setup();
    const res = await handle(recognizeReq(KEY, new TextEncoder().encode("<svg></svg>")), deps);
    expect(res.status).toBe(415);
    expect(calls.azure).toBe(0);
  });

  it("reports usage and the renewal date", async () => {
    const { deps } = setup();
    await handle(recognizeReq(), deps);
    expect(await (await handle(statusReq(), deps)).json()).toEqual({ active: true, used: 1, limit: 3, resetsAt: "2026-11-01T00:00:00.000Z" });
  });

  it("is closed until Azure and Polar are configured", async () => {
    const { deps } = setup();
    const closed = { ...deps, config: { ...deps.config, ready: false } };
    expect(await errorCode(await handle(recognizeReq(), closed))).toBe("not_available");
  });

  it("returns a JSON error for unknown routes and unexpected failures", async () => {
    const { deps, store } = setup();
    expect((await handle(new Request("https://x/functions/v1/ocr/nope"), deps)).status).toBe(404);
    store.getLicense = async () => {
      throw new Error("db down");
    };
    const logs: string[] = [];
    const res = await handle(recognizeReq(), { ...deps, log: (m) => logs.push(m) });
    expect(res.status).toBe(500);
    expect(logs[0]).toContain("db down");
  });
});

describe("Polar validation", () => {
  const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it("maps Polar's answers", async () => {
    const granted = polarValidator({ apiUrl: "https://api.polar.sh", organizationId: "org", fetchFn: respond(200, { id: "lk_1", status: "granted", expires_at: null }) });
    expect(await granted(KEY)).toEqual({ active: true, licenseId: "lk_1", expiresAt: null });
    const missing = polarValidator({ apiUrl: "https://api.polar.sh", organizationId: "org", fetchFn: respond(404, { detail: "Not found" }) });
    expect(await missing(KEY)).toEqual({ active: false });
    const down = polarValidator({ apiUrl: "https://api.polar.sh", organizationId: "org", fetchFn: respond(503, {}) });
    expect(await down(KEY)).toBeNull();
    const offline = polarValidator({
      apiUrl: "https://api.polar.sh",
      organizationId: "org",
      fetchFn: async () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await offline(KEY)).toBeNull();
  });

  it("sends the key, organization and benefit", async () => {
    let sent: { url: string; body: unknown } | null = null;
    const validate = polarValidator({
      apiUrl: "https://sandbox-api.polar.sh/",
      organizationId: "org_1",
      benefitId: "ben_1",
      fetchFn: async (url, init) => {
        sent = { url: String(url), body: JSON.parse(String(init?.body)) };
        return new Response("{}", { status: 404 });
      },
    });
    await validate(KEY);
    expect(sent).toEqual({
      url: "https://sandbox-api.polar.sh/v1/customer-portal/license-keys/validate",
      body: { key: KEY, organization_id: "org_1", benefit_id: "ben_1" },
    });
  });
});

describe("Azure recognizer", () => {
  it("calls Image Analysis 4.0", async () => {
    let url = "";
    const recognize = azureRecognizer({
      endpoint: "https://res.cognitiveservices.azure.com/",
      key: "k",
      api: "v4",
      fetchFn: async (u) => {
        url = String(u);
        return new Response(JSON.stringify({ readResult: { blocks: [] } }), { status: 200 });
      },
    });
    expect(await recognize(PNG.buffer, "")).toEqual({ status: 200, body: { readResult: { blocks: [] } }, api: "v4", retryAfter: null });
    expect(url).toBe("https://res.cognitiveservices.azure.com/computervision/imageanalysis:analyze?features=read&model-version=latest&api-version=2024-02-01");
  });

  it("polls Read 3.2 until the result is ready", async () => {
    const urls: string[] = [];
    let polls = 0;
    const recognize = azureRecognizer({
      endpoint: "https://res.cognitiveservices.azure.com",
      key: "k",
      api: "v3.2",
      sleep: async () => {},
      fetchFn: async (u) => {
        urls.push(String(u));
        if (urls.length === 1) return new Response(null, { status: 202, headers: { "Operation-Location": "https://res/op/1" } });
        polls++;
        return new Response(JSON.stringify({ status: polls < 2 ? "running" : "succeeded", analyzeResult: {} }), { status: 200 });
      },
    });
    const reply = await recognize(PNG.buffer, "de");
    expect(reply).toMatchObject({ status: 200, api: "v3.2", body: { status: "succeeded" } });
    expect(urls[0]).toBe("https://res.cognitiveservices.azure.com/vision/v3.2/read/analyze?readingOrder=natural&language=de");
    expect(urls.slice(1)).toEqual(["https://res/op/1", "https://res/op/1"]);
  });
});
