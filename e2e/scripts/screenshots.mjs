// Screenshots for the README / the Obsidian plugin listing, taken in a real
// Obsidian with handwriting that looks like handwriting (see handwriting.mjs).
//
//   SCALE=2 W=1200 H=1400 ./scripts/fresh.sh     # Obsidian at twice the pixel density
//   node scripts/screenshots.mjs                  # all scenes → e2e/shots/listing
//   node scripts/screenshots.mjs notes            # or one scene (after "setup")
//
// The arXiv scene shows real search results: they are fetched with curl before
// it runs and served to Obsidian from a local server.
import { chromium } from "playwright-core";
import { execFileSync } from "child_process";
import fs from "fs";
import http from "http";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { handwriting, handLine } from "./handwriting.mjs";

const E2E = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VAULT = path.join(E2E, "vault");
const OUT = path.join(E2E, "shots", "listing");
fs.mkdirSync(OUT, { recursive: true });
const MOCK = "http://127.0.0.1:8765";
const only = process.argv[2];

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html"));
const cdp = await page.context().newCDPSession(page);
const ev = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);
const mock = async (cfg) => fetch(`${MOCK}/__config`, { method: "POST", body: JSON.stringify(cfg) });

/** The window size of every screenshot (3:4, like a tablet held upright). */
const WIN = { w: 960, h: 1280 };

async function shot(name) {
  await ev(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, name) });
  console.log(`  📷 ${name}`);
}

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

async function closeModals() {
  for (let i = 0; i < 4; i++) {
    if ((await ev(() => document.querySelectorAll(".modal-container").length)) === 0) return;
    await page.keyboard.press("Escape");
    await sleep(250);
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

/** Show a file in the only tab. */
async function openFile(p, type) {
  await ev(async ({ p, type }) => {
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type, state: { file: p }, active: true });
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, { p, type });
  await waitView(type, p);
}

/** One tab only, sidebars closed. */
async function tidyWorkspace() {
  await ev(() => {
    const leaves = [];
    app.workspace.iterateRootLeaves((l) => leaves.push(l));
    const keep = app.workspace.getMostRecentLeaf();
    for (const l of leaves) if (l !== keep) l.detach();
    app.workspace.leftSplit.collapse();
    app.workspace.rightSplit.collapse();
  });
}

async function tool(patch) {
  await ev((patch) => __t.surface().setTools(patch), patch);
}

/** Page coordinates → screen coordinates of the open ink page. */
async function mapping() {
  return ev(() => {
    const s = __t.surface();
    const r = s.el.getBoundingClientRect();
    return { l: r.left, t: r.top, k: s.view.scale, ox: s.view.ox, oy: s.view.oy };
  });
}

/** A tap with the pen at a page point (places library items, text boxes, fills). */
async function tap(x, y) {
  const m = await mapping();
  const s = { x: m.l + m.ox + x * m.k, y: m.t + m.oy + y * m.k };
  const base = { pointerType: "pen", button: "left", buttons: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x, y: s.y, pointerType: "pen", buttons: 0, force: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: s.x, y: s.y, clickCount: 1, force: 0.5, ...base });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: s.x, y: s.y, clickCount: 1, force: 0, ...base, buttons: 0 });
}

