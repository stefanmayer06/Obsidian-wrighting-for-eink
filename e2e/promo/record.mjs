// Footage for the promo video, recorded in a real Obsidian with Ink Notebook.
//
//   SCALE=2 W=1000 H=1300 ./scripts/fresh.sh   # Obsidian at twice the pixel density
//   node promo/record.mjs                       # every scene → e2e/shots/promo/<scene>/
//   node promo/record.mjs write                 # or one scene (after "setup")
//
// Obsidian runs in its tablet layout (mobile emulation) in a window the size of a
// Boox Note Air (702 × 936 CSS pixels at 2× = 1404 × 1872, the device's
// resolution). Scenes are recorded frame by frame at 30 fps in "virtual time":
// for every frame the pen events of that 1/30 s are sent (real pointer events,
// pointerType "pen", with pressure), then the window is captured. So the
// writing has an even pace however fast this machine is. Each scene folder gets
// numbered PNGs and a manifest.json with, per frame, where the pen is (for the
// stylus drawn by compose.html) – a frame that does not change is captured once
// and listed again.
//
// The handwriting is traced from a single-stroke script font (see
// ../scripts/handwriting.mjs), and the text page is filled in by the mock Azure
// server (../scripts/mock-azure.mjs) – the same staging as the README screenshots.
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { handwriting, handLine } from "../scripts/handwriting.mjs";

const E2E = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VAULT = path.join(E2E, "vault");
const OUT = path.join(E2E, "shots", "promo");
const MOCK = "http://127.0.0.1:8765";
const FPS = 30;
/** The window: a Boox Note Air held upright (CSS pixels). */
const WIN = { w: 702, h: 936 };
const only = process.argv[2];

const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
let page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html"));
let cdp = await page.context().newCDPSession(page);
const ev = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = async (cfg) => fetch(`${MOCK}/__config`, { method: "POST", body: JSON.stringify(cfg) });

async function installHelpers() {
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
      paint: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    };
  });
}

// ---------------------------------------------------------------- recording

/**
 * One scene's frames. `frame()` captures the window; `hold(n)` repeats the last
 * capture n times. Every frame records the pen: { x, y } in CSS pixels of the
 * window, `down` while it touches the screen, `tap` on the frame of a tap.
 */
class Take {
  constructor(name) {
    this.name = name;
    this.dir = path.join(OUT, name);
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.frames = [];
    this.files = 0;
    this.pen = null;
    this.marks = {};
  }
  async frame(extra = {}) {
    await ev(() => __t.paint());
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = `${String(++this.files).padStart(4, "0")}.png`;
    fs.writeFileSync(path.join(this.dir, file), Buffer.from(data, "base64"));
    this.frames.push({ file, pen: this.pen ? { ...this.pen } : null, ...extra });
  }
  hold(n, extra = {}) {
    const last = this.frames[this.frames.length - 1];
    for (let i = 0; i < n; i++) this.frames.push({ file: last.file, pen: this.pen ? { ...this.pen } : null, ...extra });
  }
  /** Name the current frame (compose.html times captions and cuts by these). */
  mark(name) {
    this.marks[name] = this.frames.length;
  }
  save(meta = {}) {
    fs.writeFileSync(path.join(this.dir, "manifest.json"), JSON.stringify({ name: this.name, fps: FPS, width: WIN.w, height: WIN.h, frames: this.frames, marks: this.marks, ...meta }, null, 1));
    console.log(`  🎞  ${this.name}: ${this.frames.length} frames (${(this.frames.length / FPS).toFixed(1)} s), ${this.files} captures`);
  }
}

/** Page coordinates → window coordinates of the open ink page. */
async function mapping() {
  return ev(() => {
    const s = __t.surface();
    const r = s.el.getBoundingClientRect();
    return { l: r.left, t: r.top, k: s.view.scale, ox: s.view.ox, oy: s.view.oy };
  });
}

const mouse = (type, x, y, extra = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, pointerType: "pen", ...extra });
const ease = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

/**
 * Move the pen (lifted) to a window point over `sec` seconds, one frame at a time.
 */
