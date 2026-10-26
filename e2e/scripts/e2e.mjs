// End-to-end test of Ink Notebook inside a real Obsidian, with pen input sent
// through the Chrome DevTools protocol (pointerType "pen" with pressure) and a
// fake Azure server that really looks at the handwriting images.
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";
import LZString from "../../node_modules/lz-string/libs/lz-string.js";

const E2E = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VAULT = path.join(E2E, "vault");
const SHOTS = path.join(E2E, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const MOCK = "http://127.0.0.1:8765";
const only = process.argv[2]; // optional: run a single step (after "setup")

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html"));
const cdp = await page.context().newCDPSession(page);
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  if (m.text().includes("Ink Notebook")) console.log(`   [console.${m.type()}] ${m.text().slice(0, 300)}`);
});

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}${detail ? `\n      ${String(detail).replace(/\n/g, "\n      ")}` : ""}`);
  }
}
const ev = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);
const shot = async (name) => {
  await sleep(400);
  await page.screenshot({ path: path.join(SHOTS, name) });
};
const mock = async (cfg) => fetch(`${MOCK}/__config`, { method: "POST", body: JSON.stringify(cfg) });
const mockStats = async () => (await fetch(`${MOCK}/__stats`)).json();

await ev(() => {
  window.__t = {
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    async waitFor(fn, timeout = 15000, label = "") {
      const t0 = Date.now();
      let last;
      while (Date.now() - t0 < timeout) {
        try {
          last = await fn();
          if (last) return last;
        } catch (e) {
          last = e;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`timeout waiting for ${label} (last: ${last})`);
    },
    plugin: () => app.plugins.plugins["ink-notebook"],
    view: () => app.workspace.getMostRecentLeaf()?.view,
    surface: () => app.workspace.getMostRecentLeaf()?.view?.surface,
    read: (p) => app.vault.read(app.vault.getAbstractFileByPath(p)),
  };
});

async function setSettings(patch) {
  await ev(async (patch) => {
    const p = __t.plugin();
    Object.assign(p.settings, patch);
    await p.saveSettings();
    p.applyInkSettings();
  }, patch);
}

/** Close every open dialog (the first-run setup assistant, pickers, …). */
async function closeModals() {
  for (let i = 0; i < 4; i++) {
    const n = await ev(() => document.querySelectorAll(".modal-container").length);
    if (n === 0) return;
    await ev(() => document.querySelectorAll(".modal-container .modal-close-button, .modal-container .modal-header-button").forEach((b) => b.click()));
    await sleep(200);
    if ((await ev(() => document.querySelectorAll(".modal-container").length)) > 0) await page.keyboard.press("Escape");
    await sleep(200);
  }
}

async function setWindow(w, h) {
  await ev(({ w, h }) => {
    const win = window.require("@electron/remote").getCurrentWindow();
    win.unmaximize();
    win.setBounds({ x: 0, y: 0, width: w, height: h });
  }, { w, h });
  await sleep(900);
}

async function waitView(type, file) {
  return ev(
    async ({ type, file }) => {
      await __t.waitFor(() => {
        const v = __t.view();
        return v && v.getViewType() === type && (!file || v.file?.path === file) && (type !== "ink-notebook" || v.inkFile);
      }, 15000, `view ${type} ${file ?? ""}`);
      await __t.sleep(300);
      return __t.view().file.path;
    },
    { type, file },
  );
}

/** Page coordinates → screen coordinates of the open ink page. */
async function mapping() {
  return ev(() => {
    const s = __t.surface();
    const r = s.el.getBoundingClientRect();
    return { l: r.left, t: r.top, k: s.view.scale, ox: s.view.ox, oy: s.view.oy };
  });
}

/** Draw with the pen (real pointer events, pressure varying along the stroke). */
async function pen(pts, opts = {}) {
  const m = opts.m ?? (await mapping());
  const at = (x, y) => ({ x: m.l + m.ox + x * m.k, y: m.t + m.oy + y * m.k });
  const side = !!opts.side;
  const base = { pointerType: "pen", button: side ? "right" : "left", buttons: side ? 2 : 1 };
  const s0 = at(pts[0][0], pts[0][1]);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s0.x, y: s0.y, pointerType: "pen", buttons: 0, force: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: s0.x, y: s0.y, clickCount: 1, force: 0.4, ...base });
  for (let i = 1; i < pts.length; i++) {
    const s = at(pts[i][0], pts[i][1]);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x, y: s.y, force: 0.35 + 0.4 * Math.abs(Math.sin(i / 4)), ...base });
  }
  if (opts.hold) await sleep(opts.hold);
  const e = at(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: e.x, y: e.y, clickCount: 1, force: 0, ...base, buttons: 0 });
}

/** A handwritten "word": one connected zigzag. */
function word(x, y, w, h) {
  const pts = [];
  const n = Math.max(8, Math.round(w / 5));
  for (let i = 0; i <= n; i++) pts.push([x + (w * i) / n, i % 2 ? y + h : y + h * 0.15]);
  return along(pts, 3);
}

function along(corners, step = 3) {
  const out = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1];
    const [bx, by] = corners[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

const box = (x, y, w, h) => along([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y + 2]], 4);

async function tool(id) {
  await ev((id) => __t.surface().setTools({ tool: id }), id);
}

async function clickToolbar(selector) {
  await ev(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
  await page.click(`.workspace-leaf.mod-active ${selector}`, { timeout: 5000 });
}

const state = {};
const steps = {};

steps.setup = async () => {
  console.log("\n▶ setup");
  await setWindow(820, 1180);
  const info = await ev(() => ({ loaded: !!__t.plugin(), view: !!app.viewRegistry.viewByType["ink-notebook"], excalidraw: !!app.plugins.plugins["obsidian-excalidraw-plugin"] }));
  check("Ink Notebook is loaded with its own ink view, no Excalidraw", info.loaded && info.view && !info.excalidraw, JSON.stringify(info));
  await setSettings({ setupDone: true, azureEndpoint: MOCK, azureKey: "test-key", azureApi: "auto", azureDetectedApi: "", einkMode: "off", queue: [], pageLocation: "fixed", folder: "Ink", inkSubfolder: "Attachments", askForPaper: false, holdToShape: true, scribbleErase: true });
  await ev(() => {
    app.vault.setConfig("alwaysUpdateLinks", true);
    // like on a tablet: the sidebars are closed
    app.workspace.leftSplit.collapse();
    app.workspace.rightSplit.collapse();
  });
  await closeModals();
  await mock({ reset: true, mode: "ok", responses: [], fallback: null });
};

steps.createPage = async () => {
  console.log("\n▶ create an ink page");
  await ev(() => app.commands.executeCommandById("ink-notebook:new-page"));
  state.drawing = await waitView("ink-notebook");
  check("the new page opens in the ink view", /^Ink\/Attachments\/.+\.ink\.md$/.test(state.drawing), state.drawing);
  state.text = state.drawing.replace(/^Ink\/Attachments\//, "Ink/").replace(/\.ink\.md$/, ".md");
  const info = await ev(async ({ drawing, text }) => {
    const d = app.vault.getAbstractFileByPath(drawing);
    const t = app.vault.getAbstractFileByPath(text);
    const s = __t.surface();
    return {
      text: t ? await app.vault.read(t) : null,
      fm: app.metadataCache.getFileCache(d)?.frontmatter,
      pages: s.document.pages.length,
      size: [s.page.w, s.page.h],
      bg: s.page.bg,
      toolbar: !!document.querySelector(".workspace-leaf.mod-active .ink-toolbar .ink-tool-pen"),
      pageLabel: document.querySelector(".workspace-leaf.mod-active .ink-tb-pagelabel")?.textContent,
    };
  }, state);
  check("the text page sits in the folder, linked to the ink page", /ink-drawing: "\[\[Ink\/Attachments\/.+\.ink\]\]"/.test(info.text ?? ""), info.text);
  check("the ink page links back and is marked as ink page", info.fm?.["ink-notebook"] === 1 && String(info.fm?.["ink-text"]).includes("[[Ink/"), JSON.stringify(info.fm));
  check("one A4 page of ruled paper", info.pages === 1 && info.size[0] === 1000 && info.size[1] === 1414 && info.bg.kind === "paper" && info.bg.paper.style === "lined", JSON.stringify(info));
  check("the toolbar shows tools and the page number", info.toolbar && info.pageLabel === "1 / 1", JSON.stringify(info));
};

steps.write = async () => {
  console.log("\n▶ write with the pen");
  await tool("pen");
  const m = await mapping();
  // paragraph, two lines
  for (const [x, w] of [[100, 110], [225, 120], [360, 130]]) await pen(word(x, 150, w, 30), { m });
  for (const [x, w] of [[100, 70], [185, 140]]) await pen(word(x, 195, w, 30), { m });
  // a list
  for (const y of [320, 365]) {
    await pen(along([[100, y + 18], [116, y + 19]], 3), { m });
    await pen(word(130, y, 90, 30), { m });
  }
  // a handwritten link
  await pen(word(100, 440, 70, 30), { m });
  await pen(word(185, 440, 150, 30), { m });
  // a diagram: a box (snapped by holding the pen), a label, an arrow from the shape tool
  await pen(box(550, 500, 250, 150), { m, hold: 900 });
  await pen(word(610, 555, 120, 36), { m });
  await ev(() => __t.surface().setTools({ tool: "shape", shape: "arrow" }));
  await pen(along([[800, 575], [950, 575]], 8), { m });
  // a typed text box
  await tool("text");
  await pen([[100, 780], [100, 780]], { m });
  await sleep(200);
  await page.keyboard.type("See [[Welcome]] for details");
  await page.keyboard.press("Escape");
  await tool("pen");
  const info = await ev(() => {
    const p = __t.surface().page;
    return { strokes: p.strokes.length, poly: p.strokes.filter((s) => s.poly).map((s) => ({ closed: !!s.closed, arrow: !!s.arrow, n: s.pts.length / 3 })), texts: p.texts.map((t) => t.text) };
  });
  check("every stroke is on the page (12 handwritten, the box and the arrow)", info.strokes === 14, JSON.stringify(info));
  check("holding the pen snapped the box into a rectangle", info.poly.some((p) => p.closed && p.n === 4), JSON.stringify(info.poly));
  check("the shape tool drew an arrow", info.poly.some((p) => p.arrow), JSON.stringify(info.poly));
  check("the text box holds the typed text", info.texts.length === 1 && info.texts[0] === "See [[Welcome]] for details", JSON.stringify(info.texts));
  await shot("01-ink-page.png");
  const saved = await ev(async (p) => {
    await __t.waitFor(async () => ((await __t.read(p)).match(/\nS /g) ?? []).length === 14, 6000, "saved").catch(() => null);
    const text = await __t.read(p);
    return { strokes: (text.match(/\nS /g) ?? []).length, texts: (text.match(/\nT /g) ?? []).length, hasComment: /%%\n```ink-data/.test(text), size: text.length };
  }, state.drawing);
  check("the page is saved to the .ink.md file", saved.strokes === 14 && saved.texts === 1 && saved.hasComment, JSON.stringify(saved));
};

