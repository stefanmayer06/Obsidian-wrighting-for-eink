// End-to-end test of Ink Notebook (with its built-in Excalidraw) inside a real Obsidian.
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const E2E = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VAULT = path.join(E2E, "vault");
const SHOTS = path.join(E2E, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const MOCK = "http://127.0.0.1:8765";
const CLOUD = "http://127.0.0.1:8766/functions/v1/ocr";
const only = process.argv[2]; // optional: run a single step
// the vault has the Excalidraw plugin installed itself (setup-vault.sh with OWN_EXCALIDRAW=1)
const OWN = !!process.env.OWN_EXCALIDRAW;
const EXCALIDRAW_ID = "obsidian-excalidraw-plugin";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html"));
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  if (m.text().includes("Ink Notebook")) console.log(`   [console.${m.type()}] ${m.text().slice(0, 300)}`);
});

let failures = 0;
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond });
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).replace(/\n/g, "\n      ")}` : ""}`);
  }
}
const ev = (fn, arg) => page.evaluate(fn, arg);
const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, name) });
};
const mock = async (cfg) => fetch(`${MOCK}/__config`, { method: "POST", body: JSON.stringify(cfg) });
const mockStats = async () => (await fetch(`${MOCK}/__stats`)).json();

// ---------------------------------------------------------------- in-page helpers
const injectHelpers = () => ev(() => {
  const t = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async waitFor(fn, timeout = 20000, label = "") {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < timeout) {
        try {
          last = await fn();
          if (last) return last;
        } catch (e) {
          last = e;
        }
        await t.sleep(100);
      }
      throw new Error(`timeout waiting for ${label || fn.toString().slice(0, 120)} (last: ${last})`);
    },
    plugin: () => app.plugins.plugins["ink-notebook"],
    leaf: () => app.workspace.getMostRecentLeaf(),
    view: () => app.workspace.getMostRecentLeaf()?.view,
    ea(view) {
      const ea = app.plugins.plugins["obsidian-excalidraw-plugin"].ea.getAPI(view);
      ea.setView(view);
      return ea;
    },
    freedraw(ea, x, y, w, h, pts) {
      const id = ea.addLine([[x, y], [x + w, y + h]]);
      const el = ea.getElement(id);
      Object.assign(el, { type: "freedraw", points: pts, pressures: [], simulatePressure: true, lastCommittedPoint: null, x, y, width: w, height: h, strokeWidth: 1, roughness: 0, roundness: null, strokeColor: "#1e1e1e" });
      delete el.startArrowhead;
      delete el.endArrowhead;
      delete el.startBinding;
      delete el.endBinding;
      return id;
    },
    word(ea, x, y, w, h) {
      const pts = [];
      const n = Math.max(6, Math.round(w / 6));
      for (let i = 0; i <= n; i++) pts.push([(w * i) / n, i % 2 ? h : h * 0.15]);
      return t.freedraw(ea, x, y, w, h, pts);
    },
    /** A freedraw stroke through absolute scene points. */
    path(ea, pts) {
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const [x, y] = pts[0];
      return t.freedraw(ea, x, y, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), pts.map(([px, py]) => [px - x, py - y]));
    },
    dash(ea, x, y, w) {
      return t.freedraw(ea, x, y, w, 2, [[0, 0], [w / 2, 1], [w, 2]]);
    },
    box(ea, x, y, w, h) {
      const pts = [];
      const s = 20;
      for (let i = 0; i <= s; i++) pts.push([(w * i) / s, 0]);
      for (let i = 0; i <= s; i++) pts.push([w, (h * i) / s]);
      for (let i = s; i >= 0; i--) pts.push([(w * i) / s, h]);
      for (let i = s; i >= 0; i--) pts.push([0, (h * i) / s]);
      return t.freedraw(ea, x, y, w, h, pts);
    },
    async read(p) {
      return app.vault.read(app.vault.getAbstractFileByPath(p));
    },
    inkData: (e) => e.customData?.inkNotebook,
  };
  window.__t = t;
});
await injectHelpers();

async function setSettings(patch) {
  await ev(async (patch) => {
    const p = __t.plugin();
    Object.assign(p.settings, patch);
    await p.saveSettings();
  }, patch);
}

async function waitView(type, file) {
  return ev(
    async ({ type, file }) => {
      await __t.waitFor(() => {
        const v = __t.view();
        return v && v.getViewType() === type && (!file || v.file?.path === file) && (type !== "excalidraw" || (v.excalidrawAPI && v.semaphores?.viewloaded && v.isLoaded && !v.semaphores?.justLoaded && v.lastSceneLoadTime > 0));
      }, 20000, `view ${type} ${file ?? ""}`);
      await __t.sleep(600);
      return __t.view().file.path;
    },
    { type, file },
  );
}