async function travel(take, to, sec) {
  const from = take.pen ?? { x: to.x + 120, y: to.y + 160 };
  const n = Math.max(1, Math.round(sec * FPS));
  if (n === 1 && Math.hypot(to.x - from.x, to.y - from.y) < 30) {
    // a short hop (an i-dot, the next letter): the pen is just there
    take.pen = { x: to.x, y: to.y, down: false };
    take.hold(1);
    return;
  }
  for (let i = 1; i <= n; i++) {
    const u = ease(i / n);
    // a slight arc, like a hand lifting the pen
    const lift = Math.sin(Math.PI * u) * Math.min(40, Math.hypot(to.x - from.x, to.y - from.y) * 0.15);
    take.pen = { x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u - lift, down: false };
    await mouse("mouseMoved", take.pen.x, take.pen.y, { buttons: 0, force: 0 });
    take.hold(1); // the page does not change while the pen moves above it
  }
}

/**
 * Write strokes (flat [x, y, pressure, …] arrays in page units) with the pen:
 * `speed` page units per second along the stroke, the pen travelling between
 * strokes. Every frame sends the points of its 1/30 s, then captures.
 */
async function write(take, strokes, { speed = 600, gap = 0.12, m = null, hold = 0 } = {}) {
  m = m ?? (await mapping());
  const at = (x, y) => ({ x: m.l + m.ox + x * m.k, y: m.t + m.oy + y * m.k });
  for (const flat of strokes) {
    const pts = [];
    for (let i = 0; i < flat.length; i += 3) pts.push({ ...at(flat[i], flat[i + 1]), p: flat[i + 2], u: [flat[i], flat[i + 1]] });
    // the pen travels to the start of the stroke
    const d = take.pen ? Math.hypot(pts[0].x - take.pen.x, pts[0].y - take.pen.y) : 0;
    if (take.pen && d > 2) await travel(take, pts[0], Math.min(0.4, gap + d / 1600));
    // length along the stroke (page units)
    const len = [0];
    for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].u[0] - pts[i - 1].u[0], pts[i].u[1] - pts[i - 1].u[1]));
    const total = len[len.length - 1];
    const dur = Math.max(1 / FPS, total / speed);
    await mouse("mouseMoved", pts[0].x, pts[0].y, { buttons: 0, force: 0 });
    await mouse("mousePressed", pts[0].x, pts[0].y, { button: "left", buttons: 1, clickCount: 1, force: pts[0].p });
    take.pen = { x: pts[0].x, y: pts[0].y, down: true };
    let i = 1;
    const frames = Math.max(1, Math.round(dur * FPS));
    for (let f = 1; f <= frames; f++) {
      const reach = total * (f / frames);
      while (i < pts.length && len[i] <= reach + 1e-6) {
        await mouse("mouseMoved", pts[i].x, pts[i].y, { button: "left", buttons: 1, force: pts[i].p });
        take.pen = { x: pts[i].x, y: pts[i].y, down: true };
        i++;
      }
      if (f === frames && hold) await sleep(hold);
      if (f < frames) await take.frame();
    }
    const e = pts[pts.length - 1];
    await mouse("mouseReleased", e.x, e.y, { button: "left", buttons: 0, clickCount: 1, force: 0 });
    // the pen touched the screen during this frame; it lifts after it
    take.pen = { x: e.x, y: e.y, down: true };
    await take.frame();
    take.pen = { x: e.x, y: e.y, down: false };
  }
}