steps.speed = async () => {
  console.log("\n▶ speed of the pen");
  await tool("pen");
  await ev(() => {
    const input = __t.surface().input;
    const orig = input.onMove.bind(input);
    window.__moves = [];
    input.onMove = (e, raw) => {
      const t0 = performance.now();
      orig(e, raw);
      window.__moves.push(performance.now() - t0);
    };
    window.__restoreMove = () => (input.onMove = orig);
  });
  const m = await mapping();
  // a busy page: 300 more strokes, then measure while writing
  await ev(() => {
    const s = __t.surface();
    const p = s.page;
    const strokes = [];
    for (let i = 0; i < 300; i++) {
      const pts = new Float32Array(40 * 3);
      for (let k = 0; k < 40; k++) {
        pts[k * 3] = 60 + (i % 15) * 60 + k * 1.2;
        pts[k * 3 + 1] = 900 + Math.floor(i / 15) * 22 + (k % 2) * 12;
        pts[k * 3 + 2] = 0.5;
      }
      strokes.push({ id: `perf${i}`, pen: "fountain", color: "#000000", width: 1.8, pts });
    }
    s.commitPage({ ...p, strokes: [...p.strokes, ...strokes] }, "all");
  });
  await ev(() => (window.__moves = []));
  for (let i = 0; i < 6; i++) await pen(word(100 + i * 130, 840, 110, 30), { m });
  const t = await ev(() => {
    window.__restoreMove();
    const a = window.__moves.slice().sort((x, y) => x - y);
    return { n: a.length, median: a[Math.floor(a.length / 2)], p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1] };
  });
  console.log(`   pen move handler on a page with 330 strokes: ${JSON.stringify(t)} ms`);
  check("a pen move costs well under a millisecond, also on a full page", t.median < 0.5 && t.p95 < 2, JSON.stringify(t));
  // page turn: render time of a full page
  const turn = await ev(async () => {
    const s = __t.surface();
    s.addPage("end");
    await __t.sleep(600);
    const t0 = performance.now();
    s.prev();
    const t1 = performance.now();
    return t1 - t0;
  });
  console.log(`   turning to the full page: ${turn.toFixed(1)} ms`);
  check("turning to a full page is quick", turn < 120, turn);
  // clean up: undo the extra page and strokes
  await ev(async () => {
    const s = __t.surface();
    s.undo();
    s.undo();
    s.undo();
    s.undo();
    s.undo();
    s.undo();
    s.undo();
    s.undo();
  });
  const n = await ev(() => ({ strokes: __t.surface().page.strokes.length, pages: __t.surface().pageCount }));
  check("undo takes it all back", n.strokes === 14 && n.pages === 1, JSON.stringify(n));
};

