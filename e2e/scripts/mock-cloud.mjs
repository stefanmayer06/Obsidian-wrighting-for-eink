// Ink Notebook Cloud for end-to-end tests: the real server code
// (supabase/functions/ocr/handler.ts and providers.ts) with an in-memory
// database and a fake Polar, forwarding to the mock Azure server.
//
//   node --experimental-strip-types scripts/mock-cloud.mjs
//
// License keys: INK_e2e-active-license (active), anything else (not active).
import http from "http";
import { handle } from "../../supabase/functions/ocr/handler.ts";
import { azureRecognizer } from "../../supabase/functions/ocr/providers.ts";

const PORT = Number(process.env.PORT ?? 8766);
const AZURE = process.env.AZURE ?? "http://127.0.0.1:8765";

const licenses = new Map();
const usage = new Map();
const store = {
  getLicense: async (h) => licenses.get(h) ?? null,
  saveLicense: async (h, row) => void licenses.set(h, { ...row }),
  useRequest: async (id, limit) => {
    const n = usage.get(id) ?? 0;
    if (n >= limit) return null;
    usage.set(id, n + 1);
    return n + 1;
  },
  giveBackRequest: async (id) => void usage.set(id, Math.max(0, (usage.get(id) ?? 0) - 1)),
  requestsThisMonth: async (id) => usage.get(id) ?? 0,
};

const deps = {
  config: {
    monthlyLimit: 100,
    checkoutUrl: "https://example.com/checkout",
    portalUrl: "https://example.com/portal",
    privacyUrl: "https://example.com/privacy",
    ready: true,
  },
  store,
  validateLicense: async (key) => (key === "INK_e2e-active-license" ? { active: true, licenseId: "lic_e2e", expiresAt: null } : { active: false }),
  recognize: azureRecognizer({ endpoint: AZURE, key: "test-key", api: "v4" }),
  log: (m) => console.error(m),
};

let requests = 0;
http
  .createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.url === "/__stats") return res.end(JSON.stringify({ requests, usage: Object.fromEntries(usage) }));
    requests++;
    const headers = {};
    for (const name of ["x-license-key", "content-type", "content-length"]) if (req.headers[name]) headers[name] = req.headers[name];
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const response = await handle(new Request(`http://127.0.0.1:${PORT}${req.url}`, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined }), deps);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  })
  .listen(PORT, "127.0.0.1", () => console.log(`mock cloud on ${PORT}`));
