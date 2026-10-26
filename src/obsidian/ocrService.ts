import type { DataAdapter } from "obsidian";
import { mapOcrResult, type OcrLine } from "../core/ocrTypes";
import { imageRectToScene, type OcrUnit } from "../core/rasterPlan";
import type { SceneElement } from "../core/scene";
import { AzureHttpError, isApiUnavailable, isOnline, OfflineError, recognize, type ApiVersion } from "./azureClient";
import { fetchCloudStatus, recognizeCloud, type CloudConfig } from "./cloudClient";
import { renderStrokesPng } from "./rasterizer";
import { cloudEndpointFor, isOcrConfigured, type InkSettings } from "../settings";
import type { CloudStatus } from "../core/cloud";

/**
 * Handwriting recognition with caching and rate limiting.
 *
 * Results are cached per "OCR unit" (a cluster of strokes) in scene
 * coordinates; a unit's key changes whenever one of its strokes changes, so
 * editing one corner of a page only re-recognises that corner.
 */

export type OcrStatus = "ok" | "offline" | "not-configured" | "error" | "partial";

export interface RecognizeOutcome {
  lines: OcrLine[];
  /** Strokes whose unit could not be recognised (yet). */
  pendingIds: Set<string>;
  status: OcrStatus;
  error?: string;
  /** Number of recognition requests sent. */
  requests: number;
}

interface CacheEntry {
  t: number;
  lines: OcrLine[];
}

const CACHE_LIMIT = 1500;

export class OcrService {
  private cache = new Map<string, CacheEntry>();
  private cacheDirty = false;
  private saveTimer: number | null = null;
  private requestTimes: number[] = [];
  private lastError: string | null = null;

  constructor(
    private adapter: DataAdapter,
    private cachePath: string,
    private getSettings: () => InkSettings,
    private saveSettings: () => Promise<void>,
  ) {}

  get lastErrorMessage(): string | null {
    return this.lastError;
  }