steps.flipToText = async () => {
  console.log("\n▶ flip to the text page");
  await mock({ responses: [["The quick brown", "fox jumps", "- milk", "- eggs", "Call [[Welcome]]"], ["Start"]] });
  await clickToolbar(".ink-tb-text");
  const p = await waitView("markdown");
  check("the text page opens in the same tab", p === state.text, p);
  await sleep(500);
  const md = await ev((p) => __t.read(p), state.text);
  console.log("----- text page -----\n" + md + "\n---------------------");
  check("paragraph lines are joined", md.includes("The quick brown fox jumps"));
  check("the list is recognised", md.includes("- milk\n- eggs"));
  check("the handwritten link is transcribed", md.includes("Call [[Welcome]]"));
  check("the typed text box is included", md.includes("See [[Welcome]] for details"));
  check("the diagram is a live figure block", /```ink-figure\narea: [A-Za-z0-9]+\nfile: Ink\/Attachments\/.+\.ink\.md\nwidth: \d+\nlabels: Start\n```/.test(md), md);
  const meta = await ev(async (d) => {
    const text = await __t.read(d);
    const h = JSON.parse(text.split("\n").find((l) => l.startsWith("H ")).slice(2));
    return h;
  }, state.drawing);
  check("the diagram area and the handwritten link are stored in the ink page", meta.regions.length === 1 && Object.values(meta.handLinks).includes("[[Welcome]]"), JSON.stringify(meta));
  const fig = await ev(async () => {
    await __t.waitFor(() => document.querySelector(".workspace-leaf.mod-active .ink-figure canvas"), 8000, "figure");
    const c = document.querySelector(".workspace-leaf.mod-active .ink-figure canvas");
    const ctx = c.getContext("2d");
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 100) dark++;
    return { w: c.width, h: c.height, dark };
  });
  check("the figure is drawn on the text page", fig.w > 100 && fig.dark > 200, JSON.stringify(fig));
  const stats = await mockStats();
  check("one recognition request per writing area", stats.requestCount === 2, JSON.stringify(stats));
  await shot("02-text-page.png");
};

