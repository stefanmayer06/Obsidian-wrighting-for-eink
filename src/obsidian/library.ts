import { Notice, normalizePath, TFile } from "obsidian";
import type InkNotebookPlugin from "../main";
import {
  addToLibraryFile,
  itemsToExcalidraw,
  LibraryError,
  libraryItems,
  libraryNameFromUrl,
  libraryUrlFrom,
  parseExcalidrawLibrary,
  removeFromLibraryFile,
  type LibraryItem,
} from "../core/ink/excalidrawLib";
import { FLOWCHART_LIBRARY_ID, flowchartLibrary } from "../core/ink/flowchart";
import type { Items } from "../core/ink/model";
import { joinPath } from "../core/folders";
import { measuringContext, wrapText } from "../ink/render";
import type { LibrarySource } from "../ink/ui/libraryPanel";
import { send } from "./azureClient";

/**
 * Object libraries for the ink page: the built-in flowchart shapes, every
 * Excalidraw library (`.excalidrawlib`) in the vault, and the library of the
 * Obsidian Excalidraw plugin. Libraries are imported from a file or a link
 * (libraries.excalidraw.com) into the library folder; "To library" in the
 * lasso menu keeps a selection in "My library" – a normal Excalidraw library
 * too, so Excalidraw can use it.
 */

export const LIBRARY_EXTENSION = "excalidrawlib";
const PLUGIN_SOURCE = "excalidraw-plugin";
const MY_LIBRARY = "My library";
const FILE_PREFIX = "file:";

export class LibraryService {
  private cache = new Map<string, { stamp: string; items: LibraryItem[] }>();

  constructor(private plugin: InkNotebookPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  private get folder(): string {
    return this.plugin.settings.libraryFolder;
  }

  private get myLibraryPath(): string {
    return normalizePath(joinPath(this.folder, `${MY_LIBRARY}.${LIBRARY_EXTENSION}`));
  }

  /** Where the Excalidraw plugin keeps its settings (and its library). */
  private get pluginDataPath(): string {
    return normalizePath(`${this.app.vault.configDir}/plugins/obsidian-excalidraw-plugin/data.json`);
  }

  private libraryFiles(): TFile[] {
    return this.app.vault.getFiles().filter((f) => f.extension.toLowerCase() === LIBRARY_EXTENSION);
  }

  async sources(): Promise<LibrarySource[]> {
    const out: LibrarySource[] = [{ id: FLOWCHART_LIBRARY_ID, name: "Flowchart", flowchart: true }];
    const mine = this.myLibraryPath;
    const files = this.libraryFiles().sort((a, b) => (a.path === mine ? -1 : b.path === mine ? 1 : a.basename.localeCompare(b.basename)));
    if (!files.some((f) => f.path === mine)) out.push({ id: FILE_PREFIX + mine, name: MY_LIBRARY, editable: true });
    for (const f of files) out.push({ id: FILE_PREFIX + f.path, name: f.basename, editable: f.path === mine });
    try {
      if (await this.app.vault.adapter.exists(this.pluginDataPath)) out.push({ id: PLUGIN_SOURCE, name: "Excalidraw plugin" });
    } catch {
      /* no plugin library */
    }
    return out;
  }

  async items(id: string): Promise<LibraryItem[]> {
    if (id === FLOWCHART_LIBRARY_ID) return flowchartLibrary();
    let text: string;
    let stamp: string;
    if (id === PLUGIN_SOURCE) {
      const stat = await this.app.vault.adapter.stat(this.pluginDataPath);
      stamp = `${stat?.mtime ?? 0}:${stat?.size ?? 0}`;
      const hit = this.cache.get(id);
      if (hit && hit.stamp === stamp) return hit.items;
      text = await this.app.vault.adapter.read(this.pluginDataPath);
    } else if (id.startsWith(FILE_PREFIX)) {
      const file = this.app.vault.getAbstractFileByPath(id.slice(FILE_PREFIX.length));
      if (!(file instanceof TFile)) return [];
      stamp = `${file.stat.mtime}:${file.stat.size}`;
      const hit = this.cache.get(id);
      if (hit && hit.stamp === stamp) return hit.items;
      text = await this.app.vault.read(file);
    } else return [];
    let raw;
    try {
      raw = parseExcalidrawLibrary(text);
    } catch (e) {
      // the plugin's settings without a library
      if (id === PLUGIN_SOURCE && e instanceof LibraryError) return [];
      throw e;
    }
    const items = libraryItems(raw);
    this.cache.set(id, { stamp, items });
    return items;
  }

  /** Save a library (its text) into the library folder; returns the id of the new source. */
  private async save(name: string, text: string): Promise<string> {
    // never keep what cannot be read
    const raw = parseExcalidrawLibrary(text);
    if (raw.length === 0) throw new LibraryError("This library has no items.");
    await this.plugin.pairs.ensureFolder(this.folder);
    const base = name.replace(/[\\/:*?"<>|#^[\]]+/g, " ").trim() || "Library";
    let path = normalizePath(joinPath(this.folder, `${base}.${LIBRARY_EXTENSION}`));
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(joinPath(this.folder, `${base} ${n}.${LIBRARY_EXTENSION}`));
    await this.app.vault.create(path, text);
    new Notice(`Library “${base}” imported: ${raw.length} item${raw.length === 1 ? "" : "s"}.`);
    return FILE_PREFIX + path;
  }

  /** Import a library file chosen on the device. Resolves to the new source (null: nothing chosen). */
  importFile(): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".excalidrawlib,.json,application/json";
      input.addEventListener("change", () => {
        const f = input.files?.[0];
        if (!f) {
          resolve(null);
          return;
        }
        void f
          .text()
          .then((text) => this.save(f.name.replace(/\.(excalidrawlib|json)$/i, ""), text))
          .then(resolve, reject);
      });
      input.click();
    });
  }

  /** Download a library from a link (a file link, or an "Add to Excalidraw" link). */
  async importUrl(text: string): Promise<string> {
    const url = libraryUrlFrom(text);
    if (!url) throw new LibraryError("Paste the link of a library: from libraries.excalidraw.com, the link of its Download button or of “Add to Excalidraw”.");
    const res = await send({ url }, 30000);
    if (res.status >= 400) throw new LibraryError(`The library could not be downloaded (the server answered ${res.status}).`);
    return this.save(libraryNameFromUrl(url), res.text);
  }

  /** Keep items in "My library" (as an Excalidraw library item). */
  async addToMyLibrary(items: Items, name: string): Promise<void> {
    const ctx = measuringContext();
    const elements = itemsToExcalidraw(items, { wrap: (t) => wrapText(ctx, t.text, t.w, t.size) });
    if (elements.length === 0) throw new LibraryError("There is nothing in the selection a library can keep (pictures, links and figures are not kept).");
    const path = this.myLibraryPath;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (text) => addToLibraryFile(text, { name, elements }));
    } else {
      await this.plugin.pairs.ensureFolder(this.folder);
      await this.app.vault.create(path, addToLibraryFile(null, { name, elements }));
    }
    new Notice(`Added “${name}” to ${MY_LIBRARY}.`);
  }

  async removeItem(sourceId: string, itemId: string): Promise<void> {
    if (!sourceId.startsWith(FILE_PREFIX)) return;
    const file = this.app.vault.getAbstractFileByPath(sourceId.slice(FILE_PREFIX.length));
    if (!(file instanceof TFile)) return;
    await this.app.vault.process(file, (text) => removeFromLibraryFile(text, itemId));
  }
}
