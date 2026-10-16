import { describe, expect, it } from "vitest";
import { cloudError, formatCloudStatus, isPermanentCloudError, parseCloudInfo, parseCloudResult, parseCloudStatus } from "../src/core/cloud";
import { cloudEndpointFor, isOcrConfigured, loadSettings } from "../src/settings";

describe("Ink Notebook Cloud responses", () => {
  it("parses the service info and only keeps https links", () => {
    expect(parseCloudInfo({ available: true, monthlyLimit: 2000, checkoutUrl: "https://buy.polar.sh/x", portalUrl: "javascript:alert(1)", privacyUrl: "" })).toEqual({
      available: true,
      monthlyLimit: 2000,
      checkoutUrl: "https://buy.polar.sh/x",
      portalUrl: "",
      privacyUrl: "",
    });
    // no checkout link: not offered
    expect(parseCloudInfo({ available: true, monthlyLimit: 5, checkoutUrl: "" })?.available).toBe(false);
    expect(parseCloudInfo("nope")).toBeNull();
  });

  it("parses the subscription status", () => {
    expect(parseCloudStatus({ active: true, used: 12, limit: 2000, resetsAt: "2026-11-01T00:00:00.000Z" })).toEqual({ used: 12, limit: 2000, resetsAt: "2026-11-01T00:00:00.000Z" });
    expect(parseCloudStatus({ error: { code: "inactive_license" } })).toBeNull();
  });

  it("reads both Azure result shapes passed through by the server", () => {
    const v4 = { readResult: { blocks: [{ lines: [{ text: "Hello", boundingPolygon: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 0, y: 5 }], words: [] }] }] } };
    expect(parseCloudResult("v4", v4).lines.map((l) => l.text)).toEqual(["Hello"]);
    expect(parseCloudResult(null, v4).lines).toHaveLength(1);
    const v3 = { status: "succeeded", analyzeResult: { readResults: [{ lines: [{ text: "Hallo", boundingBox: [0, 0, 10, 0, 10, 5, 0, 5], words: [] }] }] } };
    expect(parseCloudResult("v3.2", v3).lines.map((l) => l.text)).toEqual(["Hallo"]);
  });

  it("turns server errors into messages and knows which ones retrying won't fix", () => {
    const quota = cloudError({ error: { code: "quota_exceeded", message: "You have used all 2,000 recognitions for this month." } }, 429);
    expect(quota.message).toBe("You have used all 2,000 recognitions for this month.");
    expect(isPermanentCloudError(429, quota.code)).toBe(true);
    expect(isPermanentCloudError(429, "busy")).toBe(false);
    expect(isPermanentCloudError(403, "inactive_license")).toBe(true);
    expect(isPermanentCloudError(503, "license_check_failed")).toBe(false);
    expect(cloudError(null, 502).message).toBe("Ink Notebook Cloud request failed (HTTP 502)");
  });

  it("describes usage", () => {
    const text = formatCloudStatus({ used: 12, limit: 2000, resetsAt: "2026-11-01T00:00:00.000Z" });
    expect(text).toMatch(/^12 of 2,?000 recognitions used this month \(renews /);
    expect(formatCloudStatus({ used: 1, limit: 3, resetsAt: "" })).toBe("1 of 3 recognitions used this month");
  });
});

describe("recognition settings", () => {
  it("keeps existing users on their own Azure key", () => {
    const s = loadSettings({ azureEndpoint: "https://x.cognitiveservices.azure.com", azureKey: "k" });
    expect(s.ocrProvider).toBe("azure");
    expect(isOcrConfigured(s)).toBe(true);
  });

  it("needs a license key for the cloud", () => {
    const s = loadSettings({ ocrProvider: "cloud", azureEndpoint: "https://x", azureKey: "k" });
    expect(isOcrConfigured(s)).toBe(false);
    expect(isOcrConfigured(loadSettings({ ocrProvider: "cloud", cloudLicenseKey: " INK_abc " }))).toBe(true);
    expect(loadSettings({ ocrProvider: "cloud", cloudLicenseKey: " INK_abc " }).cloudLicenseKey).toBe("INK_abc");
    expect(loadSettings({ ocrProvider: "something" }).ocrProvider).toBe("azure");
  });

  it("uses the built-in server unless overridden", () => {
    expect(cloudEndpointFor(loadSettings({}))).toMatch(/^https:\/\/\w+\.supabase\.co\/functions\/v1\/ocr$/);
    expect(cloudEndpointFor(loadSettings({ cloudEndpoint: "http://127.0.0.1:8765/ocr/" }))).toBe("http://127.0.0.1:8765/ocr");
  });
});