steps.flipToInk = async () => {
  console.log("\n▶ back to the ink page");
  await page.click(".workspace-leaf.mod-active .ink-bookmark-ink", { timeout: 5000 });
  const p = await waitView("ink-notebook");
  check("the Ink bookmark opens the ink page in the same tab", p === state.drawing, p);
  const badge = await ev(() => {
    const s = __t.surface();
    return Object.keys(s.meta.handLinks).length;
  });
  check("the handwritten link has a link button on the ink page", badge === 1, badge);
};

steps.tools = async () => {
  console.log("\n▶ tools");
  const m = await mapping();
  const count = () => ev(() => __t.surface().page.strokes.length);
  const n0 = await count();
  // the side button of the pen erases (partial eraser): cut the first word in two
  await pen(along([[155, 146], [155, 178]], 4), { m, side: true });
  const n1 = await count();
  check("the pen's side button erases (a word is cut in two)", n1 === n0 + 1, `${n0} -> ${n1}`);
  await clickToolbar(".ink-toolbar button[aria-label='Undo']");
  check("undo in the toolbar", (await count()) === n0);
  // lasso: select the list and delete it with the action bar
  await clickToolbar(".ink-tool-lasso");
  await pen(along([[80, 300], [260, 300], [260, 410], [80, 410], [80, 302]], 6), { m });
  const sel = await ev(() => __t.surface().selection.strokes.size);
  check("the lasso selects the list (4 strokes)", sel === 4, sel);
  await shot("03-lasso.png");
  await page.click(".workspace-leaf.mod-active .ink-sel-delete");
  check("the action bar deletes the selection", (await count()) === n0 - 4);
  await clickToolbar(".ink-toolbar button[aria-label='Undo']");
  check("…and undo brings it back", (await count()) === n0);
  // pen options card
  await clickToolbar(".ink-tool-pen");
  await clickToolbar(".ink-tool-pen");
  await page.waitForSelector(".workspace-leaf.mod-active .ink-pop-pen", { timeout: 3000 });
  await shot("04-pen-options.png");
  await page.click(".workspace-leaf.mod-active .ink-pop-pen .ink-tile[aria-label='Brush']");
  await page.click(".workspace-leaf.mod-active .ink-pop-pen .ink-swatch-btn[aria-label='Blue']");
  const t = await ev(() => ({ pen: __t.surface().tools.pen, color: __t.surface().tools.color, saved: __t.plugin().settings.tools.pen }));
  check("the pen card picks pen and colour (and remembers them)", t.pen === "brush" && t.color === "#1565c0" && t.saved === "brush", JSON.stringify(t));
  await page.keyboard.press("Escape");
  await ev(() => __t.surface().setTools({ tool: "pen", pen: "fountain", color: "#000000" }));
};

