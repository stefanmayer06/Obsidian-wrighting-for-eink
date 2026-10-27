import { moment, Notice, normalizePath, TFile, type App, type WorkspaceLeaf } from "obsidian";
import type InkNotebookPlugin from "../main";
import { dailyConfigFrom, dailyNoteDatePart, dailyNotePath, type DailyNoteConfig } from "../core/dailyNotes";
import { INK_VIEW_TYPE } from "./inkView";

/**
 * Daily notes that come with an ink page (Settings → Pages → Daily notes): a
 * daily note made on this device gets an ink page when it opens, and – if
 * chosen – the ink page is shown in its place, ready to write on.
 */

/** Only notes made this recently get an ink page when they open (not old notes, nor notes synced in later). */
const FRESH_MS = 2 * 60 * 1000;
/** Time for the daily notes plugin (and Templater) to finish writing a new note. */
const SETTLE_MS = 800;

interface PluginsApi {
  internalPlugins?: { plugins?: Record<string, { enabled?: boolean; instance?: { options?: { folder?: unknown; format?: unknown } } } | undefined> };
  plugins?: { getPlugin?(id: string): { settings?: { daily?: { enabled?: boolean; folder?: unknown; format?: unknown } } } | null };
  commands?: { executeCommandById?(id: string): boolean };
}

/** The daily note settings (of Periodic Notes if it makes the daily notes, else of the core plugin), or null if neither is on. */
export function dailyNoteSettings(app: App): { config: DailyNoteConfig; command: string } | null {
  const a = app as unknown as PluginsApi;
  const periodic = a.plugins?.getPlugin?.("periodic-notes")?.settings?.daily;
  if (periodic?.enabled) return { config: dailyConfigFrom(periodic), command: "periodic-notes:open-daily-note" };
  const core = a.internalPlugins?.plugins?.["daily-notes"];
  if (core?.enabled) return { config: dailyConfigFrom(core.instance?.options), command: "daily-notes" };
  return null;
}

export function isDailyNote(file: TFile, cfg: DailyNoteConfig): boolean {
  const part = dailyNoteDatePart(file.path, cfg.folder);
  return part !== null && date(part, cfg.format, true).isValid();
}

/** Obsidian's moment (as called here; its declarations do not show the call signature). */
const date = moment as unknown as (input?: string, format?: string, strict?: boolean) => { isValid(): boolean; format(f: string): string };

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export class DailyInk {
  /** Daily notes already looked at (path and creation time: a note made again is new). */
  private seen = new Set<string>();
  /** Today's note while "open today" makes it (it adds the ink page itself). */
  private making: string | null = null;

  constructor(private plugin: InkNotebookPlugin) {}

  private get app(): App {
    return this.plugin.app;
  }

  /** A note was opened. */
  onOpen(file: TFile | null): void {
    const mode = this.plugin.settings.dailyInk;
    if (mode === "off" || !file || file.extension !== "md" || file.path === this.making) return;
    const key = `${file.path}@${file.stat.ctime}`;
    if (this.seen.has(key) || Date.now() - file.stat.ctime > FRESH_MS) return;
    const daily = dailyNoteSettings(this.app);
    if (!daily || !isDailyNote(file, daily.config)) return;
    this.seen.add(key);
    window.setTimeout(() => {
      void this.attach(file, mode === "open").catch((e) => this.plugin.switcher.reportError("Could not add the ink page to the daily note", e));
    }, SETTLE_MS);
  }

  private async attach(file: TFile, open: boolean): Promise<void> {
    if (!(this.app.vault.getAbstractFileByPath(file.path) instanceof TFile)) return;
    // made with an ink page on another device, or an ink page itself (a template with the ink-notebook property)
    if (!this.plugin.pairs.isPlainNote(file)) return;
    const drawing = await this.plugin.switcher.addInkToNote(file, { open: false });
    if (!drawing || !open) return;
    const leaf = this.leafShowing(file);
    if (leaf) await this.plugin.switcher.toInk(leaf, drawing);
  }

  private leafShowing(file: TFile): WorkspaceLeaf | null {
    return this.app.workspace.getLeavesOfType("markdown").find((l) => (l.view as { file?: TFile | null }).file?.path === file.path) ?? null;
  }

  /** Today's daily note on its ink page (the daily notes plugin makes the note, with its template, if it does not exist yet). */
  async openToday(): Promise<void> {
    const daily = dailyNoteSettings(this.app);
    if (!daily) {
      new Notice("Turn on the Daily notes core plugin (or Periodic Notes) to use daily notes.");
      return;
    }
    const path = normalizePath(dailyNotePath(daily.config, date().format(daily.config.format)));
    let file = this.fileAt(path);
    if (!file) {
      this.making = path;
      try {
        (this.app as unknown as PluginsApi).commands?.executeCommandById?.(daily.command);
        for (let waited = 0; !file && waited < 5000; waited += 100) {
          await sleep(100);
          file = this.fileAt(path);
        }
        if (file) await sleep(SETTLE_MS);
      } finally {
        this.making = null;
      }
      if (!file) {
        new Notice("Today's daily note could not be made.");
        return;
      }
    }
    const pairs = this.plugin.pairs;
    let drawing: TFile | null;
    if (pairs.isDrawing(file)) drawing = file;
    else if (pairs.isTextPage(file)) drawing = pairs.drawingFor(file) ?? (await this.plugin.switcher.addInkToNote(file, { open: false }));
    else drawing = await this.plugin.switcher.addInkToNote(file, { open: false });
    if (!drawing) return;
    const leaf = this.leafShowing(file) ?? this.app.workspace.getLeaf(false);
    await leaf.setViewState({ type: INK_VIEW_TYPE, state: { file: drawing.path }, active: true });
    this.plugin.bookmarks.refresh(leaf);
  }

  private fileAt(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }
}
