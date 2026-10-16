// Ink Notebook Cloud – see handler.ts for the API and docs/cloud-setup.md for the secrets.
// Deploy with JWT verification off: requests are authorised by license key.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { handle, type Deps, type Store } from "./handler.ts";
import { azureRecognizer, polarValidator } from "./providers.ts";

const env = (name: string) => (Deno.env.get(name) ?? "").trim();
const log = (message: string) => console.error(`ocr: ${message}`);

function secretKey(): string {
  try {
    const keys = JSON.parse(env("SUPABASE_SECRET_KEYS") || "{}") as Record<string, string>;
    if (keys.default) return keys.default;
  } catch {
    // fall back to the legacy key
  }
  return env("SUPABASE_SERVICE_ROLE_KEY");
}

const db = createClient(env("SUPABASE_URL"), secretKey(), { auth: { persistSession: false, autoRefreshToken: false } });

function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  return result.data;
}

const store: Store = {
  async getLicense(keyHash) {
    const row = check(
      await db.from("licenses").select("license_id, status, expires_at, checked_at").eq("key_hash", keyHash).maybeSingle(),
      "read license",
    );
    return row ? { licenseId: row.license_id, status: row.status, expiresAt: row.expires_at, checkedAt: row.checked_at } : null;
  },
  async saveLicense(keyHash, row) {
    check(
      await db.from("licenses").upsert({ key_hash: keyHash, license_id: row.licenseId, status: row.status, expires_at: row.expiresAt, checked_at: row.checkedAt }),
      "save license",
    );
  },
  async useRequest(licenseId, limit) {
    const used = check(await db.rpc("use_ocr_request", { p_license_id: licenseId, p_limit: limit }), "count request");
    return typeof used === "number" ? used : null;
  },
  async giveBackRequest(licenseId) {
    check(await db.rpc("give_back_ocr_request", { p_license_id: licenseId }), "give back request");
  },
  async requestsThisMonth(licenseId) {
    const used = check(await db.rpc("ocr_requests_this_month", { p_license_id: licenseId }), "read usage");
    return typeof used === "number" ? used : 0;
  },
};

function deps(): Deps {
  const azureEndpoint = env("AZURE_ENDPOINT");
  const azureKey = env("AZURE_KEY");
  const organizationId = env("POLAR_ORGANIZATION_ID");
  const limit = parseInt(env("MONTHLY_LIMIT"), 10);
  return {
    config: {
      monthlyLimit: Number.isFinite(limit) && limit > 0 ? limit : 2000,
      checkoutUrl: env("CHECKOUT_URL"),
      portalUrl: env("PORTAL_URL"),
      privacyUrl: env("PRIVACY_URL"),
      ready: !!(azureEndpoint && azureKey && organizationId),
    },
    store,
    validateLicense: polarValidator({
      apiUrl: env("POLAR_API_URL") || "https://api.polar.sh",
      organizationId,
      benefitId: env("POLAR_BENEFIT_ID") || undefined,
      log,
    }),
    recognize: azureRecognizer({ endpoint: azureEndpoint, key: azureKey, api: env("AZURE_API") === "v3.2" ? "v3.2" : "v4" }),
    log,
  };
}

// Secrets are read per request, so changing them in the dashboard takes effect without a redeploy.
Deno.serve((req) => handle(req, deps()));