steps.pages = async () => {
  console.log("\n▶ pages");
  // a wide window shows the whole toolbar
  await setWindow(1100, 1180);
  await sleep(500);
  const fold = await ev(() => document.querySelector(".workspace-leaf.mod-active .ink-toolbar").dataset.fold);
  check("on a wide window the whole toolbar shows", fold === "0", fold);
  await clickToolbar(".ink-tb-addpage");
  let info = await ev(() => ({ n: __t.surface().pageCount, i: __t.surface().pageIndex, label: document.querySelector(".workspace-leaf.mod-active .ink-tb-pagelabel")?.textContent }));
  check("+ adds a page after this one and goes there", info.n === 2 && info.i === 1 && info.label === "2 / 2", JSON.stringify(info));
  const m = await mapping();
  await pen(word(100, 150, 200, 40), { m });
  // change the paper of this page
  await ev(() => {
    void __t.view().changePaper();
  });
  await page.waitForSelector(".modal.ink-paper-picker", { timeout: 5000 });
  await page.click(`.modal.ink-paper-picker .ink-paper-card[data-style="grid"]`);
  await page.click(`.modal.ink-paper-picker .ink-segmented button[data-value="ivory"]`);
  await page.click(".modal.ink-paper-picker button.mod-cta");
  info = await ev(() => ({ bg: __t.surface().page.bg, strokes: __t.surface().page.strokes.length }));
  check("the paper of a page can be changed, the writing stays", info.bg.paper?.style === "grid" && info.bg.paper?.color === "ivory" && info.strokes === 1, JSON.stringify(info));
  await shot("05-squared-page.png");
  // the page overview
  await clickToolbar(".ink-tb-pagelabel");
  await page.waitForSelector(".modal.ink-pages-modal .ink-page-canvas", { timeout: 5000 });
  await shot("06-pages.png");
  const tiles = await ev(() => document.querySelectorAll(".modal.ink-pages-modal .ink-page-tile:not(.ink-page-add)").length);
  check("the page overview shows both pages", tiles === 2, tiles);
  await page.click(".modal.ink-pages-modal .ink-page-tile:first-child .ink-page-thumb");
  info = await ev(() => ({ i: __t.surface().pageIndex }));
  check("tapping a page goes there", info.i === 0, JSON.stringify(info));
  // swipe with a finger to turn pages
  const mm = await mapping();
  const sx = mm.l + mm.ox + 500 * mm.k;
  const sy = mm.t + mm.oy + 1200 * mm.k;
  await sleep(800);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: sx, y: sy, id: 7 }] });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: sx - i * 30, y: sy, id: 7 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  info = await ev(() => ({ i: __t.surface().pageIndex }));
  check("swiping left with a finger turns the page", info.i === 1, JSON.stringify(info));
  await ev(() => __t.surface().goTo(0));
  await setWindow(820, 1180);
};

