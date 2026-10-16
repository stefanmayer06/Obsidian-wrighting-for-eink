import type { App, Plugin, PluginManifest } from "obsidian";
import excalidrawCode from "vendored-excalidraw:main.js";
import excalidrawCss from "vendored-excalidraw:styles.css";
import excalidrawManifest from "vendored-excalidraw:manifest.json";
import { compareVersions, EXCALIDRAW_PLUGIN_ID, excalidrawVersion, isExcalidrawReady, MIN_EXCALIDRAW_VERSION } from "./excalidrawBridge";

/**
 * Ink Notebook comes with the Excalidraw plugin built in (vendor/excalidraw),
 * so nothing else has to be installed. The built-in copy is started the way
 * Obsidian starts a community plugin and under Excalidraw's own plugin id, so
 * Excalidraw, its scripts and other plugins find it where they expect it.
 *
 * When the user has installed and enabled the Excalidraw plugin themselves,
 * their copy is used and the built-in one stays idle.
 */

export const BUNDLED_EXCALIDRAW_VERSION = excalidrawManifest.version;

/** The built-in copy is updated together with Ink Notebook: no release notes or "update it in Community plugins" notices. */
const BUNDLED_SETTINGS = {
  showReleaseNotes: false,
  previousRelease: excalidrawManifest.version,
  showNewVersionNotification: false,
};

interface PluginRegistry {
  plugins: Record<string, Plugin | undefined>;
  manifests: Record<string, PluginManifest | undefined>;
  enabledPlugins: Set<string>;
}

type PluginClass = new (app: App, manifest: PluginManifest) => Plugin;

export class BundledExcalidraw {
  private instance: Plugin | null = null;
  private starting: Promise<boolean> | null = null;
  /** Why the built-in Excalidraw could not start (not retried automatically). */
  error: string | null = null;

  constructor(private host: Plugin) {}

  private get registry(): PluginRegistry | null {
    return (this.host.app as unknown as { plugins?: PluginRegistry }).plugins ?? null;
  }

  /** The built-in Excalidraw is running. */
  get active(): boolean {
    return !!this.instance && this.registry?.plugins[EXCALIDRAW_PLUGIN_ID] === this.instance;
  }

  /** The user's own Excalidraw plugin is installed and enabled; it takes precedence. */
  ownPluginEnabled(): boolean {
    const r = this.registry;
    return !!r?.manifests[EXCALIDRAW_PLUGIN_ID] && r.enabledPlugins.has(EXCALIDRAW_PLUGIN_ID);
  }

  /** No Excalidraw is running or about to start, so the built-in one can. */
  canStart(): boolean {
    const r = this.registry;
    return !this.active && !!r && !r.plugins[EXCALIDRAW_PLUGIN_ID] && !this.ownPluginEnabled();
  }

  /**
   * Start the built-in Excalidraw if no other Excalidraw is running, e.g. on
   * startup or after the user disabled their own Excalidraw plugin. After a
   * failed start it only tries again with `retry`.
   */
  ensure(retry = false): Promise<boolean> {
    if (this.active) return Promise.resolve(true);
    if (this.starting) return this.starting;
    if (!this.canStart() || (this.error && !retry)) return Promise.resolve(false);
    this.starting = this.start().finally(() => (this.starting = null));
    return this.starting;
  }

  private async start(): Promise<boolean> {
    const r = this.registry;
    if (!r) return false;
    const app = this.host.app;
    const dir = `${this.host.manifest.dir ?? `${app.vault.configDir}/plugins/${this.host.manifest.id}`}/excalidraw`;
    let plugin: Plugin | null = null;
    try {
      await this.prepareSettings(dir);
      const Excalidraw = this.evaluate();
      plugin = new Excalidraw(app, { ...excalidrawManifest, dir });
      // registered before onload, like Obsidian does: Excalidraw looks itself up there
      r.plugins[EXCALIDRAW_PLUGIN_ID] = plugin;
      this.instance = plugin;
      await plugin.load();
      this.addStyles(plugin);
      this.error = null;
      return true;
    } catch (e) {
      console.error("Ink Notebook: the built-in Excalidraw could not start", e);
      this.error = e instanceof Error ? e.message : String(e);
      this.instance = null;
      if (plugin) {
        if (r.plugins[EXCALIDRAW_PLUGIN_ID] === plugin) delete r.plugins[EXCALIDRAW_PLUGIN_ID];
        try {
          plugin.unload();
        } catch {
          /* ignore */
        }
      }
      return false;
    }
  }