let idn = 0;
const sid = (p) => `${p}${(++idn).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Put strokes on the open page, like the pen would. */
async function addInk(items) {
  await ev((items) => {
    const s = __t.surface();
    const p = s.page;
    const strokes = items.map((it) => {
      const o = { id: it.id, pen: it.pen ?? "fountain", color: it.color ?? "#000000", width: it.width ?? 1.8, pts: Float32Array.from(it.pts) };
      for (const k of ["poly", "closed", "arrow", "dash", "fill", "fillStyle", "from", "to", "elbow"]) if (it[k]) o[k] = it[k];
      return o;
    });
    s.commitPage({ ...p, strokes: [...p.strokes, ...strokes] }, "all");
  }, items.map((it) => ({ id: sid("s"), ...it })));
}

const flat = (pts, p = 0.5) => pts.flatMap(([x, y]) => [x, y, p]);
/** A shape like the shape tool draws it: a rectangle. */
const rect = (x, y, w, h, extra = {}) => ({ id: sid("r"), pts: flat([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]), poly: true, closed: true, ...extra });
/** A hand-drawn box (a checkbox). */
const handBox = (x, y, s, seed) => ({ pts: handLine([[x, y], [x + s, y + 0.5], [x + s - 0.5, y + s], [x + 0.5, y + s - 0.5], [x, y + 1.5]], { seed, step: 1.5, rounds: 0, wobble: 0.5 }) });
/** The highlighter over a span of a line (baseline y). */
const highlight = (x1, x2, y, seed = 3) => ({ pen: "marker", color: "#ffe14d", width: 22, pts: handLine([[x1, y - 9], [x2, y - 10]], { seed, wobble: 0.6 }) });

const scenes = {};
const NOTES = { name: "Garden app", ink: "Ink/Attachments/Garden app.ink.md", text: "Ink/Garden app.md" };

scenes.setup = async () => {
  console.log("▶ setup");
  await setWindow(WIN.w, WIN.h);
  await setSettings({ setupDone: true, azureEndpoint: MOCK, azureKey: "test-key", azureApi: "auto", azureDetectedApi: "", einkMode: "off", queue: [], pageLocation: "fixed", folder: "Ink", inkSubfolder: "Attachments", askForPaper: false, askForPageName: false, holdToShape: true, scribbleErase: true });
  // the status bar shows word counts of the page's data, not of interest here
  await ev(() => {
    app.vault.setConfig("alwaysUpdateLinks", true);
    document.getElementById("ink-shots-css")?.remove();
    const style = document.head.createEl("style", { attr: { id: "ink-shots-css" } });
    style.textContent = ".status-bar { display: none !important; }";
  });
  await closeModals();
  await tidyWorkspace();
  await mock({ reset: true, mode: "ok", responses: [], fallback: null });
};

/**
 * What the (mock) Azure reads in the handwriting next: for each writing area its
 * lines, top to bottom (an image gets the texts with as many lines as it has).
 */
async function recognise(...areas) {
  await ev(() => __t.plugin().ocr.cache.clear());
  await mock({ reset: true, responses: [], fallback: null, pool: areas });
}

/** Delete files of an earlier run, so a scene starts from scratch. */
async function remove(...paths) {
  await ev(async (paths) => {
    for (const p of paths) {
      const f = app.vault.getAbstractFileByPath(p);
      if (f) await app.vault.delete(f, true);
    }
  }, paths);
  await sleep(300);
}

/** Create an ink page with the "New ink page" command, named `name`. */
async function newInkPage(name) {
  await setSettings({ askForPageName: true });
  await ev(() => app.commands.executeCommandById("ink-notebook:new-page"));
  await ev(async (name) => {
    const input = await __t.waitFor(() => document.querySelector(".modal.ink-modal input.ink-wide-input"), 5000, "name prompt");
    input.value = name;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }, name);
  await setSettings({ askForPageName: false });
  await waitView("ink-notebook", `Ink/Attachments/${name}.ink.md`);
  await tidyWorkspace();
  await sleep(500);
}

/** Open the pen card (a tap on the active pen opens it). */
async function openPenCard() {
  const sel = ".workspace-leaf.mod-active .ink-pop-pen";
  for (let i = 0; i < 3; i++) {
    await page.click(".workspace-leaf.mod-active .ink-tool-pen");
    if (await page.waitForSelector(sel, { timeout: 1200 }).catch(() => null)) return;
  }
  throw new Error("the pen card did not open");
}

/** Ruled paper: lines at y = 110 + 44k, the margin at x = 88. */
const L = (k) => 110 + 44 * k;
const SIZE = 1.4;

/** The notebook of the first screenshots: a page of meeting notes. */
scenes.notes = async () => {
  console.log("▶ notes: ink page, text page, pen options");
  await setSettings({ einkMode: "off" });
  await setWindow(WIN.w, WIN.h);
  await remove(NOTES.ink, NOTES.text);
  // the notes the page links to
  fs.mkdirSync(path.join(VAULT, "People"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "People", "Anna.md"), "# Anna\n\nDesigner of the garden app.\n");
  fs.writeFileSync(path.join(VAULT, "People", "Tom.md"), "# Tom\n\nRuns the servers.\n");
  await sleep(800);
  await newInkPage(NOTES.name);

  const ink = [];
  const w = (text, x, y, seed, opts = {}) => {
    const r = handwriting(text, { x, y, size: SIZE, seed, ...opts });
    ink.push(...r.strokes.map((pts) => ({ pts, color: opts.color ?? "#000000" })));
    return r.width;
  };
  w("Kickoff meeting", 112, L(2), 11, { size: 2.6 });
  w("Met with [[Anna]] and Tom on Monday.", 112, L(4), 21);
  w("First version before the summer.", 112, L(5), 22);
  w("- budget: 12k", 112, L(7), 31);
  const bw = w("- beta in March, ", 112, L(8), 32);
  const lw = w("launch in May", 112 + bw, L(8), 33);
  ink.unshift(highlight(112 + bw - 4, 112 + bw + lw + 6, L(8), 5));
  w("- weekly check-in on Fridays", 112, L(9), 34);
  // tasks: a box drawn in front of the line, one ticked
  ["send the mockups to Anna", "book the meeting room", "ask Tom for a server"].forEach((t, i) => {
    const y = L(11 + i);
    ink.push(handBox(114, y - 21, 21, 40 + i));
    w(t, 160, y, 41 + i);
  });
  ink.push({ pts: handLine([[118, L(12) - 12], [124, L(12) - 4], [138, L(12) - 27]], { seed: 9, step: 1.2, rounds: 0 }), width: 2.2 });
  await addInk(ink.splice(0));

  // a little flow: three shapes, labels written into them, arrows attached
  const y0 = L(15) + 10;
  const boxes = [
    { x: 112, w: 170, label: "Idea" },
    { x: 392, w: 190, label: "Sketch" },
    { x: 692, w: 170, label: "Beta", fill: "#d3f9d8" },
  ].map((b) => ({ ...b, id: sid("box") }));
  const flow = boxes.map((b) => rect(b.x, y0, b.w, 96, { id: b.id, ...(b.fill ? { fill: b.fill } : {}) }));
  for (const b of boxes) {
    const lw = handwriting(b.label, { size: SIZE * 1.15, seed: b.x }).width;
    flow.push(...handwriting(b.label, { x: b.x + (b.w - lw) / 2, y: y0 + 60, size: SIZE * 1.15, seed: b.x }).strokes.map((pts) => ({ pts })));
  }
  for (const i of [0, 1]) flow.push({ pts: flat([[boxes[i].x + boxes[i].w, y0 + 48], [boxes[i + 1].x, y0 + 48]]), poly: true, arrow: true, from: boxes[i].id, to: boxes[i + 1].id });
  // open questions, in blue
  const blue = { color: "#1565c0" };
  w("Open questions", 112, L(19), 51, blue);
  w("- which sensors? ask [[Tom]]", 112, L(20), 52, blue);
  w("- offline mode for the beta?", 112, L(21), 53, blue);
  await addInk([...flow, ...ink.splice(0)]);
  await sleep(1500);
  await tool({ tool: "pen", pen: "fountain", color: "#000000" });

  // the text page ("D": OCR reading a drawn box, as Azure does)
  await recognise(["Kickoff meeting", "Met with [[Anna]] and Tom on Monday.", "First version before the summer.", "- budget: 12k", "- beta in March, launch in May", "- weekly check-in on Fridays", "D send the mockups to Anna", "D book the meeting room", "D ask Tom for a server", "Idea Sketch Beta", "Open questions", "- which sensors? ask [[Tom]]", "- offline mode for the beta?"], ["Beta"]);
  await page.click(".workspace-leaf.mod-active .ink-tb-text", { timeout: 5000 });
  await waitView("markdown", NOTES.text);
  await ev(async () => __t.waitFor(() => document.querySelector(".workspace-leaf.mod-active .ink-figure canvas"), 10000, "figure").catch(() => null));
  await sleep(1500);
  console.log((await ev((p) => __t.read(p), NOTES.text)).replace(/^/gm, "    | "));
  console.log("    mock saw:", JSON.stringify((await (await fetch(`${MOCK}/__stats`)).json()).lastImages));
  await shot("text-page.png");

  await page.click(".workspace-leaf.mod-active .ink-bookmark-ink", { timeout: 5000 });
  await waitView("ink-notebook", NOTES.ink);
  await sleep(1000);
  await shot("ink-page.png");

  // the pen card, on an e-ink screen
  await setSettings({ einkMode: "on" });
  await sleep(800);
  await openPenCard();
  await shot("pen-options-eink.png");
  await page.keyboard.press("Escape");
  await setSettings({ einkMode: "off" });
};

/** Draw with the pen: real pointer events along the points (page coordinates). */
async function pen(pts) {
  const m = await mapping();
  const at = (x, y) => ({ x: m.l + m.ox + x * m.k, y: m.t + m.oy + y * m.k });
  const base = { pointerType: "pen", button: "left", buttons: 1 };
  const s0 = at(pts[0][0], pts[0][1]);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s0.x, y: s0.y, pointerType: "pen", buttons: 0, force: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: s0.x, y: s0.y, clickCount: 1, force: 0.5, ...base });
  for (const [x, y] of pts.slice(1)) await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(x, y), force: 0.5, ...base });
  const e = at(...pts[pts.length - 1]);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: e.x, y: e.y, clickCount: 1, force: 0, ...base, buttons: 0 });
}

/** Points every few units along a polyline (for drags). */
function along(corners, step = 8) {
  const out = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1];
    const [bx, by] = corners[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** A rounded rectangle as a polyline (hand-drawn phone frames, toggles). */
function roundRect(x, y, w, h, r) {
  const pts = [];
  const arc = (cx, cy, a0) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + (i / 6) * (Math.PI / 2);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  arc(x + w - r, y + r, -Math.PI / 2);
  arc(x + w - r, y + h - r, 0);
  arc(x + r, y + h - r, Math.PI / 2);
  arc(x + r, y + r, Math.PI);
  pts.push([x + w - r, y + 0.5]);
  return pts;
}

/** A hand-drawn ellipse (circling a word). */
function ellipse(cx, cy, rx, ry, turns = 1.08) {
  const pts = [];
  for (let i = 0; i <= 48 * turns; i++) {
    const a = -2.6 + (i / 48) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(a) * (1 + 0.03 * Math.sin(i / 5)), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** A hand-drawn arrow: the line and a two-stroke head. */
function handArrow(points, seed, color) {
  const [ax, ay] = points[points.length - 2];
  const [bx, by] = points[points.length - 1];
  const a = Math.atan2(by - ay, bx - ax);
  const head = (da) => [bx - 16 * Math.cos(a + da), by - 16 * Math.sin(a + da)];
  return [
    { pts: handLine(points, { seed, step: 1.5 }), color },
    { pts: handLine([head(0.5), [bx, by], head(-0.5)], { seed: seed + 1, step: 1.2, rounds: 0 }), color },
  ];
}

/** Handwriting as stroke items (for scenes that write a lot). */
const hw = (text, x, y, seed, opts = {}) => handwriting(text, { x, y, size: SIZE, seed, ...opts }).strokes.map((pts) => ({ pts, color: opts.color ?? "#000000" }));

const paper = (style, color = "white", spacing = "normal") => ({ kind: "paper", paper: { style, spacing, color, orientation: "portrait" } });

/** More pages in the notebook, and the page overview. */
scenes.pages = async () => {
  console.log("▶ pages: overview, paper picker");
  await setWindow(WIN.w, WIN.h);
  await openFile(NOTES.ink, "ink-notebook");
  await tidyWorkspace();
  await ev(() => {
    const s = __t.surface();
    while (s.pageCount > 1) s.deletePage(s.pageCount - 1);
    s.goTo(0);
  });
  const newPage = async (bg) => {
    await ev((bg) => {
      const s = __t.surface();
      s.addPage("end", bg);
      s.goTo(s.pageCount - 1);
    }, bg);
    await sleep(300);
  };

  // 2: squared paper, a sketch of the app's screens
  await newPage(paper("grid", "ivory"));
  const sketch = [...hw("Screens", 80, 150, 61, { size: 2.3 })];
  const names = ["Home", "Plant", "Settings"];
  names.forEach((name, i) => {
    const x = 70 + i * 300;
    const y = 230;
    sketch.push({ pts: handLine(roundRect(x, y, 240, 470, 30), { seed: 70 + i, step: 2 }) });
    sketch.push({ pts: handLine([[x + 16, y + 70], [x + 224, y + 71]], { seed: 80 + i }) });
    sketch.push(...hw(name, x + 22, y + 52, 90 + i, { size: 1.05 }));
    if (i === 0) {
      for (let r = 0; r < 4; r++) {
        const ry = y + 110 + r * 80;
        sketch.push({ pts: handLine(ellipse(x + 50, ry + 20, 20, 20, 1.02), { seed: 100 + r, step: 1.5 }) });
        sketch.push({ pts: handLine([[x + 86, ry + 12], [x + 210, ry + 12]], { seed: 110 + r }) });
        sketch.push({ pts: handLine([[x + 86, ry + 32], [x + 170, ry + 33]], { seed: 120 + r }) });
      }
    } else if (i === 1) {
      sketch.push({ pts: handLine(ellipse(x + 120, y + 190, 80, 80, 1.02), { seed: 130, step: 2 }) });
      sketch.push(...hw("photo", x + 84, y + 196, 131, { size: 1.05 }));
      for (let r = 0; r < 3; r++) sketch.push({ pts: handLine([[x + 30, y + 320 + r * 36], [x + 210 - r * 30, y + 321 + r * 36]], { seed: 140 + r }) });
      sketch.push({ pts: handLine(roundRect(x + 40, y + 410, 160, 40, 18), { seed: 150, step: 2 }) });
      sketch.push(...hw("Water", x + 82, y + 438, 151, { size: 1.0 }));
    } else {
      for (let r = 0; r < 4; r++) {
        const ry = y + 110 + r * 80;
        sketch.push({ pts: handLine([[x + 24, ry + 22], [x + 130, ry + 22]], { seed: 160 + r }) });
        sketch.push({ pts: handLine(roundRect(x + 150, ry + 6, 66, 32, 16), { seed: 170 + r, step: 1.5 }) });
        sketch.push({ pts: handLine(ellipse(x + (r % 2 ? 166 : 200), ry + 22, 12, 12, 1.02), { seed: 180 + r, step: 1.2 }) });
      }
    }
    sketch.push(...hw(name, x + 70, y + 530, 190 + i));
  });
  sketch.push(...handArrow([[315, 470], [365, 466]], 200, "#000000"));
  sketch.push(...handArrow([[615, 470], [665, 470]], 202, "#000000"));
  sketch.push(...hw("tap a plant", 600, 820, 210, { color: "#c62828" }));
  sketch.push(...handArrow([[640, 790], [520, 640]], 212, "#c62828"));
  await addInk(sketch);

  // 3: dotted paper, interview notes
  await newPage(paper("dots"));
  const notes = [...hw("User interviews", 70, 160, 220, { size: 2.3 })];
  [
    ["Maria - balcony garden, forgets to water", "#000000"],
    ["Jonas - wants reminders on his watch", "#000000"],
    ["Lea - likes the plant photos", "#000000"],
    ["Sam - has 40 plants (!)", "#000000"],
  ].forEach(([t, c], i) => notes.push(...hw(t, 70, 270 + i * 60, 230 + i, { color: c })));
  notes.push(...hw("-> reminders first!", 70, 560, 240, { color: "#c62828" }));
  await addInk(notes);

  // 4: Cornell notes
  await newPage(paper("cornell"));
  const corn = [...hw("Sensors", 30, L(2), 250, { color: "#1565c0" }), ...hw("Battery", 30, L(6), 251, { color: "#1565c0" })];
  [
    [2, "soil moisture and light"],
    [3, "one per pot, about 8 each"],
    [4, "Bluetooth, no hub needed"],
    [6, "two AA cells, 6 months"],
    [7, "warn when it gets low"],
  ].forEach(([k, t], i) => corn.push(...hw(t, 300, L(k), 260 + i)));
  corn.push(...hw("One sensor per pot is enough.", 40, 1200, 270));
  await addInk(corn);

  // 5: a checklist
  await newPage(paper("checklist"));
  const list = [...hw("Launch checklist", 70, L(0) - 8, 280, { size: 2.1 })];
  ["app store texts", "screenshots", "privacy policy", "beta feedback"].forEach((t, i) => list.push(...hw(t, 72, L(i + 2) - 10, 290 + i)));
  list.push({ pts: handLine([[37, L(2) - 30], [44, L(2) - 22], [58, L(2) - 44]], { seed: 300, step: 1.2, rounds: 0 }), width: 2.2 });
  await addInk(list);

  await ev(() => __t.surface().goTo(0));
  await sleep(600);
  await page.click(".workspace-leaf.mod-active .ink-tb-pagelabel");
  await page.waitForSelector(".modal.ink-pages-modal .ink-page-canvas", { timeout: 5000 });
  await sleep(1500);
  await shot("pages.png");
  await closeModals();

  // the paper picker
  await ev(() => void __t.view().changePaper());
  await page.waitForSelector(".modal.ink-paper-picker", { timeout: 5000 });
  await page.click(`.modal.ink-paper-picker .ink-paper-card[data-style="dots"]`);
  await page.click(`.modal.ink-paper-picker .ink-segmented button[data-value="ivory"]`);
  await sleep(500);
  await shot("paper.png");
  await closeModals();
};

/** A PDF handout, annotated. */
scenes.pdf = async () => {
  console.log("▶ pdf: annotate a PDF");
  await setWindow(WIN.w, WIN.h);
  await remove("Ink/Attachments/Companion planting (annotated).ink.md", "Ink/Companion planting (annotated).md", "Docs/Companion planting.pdf");
  // the handout: text in a column, a wide margin for notes
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const italic = await doc.embedFont(StandardFonts.HelveticaOblique);
  const pg = doc.addPage([595, 842]);
  const X = 56;
  const COL = 380;
  const lines = [];
  let y = 770;
  const text = (t, font, size, opts = {}) => {
    pg.drawText(t, { x: opts.x ?? X, y, size, font, color: opts.color ?? rgb(0.1, 0.1, 0.1) });
    lines.push({ t, x: opts.x ?? X, y, size, font });
  };
  const para = (t, size = 11.5, lead = 16.5) => {
    const words = t.split(" ");
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (regular.widthOfTextAtSize(next, size) > COL) {
        text(cur, regular, size);
        y -= lead;
        cur = w;
      } else cur = next;
    }
    if (cur) text(cur, regular, size);
    y -= lead + 8;
  };
  text("Companion planting", bold, 26);
  y -= 22;
  text("A short guide for balcony gardens", italic, 12.5, { color: rgb(0.35, 0.35, 0.35) });
  y -= 34;
  para("Some plants grow better side by side. They keep pests away from each other, share the light and use the soil in different ways. On a balcony, where every pot counts, the right neighbours make a real difference.");
  para("Basil planted next to tomatoes keeps whiteflies away and is said to improve their flavour. Marigolds protect almost anything from aphids, and their roots keep nematodes out of the soil.");
  y -= 4;
  text("Good neighbours", bold, 15);
  y -= 26;
  const rows = [
    ["Plant", "Grows well with", "Keep away from"],
    ["Tomato", "basil, carrots", "fennel"],
    ["Beans", "carrots, cucumber", "onions, garlic"],
    ["Lettuce", "radish, chives", "celery"],
    ["Cucumber", "beans, dill", "sage"],
  ];
  const cols = [X, X + 95, X + 240];
  rows.forEach((r, i) => {
    r.forEach((c, j) => {
      pg.drawText(c, { x: cols[j], y, size: 11.5, font: i === 0 ? bold : regular, color: rgb(0.1, 0.1, 0.1) });
      lines.push({ t: c, x: cols[j], y, size: 11.5, font: i === 0 ? bold : regular });
    });
    if (i === 0) pg.drawLine({ start: { x: X, y: y - 5 }, end: { x: X + COL, y: y - 5 }, thickness: 0.8, color: rgb(0.5, 0.5, 0.5) });
    y -= 21;
  });
  y -= 18;
  text("Why it works", bold, 15);
  y -= 26;
  para("Strong scents confuse insects looking for their favourite plant. Deep roots and shallow roots do not compete for water, and tall plants give shade to those that prefer it.");
  para("Start small: one pot of basil between two tomatoes is enough to see the difference in a single summer.");
  pg.drawText("Balcony gardening · 3", { x: X, y: 40, size: 9, font: italic, color: rgb(0.5, 0.5, 0.5) });
  fs.mkdirSync(path.join(VAULT, "Docs"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Docs", "Companion planting.pdf"), await doc.save());
  await sleep(1500);

  await ev(() => app.commands.executeCommandById("ink-notebook:annotate-pdf"));
  await page.waitForSelector(".prompt-input", { timeout: 5000 });
  await page.fill(".prompt-input", "Companion planting.pdf");
  await page.keyboard.press("Enter");
  await waitView("ink-notebook", "Ink/Attachments/Companion planting (annotated).ink.md");
  await tidyWorkspace();
  await ev(async () => __t.waitFor(() => __t.plugin().images.pdfPage("Docs/Companion planting.pdf", 1, 100), 8000, "pdf page").catch(() => null));
  const k = await ev(() => __t.surface().page.w / 595);
  // PDF points → page units; where a phrase of the text is
  const P = (x, y) => [x * k, (842 - y) * k];
  const span = (phrase) => {
    const l = lines.find((l) => l.t.includes(phrase));
    const x0 = l.x + l.font.widthOfTextAtSize(l.t.slice(0, l.t.indexOf(phrase)), l.size);
    const x1 = x0 + l.font.widthOfTextAtSize(phrase, l.size);
    return { x0, x1, y: l.y, size: l.size };
  };
  const ink = [];
  // highlight: basil next to tomatoes
  const h1 = span("Basil planted next to tomatoes keeps whiteflies away");
  const [hx0, hy] = P(h1.x0 - 1, h1.y + 3.5);
  const [hx1] = P(h1.x1 + 1, h1.y);
  ink.push({ pen: "marker", color: "#ffe14d", width: 24, pts: handLine([[hx0, hy], [hx1, hy - 1]], { seed: 401, wobble: 0.5 }) });
  // a note in the margin with an arrow to it
  const red = "#c62828";
  ink.push(...hw("try this", 470 * k, hy + 34, 402, { color: red, size: 1.35 }));
  ink.push(...hw("on the", 470 * k, hy + 72, 403, { color: red, size: 1.35 }));
  ink.push(...hw("balcony!", 470 * k, hy + 110, 404, { color: red, size: 1.35 }));
  const hl = lines.find((l) => l.t.includes("Basil planted"));
  const lineEnd = P(hl.x + hl.font.widthOfTextAtSize(hl.t, hl.size), hl.y)[0];
  ink.push(...handArrow([[468 * k - 4, hy + 24], [lineEnd + 30, hy + 8], [lineEnd + 8, hy - 2]], 405, red));
  // circle "fennel", underline "Marigolds"
  const f = span("fennel");
  const [fx0, fy] = P(f.x0, f.y + 4);
  const [fx1] = P(f.x1, f.y);
  ink.push({ pts: handLine(ellipse((fx0 + fx1) / 2, fy, (fx1 - fx0) / 2 + 14, 17), { seed: 406, step: 1.5 }), color: red, width: 2 });
  const m = span("Marigolds");
  const [mx0, my] = P(m.x0, m.y - 3);
  const [mx1] = P(m.x1, m.y);
  ink.push({ pts: handLine([[mx0, my], [mx1, my + 1]], { seed: 407 }), color: "#1565c0", width: 2 });
  // ticks next to the rows we will plant
  for (const name of ["Tomato", "Lettuce"]) {
    const r = span(name);
    const [tx, ty] = P(r.x0 - 16, r.y);
    ink.push({ pts: handLine([[tx - 10, ty - 8], [tx - 4, ty], [tx + 8, ty - 20]], { seed: 409 + name.length, step: 1.2, rounds: 0 }), width: 2.2 });
  }
  // a note at the end
  ink.push(...hw("Plan: basil between the tomatoes,", 60 * k, (842 - y) * k + 30, 412, { color: "#1565c0", size: 1.35 }));
  ink.push(...hw("marigolds everywhere!", 60 * k, (842 - y) * k + 76, 413, { color: "#1565c0", size: 1.35 }));
  await addInk(ink);
  await tool({ tool: "pen", pen: "fountain", color: "#000000" });
  await sleep(1200);
  await shot("pdf.png");
};

/** The arXiv search, with real results (fetched with curl, served locally). */
scenes.arxiv = async () => {
  console.log("▶ arxiv: papers from arXiv");
  await setWindow(WIN.w, WIN.h);
  const CACHE = path.join(E2E, "shots", "listing", ".arxiv-cache");
  fs.mkdirSync(CACHE, { recursive: true });
  const remote = { "/api/query": "https://export.arxiv.org/api/query", "/daily_papers": "https://huggingface.co/api/daily_papers" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:8769");
    const base = remote[url.pathname];
    if (!base) {
      res.writeHead(404);
      return res.end("not found");
    }
    const target = base + url.search;
    const file = path.join(CACHE, Buffer.from(target).toString("base64url").slice(0, 120));
    if (!fs.existsSync(file)) fs.writeFileSync(file, execFileSync("curl", ["-sS", "-m", "40", "-L", target]));
    res.writeHead(200, { "content-type": url.pathname === "/api/query" ? "application/atom+xml" : "application/json" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(8769, "127.0.0.1", r));
  try {
    await ev((base) => Object.assign(__t.plugin().papers.endpoints, { arxivApi: `${base}/api/query`, popular: `${base}/daily_papers` }), "http://127.0.0.1:8769");
    await page.click('.side-dock-ribbon-action[aria-label="Import a paper from arXiv"]', { timeout: 5000 });
    await ev(async () => __t.waitFor(() => document.querySelectorAll(".ink-arxiv-card").length > 3 && !document.querySelector(".ink-arxiv-status span"), 60000, "papers"));
    await sleep(800);
    await shot("arxiv.png");
    await closeModals();
  } finally {
    server.close();
  }
};

/** Flowchart shapes from the object library. */
scenes.flowchart = async () => {
  console.log("▶ flowchart: the object library");
  await setWindow(WIN.w, WIN.h);
  await remove("Ink/Attachments/Watering.ink.md", "Ink/Watering.md");
  await newInkPage("Watering");
  await ev(() => __t.surface().setBackground({ kind: "paper", paper: { style: "dots", spacing: "normal", color: "white", orientation: "portrait" } }));
  await ev(() => app.commands.executeCommandById("ink-notebook:object-library"));
  const panel = ".workspace-leaf.mod-active .ink-library-panel";
  await page.click(`${panel} .ink-library-source[aria-label='Flowchart']`);
  await page.waitForSelector(`${panel} .ink-library-tile[aria-label='Process']`, { timeout: 5000 });
  const place = async (tile, x, y) => {
    await page.click(`${panel} .ink-library-tile[aria-label='${tile}']`);
    await tap(x, y);
    await sleep(150);
  };
  const label = async (x, y, text) => {
    await tool({ tool: "text" });
    await tap(x, y);
    await sleep(200);
    await page.keyboard.type(text);
    await page.keyboard.press("Escape");
    await sleep(150);
  };
  const cx = 220;
  // (a second tap on the chosen tile would put it away: never the same tile twice in a row)
  await place("Start / end", cx, 190);
  await place("Process", cx, 390);
  await place("Decision", cx, 610);
  await place("Start / end", 520, 610);
  await place("Process", cx, 840);
  await place("Start / end", cx, 1060);
  await tool({ tool: "shape", shape: "arrow" });
  for (const [a, b] of [[190, 390], [390, 610], [610, 840], [840, 1060]]) await pen(along([[cx, a], [cx, b]]));
  await pen(along([[cx, 610], [520, 610]]));
  await tool({ tool: "fill", fillColor: "#fff3bf", fillStyle: "solid" });
  await tap(cx, 610);
  await tool({ tool: "fill", fillColor: "#a5d8ff", fillStyle: "hatch" });
  await tap(cx, 840);
  await label(cx, 190, "Every morning");
  await label(cx, 390, "Read the sensor");
  await label(cx, 610, "Dry?");
  await label(cx, 840, "Water 10 min");
  await label(cx, 1060, "Done");
  await label(520, 610, "Skip today");
  await label(cx + 14, 715, "yes");
  await label(360, 586, "no");
  // a note by hand, next to the shapes
  const red = "#c62828";
  await addInk([
    ...hw("rain forecast", 395, 790, 501, { color: red, size: 1.25 }),
    ...hw("too?", 395, 836, 502, { color: red, size: 1.25 }),
    ...handArrow([[420, 752], [380, 700], [318, 650]], 503, red),
  ]);
  await tool({ tool: "pen" });
  await ev(() => {
    const p = document.querySelector(".workspace-leaf.mod-active .ink-library-panel");
    if (p?.classList.contains("is-folded")) p.querySelector(".ink-library-fold").click();
  });
  await sleep(800);
  await shot("flowchart.png");
  await page.click(`${panel} .ink-library-close`).catch(() => {});
};

/** A Mermaid diagram: the dialog, and the diagram as ink. */
scenes.mermaid = async () => {
  console.log("▶ mermaid");
  await setWindow(WIN.w, WIN.h);
  const CODE = `flowchart TD
    S([Every hour]) --> R[Read the soil sensor]
    R --> D{Soil dry?}
    D -- no --> W([Wait])
    D -- yes --> F{Rain forecast?}
    F -- yes --> W
    F -- no --> V
    subgraph Watering
        V[Open the valve] --> T[Water for 10 minutes]
        T --> C[Close the valve]
    end
    C --> L[(Garden journal)]
    L --> W

    classDef sensor fill:#E1F5EE,stroke:#0F6E56,color:#085041
    classDef water fill:#E7F0FD,stroke:#1565C0,color:#0D3C78
    class S,R sensor
    class V,T,C water`;
  fs.rmSync(path.join(VAULT, "Ink libraries", "Mermaid"), { recursive: true, force: true });
  await remove("Ink/Attachments/Smart garden.ink.md", "Ink/Smart garden.md");
  fs.mkdirSync(path.join(VAULT, "Projects"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Projects", "Watering logic.md"), "What the controller does every hour:\n\n```mermaid\n" + CODE + "\n```\n");
  await sleep(1200);
  const note = "Projects/Watering logic.md";
  await openFile(note, "markdown");
  await tidyWorkspace();
  await ev(() => {
    const ed = app.workspace.activeEditor.editor;
    ed.setCursor(ed.offsetToPos(ed.getValue().indexOf("subgraph Watering")));
  });
  await ev(() => app.commands.executeCommandById("ink-notebook:add-mermaid"));
  await page.waitForSelector(".ink-mermaid-modal .ink-mermaid-code", { timeout: 5000 });
  await page.waitForFunction(() => /shapes/.test(document.querySelector(".ink-mermaid-status")?.textContent ?? ""), null, { timeout: 5000 });
  await sleep(800);
  console.log("   ", await ev(() => document.querySelector(".ink-mermaid-status").textContent));
  await shot("mermaid-dialog.png");
  await page.click(".ink-mermaid-modal button.mod-cta");
  await sleep(800);

  await newInkPage("Smart garden");
  await ev(() => __t.surface().setBackground({ kind: "paper", paper: { style: "blank", spacing: "normal", color: "white", orientation: "portrait" } }));
  await ev(() => app.commands.executeCommandById("ink-notebook:object-library"));
  const panel = ".workspace-leaf.mod-active .ink-library-panel";
  await page.click(`${panel} .ink-library-source[aria-label='Mermaid']`);
  await page.waitForSelector(`${panel} .ink-library-tile[aria-label='Watering logic']`, { timeout: 5000 });
  await page.click(`${panel} .ink-library-tile[aria-label='Watering logic']`);
  // (left of the middle: the library panel covers the right of the page)
  await tap(330, 707);
  await sleep(300);
  await tool({ tool: "pen" });
  await ev(() => {
    const p = document.querySelector(".workspace-leaf.mod-active .ink-library-panel");
    if (p?.classList.contains("is-folded")) p.querySelector(".ink-library-fold").click();
  });
  await sleep(800);
  await shot("mermaid.png");
  await page.click(`${panel} .ink-library-close`).catch(() => {});
};

const order = ["setup", "notes", "pages", "pdf", "arxiv", "flowchart", "mermaid"];
const run = only ? ["setup", only] : order;
for (const name of run) {
  try {
    await scenes[name]();
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.stack ?? e}`);
    await page.screenshot({ path: path.join(OUT, `error-${name}.png`) }).catch(() => {});
    process.exitCode = 1;
  }
}
await browser.close();
