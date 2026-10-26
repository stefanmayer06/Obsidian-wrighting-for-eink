import { Notice, normalizePath, TFile } from "obsidian";
import type InkNotebookPlugin from "../main";
import { serializeInkFile, withInkFrontmatter } from "../core/ink/codec";
import { excalidrawToInk, readExcalidrawScene } from "../core/ink/fromExcalidraw";
import { joinPath, parentPath } from "../core/folders";
import { ConfirmModal } from "./modals";
import { FM_DRAWING_TO_TEXT, FM_TEXT_TO_DRAWING, INK_SUFFIX, pairLink } from "./pairs";

/**
 * Ink pages made with earlier versions of Ink Notebook were Excalidraw
 * drawings (`Name.excalidraw.md`). This converts them into ink notebooks
 * (`Name.ink.md`) next to them and points their text pages at the new file.
 * The old drawings are left untouched, so nothing is lost.
 */

/** Text pages whose `ink-drawing` points at an Excalidraw drawing. */
function oldPairs(plugin: InkNotebookPlugin): Array<{ text: TFile; drawing: TFile }> {
  const out: Array<{ text: TFile; drawing: TFile }> = [];
  const { metadataCache } = plugin.app;
  for (const text of plugin.app.vault.getMarkdownFiles()) {
    const fm = metadataCache.getFileCache(text)?.frontmatter;
    const raw = fm?.[FM_TEXT_TO_DRAWING];
    const link = typeof raw === "string" ? /\[\[([^\]|#]+)/.exec(raw)?.[1] ?? raw : null;
    if (!link || !/\.excalidraw(\.md)?$/i.test(link.trim())) continue;
    const drawing = metadataCache.getFirstLinkpathDest(link.trim(), text.path);
    if (drawing instanceof TFile && drawing.extension === "md" && drawing.basename.endsWith(".excalidraw")) out.push({ text, drawing });
  }
  return out;
}

export async function migrateExcalidrawPages(plugin: InkNotebookPlugin): Promise<void> {
  const pairs = oldPairs(plugin);
  if (pairs.length === 0) {
    new Notice("There are no ink pages made with Excalidraw in this vault.");
    return;
  }
  const ok = await ConfirmModal.ask(plugin.app, {
    title: `Convert ${pairs.length} ink page${pairs.length === 1 ? "" : "s"}?`,
    text: "Each Excalidraw drawing gets an ink notebook (Name.ink.md) next to it with the same pages, writing, shapes, text and pictures, and its text page is updated. The Excalidraw files stay as they are – delete them once you are happy.",
    confirm: "Convert",
  });
  if (!ok) return;
  const notice = new Notice("Converting ink pages…", 0);
  let done = 0;
  const failed: string[] = [];
  for (const { text, drawing } of pairs) {
    try {
      const scene = readExcalidrawScene(await plugin.app.vault.read(drawing));
      if (!scene) throw new Error("no drawing data");
      const ink = excalidrawToInk(scene.elements, scene.files);
      const base = drawing.basename.replace(/\.excalidraw$/i, "");
      const folder = parentPath(drawing.path);
      let path = normalizePath(joinPath(folder, `${base}${INK_SUFFIX}`));
      for (let n = 2; plugin.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(joinPath(folder, `${base} ${n}${INK_SUFFIX}`));
      const fm = withInkFrontmatter("", { [FM_DRAWING_TO_TEXT]: JSON.stringify(`[[${pairLink(text)}]]`) });
      const created = await plugin.app.vault.create(path, serializeInkFile(fm, ink));
      await plugin.app.fileManager.processFrontMatter(text, (f) => {
        f[FM_TEXT_TO_DRAWING] = `[[${pairLink(created)}]]`;
      });
      done++;
      notice.setMessage(`Converting ink pages… ${done} of ${pairs.length}`);
      // the text page's pictures of the old drawing are rewritten by the next transcription
      window.setTimeout(() => void plugin.sync.syncInkToText(created, { network: true }).catch(() => undefined), 500 * done);
    } catch (e) {
      console.error("Ink Notebook: conversion failed", drawing.path, e);
      failed.push(drawing.path);
    }
  }
  notice.hide();
  new Notice(`Converted ${done} ink page${done === 1 ? "" : "s"}.${failed.length ? ` Could not convert: ${failed.join(", ")}` : ""}`, 10000);
  plugin.bookmarks.refreshAll();
}
