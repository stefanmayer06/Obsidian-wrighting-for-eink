/**
 * Runs the ink surface and toolbar outside Obsidian, in a plain browser page
 * (dev/harness.html), for fast checks of drawing, tools and speed.
 * Build: node dev/build-harness.mjs
 */
import { InkSurface } from "../src/ink/surface";
import { Toolbar } from "../src/ink/ui/toolbar";
import { newDoc, EMPTY_META } from "../src/core/ink/model";
import { NO_IMAGES } from "../src/ink/render";
import { parseInkFile, serializeInkFile } from "../src/core/ink/codec";

const root = document.getElementById("app") as HTMLElement;
root.classList.add("ink-view-content");
root.dataset.toolbar = "top";

const icon = (el: HTMLElement, name: string) => {
  el.textContent = name.slice(0, 2);
  el.dataset.icon = name;
};

const log: string[] = [];
let changes = 0;
let toolbar: Toolbar | null = null;
const surface = new InkSurface(root, {
  images: NO_IMAGES,
  icon,
  openLink: (t) => log.push(`open:${t}`),
  changed: () => changes++,
  pageChanged: (i, n) => toolbar?.refreshPage(i, n),
  historyChanged: (u, r) => toolbar?.refreshHistory(u, r),
  toolChanged: () => toolbar?.refreshTools(),
  notice: (m) => log.push(`notice:${m}`),
});
toolbar = new Toolbar(root, surface, {
  icon,
  openPages: () => log.push("pages"),
  insertMenu: () => [{ items: [{ icon: "link", label: "Link to a note…", run: () => surface.insertLink("Some note") }] }],
  moreMenu: () => [{ items: [{ icon: "file-plus", label: "Add page at the end", run: () => surface.addPage("end") }] }],
  toolsChanged: () => undefined,
  settingsChanged: () => undefined,
  endButtons: () => [{ id: "text", icon: "file-text", label: "Text", showLabel: true, run: () => log.push("text") }],
});
// the toolbar goes first in the flex column
root.prepend(toolbar.el);
surface.load({ doc: newDoc(), meta: EMPTY_META });
surface.resize();

Object.assign(window, { surface, log, getChanges: () => changes, parseInkFile, serializeInkFile });
