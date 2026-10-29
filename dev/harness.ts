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
import { drawThumb, LibraryPanel } from "../src/ink/ui/libraryPanel";
import { FLOWCHART_LIBRARY_ID, flowchartLibrary } from "../src/core/ink/flowchart";
import { libraryItems, parseExcalidrawLibrary } from "../src/core/ink/excalidrawLib";

/** A small Excalidraw library (as from libraries.excalidraw.com). */
const SAMPLE_LIBRARY = {
  type: "excalidrawlib",
  version: 2,
  libraryItems: [
    {
      id: "cloud",
      name: "Labelled box",
      status: "published",
      elements: [
        { id: "r", type: "rectangle", x: 0, y: 0, width: 200, height: 90, strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "hachure", strokeWidth: 2, roundness: { type: 3 }, angle: 0, opacity: 100 },
        { id: "t", type: "text", x: 50, y: 32, width: 100, height: 25, text: "Server", originalText: "Server", fontSize: 20, textAlign: "center", containerId: "r", strokeColor: "#1971c2" },
      ],
    },
  ],
};

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
let library: LibraryPanel | null = null;
/** The "Sample" library (replace it from the console to try any .excalidrawlib). */
let sample: unknown = SAMPLE_LIBRARY;
const surface = new InkSurface(root, {
  images: NO_IMAGES,
  icon,
  openLink: (t) => log.push(`open:${t}`),
  changed: () => changes++,
  pageChanged: (i, n) => toolbar?.refreshPage(i, n),
  historyChanged: (u, r) => toolbar?.refreshHistory(u, r),
  toolChanged: () => {
    toolbar?.refreshTools();
    library?.markActive();
  },
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
  openLibrary: () => {
    if (library) {
      library.close();
      return;
    }
    library = new LibraryPanel(
      surface.el,
      surface,
      {
        icon,
        sources: async () => [
          { id: FLOWCHART_LIBRARY_ID, name: "Flowchart", flowchart: true },
          { id: "sample", name: "Sample" },
        ],
        items: async (id) => (id === FLOWCHART_LIBRARY_ID ? flowchartLibrary() : libraryItems(parseExcalidrawLibrary(sample))),
        setTools: (patch) => {
          surface.setTools(patch);
          toolbar?.refreshTools();
        },
        actions: () => [{ icon: "upload", label: "Import a library file…", run: () => log.push("import") }],
      },
      () => (library = null),
    );
  },
});
// the toolbar goes first in the flex column
root.prepend(toolbar.el);
surface.load({ doc: newDoc(), meta: EMPTY_META });
surface.resize();

Object.assign(window, {
  surface,
  log,
  getChanges: () => changes,
  parseInkFile,
  serializeInkFile,
  setSampleLibrary: (v: unknown) => (sample = v),
  libraryThumbs: (v: unknown) => libraryItems(parseExcalidrawLibrary(v)).map((it) => {
    const c = document.createElement("canvas");
    drawThumb(c, it);
    return c;
  }),
});