steps.typedNotes = async () => {
  console.log("\n▶ typed notes");
  await ev(async (p) => {
    await app.vault.process(app.vault.getAbstractFileByPath(p), (md) => md + "\nTyped on the text page with a [[Welcome]] link.\n");
  }, state.text);
  await ev(() => __t.view().toggleNotes());
  const shown = await ev(async () => {
    await __t.waitFor(() => document.querySelector(".workspace-leaf.mod-active .ink-notes-panel .markdown-rendered"), 5000, "notes");
    return document.querySelector(".workspace-leaf.mod-active .ink-notes-panel .ink-notes-body").textContent;
  });
  check("the typed notes of the text page show on the ink page", shown.includes("Typed on the text page"), shown);
  await page.click(".workspace-leaf.mod-active .ink-notes-panel .ink-notes-btn");
  await page.fill(".workspace-leaf.mod-active .ink-notes-input", "Typed on the text page with a [[Welcome]] link.\n\nAdded on the ink page.");
  await page.click(".workspace-leaf.mod-active .ink-notes-panel .ink-notes-btn");
  await sleep(500);
  const md = await ev((p) => __t.read(p), state.text);
  check("notes edited on the ink page go to the text page (transcript kept)", md.includes("Added on the ink page.") && md.includes("%% ink-notebook:start %%"), md);
  await page.click(".workspace-leaf.mod-active .ink-notes-panel button[aria-label='Close']");
};

steps.pdf = async () => {
  console.log("\n▶ annotate a PDF");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Lecture slide ${i}`, { x: 60, y: 760, size: 28, font });
    if (i === 2) p.setRotation(degrees(90));
  }
  fs.mkdirSync(path.join(VAULT, "Docs"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Docs", "Slides.pdf"), await doc.save());
  await sleep(1500);
  await ev(() => app.commands.executeCommandById("ink-notebook:annotate-pdf"));
  // the command asks for the PDF
  await page.waitForSelector(".prompt-input", { timeout: 5000 });
  await page.fill(".prompt-input", "Slides.pdf");
  await page.keyboard.press("Enter");
  const p = await waitView("ink-notebook");
  const info = await ev(async () => {
    const s = __t.surface();
    await __t.waitFor(() => __t.plugin().images.pdfPage("Docs/Slides.pdf", 1, 100), 8000, "pdf page").catch(() => null);
    return { pages: s.document.pages.map((p) => ({ bg: p.bg, w: p.w, h: p.h })) };
  });
  check("the PDF's pages become the pages of an ink page", info.pages.length === 3 && info.pages.every((x, i) => x.bg.kind === "pdf" && x.bg.page === i + 1), JSON.stringify(info));
  check("a rotated PDF page keeps its shape (landscape)", info.pages[1].h < info.pages[1].w, JSON.stringify(info.pages[1]));
  await sleep(800);
  const m = await mapping();
  await pen(word(100, 300, 300, 40), { m });
  await ev(() => __t.surface().setTools({ tool: "marker" }));
  await pen(along([[90, 150], [600, 150]], 6), { m });
  await ev(() => __t.surface().setTools({ tool: "pen" }));
  await shot("07-pdf.png");
  await ev(() => __t.surface().goTo(1));
  await sleep(500);
  const m2 = await mapping();
  await pen(word(200, 200, 200, 40), { m: m2 });
  await ev(() => app.commands.executeCommandById("ink-notebook:export-annotated-pdf"));
  const out = await ev(async () => {
    await __t.waitFor(() => app.vault.getAbstractFileByPath("Ink/Slides (annotated).pdf"), 15000, "export");
    return true;
  }).catch((e) => String(e));
  check("Export annotated PDF writes a copy next to the text page", out === true, out);
  if (out === true) {
    const bytes = fs.readFileSync(path.join(VAULT, "Ink", "Slides (annotated).pdf"));
    const pdf = await PDFDocument.load(bytes);
    const rotation = pdf.getPage(1).getRotation().angle;
    check("the annotated PDF keeps all pages and their rotation", pdf.getPageCount() === 3 && rotation === 90, `${pdf.getPageCount()} ${rotation}`);
    check("the ink is in the PDF as vector paths (text stays text)", bytes.length > 2000 && bytes.length < 200000, bytes.length);
  }
  state.pdfInk = p;
  await ev(() => __t.plugin().exportNotebookPdf());
  const nb = await ev(async (p) => {
    const name = `Ink/${p.split("/").pop().replace(/\.ink\.md$/, "")}.pdf`;
    await __t.waitFor(() => app.vault.getAbstractFileByPath(name), 15000, "export pdf");
    return name;
  }, p).catch((e) => String(e));
  check("Export as PDF writes the whole notebook", nb.endsWith(".pdf"), nb);
};

/** Show a file in a new tab and make it the active one. */
async function openFile(p, type) {
  await ev(async ({ p, type }) => {
    const leaf = app.workspace.getLeaf("tab");
    await leaf.setViewState({ type, state: { file: p }, active: true });
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, { p, type });
}

steps.reload = async () => {
  console.log("\n▶ reload the plugin");
  await openFile(state.drawing, "ink-notebook");
  await waitView("ink-notebook", state.drawing);
  await sleep(2500); // saved
  await ev(async () => {
    await app.plugins.disablePlugin("ink-notebook");
    await new Promise((r) => setTimeout(r, 1000));
    await app.plugins.enablePlugin("ink-notebook");
  });
  await sleep(2000);
  const info = await ev(async (d) => {
    // tabs come back "deferred" (they load when shown)
    const leaf = await __t.waitFor(() => app.workspace.getLeavesOfType("ink-notebook").find((l) => l.getViewState().state?.file === d), 8000, "leaf back").catch(() => null);
    if (!leaf) return { back: false };
    await leaf.loadIfDeferred?.();
    app.workspace.setActiveLeaf(leaf, { focus: true });
    await __t.waitFor(() => leaf.view.inkFile, 8000, "view loaded").catch(() => null);
    return { back: !!leaf.view.inkFile, strokes: leaf.view.surface?.document.pages.reduce((a, p) => a + p.strokes.length, 0) };
  }, state.drawing);
  check("after a reload the ink page is shown again with all strokes", info.back && info.strokes === 15, JSON.stringify(info));
};

steps.asMarkdown = async () => {
  console.log("\n▶ open as Markdown, embeds");
  await openFile(state.drawing, "ink-notebook");
  await waitView("ink-notebook", state.drawing);
  await ev(async () => __t.plugin().openAsMarkdown(app.workspace.getMostRecentLeaf()));
  const p = await waitView("markdown");
  check("Open as Markdown shows the file in the editor", p === state.drawing, p);
  await openFile(state.drawing, "markdown");
  const back = await waitView("ink-notebook");
  check("opening it normally shows the ink view again", back === state.drawing, back);
  // embedding the ink page in a note shows its pages
  await ev(async (d) => {
    const f = await app.vault.create("Embed test.md", `# Embed\n\n![[${d.replace(/\.md$/, "")}]]\n`);
    await app.workspace.getLeaf(false).setViewState({ type: "markdown", state: { file: f.path, mode: "preview" } });
  }, state.drawing);
  const emb = await ev(async () => {
    await __t.waitFor(() => document.querySelector(".workspace-leaf.mod-active .ink-preview canvas"), 8000, "preview").catch(() => null);
    return document.querySelectorAll(".workspace-leaf.mod-active .ink-preview canvas").length;
  });
  check("an embedded ink page shows its pages", emb === 2, emb);
};