/** Tap with the pen on a window point (a button), after moving there. */
async function tapAt(take, x, y, { sec = 0.45, after = null } = {}) {
  await travel(take, { x, y }, sec);
  await mouse("mouseMoved", x, y, { buttons: 0, force: 0 });
  await mouse("mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1, force: 0.5 });
  take.pen = { x, y, down: true };
  await take.frame({ tap: true });
  await mouse("mouseReleased", x, y, { button: "left", buttons: 0, clickCount: 1, force: 0 });
  take.pen = { x, y, down: false };
  if (after) await after();
}

/** The middle of an element (window coordinates). */
async function centre(selector) {
  return ev((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`no ${sel}`);
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
}

// ---------------------------------------------------------------- Obsidian

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
    await ev(() => document.querySelectorAll(".modal-container .modal-close-button").forEach((b) => b.click()));
    await sleep(250);
    if ((await ev(() => document.querySelectorAll(".modal-container").length)) > 0) await page.keyboard.press("Escape");
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

async function openFile(p, type) {
  await ev(async ({ p, type }) => {
    const leaf = app.workspace.getLeaf(false);
    await leaf.setViewState({ type, state: { file: p }, active: true });
    app.workspace.setActiveLeaf(leaf, { focus: true });
  }, { p, type });
  await waitView(type, p);
}

/** One tab only, sidebars closed, no notices. */
async function tidyWorkspace() {
  await ev(() => {
    const leaves = [];
    app.workspace.iterateRootLeaves((l) => leaves.push(l));
    const keep = app.workspace.getMostRecentLeaf();
    for (const l of leaves) if (l !== keep) l.detach();
    app.workspace.leftSplit.collapse();
    app.workspace.rightSplit.collapse();
    document.querySelectorAll(".notice").forEach((n) => n.remove());
  });
}

async function tool(patch) {
  await ev((patch) => __t.surface().setTools(patch), patch);
}

async function recognise(...areas) {
  await ev(() => __t.plugin().ocr.cache.clear());
  await mock({ reset: true, responses: [], fallback: null, pool: areas });
}

async function remove(...paths) {
  await ev(async (paths) => {
    for (const p of paths) {
      const f = app.vault.getAbstractFileByPath(p);
      if (f) await app.vault.delete(f, true);
    }
  }, paths);
  await sleep(300);
}

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

let idn = 0;
const sid = (p) => `${p}${(++idn).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Put strokes on the open page at once (what was written before the scene). */
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
const rect = (x, y, w, h, extra = {}) => ({ id: sid("r"), pts: flat([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]), poly: true, closed: true, ...extra });
const handBox = (x, y, s, seed) => ({ pts: handLine([[x, y], [x + s, y + 0.5], [x + s - 0.5, y + s], [x + 0.5, y + s - 0.5], [x, y + 1.5]], { seed, step: 1.5, rounds: 0, wobble: 0.5 }) });

// ---------------------------------------------------------------- scenes

const scenes = {};

scenes.setup = async () => {
  console.log("▶ setup");
  const mobile = await ev(() => app.isMobile);
  if (!mobile) {
    // the tablet layout of Obsidian (as on a Boox); Obsidian reloads its window
    await ev(() => setTimeout(() => app.emulateMobile(true), 50));
    await sleep(9000);
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("index.html"));
    cdp = await page.context().newCDPSession(page);
  }
  await installHelpers();
  await setWindow(WIN.w, WIN.h);
  await setSettings({ setupDone: true, azureEndpoint: MOCK, azureKey: "test-key", azureApi: "auto", azureDetectedApi: "", einkMode: "on", lowLatency: "off", fit: "width", queue: [], pageLocation: "fixed", folder: "Ink", inkSubfolder: "Attachments", askForPaper: false, askForPageName: false, holdToShape: true, scribbleErase: true, textViewMode: "reading" });
  await ev(() => {
    app.vault.setConfig("alwaysUpdateLinks", true);
    document.getElementById("ink-promo-css")?.remove();
    const style = document.head.createEl("style", { attr: { id: "ink-promo-css" } });
    // no notices or status bar in the footage; no text cursor blinking
    // (and no empty band for the Android status bar at the top: the device frame is drawn around the window)
    style.textContent = "body { --safe-area-inset-top: 0px !important; --safe-area-inset-bottom: 0px !important; } .notice-container, .status-bar { display: none !important; } * { caret-color: transparent !important; }";
  });
  await closeModals();
  await tidyWorkspace();
  await mock({ reset: true, mode: "ok", responses: [], fallback: null });
  console.log("  ", await ev(() => ({ mobile: app.isMobile, tablet: document.body.classList.contains("is-tablet"), w: innerWidth, h: innerHeight, dpr: devicePixelRatio })));
};

/** Wide ruled paper: lines at y = 140 + 56k, the margin at x = 112. */
const S = 56;
const L = (k) => S * 2.5 + S * k;
const X0 = 138;
const SIZE = 2.0;
const hw = (text, x, y, seed, opts = {}) => handwriting(text, { x, y, size: SIZE, seed, ...opts }).strokes;
const asInk = (strokes, extra = {}) => strokes.map((pts) => ({ pts, ...extra }));
const paper = (style, color = "white", spacing = "normal") => ({ kind: "paper", paper: { style, spacing, color, orientation: "portrait" } });

const NOTES = { name: "Garden app", ink: "Ink/Attachments/Garden app.ink.md", text: "Ink/Garden app.md" };

/**
 * Writing: a page of meeting notes; the pen writes the last list item and
 * ticks a task, then taps "Text".
 */
scenes.write = async () => {
  console.log("▶ write: handwriting on the ink page");
  await remove(NOTES.ink, NOTES.text);
  fs.mkdirSync(path.join(VAULT, "People"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "People", "Anna.md"), "# Anna\n\nDesigner of the garden app.\n");
  await sleep(600);
  await newInkPage(NOTES.name);
  await ev((bg) => __t.surface().setBackground(bg), paper("lined", "white", "wide"));
  await tool({ tool: "pen", pen: "fountain", color: "#000000" });

  // what is on the page already
  const ink = [
    ...asInk(hw("Kickoff meeting", X0, L(2) - 6, 11, { size: 3.3 })),
    ...asInk(hw("Met with [[Anna]] and Tom.", X0, L(4) - 4, 21)),
    ...asInk(hw("- budget: 12k", X0, L(5) - 4, 31)),
  ];
  // two tasks: a box drawn in front of the line
  const boxes = [L(7), L(8)].map((y, i) => handBox(X0 + 2, y - 30, 28, 40 + i));
  ink.push(...boxes, ...asInk(hw("send the mockups", X0 + 52, L(7) - 4, 41)), ...asInk(hw("book a room", X0 + 52, L(8) - 4, 42)));
  // a small flow: three boxes with handwritten labels and attached arrows
  const y0 = L(10) - 10;
  const flow = [
    { x: X0, w: 200, label: "Idea" },
    { x: X0 + 290, w: 220, label: "Sketch" },
    { x: X0 + 600, w: 200, label: "Beta", fill: "#d3f9d8" },
  ].map((b) => ({ ...b, id: sid("box") }));
  const shapes = flow.map((b) => rect(b.x, y0, b.w, 104, { id: b.id, ...(b.fill ? { fill: b.fill } : {}) }));
  for (const b of flow) {
    const lw = handwriting(b.label, { size: SIZE * 1.1, seed: b.x }).width;
    shapes.push(...asInk(hw(b.label, b.x + (b.w - lw) / 2, y0 + 66, b.x, { size: SIZE * 1.1 })));
  }
  for (const i of [0, 1]) shapes.push({ pts: flat([[flow[i].x + flow[i].w, y0 + 52], [flow[i + 1].x, y0 + 52]]), poly: true, arrow: true, from: flow[i].id, to: flow[i + 1].id });
  await addInk([...ink, ...shapes]);
  await sleep(1200);

  const take = new Take("write");
  const m = await mapping();
  const at = (x, y) => ({ x: m.l + m.ox + x * m.k, y: m.t + m.oy + y * m.k });
  take.pen = { ...at(X0 + 10, L(6) - 40), down: false };
  await take.frame();
  take.hold(5);
  take.mark("writeStart");
  await write(take, hw("- launch in May", X0, L(6) - 4, 33), { speed: 760, m });
  take.mark("writeEnd");
  // tick the second task (a big tick, the way a hand ticks a box)
  const bx = X0 + 2;
  const by = L(8) - 30;
  await write(take, [handLine([[bx + 3, by + 11], [bx + 13, by + 25], [bx + 40, by - 14]], { seed: 9, step: 1.2, rounds: 0 })], { speed: 380, m });
  take.mark("tickEnd");
  take.hold(6);
  // flip to the text page
  await recognise(["Kickoff meeting", "Met with [[Anna]] and Tom.", "- budget: 12k", "- launch in May", "D send the mockups", "D book a room", "Idea Sketch Beta"], ["Beta"], ["Idea", "Sketch", "Beta"]);
  const btn = await centre(".workspace-leaf.mod-active .ink-tb-text");
  take.mark("tapText");
  await tapAt(take, btn.x, btn.y, { sec: 0.5 });
  take.hold(2);
  take.save({ button: btn });

  // the text page
  await waitView("markdown", NOTES.text);
  await ev(async () => __t.waitFor(() => document.querySelector(".workspace-leaf.mod-active .ink-figure canvas"), 10000, "figure").catch(() => null));
  await sleep(1500);
  console.log((await ev((p) => __t.read(p), NOTES.text)).replace(/^/gm, "    | "));
  console.log("    mock saw:", JSON.stringify((await (await fetch(`${MOCK}/__stats`)).json()).lastImages.map((i) => ({ lines: i.lines, texts: i.texts }))));
  const text = new Take("text");
  text.pen = { x: btn.x, y: btn.y, down: false };
  await text.frame();
  text.hold(FPS * 4);
  text.save();
};

/** A hand-drawn ellipse (circling a word, a lasso loop). */
function ellipse(cx, cy, rx, ry, turns = 1.08, start = -2.6) {
  const pts = [];
  for (let i = 0; i <= 48 * turns; i++) {
    const a = start + (i / 48) * Math.PI * 2;
    pts.push([cx + rx * Math.cos(a) * (1 + 0.03 * Math.sin(i / 5)), cy + ry * Math.sin(a)]);
  }
  return pts;
}

/** Points every few units along a polyline (pressure 0.5). */
function along(corners, step = 6) {
  const out = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const [ax, ay] = corners[i - 1];
    const [bx, by] = corners[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/** Tap a toolbar button (or any element) with the pen. */
async function tapEl(take, selector, opts = {}) {
  const c = await centre(selector);
  await tapAt(take, c.x, c.y, opts);
  return c;
}

const MERMAID = `flowchart TD
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

/**
 * Diagrams: a Mermaid diagram from the object library is placed as ink with a
 * tap; then the lasso moves one of its shapes and the arrows follow.
 */
scenes.diagram = async () => {
  console.log("▶ diagram: Mermaid as ink, the lasso moves a shape");
  fs.rmSync(path.join(VAULT, "Ink libraries", "Mermaid"), { recursive: true, force: true });
  await remove("Ink/Attachments/Smart garden.ink.md", "Ink/Smart garden.md");
  fs.mkdirSync(path.join(VAULT, "Projects"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Projects", "Watering logic.md"), "What the controller does every hour:\n\n```mermaid\n" + MERMAID + "\n```\n");
  await sleep(1200);
  await openFile("Projects/Watering logic.md", "markdown");
  await tidyWorkspace();
  await ev(() => {
    const ed = app.workspace.activeEditor.editor;
    ed.setCursor(ed.offsetToPos(ed.getValue().indexOf("subgraph Watering")));
  });
  await ev(() => app.commands.executeCommandById("ink-notebook:add-mermaid"));
  await page.waitForSelector(".ink-mermaid-modal .ink-mermaid-code", { timeout: 5000 });
  await page.waitForFunction(() => /shapes/.test(document.querySelector(".ink-mermaid-status")?.textContent ?? ""), null, { timeout: 5000 });
  await page.click(".ink-mermaid-modal button.mod-cta");
  await sleep(800);
  await closeModals();

  await newInkPage("Smart garden");
  await ev((bg) => __t.surface().setBackground(bg), paper("dots"));
  await ev(() => app.commands.executeCommandById("ink-notebook:object-library"));
  const panel = ".workspace-leaf.mod-active .ink-library-panel";
  await page.click(`${panel} .ink-library-source[aria-label='Mermaid']`);
  await page.waitForSelector(`${panel} .ink-library-tile[aria-label='Watering logic']`, { timeout: 5000 });
  await sleep(800);

  const take = new Take("diagram");
  const tile = await centre(`${panel} .ink-library-tile[aria-label='Watering logic']`);
  take.pen = { x: tile.x - 60, y: tile.y + 140, down: false };
  await take.frame();
  take.hold(4);
  take.mark("tapTile");
  await tapAt(take, tile.x, tile.y, { sec: 0.4 });
  await take.frame();
  take.hold(3);
  // the panel folds away while placing: tap the page where the diagram goes
  const m = await mapping();
  const vis = await ev(() => {
    const s = __t.surface();
    const r = s.el.getBoundingClientRect();
    const p = document.querySelector(".workspace-leaf.mod-active .ink-library-panel");
    const pr = p && !p.hidden ? p.getBoundingClientRect() : null;
    return { l: r.left, r: r.right, t: r.top, b: r.bottom, panel: pr ? { l: pr.left, t: pr.top, b: pr.bottom, folded: p.classList.contains("is-folded") } : null };
  });
  console.log("   visible:", JSON.stringify(vis));
  const place = { x: 500, y: 640 };
  const sp = { x: m.l + m.ox + place.x * m.k, y: m.t + m.oy + place.y * m.k };
  take.mark("place");
  await tapAt(take, sp.x, sp.y, { sec: 0.45 });
  await sleep(600);
  await take.frame();
  take.mark("placed");
  take.hold(10);
  // close the library (choosing a tool stops placing)
  await tapEl(take, `${panel} .ink-library-close`, { sec: 0.4 });
  await sleep(300);
  await take.frame();
  take.hold(3);
  await tapEl(take, ".workspace-leaf.mod-active .ink-tool-lasso", { sec: 0.4 });
  await sleep(200);
  await take.frame();
  take.hold(2);
  // where is "Soil dry?" (page units)
  const box = await ev(() => {
    const p = __t.surface().page;
    const t = p.texts.find((t) => /Soil dry/.test(t.text));
    const st = p.strokes.find((s) => s.id === t.container);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < st.pts.length; i += 3) {
      x0 = Math.min(x0, st.pts[i]); x1 = Math.max(x1, st.pts[i]);
      y0 = Math.min(y0, st.pts[i + 1]); y1 = Math.max(y1, st.pts[i + 1]);
    }
    return { x0, y0, x1, y1 };
  });
  console.log("   soil dry:", JSON.stringify(box));
  const cx = (box.x0 + box.x1) / 2;
  const cy = (box.y0 + box.y1) / 2;
  // a lasso loop around it
  take.mark("lasso");
  const loop = ellipse(cx, cy, (box.x1 - box.x0) / 2 + 26, (box.y1 - box.y0) / 2 + 22, 1.12, Math.PI * 0.95);
  await write(take, [flat(loop)], { speed: 900, m });
  await sleep(300);
  await take.frame();
  take.hold(8);
  // drag it to the left: the arrows follow
  take.mark("drag");
  const dx = -170;
  const drag = along([[cx, cy], [cx + dx * 0.5, cy + 8], [cx + dx, cy + 4]], 4);
  await write(take, [flat(drag, 0.5)], { speed: 260, m });
  await sleep(300);
  await take.frame();
  take.mark("dropped");
  take.hold(10);
  // tap beside it: the selection goes away
  await tapAt(take, m.l + m.ox + 130 * m.k, m.t + m.oy + 980 * m.k, { sec: 0.4 });
  await sleep(200);
  await take.frame();
  take.hold(12);
  take.save();
  await tool({ tool: "pen" });
};

/** A PDF handout: the highlighter, a circle and a note in the margin. */
scenes.pdf = async () => {
  console.log("▶ pdf: annotate a PDF");
  await remove("Ink/Attachments/Companion planting (annotated).ink.md", "Ink/Companion planting (annotated).md", "Docs/Companion planting.pdf");
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
    let cur = "";
    for (const w of t.split(" ")) {
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
  await tool({ tool: "pen", pen: "fountain", color: "#000000" });
  await sleep(1500);
  const k = await ev(() => __t.surface().page.w / 595);
  const P = (x, y) => [x * k, (842 - y) * k];
  const span = (phrase) => {
    const l = lines.find((l) => l.t.includes(phrase));
    const x0 = l.x + l.font.widthOfTextAtSize(l.t.slice(0, l.t.indexOf(phrase)), l.size);
    const x1 = x0 + l.font.widthOfTextAtSize(phrase, l.size);
    return { x0, x1, y: l.y, size: l.size };
  };

  const take = new Take("pdf");
  const m = await mapping();
  const toScreen = (x, y) => ({ x: m.l + m.ox + x * m.k, y: m.t + m.oy + y * m.k });
  const h1 = span("Basil planted next to tomatoes keeps whiteflies away");
  const [hx0, hy] = P(h1.x0 - 1, h1.y + 3.5);
  const [hx1] = P(h1.x1 + 1, h1.y);
  take.pen = { ...toScreen(hx0 + 60, hy + 120), down: false };
  await take.frame();
  take.hold(4);
  // the highlighter
  take.mark("marker");
  await tapEl(take, ".workspace-leaf.mod-active .ink-tool-marker", { sec: 0.4 });
  await take.frame();
  await write(take, [handLine([[hx0, hy], [hx1, hy - 1]], { seed: 401, wobble: 0.5 })], { speed: 1300, m });
  take.mark("markerEnd");
  take.hold(3);
  // back to the pen, in red: circle "fennel", a note in the margin
  await tapEl(take, ".workspace-leaf.mod-active .ink-tool-pen", { sec: 0.35 });
  await tool({ tool: "pen", pen: "fountain", color: "#c62828" });
  await take.frame();
  const f = span("fennel");
  const [fx0, fy] = P(f.x0, f.y + 4);
  const [fx1] = P(f.x1, f.y);
  take.mark("circle");
  await write(take, [handLine(ellipse((fx0 + fx1) / 2, fy, (fx1 - fx0) / 2 + 14, 19), { seed: 406, step: 1.5 })], { speed: 900, m });
  take.hold(2);
  take.mark("note");
  const noteX = 455 * k;
  await write(take, hw("try this!", noteX, hy + 60, 402, { size: 1.9 }), { speed: 800, m });
  const hl = lines.find((l) => l.t.includes("Basil planted"));
  const lineEnd = P(hl.x + hl.font.widthOfTextAtSize(hl.t, hl.size), hl.y)[0];
  // an arrow from the note to the sentence
  const [ax, ay] = [noteX - 6, hy + 36];
  const [bx, by] = [lineEnd + 10, hy - 2];
  const a = Math.atan2(by - ay, bx - ax);
  const head = (da) => [bx - 18 * Math.cos(a + da), by - 18 * Math.sin(a + da)];
  await write(take, [handLine([[ax, ay], [(ax + bx) / 2 + 6, (ay + by) / 2 + 6], [bx, by]], { seed: 405, step: 1.5 }), handLine([head(0.5), [bx, by], head(-0.5)], { seed: 406, step: 1.2, rounds: 0 })], { speed: 900, m });
  take.mark("noteEnd");
  take.hold(4);
  await travel(take, { x: take.pen.x + 40, y: take.pen.y + 120 }, 0.5);
  take.hold(10);
  take.save();
};

/** The notebook's pages: different paper, and the page overview. */
scenes.pages = async () => {
  console.log("▶ pages: overview and paper");
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
  const H = (text, x, y, seed, opts = {}) => asInk(hw(text, x, y, seed, { size: 1.4, ...opts }), opts.color ? { color: opts.color } : {});
  const roundRect = (x, y, w, h, r) => {
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
  };
  // 2: squared paper, a sketch of the app's screens
  await newPage(paper("grid", "ivory"));
  const sketch = [...H("Screens", 80, 150, 61, { size: 2.3 })];
  ["Home", "Plant", "Settings"].forEach((name, i) => {
    const x = 70 + i * 300;
    const y = 230;
    sketch.push({ pts: handLine(roundRect(x, y, 240, 470, 30), { seed: 70 + i, step: 2 }) });
    sketch.push({ pts: handLine([[x + 16, y + 70], [x + 224, y + 71]], { seed: 80 + i }) });
    sketch.push(...H(name, x + 22, y + 52, 90 + i, { size: 1.05 }));
    if (i === 0) {
      for (let r = 0; r < 4; r++) {
        const ry = y + 110 + r * 80;
        sketch.push({ pts: handLine(ellipse(x + 50, ry + 20, 20, 20, 1.02), { seed: 100 + r, step: 1.5 }) });
        sketch.push({ pts: handLine([[x + 86, ry + 12], [x + 210, ry + 12]], { seed: 110 + r }) });
        sketch.push({ pts: handLine([[x + 86, ry + 32], [x + 170, ry + 33]], { seed: 120 + r }) });
      }
    } else if (i === 1) {
      sketch.push({ pts: handLine(ellipse(x + 120, y + 190, 80, 80, 1.02), { seed: 130, step: 2 }) });
      sketch.push(...H("photo", x + 84, y + 196, 131, { size: 1.05 }));
      for (let r = 0; r < 3; r++) sketch.push({ pts: handLine([[x + 30, y + 320 + r * 36], [x + 210 - r * 30, y + 321 + r * 36]], { seed: 140 + r }) });
      sketch.push({ pts: handLine(roundRect(x + 40, y + 410, 160, 40, 18), { seed: 150, step: 2 }) });
      sketch.push(...H("Water", x + 82, y + 438, 151, { size: 1.0 }));
    } else {
      for (let r = 0; r < 4; r++) {
        const ry = y + 110 + r * 80;
        sketch.push({ pts: handLine([[x + 24, ry + 22], [x + 130, ry + 22]], { seed: 160 + r }) });
        sketch.push({ pts: handLine(roundRect(x + 150, ry + 6, 66, 32, 16), { seed: 170 + r, step: 1.5 }) });
        sketch.push({ pts: handLine(ellipse(x + (r % 2 ? 166 : 200), ry + 22, 12, 12, 1.02), { seed: 180 + r, step: 1.2 }) });
      }
    }
    sketch.push(...H(name, x + 70, y + 530, 190 + i));
  });
  sketch.push(...H("tap a plant", 600, 820, 210, { color: "#c62828" }));
  await addInk(sketch);
  // 3: dotted paper, interview notes
  await newPage(paper("dots"));
  const notes = [...H("User interviews", 70, 160, 220, { size: 2.3 })];
  ["Maria - balcony garden, forgets to water", "Jonas - wants reminders on his watch", "Lea - likes the plant photos", "Sam - has 40 plants (!)"].forEach((t, i) => notes.push(...H(t, 70, 270 + i * 60, 230 + i)));
  notes.push(...H("-> reminders first!", 70, 560, 240, { color: "#c62828" }));
  await addInk(notes);
  // 4: Cornell notes
  await newPage(paper("cornell"));
  const LN = (k) => 110 + 44 * k;
  const corn = [...H("Sensors", 30, LN(2), 250, { color: "#1565c0" }), ...H("Battery", 30, LN(6), 251, { color: "#1565c0" })];
  [[2, "soil moisture and light"], [3, "one per pot, about 8 each"], [4, "Bluetooth, no hub needed"], [6, "two AA cells, 6 months"], [7, "warn when it gets low"]].forEach(([k, t], i) => corn.push(...H(t, 300, LN(k), 260 + i)));
  corn.push(...H("One sensor per pot is enough.", 40, 1200, 270));
  await addInk(corn);
  // 5: a checklist
  await newPage(paper("checklist"));
  const list = [...H("Launch checklist", 70, LN(0) - 8, 280, { size: 2.1 })];
  ["app store texts", "screenshots", "privacy policy", "beta feedback"].forEach((t, i) => list.push(...H(t, 72, LN(i + 2) - 10, 290 + i)));
  list.push({ pts: handLine([[37, LN(2) - 30], [44, LN(2) - 22], [58, LN(2) - 44]], { seed: 300, step: 1.2, rounds: 0 }), width: 2.2 });
  await addInk(list);
  // 6: music staff
  await newPage(paper("music"));
  await ev(() => __t.surface().goTo(0));
  await sleep(800);

  const take = new Take("pages");
  const label = await centre(".workspace-leaf.mod-active .ink-tb-pagelabel");
  take.pen = { x: label.x - 80, y: label.y + 260, down: false };
  await take.frame();
  take.hold(3);
  take.mark("tapPages");
  await tapAt(take, label.x, label.y, { sec: 0.4 });
  await page.waitForSelector(".modal.ink-pages-modal .ink-page-canvas", { timeout: 5000 });
  await sleep(1500);
  await travel(take, { x: label.x - 200, y: label.y + 420 }, 0.5);
  await take.frame();
  take.mark("overview");
  take.hold(FPS * 2);
  take.save();
  await closeModals();

  // the paper picker
  const pick = new Take("paper");
  await ev(() => void __t.view().changePaper());
  await page.waitForSelector(".modal.ink-paper-picker", { timeout: 5000 });
  await sleep(800);
  pick.pen = { x: 420, y: 700, down: false };
  await pick.frame();
  pick.hold(6);
  for (const style of ["dots", "grid", "cornell"]) {
    await tapEl(pick, `.modal.ink-paper-picker .ink-paper-card[data-style="${style}"]`, { sec: 0.35 });
    await sleep(300);
    await pick.frame();
    pick.hold(8);
  }
  pick.save();
  await closeModals();
};

const order = ["setup", "write", "diagram", "pdf", "pages"];
const run = only ? ["setup", ...only.split(",")] : order;
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