  async loadCache(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.cachePath))) return;
      const raw = JSON.parse(await this.adapter.read(this.cachePath)) as { v?: number; entries?: Record<string, CacheEntry> };
      if (raw?.v !== 1 || !raw.entries) return;
      for (const [k, v] of Object.entries(raw.entries)) {
        if (v && Array.isArray(v.lines)) this.cache.set(k, v);
      }
    } catch (e) {
      console.warn("Ink Notebook: OCR cache could not be read and will be rebuilt", e);
    }
  }

  private scheduleSave(): void {
    this.cacheDirty = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, 3000);
  }

  async flush(): Promise<void> {
    if (!this.cacheDirty) return;
    this.cacheDirty = false;
    // keep the newest entries
    if (this.cache.size > CACHE_LIMIT) {
      const sorted = [...this.cache.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, CACHE_LIMIT);
      this.cache = new Map(sorted);
    }
    try {
      await this.adapter.write(this.cachePath, JSON.stringify({ v: 1, entries: Object.fromEntries(this.cache) }));
    } catch (e) {
      console.warn("Ink Notebook: could not save OCR cache", e);
    }
  }

  clearCache(): void {
    this.cache.clear();
    this.scheduleSave();
  }

  hasCached(unit: OcrUnit): boolean {
    return unit.renderIds.length === 0 || this.cache.has(unit.key);
  }

  private async rateLimit(deadline: number): Promise<boolean> {
    const perMinute = Math.max(1, this.getSettings().requestsPerMinute);
    for (;;) {
      const now = Date.now();
      this.requestTimes = this.requestTimes.filter((t) => now - t < 60000);
      if (this.requestTimes.length < perMinute) {
        this.requestTimes.push(now);
        return true;
      }
      const wait = 60000 - (now - this.requestTimes[0]) + 50;
      if (now + wait > deadline) return false;
      await new Promise((r) => window.setTimeout(r, Math.min(wait, 5000)));
    }
  }

  private apiFor(s: InkSettings): ApiVersion {
    if (s.azureApi === "v4" || s.azureApi === "v3.2") return s.azureApi;
    return s.azureDetectedApi || "v4";
  }

  private cloudConfig(s: InkSettings, minTimeoutMs = 0): CloudConfig {
    return {
      endpoint: cloudEndpointFor(s),
      licenseKey: s.cloudLicenseKey,
      language: s.azureLanguage,
      timeoutMs: Math.max(minTimeoutMs, s.transcribeTimeoutSec * 1000),
    };
  }

  /** Recognise one image: with Ink Notebook Cloud, or with the user's Azure resource (automatic API detection). */
  private async recognizePng(png: ArrayBuffer): Promise<OcrLine[] | null> {
    const s = this.getSettings();
    if (s.ocrProvider === "cloud") return (await recognizeCloud(png, this.cloudConfig(s))).lines;
    const cfg = {
      endpoint: s.azureEndpoint,
      key: s.azureKey,
      api: this.apiFor(s),
      language: s.azureLanguage,
      timeoutMs: s.transcribeTimeoutSec * 1000,
    };
    try {
      return (await recognize(png, cfg)).lines;
    } catch (e) {
      if (s.azureApi === "auto" && isApiUnavailable(e)) {
        const other: ApiVersion = cfg.api === "v4" ? "v3.2" : "v4";
        const lines = (await recognize(png, { ...cfg, api: other })).lines;
        s.azureDetectedApi = other;
        await this.saveSettings();
        return lines;
      }
      throw e;
    }
  }

  /**
   * Recognise all units. Cached units are free; others are sent to Azure if
   * `network` is true, the service is configured and we are online.
   */
  async recognizeUnits(
    units: ReadonlyArray<OcrUnit>,
    elementsById: ReadonlyMap<string, SceneElement>,
    opts: { network: boolean; deadline: number },
  ): Promise<RecognizeOutcome> {
    const s = this.getSettings();
    const lines: OcrLine[] = [];
    const pendingIds = new Set<string>();
    let requests = 0;
    let status: OcrStatus = "ok";
    let error: string | undefined;
    const configured = isOcrConfigured(s);

    const markPending = (u: OcrUnit) => u.elementIds.forEach((id) => pendingIds.add(id));

    for (const unit of units) {
      // only table lines or underlines: nothing to read
      if (unit.renderIds.length === 0) continue;
      const cached = this.cache.get(unit.key);
      if (cached) {
        cached.t = Date.now();
        lines.push(...cached.lines);
        continue;
      }
      if (!configured) {
        status = "not-configured";
        markPending(unit);
        continue;
      }
      if (!opts.network || status === "offline" || (status === "error" && error)) {
        if (status === "ok") status = opts.network ? status : "partial";
        markPending(unit);
        continue;
      }
      if (!isOnline()) {
        status = "offline";
        markPending(unit);
        continue;
      }
      if (Date.now() > opts.deadline || !(await this.rateLimit(opts.deadline))) {
        status = "partial";
        markPending(unit);
        continue;
      }
      try {
        const strokes = unit.renderIds.map((id) => elementsById.get(id)).filter((e): e is SceneElement => !!e);
        const png = await renderStrokesPng(unit.plan, strokes);
        requests++;
        const imageLines = await this.recognizePng(png);
        if (!imageLines) throw new Error("No result");
        const sceneLines = mapOcrResult({ lines: imageLines }, (r) => imageRectToScene(unit.plan, r)).lines;
        this.cache.set(unit.key, { t: Date.now(), lines: sceneLines });
        this.scheduleSave();
        lines.push(...sceneLines);
        this.lastError = null;
      } catch (e) {
        markPending(unit);
        if (e instanceof OfflineError) {
          status = "offline";
        } else {
          status = "error";
          error = e instanceof Error ? e.message : String(e);
          this.lastError = error;
          if (e instanceof AzureHttpError && e.status === 429) {
            // back off: pretend the minute is full
            const now = Date.now();
            this.requestTimes = Array.from({ length: s.requestsPerMinute }, () => now);
          }
          console.warn("Ink Notebook: handwriting recognition failed", e);
        }
      }
    }
    if (status === "partial" && pendingIds.size === 0) status = "ok";
    return { lines, pendingIds, status, error, requests };
  }

  /** Ink Notebook Cloud subscription state and usage. */
  async cloudStatus(): Promise<CloudStatus> {
    return fetchCloudStatus(this.cloudConfig(this.getSettings(), 10000));
  }

  /** Check endpoint and key with a tiny test image. Returns the working API version. */
  async testConnection(png: ArrayBuffer): Promise<{ api: ApiVersion; text: string }> {
    const s = this.getSettings();
    const base = {
      endpoint: s.azureEndpoint,
      key: s.azureKey,
      language: s.azureLanguage,
      timeoutMs: Math.max(10000, s.transcribeTimeoutSec * 1000),
    };
    const order: ApiVersion[] = s.azureApi === "auto" ? ["v4", "v3.2"] : [s.azureApi];
    let lastErr: unknown = null;
    for (const api of order) {
      try {
        const result = await recognize(png, { ...base, api });
        if (s.azureApi === "auto") {
          s.azureDetectedApi = api;
          await this.saveSettings();
        }
        return { api, text: result.lines.map((l) => l.text).join(" ") };
      } catch (e) {
        lastErr = e;
        if (!(s.azureApi === "auto" && isApiUnavailable(e))) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
}