steps.migrate = async () => {
  console.log("\n▶ convert an ink page made with Excalidraw");
  const elements = [
    { id: "paper1", type: "image", x: 0, y: 0, width: 1000, height: 1414, locked: true, customData: { inkNotebook: { role: "paper", paper: { style: "dots", spacing: "normal", color: "white", orientation: "portrait" } } } },
    { id: "stroke1", type: "freedraw", x: 100, y: 100, width: 50, height: 20, strokeWidth: 1, strokeColor: "#1e1e1e", points: [[0, 0], [25, 20], [50, 0]], pressures: [0.5, 0.6, 0.4] },
    { id: "text1", type: "text", x: 100, y: 300, width: 200, height: 25, text: "typed", rawText: "typed", originalText: "typed", fontSize: 20, strokeColor: "#1e1e1e" },
    { id: "region1", type: "rectangle", x: 90, y: 90, width: 80, height: 40, locked: true, customData: { inkNotebook: { role: "region", kind: "diagram" } } },
  ];
  const json = JSON.stringify({ type: "excalidraw", version: 2, elements, appState: {}, files: {} });
  const compressed = LZString.compressToBase64(json).match(/.{1,256}/g).join("\n\n");
  fs.mkdirSync(path.join(VAULT, "Old", "Attachments"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Old", "Attachments", "Old page.excalidraw.md"), `---\nexcalidraw-plugin: parsed\nink-text: "[[Old/Old page]]"\n---\n# Excalidraw Data\n\n%%\n## Drawing\n\`\`\`compressed-json\n${compressed}\n\`\`\`\n%%`);
  fs.writeFileSync(path.join(VAULT, "Old", "Old page.md"), `---\nink-drawing: "[[Old/Attachments/Old page.excalidraw]]"\n---\n%% ink-notebook:start %%\n![[Old/Attachments/Old page.excalidraw#^area=region1|300]]\n%% ink-notebook:end v1 %%\n`);
  await sleep(2000);
  await ev(() => app.commands.executeCommandById("ink-notebook:migrate-excalidraw"));
  await page.waitForSelector(".modal.ink-confirm button.mod-cta", { timeout: 5000 });
  await page.click(".modal.ink-confirm button.mod-cta");
  const info = await ev(async () => {
    await __t.waitFor(() => app.vault.getAbstractFileByPath("Old/Attachments/Old page.ink.md"), 8000, "converted");
    // (the first transcription follows half a second later and replaces unused diagram areas)
    const ink = __t.plugin().internals.parseInkFile(await __t.read("Old/Attachments/Old page.ink.md"));
    await __t.sleep(1500);
    return {
      pages: ink.doc.pages.map((p) => ({ bg: p.bg, strokes: p.strokes.length, texts: p.texts.map((t) => t.text) })),
      regions: ink.meta.regions.map((r) => r.id),
      text: await __t.read("Old/Old page.md"),
    };
  }).catch((e) => ({ error: String(e) }));
  check("the Excalidraw page is converted with its paper, writing and text", info.pages?.length === 1 && info.pages[0].bg.paper?.style === "dots" && info.pages[0].strokes === 1 && info.pages[0].texts[0] === "typed", JSON.stringify(info));
  check("diagram areas keep their ids", info.regions?.[0] === "region1", JSON.stringify(info.regions));
  check("the text page now points at the new ink page", /ink-drawing: "\[\[Old\/Attachments\/Old page\.ink\]\]"/.test(info.text ?? ""), info.text);
};

steps.eink = async () => {
  console.log("\n▶ e-ink look on a Boox-sized window");
  await setSettings({ einkMode: "on" });
  await setWindow(702, 936);
  await openFile(state.drawing, "ink-notebook");
  await waitView("ink-notebook", state.drawing);
  await sleep(800);
  const tb = await ev(() => {
    const t = document.querySelector(".workspace-leaf.mod-active .ink-toolbar");
    const visible = (sel) => [...t.querySelectorAll(sel)].some((b) => b.offsetWidth > 0);
    return { fold: t.dataset.fold, overflow: t.scrollWidth > t.clientWidth + 1, arrows: visible("button[aria-label='Next page']"), undo: visible("button[aria-label='Undo']"), text: visible(".ink-tb-text") };
  });
  check("the toolbar fits a Boox-sized screen with tools, undo, page arrows and the text page", !tb.overflow && tb.arrows && tb.undo && tb.text, JSON.stringify(tb));
  await shot("08-eink-ink-page.png");
  await clickToolbar(".ink-tool-pen");
  await page.waitForSelector(".workspace-leaf.mod-active .ink-pop-pen", { timeout: 3000 });
  await shot("09-eink-pen-options.png");
  await page.keyboard.press("Escape");
  await clickToolbar(".ink-tb-more");
  await shot("10-eink-menu.png");
  await page.keyboard.press("Escape");
  await clickToolbar(".ink-tb-text");
  await waitView("markdown");
  await sleep(1200);
  await shot("11-eink-text-page.png");
  await setSettings({ einkMode: "off" });
  await setWindow(820, 1180);
};

const order = ["setup", "createPage", "write", "speed", "flipToText", "flipToInk", "tools", "pages", "typedNotes", "pdf", "reload", "asMarkdown", "migrate", "eink"];
const run = only ? ["setup", only] : order;
for (const name of run) {
  try {
    await steps[name]();
  } catch (e) {
    failures++;
    console.log(`  ✗ step ${name} threw: ${e.stack ?? e}`);
    await shot(`error-${name}.png`).catch(() => {});
  }
}
const unexpected = errors.filter((e) => !/ResizeObserver loop|net::ERR|Failed to load resource/.test(e));
check("no errors in the console", unexpected.length === 0, unexpected.slice(0, 10).join("\n"));
console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