  /** Evaluate Excalidraw's main.js with the same wrapper and `require` Obsidian gives community plugins. */
  private evaluate(): PluginClass {
    const module: { exports: unknown } = { exports: {} };
    const factory = window.eval(
      `(function anonymous(require,module,exports){${excalidrawCode}\n})\n//# sourceURL=plugin:${encodeURIComponent(EXCALIDRAW_PLUGIN_ID)}\n`,
    ) as (req: unknown, mod: { exports: unknown }, exp: unknown) => void;
    factory(require, module, module.exports);
    const exported = module.exports as (PluginClass & { default?: PluginClass }) | null;
    const cls = exported?.default ?? exported;
    if (typeof cls !== "function") throw new Error("Excalidraw did not export a plugin.");
    return cls;
  }

  /** Excalidraw's styles.css, where Obsidian puts plugin styles (before the user's CSS snippets). */
  private addStyles(plugin: Plugin): void {
    const style = document.createElement("style");
    style.textContent = excalidrawCss;
    const snippets = (this.host.app as unknown as { customCss?: { styleEl?: HTMLElement } }).customCss?.styleEl;
    if (snippets?.parentElement === document.head) document.head.insertBefore(style, snippets);
    else document.head.appendChild(style);
    plugin.register(() => style.remove());
  }

  /** First start: take over the settings of an Excalidraw plugin used before in this vault. */
  private async prepareSettings(dir: string): Promise<void> {
    const adapter = this.host.app.vault.adapter;
    const file = `${dir}/data.json`;
    if (await adapter.exists(file)) return;
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    let previous: Record<string, unknown> = {};
    const ownDir = this.registry?.manifests[EXCALIDRAW_PLUGIN_ID]?.dir ?? `${this.host.app.vault.configDir}/plugins/${EXCALIDRAW_PLUGIN_ID}`;
    try {
      if (await adapter.exists(`${ownDir}/data.json`)) {
        const data: unknown = JSON.parse(await adapter.read(`${ownDir}/data.json`));
        if (data && typeof data === "object" && !Array.isArray(data)) previous = data as Record<string, unknown>;
      }
    } catch {
      previous = {};
    }
    await adapter.write(file, JSON.stringify({ ...previous, ...BUNDLED_SETTINGS }, null, "\t"));
  }

  /** Stop the built-in Excalidraw (when Ink Notebook is disabled). */
  unload(): void {
    const plugin = this.instance;
    this.instance = null;
    if (!plugin) return;
    try {
      plugin.unload();
    } catch (e) {
      console.warn("Ink Notebook: could not stop the built-in Excalidraw", e);
    }
    const r = this.registry;
    if (r?.plugins[EXCALIDRAW_PLUGIN_ID] === plugin) delete r.plugins[EXCALIDRAW_PLUGIN_ID];
  }

  /** Which Excalidraw Ink Notebook uses, for the setup assistant, settings and notices. */
  describe(): { ok: boolean; text: string } {
    const app = this.host.app;
    const version = excalidrawVersion(app);
    if (isExcalidrawReady(app) && this.active) {
      return { ok: true, text: `Excalidraw ${BUNDLED_EXCALIDRAW_VERSION} is built into Ink Notebook – nothing to install.` };
    }
    if (isExcalidrawReady(app)) {
      if (version && compareVersions(version, MIN_EXCALIDRAW_VERSION) < 0) {
        return {
          ok: false,
          text: `Your Excalidraw plugin ${version} is too old. Update it, or disable it to use the Excalidraw ${BUNDLED_EXCALIDRAW_VERSION} built into Ink Notebook.`,
        };
      }
      return {
        ok: true,
        text: `Using your own Excalidraw plugin${version ? ` ${version}` : ""}. If you disable it, the Excalidraw ${BUNDLED_EXCALIDRAW_VERSION} built into Ink Notebook takes over.`,
      };
    }
    if (this.ownPluginEnabled()) {
      return {
        ok: false,
        text: "Your Excalidraw plugin is enabled but not running. Check it under Settings → Community plugins, or disable it to use the Excalidraw built into Ink Notebook.",
      };
    }
    if (this.error) return { ok: false, text: `The Excalidraw built into Ink Notebook could not start: ${this.error}` };
    return { ok: false, text: "Excalidraw is starting…" };
  }
}