async function clickBookmark(which) {
  // notices (e.g. "Saved …") can cover the bookmarks for a few seconds
  await ev(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
  await page.click(`.workspace-leaf.mod-active .ink-bookmark-${which}`, { timeout: 5000 });
}

/** Choose in the paper picker (only the given fields) and confirm. */
async function pickPaper({ style, spacing, color, orientation, position, name }) {
  await page.waitForSelector(".modal.ink-paper-picker", { timeout: 5000 });
  if (name !== undefined) await page.fill(".modal.ink-paper-picker .ink-paper-name-row input", name);
  if (style) await page.click(`.modal.ink-paper-picker .ink-paper-card[data-style="${style}"]`);
  for (const v of [spacing, color, orientation, position]) if (v) await page.click(`.modal.ink-paper-picker .ink-segmented button[data-value="${v}"]`);
  await page.click(".modal.ink-paper-picker button.mod-cta");
  await page.waitForSelector(".modal.ink-paper-picker", { state: "detached", timeout: 5000 });
}

/** Do the visible bookmarks of the active page overlap any toolbar, panel or header? */
async function bookmarkOverlaps() {
  return ev(async () => {
    await __t.sleep(900); // the layout pass is debounced
    const leafEl = document.querySelector(".workspace-leaf.mod-active .workspace-leaf-content");
    const c = leafEl.getBoundingClientRect();
    const sel = [".view-header", ".excalidraw .Island", ".excalidraw .sidebar", '.excalidraw [class*="misc-tools-container"]', ".excalidraw .layer-ui__wrapper__footer-right", ".excalidraw .ToolIcon", ".excalidraw button"].join(",");
    const obstacles = [...leafEl.querySelectorAll(sel), ...document.querySelectorAll(".status-bar, .mobile-navbar")]
      .filter((e) => !e.closest(".ink-bookmarks, .HintViewer") && getComputedStyle(e).visibility !== "hidden")
      .map((e) => ({ cls: e.className?.baseVal ?? String(e.className).slice(0, 60), r: e.getBoundingClientRect() }))
      .filter((o) => o.r.width > 0 && o.r.height > 0);
    const buttons = [...leafEl.querySelectorAll(".ink-bookmarks .ink-bookmark")].filter((b) => getComputedStyle(b).display !== "none").map((b) => b.getBoundingClientRect());
    const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const bad = [];
    for (const b of buttons) for (const o of obstacles) if (hit(b, o.r)) bad.push({ obstacle: o.cls, o: [o.r.left, o.r.top, o.r.width, o.r.height].map(Math.round), b: [b.left, b.top, b.width, b.height].map(Math.round) });
    const inside = buttons.every((b) => b.top >= c.top && b.bottom <= c.bottom + 0.5 && b.right <= c.right + 0.5);
    const root = leafEl.querySelector(".ink-bookmarks");
    return { ok: buttons.length > 0 && bad.length === 0 && inside, n: buttons.length, inside, compact: root?.classList.contains("is-compact"), cramped: root?.classList.contains("is-cramped"), bad: bad.slice(0, 4) };
  });
}

async function setWindow(w, h) {
  await ev(({ w, h }) => {
    const win = window.require("@electron/remote").getCurrentWindow();
    win.unmaximize();
    win.setBounds({ x: 0, y: 0, width: w, height: h });
  }, { w, h });
  await page.waitForTimeout(900);
}

/** Paper pages of the open drawing, top to bottom. */
const papersOnPage = () =>
  ev(() => {
    const api = __t.view().excalidrawAPI;
    const files = api.getFiles();
    const els = api.getSceneElements();
    return els
      .map((e, z) => ({ e, z }))
      .filter(({ e }) => ["paper", "pdf-page", "image-page"].includes(e.customData?.inkNotebook?.role))
      .map(({ e, z }) => ({ id: e.id, x: e.x, y: Math.round(e.y), w: e.width, h: e.height, z, style: e.customData.inkNotebook.paper?.style, orientation: e.customData.inkNotebook.paper?.orientation, hasFile: !!files[e.fileId], locked: e.locked }))
      .sort((a, b) => a.y - b.y);
  });

// ---------------------------------------------------------------- state shared between steps
const state = {};

// ---------------------------------------------------------------- steps
const steps = {};

steps.setup = async () => {
  console.log("\n▶ setup: plugin loaded, settings, window");
  await ev(() => {
    const w = window.require("@electron/remote").getCurrentWindow();
    w.unmaximize();
    w.setBounds({ x: 0, y: 0, width: 800, height: 1200 });
  });
  await page.waitForTimeout(800);
  const info = await ev(() => ({ loaded: !!__t.plugin(), ea: !!app.plugins.plugins["obsidian-excalidraw-plugin"]?.ea, size: [innerWidth, innerHeight] }));
  check("ink-notebook and excalidraw are loaded", info.loaded && info.ea, JSON.stringify(info));
  const ex = await ev((id) => ({
    builtIn: __t.plugin().excalidraw.active,
    installed: !!app.plugins.manifests[id],
    version: app.plugins.plugins[id]?.manifest?.version,
    dir: app.plugins.plugins[id]?.manifest?.dir,
    styles: [...document.head.querySelectorAll("style")].filter((s) => s.textContent.includes(".excalidraw-script-store")).length,
  }), EXCALIDRAW_ID);
  if (OWN) check("the user's own Excalidraw plugin is used, the built-in one stays idle", ex.installed && !ex.builtIn && ex.styles === 1, JSON.stringify(ex));
  else check("Excalidraw is built in: nothing else installed, its settings and styles are Ink Notebook's", ex.builtIn && !ex.installed && ex.dir === ".obsidian/plugins/ink-notebook/excalidraw" && ex.styles === 1, JSON.stringify(ex));
  // the main flow uses the older side-by-side layout in a fixed folder; the "folders"/"paper…" steps cover the new defaults
  await setSettings({ setupDone: true, azureEndpoint: MOCK, azureKey: "test-key", azureApi: "auto", azureDetectedApi: "", einkMode: "off", queue: [], pageLocation: "fixed", folder: "Ink", inkSubfolder: "", askForPaper: false });
  await ev(() => {
    app.vault.setConfig("alwaysUpdateLinks", true);
    document.querySelectorAll(".modal-close-button").forEach((b) => b.click());
  });
  await mock({ reset: true, mode: "ok", responses: [], fallback: null });
};

steps.createPage = async () => {
  console.log("\n▶ create a new ink page");
  await ev(() => app.commands.executeCommandById("ink-notebook:new-page"));
  state.drawing = await waitView("excalidraw");
  check("new drawing opens in Excalidraw", state.drawing?.endsWith(".excalidraw.md"), state.drawing);
  state.text = state.drawing.replace(/\.excalidraw\.md$/, ".md");
  const info = await ev(async ({ drawing, text }) => {
    const d = app.vault.getAbstractFileByPath(drawing);
    const tf = app.vault.getAbstractFileByPath(text);
    const els = __t.view().excalidrawAPI.getSceneElements();
    return {
      textExists: !!tf,
      textContent: tf ? await app.vault.read(tf) : null,
      drawingFm: app.metadataCache.getFileCache(d)?.frontmatter,
      paper: els.filter((e) => __t.inkData(e)?.role === "paper").map((e) => ({ w: e.width, h: e.height, locked: e.locked })),
      bookmarks: document.querySelectorAll(".workspace-leaf.mod-active .ink-bookmark-tabs .ink-bookmark").length,
      addButton: !!document.querySelector(".workspace-leaf.mod-active .ink-bookmark-add:not(.is-hidden)"),
      activeBookmark: document.querySelector(".workspace-leaf.mod-active .ink-bookmark.is-active")?.textContent,
    };
  }, state);
  check("text page was created next to the drawing", info.textExists, JSON.stringify(info));
  check("text page links to the drawing", /ink-drawing: "\[\[.*\.excalidraw\]\]"/.test(info.textContent ?? ""), info.textContent);
  check("drawing links back to the text page", typeof info.drawingFm?.["ink-text"] === "string" && info.drawingFm["ink-text"].includes("[["), JSON.stringify(info.drawingFm));
  check("lined paper page added, locked, A4 size", info.paper.length === 1 && info.paper[0].locked && info.paper[0].w === 1000, JSON.stringify(info.paper));
  check("two bookmarks shown, Ink active", info.bookmarks === 2 && /Ink/.test(info.activeBookmark ?? ""), JSON.stringify(info));
  check("+ Page bookmark shown on the ink page", info.addButton, JSON.stringify(info));
  await shot("02-new-ink-page.png");
};

steps.write = async () => {
  console.log("\n▶ write handwriting, a diagram and a text element");
  await ev(async () => {
    const view = __t.view();
    const ea = __t.ea(view);
    // paragraph (two lines)
    __t.word(ea, 100, 150, 110, 30);
    __t.word(ea, 225, 150, 120, 30);
    __t.word(ea, 360, 150, 130, 30);
    __t.word(ea, 100, 195, 70, 30);
    __t.word(ea, 185, 195, 140, 30);
    // list
    __t.dash(ea, 100, 335, 16);
    __t.word(ea, 130, 320, 90, 30);
    __t.dash(ea, 100, 380, 16);
    __t.word(ea, 130, 365, 90, 30);
    // a handwritten link
    __t.word(ea, 100, 440, 70, 30);
    __t.word(ea, 185, 440, 150, 30);
    // diagram: hand-drawn box with a label and an arrow
    __t.box(ea, 550, 500, 250, 150);
    __t.word(ea, 610, 555, 120, 36);
    ea.style.strokeColor = "#1e1e1e";
    ea.addArrow([[800, 575], [950, 575]]);
    // typed text element with a link
    ea.style.fontSize = 20;
    ea.addText(100, 760, "See [[Welcome]] for details");
    await ea.addElementsToView(false, true, true);
    ea.destroy();
  });
  await page.waitForTimeout(800);
  await shot("03-ink-page-with-writing.png");
  await mock({ responses: [["The quick brown", "fox jumps", "- milk", "- eggs", "Call [[Welcome]]"], ["Start"]] });
};

steps.flipToText = async () => {
  console.log("\n▶ flip to the text page (bookmark)");
  await clickBookmark("text");
  const p = await waitView("markdown");
  check("text page opens in the same tab", p === state.text, p);
  const md = await ev((p) => __t.read(p), state.text);
  state.md1 = md;
  console.log("----- text page -----\n" + md + "\n---------------------");
  check("paragraph lines are joined", md.includes("The quick brown fox jumps"));
  check("list is recognised", md.includes("- milk\n- eggs"));
  check("diagram is embedded live via #^area", /!\[\[.*\.excalidraw#\^area=[A-Za-z0-9_-]+\|\d+\]\]/.test(md));
  check("diagram label kept (hidden comment)", md.includes("%% Start %%"));
  check("typed Excalidraw text element with link is included", md.includes("See [[Welcome]] for details"));
  check("handwriting label is not duplicated as a paragraph", !/^Start$/m.test(md));
  const regions = await ev(async (drawing) => {
    const f = app.vault.getAbstractFileByPath(drawing);
    const ea = app.plugins.plugins["obsidian-excalidraw-plugin"].ea.getAPI();
    const scene = await ea.getSceneFromFile(f);
    ea.destroy();
    return scene.elements.filter((e) => e.customData?.inkNotebook?.role === "region").map((e) => ({ id: e.id, locked: e.locked, x: e.x, w: e.width }));
  }, state.drawing);
  check("one invisible region rectangle saved in the drawing", regions.length === 1 && regions[0].locked, JSON.stringify(regions));
  check("embed references that region", regions.length === 1 && md.includes(`#^area=${regions[0].id}`));
  check("handwritten link transcribed", md.includes("Call [[Welcome]]"), md);
  const linked = await ev(async (drawing) => {
    const ea = app.plugins.plugins["obsidian-excalidraw-plugin"].ea.getAPI();
    const scene = await ea.getSceneFromFile(app.vault.getAbstractFileByPath(drawing));
    ea.destroy();
    return scene.elements.filter((e) => e.type === "freedraw" && e.link).map((e) => ({ x: Math.round(e.x), y: Math.round(e.y), link: e.link }));
  }, state.drawing);
  check("handwritten link is clickable on the ink page", linked.length === 1 && linked[0].link === "[[Welcome]]" && linked[0].x === 185, JSON.stringify(linked));
  const stats = await mockStats();
  check("one OCR request per writing area", stats.requestCount === 2, JSON.stringify(stats));
  await page.waitForTimeout(1500); // let the Excalidraw embed render
  const embed = await ev(async () => {
    await __t.waitFor(() => document.querySelector(".workspace-leaf.mod-active .markdown-reading-view img, .workspace-leaf.mod-active .markdown-reading-view .excalidraw-svg svg"), 8000, "embed image").catch(() => null);
    const root = document.querySelector(".workspace-leaf.mod-active .markdown-reading-view");
    const imgs = root ? [...root.querySelectorAll("img, svg")].filter((e) => !e.closest(".ink-bookmarks")) : [];
    return { img: imgs.length > 0, tags: imgs.map((e) => `${e.tagName}.${e.getAttribute("class") ?? ""}`).slice(0, 5) };
  });
  check("diagram embed renders as an image in reading view", embed?.img, JSON.stringify(embed));
  await shot("04-text-page.png");
};

steps.editText = async () => {
  console.log("\n▶ correct the transcript and type notes on the text page");
  await ev(async (p) => {
    const f = app.vault.getAbstractFileByPath(p);
    await app.vault.process(f, (md) => md.replace("fox jumps", "fox jumped") + "\nTyped note about [[Welcome]]\n- a typed bullet\n");
  }, state.text);
  await page.waitForTimeout(500);
};

steps.flipToInk = async () => {
  console.log("\n▶ flip to the ink page – typed notes appear on the drawing");
  await clickBookmark("ink");
  await waitView("excalidraw", state.drawing);
  const card = await ev(async () => {
    const v = __t.view();
    const c = await __t.waitFor(() => v.excalidrawAPI.getSceneElements().find((e) => e.customData?.inkNotebook?.role === "typed"), 8000, "typed card");
    return { text: c.rawText ?? c.originalText ?? c.text, display: c.text, width: c.width, height: c.height, x: c.x, y: c.y, fontFamily: c.fontFamily };
  });
  console.log("   card:", JSON.stringify(card));
  check("typed notes card created on the drawing", card.text === "Typed note about [[Welcome]]\n- a typed bullet", card.text);
  check("card placed below the writing inside the page", card.y > 760 && card.x >= 80 && card.y < 1414, JSON.stringify(card));
  await shot("05-ink-with-typed-card.png");
};

steps.flipBack = async () => {
  console.log("\n▶ flip back – correction preserved, nothing duplicated");
  await clickBookmark("text");
  await waitView("markdown", state.text);
  const md = await ev((p) => __t.read(p), state.text);
  check("user correction kept", md.includes("The quick brown fox jumped") && !md.includes("fox jumps"), md);
  check("typed notes appear once", md.split("Typed note about [[Welcome]]").length === 2, md);
  const stats = await mockStats();
  check("no new OCR request (cache hit)", stats.requestCount === 2, JSON.stringify(stats));
};

steps.editCard = async () => {
  console.log("\n▶ edit the typed card on the ink page – the text page follows");
  await clickBookmark("ink");
  await waitView("excalidraw", state.drawing);
  await page.waitForTimeout(1500); // a person needs at least this long before editing
  await ev(async () => {
    const v = __t.view();
    const ea = __t.ea(v);
    const card = v.excalidrawAPI.getSceneElements().find((e) => e.customData?.inkNotebook?.role === "typed");
    ea.copyViewElementsToEAforEditing([card]);
    const m = ea.getElement(card.id);
    m.text = m.originalText = m.rawText = "Typed note about [[Welcome]]\n- a typed bullet\n- added on the ink page";
    await ea.addElementsToView(false, true, true, true);
    ea.destroy();
  });
  await page.waitForTimeout(500);
  const after = await ev(() => {
    const c = __t.view().excalidrawAPI.getSceneElements().find((e) => e.customData?.inkNotebook?.role === "typed");
    return { rawText: c.rawText, originalText: c.originalText, text: c.text, cd: c.customData };
  });
  console.log("   card after edit:", JSON.stringify(after));
  await clickBookmark("text");
  await waitView("markdown", state.text);
  const md = await ev((p) => __t.read(p), state.text);
  check("card edit synced back to the text page", md.includes("- added on the ink page"), md);
  check("transcript correction still there", md.includes("fox jumped"), md);
  await page.waitForTimeout(2000);
  // typed sync back to the drawing must not loop or duplicate
  const card = await ev(async (p) => {
    const ea = app.plugins.plugins["obsidian-excalidraw-plugin"].ea.getAPI();
    const scene = await ea.getSceneFromFile(app.vault.getAbstractFileByPath(p));
    ea.destroy();
    return scene.elements.filter((e) => e.customData?.inkNotebook?.role === "typed").length;
  }, state.drawing);
  check("still exactly one typed card", card === 1, card);
};

steps.tasksTables = async () => {
  console.log("\n▶ hand-drawn checkboxes and a table become tasks and a Markdown table");
  await ev(() => app.commands.executeCommandById("ink-notebook:new-page"));
  const drawing = await waitView("excalidraw");
  const text = drawing.replace(/\.excalidraw\.md$/, ".md");
  await ev(async () => {
    const v = __t.view();
    const ea = __t.ea(v);
    // a ticked box in front of "get the", an empty one in front of "milk"
    __t.box(ea, 100, 600, 40, 40);
    __t.path(ea, [[108, 615], [117, 632], [130, 610], [150, 580]]);
    __t.word(ea, 160, 605, 70, 30);
    __t.word(ea, 245, 605, 60, 30);
    __t.box(ea, 100, 670, 40, 40);
    __t.word(ea, 160, 675, 90, 30);
    // a 3×3 table: a line under the headings, one between the rows, two column lines
    __t.path(ea, [[100, 1200], [400, 1201], [700, 1203]]);
    __t.path(ea, [[100, 1300], [400, 1299], [700, 1297]]);
    __t.path(ea, [[300, 1150], [301, 1300], [300, 1420]]);
    __t.path(ea, [[500, 1150], [500, 1300], [501, 1420]]);
    for (const x of [150, 350, 550]) for (const y of [1160, 1240, 1345]) __t.word(ea, x, y, 60, 30);
    await ea.addElementsToView(false, true, true);
    ea.destroy();
  });
  await page.waitForTimeout(800);
  await shot("tasks-tables-ink.png");
  const units = await ev(() => {
    const strokes = __t.view().excalidrawAPI.getSceneElements().filter((e) => e.type === "freedraw" && !e.isDeleted && !e.customData?.inkNotebook);
    return __t.plugin().internals.planOcrUnits(strokes, 150).map((u) => ({ all: u.elementIds.length, drawn: u.renderIds.length }));
  });
  check("the four table lines are left out of the OCR image", units.some((u) => u.all === 13 && u.drawn === 9), JSON.stringify(units));
  // OCR reads the drawn boxes as "D" and "0"; the table lines are left out of its image
  await mock({ responses: [["D get the", "0 milk"], ["a b c", "d e f", "g h i"]] });
  await clickBookmark("text");
  await waitView("markdown", text);
  const md = await ev((p) => __t.read(p), text);
  console.log("----- text page -----\n" + md + "\n---------------------");
  check("hand-drawn boxes become tasks (ticked = done)", md.includes("- [x] get the\n- [ ] milk"), md);
  check("hand-drawn table becomes a Markdown table", md.includes("| a | b | c |\n| --- | --- | --- |\n| d | e | f |\n| g | h | i |"), md);
  check("neither is embedded as a picture", !md.includes("#^area="), md);
  const rendered = await ev(async () => {
    await __t.waitFor(() => document.querySelector(".workspace-leaf.mod-active .markdown-reading-view table"), 5000, "table");
    const root = document.querySelector(".workspace-leaf.mod-active .markdown-reading-view");
    const boxes = [...root.querySelectorAll("input.task-list-item-checkbox")];
    return { boxes: boxes.length, checked: boxes.filter((b) => b.checked).length, headers: [...root.querySelectorAll("table th")].map((th) => th.textContent.trim()) };
  });
  check("reading view shows tickable checkboxes and a table", rendered.boxes === 2 && rendered.checked === 1 && rendered.headers.join() === "a,b,c", JSON.stringify(rendered));
  await shot("tasks-tables-text.png");
  // back to the main page for the next steps
  if (state.text) {
    await ev((p) => app.workspace.getMostRecentLeaf().openFile(app.vault.getAbstractFileByPath(p)), state.text);
    await waitView("markdown", state.text);
  }
};

steps.offline = async () => {
  console.log("\n▶ offline: new handwriting is queued and shown as an image");
  await clickBookmark("ink");
  await waitView("excalidraw", state.drawing);
  await ev(async () => {
    const v = __t.view();
    const ea = __t.ea(v);
    __t.word(ea, 100, 1150, 140, 32);
    __t.word(ea, 255, 1150, 160, 32);
    await ea.addElementsToView(false, true, true);
    ea.destroy();
  });
  await page.waitForTimeout(500);
  // simulate no connection: point the endpoint at a closed port
  await setSettings({ azureEndpoint: "http://127.0.0.1:8799" });
  await clickBookmark("text");
  await waitView("markdown", state.text);
  const md = await ev((p) => __t.read(p), state.text);
  const q = await ev(() => __t.plugin().settings.queue);
  console.log("----- offline text page -----\n" + md + "\n---------------------");
  check("offline callout shown", md.includes("Waiting for a connection"), md);
  check("page shown as image while waiting", /!\[\[.*\.excalidraw#\^area=[^\]]+\]\]/.test(md));
  check("drawing is in the offline queue", q.includes(state.drawing), JSON.stringify(q));
  check("earlier transcript kept while offline", md.includes("The quick brown fox jumped"));
  await shot("06-offline.png");
  const badge = await ev(() => document.querySelector(".workspace-leaf.mod-active .ink-bookmark-badge")?.className);
  check("bookmark shows the offline badge", /is-offline/.test(badge ?? ""), badge);

  console.log("   …back online");
  await setSettings({ azureEndpoint: MOCK });
  await mock({ responses: [["Second page note"]] });
  await ev(() => __t.plugin().processQueue());
  await page.waitForTimeout(500);
  const md2 = await ev((p) => __t.read(p), state.text);
  const q2 = await ev(() => __t.plugin().settings.queue);
  check("queued page transcribed when back online", md2.includes("Second page note"), md2);
  check("callout removed", !md2.includes("Waiting for a connection"), md2);
  check("queue emptied", q2.length === 0, JSON.stringify(q2));
};

steps.v3 = async () => {
  console.log("\n▶ API fallback: Image Analysis 4.0 unavailable -> Read 3.2");
  await mock({ mode: "v4-unsupported", responses: [["Read three two works"]] });
  await setSettings({ azureApi: "auto", azureDetectedApi: "" });
  await clickBookmark("ink");
  await waitView("excalidraw", state.drawing);
  await ev(async () => {
    const v = __t.view();
    const ea = __t.ea(v);
    __t.word(ea, 2000, 100, 150, 30);
    __t.word(ea, 2170, 100, 150, 30);
    __t.word(ea, 2340, 100, 150, 30);
    __t.word(ea, 2510, 100, 150, 30);
    await ea.addElementsToView(false, true, true);
    ea.destroy();
  });
  await page.waitForTimeout(400);
  await clickBookmark("text");
  await waitView("markdown", state.text);
  const md = await ev((p) => __t.read(p), state.text);
  const detected = await ev(() => __t.plugin().settings.azureDetectedApi);
  check("fell back to Read 3.2 and remembered it", detected === "v3.2", detected);
  check("text from Read 3.2 added", md.includes("Read three two works"), md);
  await mock({ mode: "ok" });
};

steps.errors = async () => {
  console.log("\n▶ wrong key: friendly error, nothing lost");
  await setSettings({ azureKey: "wrong" });
  await clickBookmark("ink");
  await waitView("excalidraw", state.drawing);
  await ev(async () => {
    const v = __t.view();
    const ea = __t.ea(v);
    __t.word(ea, 100, 3000, 150, 30);
    await ea.addElementsToView(false, true, true);
    ea.destroy();
  });
  await clickBookmark("text");
  await waitView("markdown", state.text);
  const md = await ev((p) => __t.read(p), state.text);
  check("error callout explains the problem", /recognition failed[\s\S]*invalid subscription key/i.test(md), md.slice(0, 600));
  check("previous transcript still intact", md.includes("fox jumped") && md.includes("Second page note"));
  await setSettings({ azureKey: "test-key" });
  await mock({ responses: [["fixed key line"]] });
  await ev(() => __t.plugin().processQueue());
  const md2 = await ev((p) => __t.read(p), state.text);
  check("recovers after the key is fixed", md2.includes("fixed key line") && !/recognition failed/i.test(md2), md2.slice(0, 600));
};

steps.cloud = async () => {
  console.log("\n▶ Ink Notebook Cloud: a license key instead of an Azure resource");
  await setSettings({ ocrProvider: "cloud", cloudEndpoint: CLOUD, cloudLicenseKey: "INK_e2e-active-license", azureKey: "" });
  await mock({ mode: "ok", responses: [["Recognised by the cloud"]] });
  const writeAt = async (y) => {
    await clickBookmark("ink");
    await waitView("excalidraw", state.drawing);
    await ev(async (y) => {
      const v = __t.view();
      const ea = __t.ea(v);
      __t.word(ea, 100, y, 150, 30);
      __t.word(ea, 270, y, 150, 30);
      __t.word(ea, 440, y, 150, 30);
      await ea.addElementsToView(false, true, true);
      ea.destroy();
    }, y);
    await page.waitForTimeout(400);
    await clickBookmark("text");
    await waitView("markdown", state.text);
    return ev((p) => __t.read(p), state.text);
  };
  const before = await ev(() => __t.plugin().ocr.cloudStatus());
  const md = await writeAt(3400);
  check("handwriting transcribed through Ink Notebook Cloud", md.includes("Recognised by the cloud"), md.slice(-800));
  const status = await ev(() => __t.plugin().ocr.cloudStatus());
  check("the cloud counts the recognition", status.used === before.used + 1 && status.limit === 100, JSON.stringify({ before, status }));

  // Obsidian opens the settings in a window of their own; the plugin tab lives in app.setting.activeTab
  await ev(() => __t.plugin().openSettings());
  await page.waitForTimeout(1500);
  const ui = await ev(() => {
    const root = app.setting.activeTab?.containerEl;
    const select = [...(root?.querySelectorAll(".setting-item") ?? [])].find((el) => el.querySelector(".setting-item-name")?.textContent === "Service")?.querySelector("select");
    return { tab: app.setting.activeTab?.id, service: select?.value ?? null, subscribe: !!root?.querySelector('a[href="https://example.com/checkout"]'), azureFields: !!root?.querySelector('input[placeholder^="https://<name>"]') };
  });
  check("settings offer the cloud, with a Subscribe link and no Azure fields", ui.service === "cloud" && ui.subscribe && !ui.azureFields, JSON.stringify(ui));
  const checked = await ev(async () => {
    const root = app.setting.activeTab.containerEl;
    [...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Check")?.click();
    await __t.waitFor(() => /Active|✗/.test(root.querySelector(".ink-test-status")?.textContent ?? ""), 8000, "subscription check").catch(() => null);
    [...root.querySelectorAll(".setting-item-heading")].find((h) => /Handwriting/.test(h.textContent))?.scrollIntoView();
    return root.querySelector(".ink-test-status")?.textContent;
  });
  check("Check shows the subscription and usage", (checked ?? "").includes(`Active – ${status.used} of 100 recognitions used this month`), checked);
  const settingsPage = browser.contexts().flatMap((c) => c.pages()).find((p) => p !== page && p.url() === "about:blank");
  if (settingsPage) await settingsPage.screenshot({ path: path.join(SHOTS, "18-cloud-settings.png") }).catch(() => {});
  await ev(() => app.setting.close());
  await page.waitForTimeout(300);

  await setSettings({ cloudLicenseKey: "INK_e2e-ended-license" });
  const md2 = await writeAt(3500);
  check("an ended subscription is explained on the text page", /recognition failed[\s\S]*license key is not active/i.test(md2), md2.slice(0, 600));
  check("nothing is lost while the key is not active", md2.includes("Recognised by the cloud"));
  await setSettings({ cloudLicenseKey: "INK_e2e-active-license" });
  await mock({ responses: [["Renewed and working"]] });
  await ev(() => __t.plugin().processQueue());
  const md3 = await ev((p) => __t.read(p), state.text);
  check("recognition resumes with an active key", md3.includes("Renewed and working") && !/not active/.test(md3), md3.slice(0, 600));
  await setSettings({ ocrProvider: "azure", cloudEndpoint: "", cloudLicenseKey: "", azureKey: "test-key" });
};

steps.pdf = async () => {
  console.log("\n▶ annotate a PDF and export it");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    const pg = doc.addPage([595, 842]);
    pg.drawText(`Sample PDF page ${i}`, { x: 60, y: 760, size: 28, font });
  }
  const rotated = doc.addPage([595, 842]);
  rotated.drawText("Rotated page", { x: 60, y: 760, size: 28, font });
  rotated.setRotation({ type: "degrees", angle: 90 });
  const b64 = Buffer.from(await doc.save()).toString("base64");
  await ev(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    if (!app.vault.getAbstractFileByPath("Docs")) await app.vault.createFolder("Docs");
    const f = await app.vault.createBinary("Docs/sample.pdf", bin.buffer);
    await __t.plugin().annotatePdf(f);
  }, b64);
  state.pdfDrawing = await waitView("excalidraw");
  check("annotation page created", /sample \(annotated\)\.excalidraw\.md$/.test(state.pdfDrawing), state.pdfDrawing);
  const pages = await ev(() =>
    __t.view().excalidrawAPI.getSceneElements().filter((e) => e.customData?.inkNotebook?.role === "pdf-page").map((e) => ({ page: e.customData.inkNotebook.page, x: e.x, y: e.y, w: e.width, h: e.height, locked: e.locked, fileId: e.fileId })),
  );
  check("all PDF pages placed as locked backgrounds", pages.length === 3 && pages.every((p) => p.locked), JSON.stringify(pages));
  const rot = pages.find((p) => p.page === 3);
  check("rotated page has landscape proportions", rot && rot.w > rot.h, JSON.stringify(rot));
  const files = await ev(() => Object.keys(__t.view().excalidrawAPI.getFiles()).length);
  check("PDF pages rendered as images", files >= 3, files);
  await page.waitForTimeout(1500);
  await shot("07-pdf-annotation.png");
  // write on page 1 and on the rotated page 3
  await ev(async (pages) => {
    const v = __t.view();
    const ea = __t.ea(v);
    const p1 = pages.find((p) => p.page === 1);
    const p3 = pages.find((p) => p.page === 3);
    __t.word(ea, p1.x + 120, p1.y + 300, 200, 40);
    __t.word(ea, p1.x + 340, p1.y + 300, 160, 40);
    __t.box(ea, p1.x + 600, p1.y + 600, 250, 160);
    __t.word(ea, p3.x + 100, p3.y + 100, 200, 40);
    await ea.addElementsToView(false, true, true);
    ea.destroy();
  }, pages);
  await page.waitForTimeout(600);
  await shot("08-pdf-annotated.png");
  await ev(() => __t.plugin().exportAnnotatedPdf(app.workspace.getMostRecentLeaf()));
  await page.waitForTimeout(2000);
  const outPath = path.join(path.dirname(path.join(VAULT, state.pdfDrawing)), "sample (annotated).pdf");
  check("annotated PDF written", fs.existsSync(outPath), outPath);
  if (fs.existsSync(outPath)) {
    const out = await PDFDocument.load(fs.readFileSync(outPath));
    check("annotated PDF keeps all pages", out.getPageCount() === 3, out.getPageCount());
    const xobjects = out.getPages().map((p) => {
      const res = p.node.Resources();
      const xo = res?.lookup?.(res.context.obj("XObject"));
      return xo ? xo.keys().length : 0;
    });
    check("ink overlay drawn on pages 1 and 3 only", xobjects[0] > 0 && xobjects[1] === 0 && xobjects[2] > 0, JSON.stringify(xobjects));
    check("original rotation kept", out.getPage(2).getRotation().angle === 90);
    // render the exported PDF page 1 and the rotated page for visual inspection
    state.pdfOut = outPath;
  }
  // the export opened the PDF in a new tab – go back to the ink page
  await ev(async (p) => {
    const leaf = app.workspace.getLeavesOfType("excalidraw").find((l) => l.view.file?.path === p);
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, state.pdfDrawing);
  await page.waitForTimeout(500);
  await mock({ responses: [["note on page one", "second word"], ["rotated note"]], fallback: ["fallback"] });
  await clickBookmark("text");
  await waitView("markdown");
  const md = await ev(() => app.vault.read(__t.view().file));
  console.log("----- pdf text page -----\n" + md + "\n---------------------");
  check("PDF text page has linked page headings", /### \[\[.*sample\.pdf#page=1\|Page 1\]\]/.test(md), md);
};

steps.rename = async () => {
  console.log("\n▶ rename the text page – the drawing follows");
  await ev(async (p) => {
    const f = app.vault.getAbstractFileByPath(p);
    await app.fileManager.renameFile(f, f.parent.path + "/Shopping list.md");
  }, state.text);
  await page.waitForTimeout(2500);
  const info = await ev(() => {
    const files = app.vault.getMarkdownFiles().map((f) => f.path).filter((p) => p.startsWith("Ink/"));
    const d = app.vault.getAbstractFileByPath("Ink/Shopping list.excalidraw.md");
    const t = app.vault.getAbstractFileByPath("Ink/Shopping list.md");
    return { files, drawingFm: d && app.metadataCache.getFileCache(d)?.frontmatter, textFm: t && app.metadataCache.getFileCache(t)?.frontmatter };
  });
  check("drawing renamed to match", !!info.drawingFm, JSON.stringify(info.files));
  check("links updated both ways", info.drawingFm?.["ink-text"] === "[[Ink/Shopping list]]" && /Shopping list\.excalidraw/.test(info.textFm?.["ink-drawing"] ?? ""), JSON.stringify(info));
  state.text = "Ink/Shopping list.md";
  state.drawing = "Ink/Shopping list.excalidraw.md";
  const md = await ev((p) => __t.read(p), state.text);
  check("diagram embed link updated after rename", md.includes("Shopping list.excalidraw#^area="), md);
};

steps.updateTyped = async () => {
  console.log("\n▶ change typed notes again – the existing card on the drawing updates");
  await ev(async (p) => {
    const f = app.vault.getAbstractFileByPath(p);
    await app.vault.process(f, (md) => md.replace("- a typed bullet", "- a typed bullet (changed on the text page)"));
  }, state.text);
  await page.waitForTimeout(300);
  await clickBookmark("ink");
  await waitView("excalidraw", state.drawing);
  const card = await ev(async () => {
    await __t.sleep(1800); // includes the plugin's verify-and-reapply window
    const c = __t.view().excalidrawAPI.getSceneElements().filter((e) => e.customData?.inkNotebook?.role === "typed");
    return c.map((e) => e.rawText ?? e.originalText);
  });
  check("existing card shows the new typed notes", card.length === 1 && card[0].includes("(changed on the text page)"), JSON.stringify(card));
};

steps.undoSafety = async () => {
  console.log("\n▶ undo on the ink page does not remove diagram regions");
  const before = await ev(() => __t.view().excalidrawAPI.getSceneElements().filter((e) => e.customData?.inkNotebook?.role === "region").length);
  await ev(async () => {
    const v = __t.view();
    v.excalidrawAPI.history?.undo?.();
  });
  await page.keyboard.press("Control+z").catch(() => {});
  await page.waitForTimeout(400);
  const after = await ev(() => __t.view().excalidrawAPI.getSceneElements().filter((e) => e.customData?.inkNotebook?.role === "region").length);
  check("region rectangles survive undo", before >= 1 && after === before, `${before} -> ${after}`);
};

steps.addPage = async () => {
  console.log("\n▶ add a paper page (picker, same paper)");
  await ev(() => app.commands.executeCommandById("ink-notebook:add-paper-page"));
  await pickPaper({});
  await page.waitForTimeout(1500);
  const papers = await ev(() => __t.view().excalidrawAPI.getSceneElements().filter((e) => e.customData?.inkNotebook?.role === "paper").map((e) => ({ y: e.y, locked: e.locked })));
  papers.sort((a, b) => a.y - b.y);
  check("second paper page added below the first", papers.length === 2 && papers[1].y > papers[0].y + 1400 && papers.every((p) => p.locked), JSON.stringify(papers));
};

steps.markDiagram = async () => {
  console.log("\n▶ turn a selection into a diagram");
  const ids = await ev(async () => {
    const v = __t.view();
    const ea = __t.ea(v);
    const a = __t.word(ea, 300, 1250, 120, 30);
    const b = __t.word(ea, 300, 1290, 120, 30);
    await ea.addElementsToView(false, true, true);
    ea.destroy();
    await __t.sleep(300);
    v.excalidrawAPI.updateScene({ appState: { selectedElementIds: { [a]: true, [b]: true } } });
    return [a, b];
  });
  await ev(() => app.commands.executeCommandById("ink-notebook:mark-diagram"));
  await page.waitForTimeout(800);
  const frame = await ev(() => __t.view().excalidrawAPI.getSceneElements().filter((e) => e.type === "frame" && e.name === "Diagram").map((e) => e.id));
  check("frame named Diagram created", frame.length === 1, JSON.stringify(frame));
  await mock({ responses: [["word one", "word two"]] });
  await clickBookmark("text");
  await waitView("markdown", state.text);
  const md = await ev((p) => __t.read(p), state.text);
  check("framed drawing embedded via #^frame=", frame.length === 1 && md.includes(`#^frame=${frame[0]}`), md.slice(-900));
  check("framed handwriting not transcribed as a paragraph", !/^word one/m.test(md), md.slice(-600));
  state.ids = ids;
};

steps.livePreview = async () => {
  console.log("\n▶ Live Preview shows a quiet label instead of raw markers");
  await ev(async (p) => {
    const leaf = app.workspace.getMostRecentLeaf();
    await leaf.setViewState({ type: "markdown", state: { file: p, mode: "source", source: false }, active: true });
  }, state.text);
  await page.waitForTimeout(1200);
  const info = await ev(() => {
    const root = document.querySelector(".workspace-leaf.mod-active .markdown-source-view");
    return {
      label: root?.querySelector(".ink-transcript-start")?.textContent ?? null,
      rawVisible: (root?.querySelector(".cm-content")?.textContent ?? "").includes("ink-notebook:end"),
      labelVisible: (root?.querySelector(".cm-content")?.textContent ?? "").includes("%% Start %%"),
    };
  });
  check("diagram label comment hidden in Live Preview", info.labelVisible === false, JSON.stringify(info));
  check("start marker rendered as label", !!info.label && info.label.includes("handwriting"), JSON.stringify(info));
  check("end marker state hidden", info.rawVisible === false, JSON.stringify(info));
  await shot("11-live-preview.png");
};

steps.wizardTest = async () => {
  console.log("\n▶ setup assistant: Test connection");
  await ev(() => app.commands.executeCommandById("ink-notebook:open-setup"));
  await page.waitForTimeout(600);
  await shot("12-setup-wizard.png");
  const step1 = await ev(() => document.querySelector(".modal.ink-setup .ink-step p")?.textContent ?? "");
  check("setup assistant: Excalidraw needs no installation", OWN ? /Using your own Excalidraw plugin/.test(step1) : /built into Ink Notebook – nothing to install/.test(step1), step1);
  const buttons = await page.$$(".modal.ink-setup button");
  let clicked = false;
  for (const b of buttons) {
    if ((await b.textContent())?.trim() === "Test") {
      await b.click();
      clicked = true;
      break;
    }
  }
  await page.waitForTimeout(2500);
  const status = await ev(() => document.querySelector(".modal.ink-setup .ink-test-status")?.textContent);
  check("Test button reports a working connection", clicked && /Connected/.test(status ?? ""), status);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const open = await ev(() => document.querySelectorAll(".modal-container").length);
  check("setup assistant closes", open === 0, open);
};

steps.image = async () => {
  console.log("\n▶ annotate an image and export it");
  const b64 = await ev(async () => {
    const c = document.createElement("canvas");
    c.width = 600;
    c.height = 400;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#dde";
    ctx.fillRect(0, 0, 600, 400);
    ctx.fillStyle = "#000";
    ctx.font = "40px sans-serif";
    ctx.fillText("Photo", 40, 80);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const buf = await blob.arrayBuffer();
    const f = await app.vault.createBinary("Docs/photo.png", buf);
    await __t.plugin().annotateImage(f);
    return true;
  });
  const p = await waitView("excalidraw");
  check("image annotation page created", /photo \(annotated\)\.excalidraw\.md$/.test(p), p);
  await ev(async () => {
    const v = __t.view();
    const ea = __t.ea(v);
    __t.word(ea, 100, 200, 200, 40);
    await ea.addElementsToView(false, true, true);
    ea.destroy();
  });
  await page.waitForTimeout(500);
  await ev(() => __t.plugin().exportAnnotatedImage(app.workspace.getMostRecentLeaf()));
  await page.waitForTimeout(1500);
  const out = path.join(path.dirname(path.join(VAULT, p)), "photo (annotated).png");
  check("annotated image exported", fs.existsSync(out) && fs.statSync(out).size > 1000, out);
};

steps.mobile = async () => {
  console.log("\n▶ mobile layout (Obsidian's mobile emulation, like the Boox app)");
  const reloadAs = async (mobile) => {
    await ev((m) => app.emulateMobile(m), mobile).catch(() => {});
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => window.app?.workspace?.layoutReady && window.app.plugins?.plugins?.["ink-notebook"], null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    await injectHelpers();
  };
  state.reloadAs = reloadAs;
  await reloadAs(true);
  const isMobile = await ev(() => document.body.classList.contains("is-mobile"));
  check("mobile layout active", isMobile);
  await ev(async (p) => {
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: "excalidraw", state: { file: p }, active: true });
  }, state.drawing);
  await waitView("excalidraw", state.drawing);
  await page.waitForTimeout(1000);
  await shot("13-mobile-ink.png");
  const n = await ev(() => document.querySelectorAll(".workspace-leaf.mod-active .ink-bookmark-tabs .ink-bookmark").length);
  check("bookmarks shown in mobile layout", n === 2, n);
  const overlaps = await bookmarkOverlaps();
  check("mobile layout: bookmarks clear of all toolbars and panels", overlaps.ok, JSON.stringify(overlaps));
  await clickBookmark("text");
  await waitView("markdown", state.text);
  await page.waitForTimeout(800);
  await shot("14-mobile-text.png");
  const p2 = await ev(() => __t.view()?.file?.path);
  check("flip works in mobile layout", p2 === state.text, p2);
  await reloadAs(false);
};

steps.eink = async () => {
  console.log("\n▶ e-ink mode");
  await setSettings({ einkMode: "on" });
  await ev(() => app.commands.executeCommandById("ink-notebook:toggle-eink"));
  await ev(() => app.commands.executeCommandById("ink-notebook:toggle-eink"));
  const on = await ev(() => document.body.classList.contains("ink-eink"));
  check("e-ink class applied", on);
  await ev(async (p) => {
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(app.vault.getAbstractFileByPath(p));
  }, state.text);
  await waitView("markdown", state.text);
  await page.waitForTimeout(1200);
  await shot("09-eink-text.png");
  await clickBookmark("ink");
  await waitView("excalidraw", state.drawing);
  await page.waitForTimeout(1000);
  await shot("10-eink-ink.png");
};

steps.reopen = async () => {
  console.log("\n▶ reopen everything after a reload of the plugin");
  const between = await ev(async (id) => {
    await app.plugins.disablePlugin("ink-notebook");
    const stopped = !app.plugins.plugins[id];
    await app.plugins.enablePlugin("ink-notebook");
    return stopped;
  }, EXCALIDRAW_ID);
  check(OWN ? "disabling Ink Notebook leaves the user's Excalidraw running" : "disabling Ink Notebook stops the built-in Excalidraw", OWN ? !between : between);
  await page.waitForTimeout(1500);
  if (!OWN) {
    const back = await ev(() => __t.waitFor(() => __t.plugin().excalidraw.active && app.workspace.getLeavesOfType("excalidraw").some((l) => l.view.excalidrawAPI), 20000).then(() => true, () => false));
    check("built-in Excalidraw runs again and reopens the ink pages", back);
  }
  const info = await ev(() => {
    const leaves = [...app.workspace.getLeavesOfType("excalidraw"), ...app.workspace.getLeavesOfType("markdown")];
    const p = __t.plugin();
    const inkLeaves = leaves.filter((l) => l.view.file && p.pairs.pairOf(l.view.file) && (l.view.getViewType() === "excalidraw" || p.pairs.isTextPage(l.view.file)));
    return { inkLeaves: inkLeaves.length, perLeaf: inkLeaves.map((l) => l.view.containerEl.querySelectorAll(".ink-bookmarks").length) };
  });
  check("bookmarks restored after plugin reload, one set per ink page tab", info.inkLeaves > 0 && info.perLeaf.every((n) => n === 1), JSON.stringify(info));
};

steps.ownExcalidraw = async () => {
  if (OWN) return;
  console.log("\n▶ installing, enabling and disabling the Excalidraw plugin while the built-in one runs");
  const dir = path.join(VAULT, ".obsidian/plugins", EXCALIDRAW_ID);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of ["main.js", "manifest.json", "styles.css"]) fs.copyFileSync(path.join(E2E, "..", "vendor/excalidraw", f), path.join(dir, f));
  const enabled = await ev(async (id) => {
    const builtIn = app.plugins.plugins[id];
    await app.plugins.loadManifests();
    await app.plugins.enablePluginAndSave(id);
    return { same: app.plugins.plugins[id] === builtIn, builtIn: __t.plugin().excalidraw.active };
  }, EXCALIDRAW_ID);
  check("enabling the Excalidraw plugin keeps the running built-in copy (no second Excalidraw)", enabled.same && enabled.builtIn, JSON.stringify(enabled));
  // Obsidian now unloads the running copy (the built-in one); Ink Notebook starts it again
  await ev((id) => app.plugins.disablePluginAndSave(id), EXCALIDRAW_ID);
  const back = await ev(() => __t.waitFor(() => __t.plugin().excalidraw.active && __t.plugin().excalidraw.describe().ok, 20000).then(() => true, () => false));
  check("built-in Excalidraw takes over again after the Excalidraw plugin is disabled", back);
  await ev(async (p) => {
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type: "excalidraw", state: { file: p }, active: true });
  }, state.drawing);
  const p = await waitView("excalidraw", state.drawing);
  check("ink page opens with the built-in Excalidraw again", p === state.drawing, p);
  fs.rmSync(dir, { recursive: true, force: true });
  await ev(() => app.plugins.loadManifests());
};

steps.folders = async () => {
  console.log("\n▶ new page in the current folder, ink files in its subfolder, chosen paper");
  await setSettings({ pageLocation: "current", inkSubfolder: "Attachments", askForPaper: true, askForPageName: true });
  const CA = "003 - University/Computer Architecture";
  await ev(async (CA) => {
    await app.vault.createFolder(CA).catch(() => {});
    const f = app.vault.getAbstractFileByPath(`${CA}/Computer Architecture.md`) ?? (await app.vault.create(`${CA}/Computer Architecture.md`, "# Computer Architecture\n"));
    await app.workspace.getLeaf(false).openFile(f);
  }, CA);
  await page.waitForTimeout(800);
  await ev(() => app.commands.executeCommandById("ink-notebook:new-page"));
  await page.waitForSelector(".modal.ink-paper-picker", { timeout: 5000 });
  const picker = await ev(() => ({
    cards: document.querySelectorAll(".modal.ink-paper-picker .ink-paper-card").length,
    thumbs: [...document.querySelectorAll(".modal.ink-paper-picker .ink-paper-thumb img")].filter((i) => i.complete && i.naturalWidth > 0).length,
    selected: document.querySelector(".modal.ink-paper-picker .ink-paper-card.is-selected")?.dataset.style,
  }));
  check("paper picker shows all templates with previews", picker.cards === 9 && picker.thumbs === 9 && picker.selected === "lined", JSON.stringify(picker));
  await shot("15-paper-picker.png");
  await pickPaper({ name: "Week 1", style: "dots", spacing: "narrow", orientation: "landscape" });
  const drawing = await waitView("excalidraw");
  const info = await ev(async ({ drawing, CA }) => {
    const p = __t.plugin();
    const d = app.vault.getAbstractFileByPath(drawing);
    const t = p.pairs.textFor(d);
    return {
      text: t?.path,
      drawingFm: app.metadataCache.getFileCache(d)?.frontmatter?.["ink-text"],
      textFm: t && app.metadataCache.getFileCache(t)?.frontmatter?.["ink-drawing"],
      paperFile: !!app.vault.getAbstractFileByPath(`${CA}/Attachments/ink-paper-dots-narrow-landscape.svg`),
      caFiles: app.vault.getAbstractFileByPath(CA).children.map((c) => c.name).sort(),
    };
  }, { drawing, CA });
  check("drawing is in the Attachments subfolder of the current folder", drawing === `${CA}/Attachments/Week 1.excalidraw.md`, drawing);
  check("text page is in the current folder", info.text === `${CA}/Week 1.md`, JSON.stringify(info));
  check("the course folder only shows notes and the ink subfolder", JSON.stringify(info.caFiles) === JSON.stringify(["Attachments", "Computer Architecture.md", "Week 1.md"]), JSON.stringify(info.caFiles));
  check("pair links use full paths", info.drawingFm === `[[${CA}/Week 1]]` && info.textFm === `[[${CA}/Attachments/Week 1.excalidraw]]`, JSON.stringify(info));
  check("paper SVG stored next to the drawing", info.paperFile, JSON.stringify(info));
  const papers = await papersOnPage();
  check("chosen paper used: dotted, landscape", papers.length === 1 && papers[0].style === "dots" && papers[0].w === 1414 && papers[0].h === 1000 && papers[0].hasFile, JSON.stringify(papers));
  state.ca = { drawing, text: info.text };
  // same name in another folder: each page stays paired with its own partner
  const other = await ev(async () => {
    const p = __t.plugin();
    await app.vault.createFolder("003 - University/Maths").catch(() => {});
    const r = await p.switcher.createPage({ name: "Week 1", folder: "003 - University/Maths", paper: { style: "grid", spacing: "normal", color: "white", orientation: "portrait" }, open: false });
    await __t.sleep(800);
    const caDrawing = app.vault.getAbstractFileByPath("003 - University/Computer Architecture/Attachments/Week 1.excalidraw.md");
    return { drawing: r.drawing.path, text: r.text.path, textOfMaths: p.pairs.textFor(r.drawing)?.path, drawingOfMaths: p.pairs.drawingFor(r.text)?.path, textOfCA: p.pairs.textFor(caDrawing)?.path };
  });
  check("same page name in two folders: no mix-up", other.textOfMaths === "003 - University/Maths/Week 1.md" && other.drawingOfMaths === "003 - University/Maths/Attachments/Week 1.excalidraw.md" && other.textOfCA === `${CA}/Week 1.md`, JSON.stringify(other));
  await clickBookmark("text");
  const t = await waitView("markdown");
  check("flip to the text page works with the subfolder layout", t === state.ca.text, t);
  await clickBookmark("ink");
  await waitView("excalidraw", state.ca.drawing);
  await setSettings({ askForPageName: false });
};

steps.paperPages = async () => {
  console.log("\n▶ add, insert and change pages");
  await waitView("excalidraw", state.ca.drawing);
  // writing on page 1
  await ev(async () => {
    const v = __t.view();
    const ea = __t.ea(v);
    __t.word(ea, 120, 200, 140, 30);
    await ea.addElementsToView(false, true, true);
    ea.destroy();
  });
  // + Page bookmark → picker → ruled page at the end
  await ev(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
  await page.click(".workspace-leaf.mod-active .ink-bookmark-add");
  const where = await ev(async () => {
    await __t.waitFor(() => document.querySelector(".modal.ink-paper-picker"), 5000);
    return { selected: document.querySelector(".modal.ink-paper-picker .ink-paper-card.is-selected")?.dataset.style, positions: [...document.querySelectorAll('.modal.ink-paper-picker .ink-segmented button[data-value="after"], .modal.ink-paper-picker .ink-segmented button[data-value="end"]')].length };
  });
  check("+ Page suggests the paper of the current page and offers positions", where.selected === "dots" && where.positions === 2, JSON.stringify(where));
  await pickPaper({ style: "lined", orientation: "portrait", position: "end" });
  await page.waitForTimeout(1200);
  let papers = await papersOnPage();
  check("ruled page added at the end", papers.length === 2 && papers[1].style === "lined" && papers[1].y === 1000 + 80 && papers[1].h === 1414, JSON.stringify(papers));
  // write on page 2, go back to page 1 and insert a squared page after it
  await ev(async () => {
    const v = __t.view();
    const ea = __t.ea(v);
    __t.word(ea, 120, 1300, 140, 30);
    await ea.addElementsToView(false, true, true);
    ea.destroy();
    const first = v.excalidrawAPI.getSceneElements().filter((e) => e.customData?.inkNotebook?.role === "paper").sort((a, b) => a.y - b.y)[0];
    const z = __t.ea(v);
    z.viewZoomToElements(false, [first]);
    z.destroy();
  });
  await page.waitForTimeout(800);
  await ev(() => app.commands.executeCommandById("ink-notebook:add-paper-page"));
  await pickPaper({ style: "grid", orientation: "portrait", position: "after" });
  await page.waitForTimeout(1500);
  papers = await papersOnPage();
  const strokes = await ev(() => __t.view().excalidrawAPI.getSceneElements().filter((e) => e.type === "freedraw").map((e) => Math.round(e.y)).sort((a, b) => a - b));
  const shift = 1414 + 80;
  check(
    "squared page inserted after page 1, later pages moved down",
    papers.length === 3 && papers[0].style === "dots" && papers[1].style === "grid" && papers[1].y === 1080 && papers[2].style === "lined" && papers[2].y === 1080 + shift,
    JSON.stringify(papers),
  );
  check("writing on page 1 stayed, writing on the old page 2 moved with it", strokes[0] === 200 && strokes[1] === 1300 + shift, JSON.stringify(strokes));
  const order = await ev(() => {
    const els = __t.view().excalidrawAPI.getSceneElements();
    const lastPaper = Math.max(...els.map((e, i) => (e.customData?.inkNotebook?.role === "paper" ? i : -1)));
    const firstStroke = els.findIndex((e) => e.type === "freedraw");
    return { lastPaper, firstStroke };
  });
  check("paper stays behind the writing", order.lastPaper < order.firstStroke, JSON.stringify(order));
  check("all paper images still load", papers.every((p) => p.hasFile && p.locked), JSON.stringify(papers));
  await shot("16-inserted-pages.png");
  // change the paper of page 1 (landscape dots → portrait Cornell): the pages below move down by the extra height
  await ev(() => {
    const v = __t.view();
    const first = v.excalidrawAPI.getSceneElements().filter((e) => e.customData?.inkNotebook?.role === "paper").sort((a, b) => a.y - b.y)[0];
    const z = __t.ea(v);
    z.viewZoomToElements(false, [first]);
    z.destroy();
  });
  await page.waitForTimeout(800);
  await ev(() => app.commands.executeCommandById("ink-notebook:change-paper"));
  await pickPaper({ style: "cornell", orientation: "portrait" });
  await page.waitForTimeout(1500);
  const after = await papersOnPage();
  check(
    "page 1 changed to Cornell (portrait), pages below moved by the extra height",
    after.length === 3 && after[0].style === "cornell" && after[0].h === 1414 && after[1].y === papers[1].y + 414 && after[2].y === papers[2].y + 414 && after.every((p) => p.hasFile),
    JSON.stringify(after),
  );
  const md = await ev(async (p) => {
    await __t.plugin().sync.syncInkToText(app.vault.getAbstractFileByPath(p), { view: __t.view(), network: true });
    return __t.read(__t.plugin().pairs.textFor(app.vault.getAbstractFileByPath(p)).path);
  }, state.ca.drawing);
  check("text page still builds after page changes", md.includes("%% ink-notebook:start %%"), md);
};

steps.renameSub = async () => {
  console.log("\n▶ rename/move a text page – the drawing in the subfolder follows");
  const CA = "003 - University/Computer Architecture";
  await ev(async (p) => {
    const f = app.vault.getAbstractFileByPath(p);
    await app.fileManager.renameFile(f, f.parent.path + "/Week 1 - Intro.md");
  }, state.ca.text);
  await page.waitForTimeout(2500);
  let info = await ev((CA) => ({
    drawing: !!app.vault.getAbstractFileByPath(`${CA}/Attachments/Week 1 - Intro.excalidraw.md`),
    oldDrawing: !!app.vault.getAbstractFileByPath(`${CA}/Attachments/Week 1.excalidraw.md`),
  }), CA);
  check("drawing in the subfolder renamed with the text page", info.drawing && !info.oldDrawing, JSON.stringify(info));
  await ev(async (CA) => {
    await app.vault.createFolder("Archive").catch(() => {});
    await app.fileManager.renameFile(app.vault.getAbstractFileByPath(`${CA}/Week 1 - Intro.md`), "Archive/Week 1 - Intro.md");
  }, CA);
  await page.waitForTimeout(2500);
  info = await ev(() => {
    const t = app.vault.getAbstractFileByPath("Archive/Week 1 - Intro.md");
    const d = app.vault.getAbstractFileByPath("Archive/Attachments/Week 1 - Intro.excalidraw.md");
    const p = __t.plugin();
    return { moved: !!d, paired: !!t && !!d && p.pairs.textFor(d)?.path === t.path && p.pairs.drawingFor(t)?.path === d.path, link: d && app.metadataCache.getFileCache(d)?.frontmatter?.["ink-text"] };
  });
  check("moving the text page moves the drawing into the new folder's subfolder", info.moved && info.paired && info.link === "[[Archive/Week 1 - Intro]]", JSON.stringify(info));
  state.ca = { drawing: "Archive/Attachments/Week 1 - Intro.excalidraw.md", text: "Archive/Week 1 - Intro.md" };
};

steps.collision = async () => {
  console.log("\n▶ bookmarks never cover toolbars or panels, whatever the window size");
  const sizes = [[800, 600], [800, 1200], [1024, 700], [1400, 1000], [700, 500], [640, 420], [1280, 520]];
  const open = async (type, file) => {
    await ev(async ({ type, file }) => {
      await app.workspace.getLeaf(false).setViewState({ type, state: { file }, active: true });
    }, { type, file });
    await waitView(type, file);
  };
  await open("excalidraw", state.ca.drawing);
  for (const [w, h] of sizes) {
    await setWindow(w, h);
    const r = await bookmarkOverlaps();
    check(`ink page ${w}×${h}: bookmarks clear of toolbars and panels${r.compact ? " (compact)" : ""}`, r.ok, JSON.stringify(r));
    if (w === 800 && h === 600) await shot("17-bookmarks-800x600.png");
  }
  await open("markdown", state.ca.text);
  for (const [w, h] of [[800, 600], [640, 420]]) {
    await setWindow(w, h);
    const r = await bookmarkOverlaps();
    check(`text page ${w}×${h}: bookmarks clear of the header and status bar`, r.ok, JSON.stringify(r));
  }
  // an Excalidraw panel that appears later (here: the library sidebar) pushes the bookmarks away too
  await open("excalidraw", state.ca.drawing);
  await setWindow(800, 1200);
  await ev(() => __t.view().excalidrawAPI.toggleSidebar?.({ name: "default", force: true }));
  await page.waitForTimeout(600);
  const r = await bookmarkOverlaps();
  const sidebar = await ev(() => !!document.querySelector(".workspace-leaf.mod-active .excalidraw .sidebar"));
  check("bookmarks move clear of a docked Excalidraw sidebar", !sidebar || r.ok, JSON.stringify({ sidebar, ...r }));
  await ev(() => __t.view().excalidrawAPI.toggleSidebar?.({ name: "default", force: false }));
  await setWindow(800, 1200);
};

const order = ["setup", "createPage", "write", "flipToText", "editText", "flipToInk", "flipBack", "editCard", "updateTyped", "undoSafety", "addPage", "markDiagram", "tasksTables", "offline", "v3", "errors", "cloud", "livePreview", "wizardTest", "pdf", "image", "rename", "eink", "reopen", "ownExcalidraw", "folders", "paperPages", "renameSub", "collision", "mobile"];
for (const name of order) {
  if (only && !only.split(",").includes(name) && name !== "setup") continue;
  try {
    await steps[name]();
  } catch (e) {
    failures++;
    console.log(`  ✗ step ${name} threw: ${e.message}`);
    await shot(`error-${name}.png`).catch(() => {});
    if (!only) break;
  }
}
fs.writeFileSync(path.join(E2E, "state.json"), JSON.stringify(state, null, 2));
const relevantErrors = errors.filter((e) => !/favicon|ERR_CONNECTION_REFUSED|127\.0\.0\.1:8799|status of 40[14]/.test(e));
console.log(`\nconsole errors (${relevantErrors.length}):`);
relevantErrors.slice(0, 30).forEach((e) => console.log("  " + e.slice(0, 400)));
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed, ${failures} failure(s)`);
await browser.close().catch(() => {});
process.exit(failures ? 1 : 0);
