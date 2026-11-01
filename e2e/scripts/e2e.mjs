// End-to-end test of Ink Notebook inside a real Obsidian, with pen input sent
// through the Chrome DevTools protocol (pointerType "pen" with pressure) and a
// fake Azure server that really looks at the handwriting images.
import { chromium } from "playwright-core";
import fs from "fs";
import http from "http";
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
// ---- a fake arXiv (API + PDFs) and Hugging Face Papers, for the "papers" step
const PAPERS = "http://127.0.0.1:8769";
const paperRequests = [];
let paperPdf = new Uint8Array();
const xml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const SEARCH_RESULTS = [
  { id: "2401.00001v2", title: "Attention Is All You Need: Again", authors: ["Ada Lovelace", "Alan Turing", "Grace Hopper", "Edsger Dijkstra"], summary: "We revisit attention for <e-ink> tablets. ".repeat(12) },
  { id: "2401.00002v1", title: "Handwriting on Paper", authors: ["Donald Knuth"], summary: "A short abstract." },
];
function atom(entries, total) {
  const entry = (p) => `<entry>
    <id>http://arxiv.org/abs/${p.id}</id>
    <title>${xml(p.title)}</title>
    <link href="${PAPERS}/abs/${p.id}" rel="alternate" type="text/html"/>
    <link href="${PAPERS}/pdf/${p.id}" rel="related" type="application/pdf" title="pdf"/>
    <summary>${xml(p.summary)}</summary>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <published>2024-01-02T00:00:00Z</published>
    <arxiv:primary_category term="cs.LG"/>
    ${p.authors.map((a) => `<author><name>${xml(a)}</name></author>`).join("")}
  </entry>`;
  return `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <opensearch:totalResults>${total}</opensearch:totalResults>
  ${entries.map(entry).join("\n")}
</feed>`;
}
const paperServer = http.createServer((req, res) => {
  const url = new URL(req.url, PAPERS);
  paperRequests.push(url.pathname + url.search);
  if (url.pathname === "/api/query") {
    const id = url.searchParams.get("id_list");
    const entries = id ? SEARCH_RESULTS.filter((p) => p.id.startsWith(id)) : SEARCH_RESULTS;
    res.writeHead(200, { "content-type": "application/atom+xml" });
    res.end(atom(entries, entries.length));
  } else if (url.pathname === "/daily_papers") {
    const p = Number(url.searchParams.get("p") ?? 0);
    const n = p === 0 ? 20 : p === 1 ? 3 : 0;
    const items = Array.from({ length: n }, (_, i) => {
      const k = p * 20 + i + 1;
      return { paper: { id: `2610.${10000 + k}`, title: `Popular paper ${k}`, summary: `Why paper ${k} is popular. `.repeat(10), authors: [{ name: "Ada Lovelace" }, { name: "Alan Turing" }], publishedAt: "2026-10-20T00:00:00.000Z", upvotes: 300 - k } };
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(items));
  } else if (url.pathname.startsWith("/pdf/")) {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end(Buffer.from(paperPdf));
  } else {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => paperServer.listen(8769, "127.0.0.1", r));

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
  await setSettings({ setupDone: true, azureEndpoint: MOCK, azureKey: "test-key", azureApi: "auto", azureDetectedApi: "", einkMode: "off", queue: [], pageLocation: "fixed", folder: "Ink", inkSubfolder: "Attachments", askForPaper: false, askForPageName: false, holdToShape: true, scribbleErase: true });
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
  await setSettings({ askForPageName: true });
  await ev(() => app.commands.executeCommandById("ink-notebook:new-page"));
  // you name the page: the date and time is filled in, type over it
  const suggested = await ev(async () => {
    const input = await __t.waitFor(() => document.querySelector(".modal.ink-modal input.ink-wide-input"), 5000, "name prompt");
    const was = input.value;
    input.value = "Lecture notes";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return was;
  });
  await setSettings({ askForPageName: false });
  state.drawing = await waitView("ink-notebook");
  check("the new page opens in the ink view", /^Ink\/Attachments\/.+\.ink\.md$/.test(state.drawing), state.drawing);
  check("a new page gets the name you type (the date and time is suggested)", /^Ink \d{4}-\d\d-\d\d \d{4}$/.test(suggested) && state.drawing === "Ink/Attachments/Lecture notes.ink.md", `${suggested} → ${state.drawing}`);
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
  // wait for the new notebook (an ink page may be open already)
  const p = await waitView("ink-notebook", "Ink/Attachments/Slides (annotated).ink.md");
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

steps.papers = async () => {
  console.log("\n▶ papers from arXiv");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 3; i++) doc.addPage([612, 792]).drawText(`Paper page ${i}`, { x: 60, y: 700, size: 28, font });
  paperPdf = await doc.save();
  await ev((base) => Object.assign(__t.plugin().papers.endpoints, { arxivApi: `${base}/api/query`, arxivSite: base, popular: `${base}/daily_papers` }), PAPERS);
  await setSettings({ einkMode: "on" });
  await setWindow(702, 936);
  const cards = () => ev(() => document.querySelectorAll(".ink-arxiv-card").length);
  const listInfo = () =>
    ev(() => ({
      heading: document.querySelector(".ink-arxiv-title")?.textContent,
      sub: document.querySelector(".ink-arxiv-sub")?.textContent,
      cards: [...document.querySelectorAll(".ink-arxiv-card")].map((c) => ({
        title: c.querySelector(".ink-arxiv-card-title")?.textContent,
        meta: c.querySelector(".ink-arxiv-card-meta")?.textContent,
        button: c.querySelector(".ink-arxiv-import")?.textContent,
        abstract: !!c.querySelector(".ink-arxiv-card-abstract"),
      })),
      more: !!document.querySelector(".ink-arxiv-more:not([hidden])"),
    }));
  const waitCards = (n, label) => ev(async ({ n, label }) => __t.waitFor(() => document.querySelectorAll(".ink-arxiv-card").length === n && !document.querySelector(".ink-arxiv-status span"), 15000, label), { n, label });

  // the ribbon button opens the search, showing the most popular papers
  await page.click('.side-dock-ribbon-action[aria-label="Import a paper from arXiv"]', { timeout: 5000 });
  await waitCards(20, "popular papers");
  let info = await listInfo();
  check("with nothing searched the most popular papers are listed", info.heading === "Most popular papers" && info.cards.length === 20 && info.cards[0].title === "Popular paper 1" && info.cards[0].abstract && info.more, JSON.stringify({ ...info, cards: info.cards.slice(0, 2) }));
  check("each card shows title, authors, date and an Import button", /Ada Lovelace, Alan Turing/.test(info.cards[0].meta) && /2026-10-20/.test(info.cards[0].meta) && info.cards[0].button === "Import", JSON.stringify(info.cards[0]));
  await page.click(".ink-arxiv-card:nth-of-type(1) .ink-arxiv-card-abstract");
  await ev(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
  await shot("12-eink-arxiv-popular.png");
  await page.click(".ink-arxiv-more");
  await waitCards(23, "more popular papers");
  info = await listInfo();
  check("Load more adds the next papers (and goes away at the end)", info.cards.length === 23 && !info.more, JSON.stringify({ n: info.cards.length, more: info.more }));

  // search
  await page.fill(".ink-arxiv-input", '"attention" transformer');
  await page.keyboard.press("Enter");
  await waitCards(2, "search results");
  info = await listInfo();
  check("a search lists the papers arXiv finds", /^Results for/.test(info.heading) && info.cards[0].title === "Attention Is All You Need: Again" && /et al\./.test(info.cards[0].meta) && /2 papers/.test(info.sub), JSON.stringify(info));
  check("the search is sent to the arXiv API", paperRequests.some((r) => r.includes("search_query=all%3A%22attention%22%20AND%20all%3Atransformer")), paperRequests.join("\n"));
  await shot("13-eink-arxiv-search.png");

  // import: the PDF becomes the pages of a new ink page
  await page.click(".ink-arxiv-card:nth-of-type(1) .ink-arxiv-import");
  const name = "Attention Is All You Need - Again";
  const drawing = await waitView("ink-notebook", `Papers/Attachments/${name}.ink.md`).catch((e) => String(e));
  check("Import opens the paper as an ink page in the papers folder", drawing === `Papers/Attachments/${name}.ink.md`, drawing);
  const made = await ev(async (name) => {
    const s = __t.surface();
    await __t.waitFor(() => __t.plugin().images.pdfPage(`Papers/Attachments/${name}.pdf`, 1, 100), 8000, "pdf page").catch(() => null);
    const text = app.vault.getAbstractFileByPath(`Papers/${name}.md`);
    return {
      modal: document.querySelectorAll(".ink-arxiv-modal").length,
      pages: s.document.pages.map((p) => p.bg),
      md: text ? await app.vault.read(text) : null,
      fm: text ? app.metadataCache.getFileCache(text)?.frontmatter : null,
    };
  }, name);
  check("its pages are the pages of the downloaded PDF", made.pages.length === 3 && made.pages.every((bg, i) => bg.kind === "pdf" && bg.path === `Papers/Attachments/${name}.pdf` && bg.page === i + 1), JSON.stringify(made.pages));
  check(
    "the text page has the paper's title, authors, arXiv id and abstract",
    made.fm?.title === "Attention Is All You Need: Again" && made.fm?.authors?.length === 4 && made.fm?.arxiv === "2401.00001v2" && /> \[!abstract\]- Abstract\n> We revisit attention for &lt;e-ink> tablets/.test(made.md ?? ""),
    made.md,
  );
  check("the search closes after the import", made.modal === 0);
  await pen(word(120, 300, 260, 40));
  await sleep(300);
  check("you can write on the paper", (await ev(() => __t.surface().document.pages[0].strokes.length)) === 1);
  await shot("14-eink-paper.png");

  // importing the same paper again opens it
  const before = await ev(() => app.vault.getFiles().length);
  await ev(() => app.commands.executeCommandById("ink-notebook:import-arxiv"));
  await waitCards(20, "popular papers");
  await page.fill(".ink-arxiv-input", "https://arxiv.org/abs/2401.00001");
  await page.keyboard.press("Enter");
  await waitCards(1, "paper by link");
  info = await listInfo();
  check("a pasted arXiv link finds that paper", paperRequests.some((r) => r.includes("id_list=2401.00001")) && info.cards[0]?.title === "Attention Is All You Need: Again", JSON.stringify(info.cards));
  check("a paper imported before shows Open", info.cards[0]?.button === "Open", info.cards[0]?.button);
  await closeModals();
  await openFile(state.drawing, "ink-notebook");
  await waitView("ink-notebook", state.drawing);
  await ev(() => app.commands.executeCommandById("ink-notebook:import-arxiv"));
  await waitCards(20, "popular papers");
  await page.fill(".ink-arxiv-input", "2401.00001");
  await page.keyboard.press("Enter");
  await waitCards(1, "paper by id");
  await page.click(".ink-arxiv-card:nth-of-type(1) .ink-arxiv-import");
  const reopened = await waitView("ink-notebook", drawing);
  check("Open goes to its ink page without a second copy", reopened === drawing && (await ev(() => app.vault.getFiles().length)) === before, `${reopened} ${before}`);

  // from an ink page's Insert menu: the paper's pages are added to it
  await openFile(state.pdfInk, "ink-notebook");
  await waitView("ink-notebook", state.pdfInk);
  const n0 = await ev(() => __t.surface().document.pages.length);
  await ev(() => __t.plugin().openPaperSearch(__t.view()));
  await waitCards(20, "popular papers");
  check("from an ink page the button adds the pages", (await listInfo()).cards[1].button === "Add pages");
  await page.click(".ink-arxiv-card:nth-of-type(2) .ink-arxiv-import");
  const added = await ev(async (n0) => {
    await __t.waitFor(() => __t.surface().document.pages.length === n0 + 3, 15000, "added pages");
    const s = __t.surface();
    return { pages: s.document.pages.length, at: s.pageIndex, bg: s.document.pages[n0].bg };
  }, n0).catch((e) => ({ error: String(e) }));
  check("Pages of a paper from arXiv adds its pages to the open ink page", added.pages === n0 + 3 && added.at === n0 && added.bg?.path === "Ink/Attachments/Popular paper 2.pdf", JSON.stringify(added));
  await closeModals();
  await setSettings({ einkMode: "off" });
  await setWindow(820, 1180);
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

steps.notes = async () => {
  console.log("\n▶ ink pages for notes that exist, daily notes, matching names, choosing the folder");
  await closeModals();
  await setSettings({ askForPaper: false, pageLocation: "fixed" });

  // a daily note that is its own ink page (earlier versions made one when a note opened in a tab showing an ink page)
  const flipped = await ev(async () => {
    const p = __t.plugin();
    const fence = "\u0060\u0060\u0060";
    const ink = [
      "---", "ink-notebook: 1", "---", `${fence}ink-notebook`, "Handwritten pages", fence, "", "%%", `${fence}ink-data`,
      'H {"v":1,"regions":[],"handLinks":{}}',
      'P {"id":"pg0","w":1000,"h":1414,"bg":{"kind":"paper","paper":{"style":"lined","spacing":"normal","color":"white","orientation":"portrait"}}}',
      "S st1 b 000000 2 0 rA6mCQ4NDxgJGCQLYDQBwAEgEfABEguAAQIKC1McN10",
      fence, "%%", "",
    ].join("\n");
    if (!app.vault.getAbstractFileByPath("Days")) await app.vault.createFolder("Days");
    const f = await app.vault.create("Days/2026-01-02.md", ink);
    await app.vault.create("Days/Diary.md", "Yesterday: [[2026-01-02]]\n");
    await __t.sleep(800);
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(f);
    await __t.waitFor(() => leaf.view.inkFile, 8000, "ink view");
    await p.switcher.toText(leaf, f);
    await __t.waitFor(() => app.vault.getAbstractFileByPath("Days/Attachments/2026-01-02.ink.md"), 8000, "moved");
    const t = app.vault.getAbstractFileByPath("Days/2026-01-02.md");
    const link = app.metadataCache.getFirstLinkpathDest("2026-01-02", "Days/Diary.md")?.path;
    return { leaf: `${leaf.view.getViewType()} ${leaf.view.file?.path}`, drawing: p.pairs.drawingFor(t)?.path, strokes: (await __t.read("Days/Attachments/2026-01-02.ink.md")).split("\n").filter((l) => l.startsWith("S ")).length, diary: await __t.read("Days/Diary.md"), link };
  });
  check("flipping a note that is its own ink page gives Name.md and Attachments/Name.ink.md", flipped.leaf === "markdown Days/2026-01-02.md" && flipped.drawing === "Days/Attachments/2026-01-02.ink.md" && flipped.strokes > 0, JSON.stringify(flipped));
  check("links to its name stay and lead to the text page", flipped.diary === "Yesterday: [[2026-01-02]]\n" && flipped.link === "Days/2026-01-02.md", JSON.stringify(flipped));

  // ink pages whose names do not match are matched up (after asking)
  const matched = await ev(async () => {
    const p = __t.plugin();
    const ink = p.internals.serializeInkFile('---\nink-notebook: 1\nink-text: "[[Days/2026-01-03 (text)]]"\n---\n', { doc: { pages: [{ id: "pg1", w: 1000, h: 1414, bg: { kind: "paper", paper: { style: "lined", spacing: "normal", color: "white", orientation: "portrait" } }, strokes: [], texts: [], images: [], links: [], figures: [] }] }, meta: { regions: [], handLinks: {} } });
    await app.vault.create("Days/2026-01-03.md", ink);
    await app.vault.create("Days/2026-01-03 (text).md", '---\nink-drawing: "[[Days/2026-01-03]]"\n---\nTyped.\n\n%% ink-notebook:start %%\n%% ink-notebook:end v1 %%\n');
    await app.vault.create("Days/Links.md", "See [[2026-01-03 (text)]] and [[2026-01-03]].\n");
    await __t.sleep(1000);
    const job = p.matchUpPages();
    const dialog = await __t.waitFor(() => document.querySelector(".ink-confirm")?.innerText, 5000, "dialog");
    [...document.querySelectorAll(".ink-confirm button")].find((b) => b.textContent === "Rename").click();
    await job;
    await __t.sleep(800);
    const t = app.vault.getAbstractFileByPath("Days/2026-01-03.md");
    return { dialog: dialog.includes("Days/2026-01-03 (text).md → Days/2026-01-03.md"), drawing: t && p.pairs.drawingFor(t)?.path, text: t && (await app.vault.read(t)).includes("Typed."), links: await __t.read("Days/Links.md") };
  });
  check("matching up renames the pair and links lead to the text page", matched.dialog && matched.drawing === "Days/Attachments/2026-01-03.ink.md" && matched.text && matched.links === "See [[2026-01-03]] and [[2026-01-03]].\n", JSON.stringify(matched));

  // drawing on a note that exists
  const added = await ev(async () => {
    const p = __t.plugin();
    const f = await app.vault.create("Days/Meeting.md", "---\ntags: [meeting]\n---\n# Meeting\n\n- budget\n");
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(f);
    await __t.sleep(500);
    app.commands.executeCommandById("ink-notebook:add-ink-to-note");
    await __t.waitFor(() => leaf.view.getViewType() === "ink-notebook" && leaf.view.inkFile, 8000, "ink page");
    return { leaf: leaf.view.file?.path, text: await app.vault.read(f), drawing: p.pairs.drawingFor(f)?.path };
  });
  check(
    "a note gets an ink page next to it and keeps its text",
    added.leaf === "Days/Attachments/Meeting.ink.md" && added.drawing === added.leaf && /# Meeting\n\n- budget\n\n%% ink-notebook:start %%/.test(added.text) && added.text.includes("tags:"),
    JSON.stringify(added),
  );

  // a normal note opened in a tab that shows an ink page is shown as Markdown and left alone
  const foreign = await ev(async () => {
    const f = await app.vault.create("Days/Plain.md", "# Plain\n\nimportant text\n");
    const leaf = app.workspace.getMostRecentLeaf();
    await leaf.openFile(f);
    await __t.waitFor(() => leaf.view.getViewType() === "markdown", 5000, "markdown");
    await leaf.openFile(app.vault.getAbstractFileByPath("Welcome.md"));
    await __t.sleep(800);
    return { text: await app.vault.read(f) };
  });
  check("a note opened in a tab showing an ink page opens as Markdown and is not changed", foreign.text === "# Plain\n\nimportant text\n", JSON.stringify(foreign));

  // a note with the ink-notebook property and text in it
  const typed = await ev(async () => {
    const p = __t.plugin();
    const f = await app.vault.create("Days/Shopping.md", "---\nink-notebook: 1\n---\n# Shopping\n\n- milk\n");
    await __t.waitFor(() => app.metadataCache.getFileCache(f)?.frontmatter, 5000, "properties read");
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(f);
    const panel = await __t.waitFor(() => document.querySelector(".workspace-leaf.mod-active .ink-typed-note"), 5000, "panel");
    await leaf.view.save();
    const kept = (await app.vault.read(f)).includes("- milk");
    [...panel.querySelectorAll("button")].find((b) => b.textContent.startsWith("Keep the text")).click();
    await __t.waitFor(() => leaf.view.file?.path === "Days/Attachments/Shopping.ink.md" && leaf.view.inkFile, 8000, "ink page");
    const text = await app.vault.read(f);
    const fm = app.metadataCache.getFileCache(f)?.frontmatter ?? {};
    return { kept, text: text.includes("- milk"), fm: !("ink-notebook" in fm) && "ink-drawing" in fm, drawing: p.pairs.drawingFor(f)?.path };
  });
  check("a note with the ink-notebook property and text keeps its text and gets an ink page", typed.kept && typed.text && typed.fm && typed.drawing === "Days/Attachments/Shopping.ink.md", JSON.stringify(typed));

  // daily notes come with an ink page that opens to write on
  await setSettings({ dailyInk: "open" });
  const daily = await ev(async () => {
    const p = __t.plugin();
    const dn = app.internalPlugins.plugins["daily-notes"];
    if (!dn.enabled) await dn.enable();
    dn.instance.options = { folder: "Journal", format: "YYYY-MM-DD" };
    if (!app.vault.getAbstractFileByPath("Journal")) await app.vault.createFolder("Journal");
    const today = `Journal/${window.moment().format("YYYY-MM-DD")}.md`;
    app.commands.executeCommandById("daily-notes");
    const leaf = await __t.waitFor(() => app.workspace.getLeavesOfType("ink-notebook").find((l) => l.view.file?.path.startsWith("Journal/Attachments/") && l.view.inkFile), 10000, "daily ink page");
    const note = app.vault.getAbstractFileByPath(today);
    // opening it again makes no second ink page
    app.commands.executeCommandById("daily-notes");
    await __t.sleep(2500);
    const inkFiles = app.vault.getMarkdownFiles().filter((f) => f.path.startsWith("Journal/Attachments/")).length;
    // the command opens it on the ink page too
    await app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath("Welcome.md"));
    await __t.sleep(300);
    app.commands.executeCommandById("ink-notebook:open-today-ink");
    await __t.waitFor(() => __t.view()?.getViewType() === "ink-notebook" && __t.view().file?.path.startsWith("Journal/Attachments/"), 8000, "today");
    await dn.disable();
    return { leaf: leaf.view.file.path, drawing: note && p.pairs.drawingFor(note)?.path, inkFiles };
  });
  await setSettings({ dailyInk: "off" });
  check("a new daily note gets an ink page, which opens to write on", daily.leaf === daily.drawing && daily.inkFiles === 1, JSON.stringify(daily));

  // choosing the folder of a new page
  await setSettings({ pageLocation: "ask" });
  const asked = await ev(async () => {
    const p = __t.plugin();
    const job = p.switcher.createPage({ name: "Asked" });
    const input = await __t.waitFor(() => document.querySelector(".prompt-input"), 5000, "folder picker");
    input.value = "Projects/New one";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await __t.sleep(300);
    const offered = document.querySelector(".suggestion-item.is-selected")?.innerText;
    document.querySelector(".suggestion-item.is-selected").click();
    const r = await job;
    return { offered, text: r?.text.path, drawing: r?.drawing.path };
  });
  await setSettings({ pageLocation: "fixed" });
  check("asking for the folder offers a new one and puts the page there", asked.offered === "New folder: Projects/New one" && asked.text === "Projects/New one/Asked.md" && asked.drawing === "Projects/New one/Attachments/Asked.ink.md", JSON.stringify(asked));
  await closeModals();
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

steps.flowchart = async () => {
  console.log("\n▶ fill, flowcharts and object libraries");
  await setWindow(1100, 1180);
  // an Excalidraw library somewhere in the vault, and a new ink page
  const lib = {
    type: "excalidrawlib",
    version: 2,
    libraryItems: [
      {
        id: "srv",
        name: "Labelled box",
        status: "published",
        elements: [
          { id: "r", type: "rectangle", x: 0, y: 0, width: 200, height: 90, strokeColor: "#1971c2", backgroundColor: "#a5d8ff", fillStyle: "hachure", strokeWidth: 2, roundness: { type: 3 } },
          { id: "t", type: "text", x: 50, y: 32, width: 100, height: 25, text: "Server", originalText: "Server", fontSize: 20, textAlign: "center", containerId: "r", strokeColor: "#1971c2" },
        ],
      },
    ],
  };
  fs.mkdirSync(path.join(VAULT, "Libraries"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Libraries", "Servers.excalidrawlib"), JSON.stringify(lib));
  fs.mkdirSync(path.join(VAULT, "Flow", "Attachments"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Flow", "Attachments", "Flow.ink.md"), "---\nink-notebook: 1\n---\n");
  await sleep(1500);
  const file = "Flow/Attachments/Flow.ink.md";
  await openFile(file, "ink-notebook");
  await waitView("ink-notebook", file);
  await ev(() => app.commands.executeCommandById("ink-notebook:object-library"));
  const panel = ".workspace-leaf.mod-active .ink-library-panel";
  await page.waitForSelector(`${panel} .ink-library-tile[aria-label='Process']`, { timeout: 5000 });
  const sources = await ev(() => [...document.querySelectorAll(".workspace-leaf.mod-active .ink-library-source")].map((b) => b.getAttribute("aria-label")));
  check("the object library lists the flowchart shapes, My library and the library in the vault", sources.includes("Flowchart") && sources.includes("My library") && sources.includes("Servers"), JSON.stringify(sources));
  const m = await mapping();
  await page.click(`${panel} .ink-library-tile[aria-label='Process']`);
  await pen([[200, 200], [200, 200]], { m });
  await page.click(`${panel} .ink-library-tile[aria-label='Decision']`);
  await pen([[200, 480], [200, 480]], { m });
  await ev(() => __t.surface().setTools({ tool: "shape", shape: "arrow" }));
  await pen(along([[200, 200], [200, 480]], 8), { m });
  const flow = await ev(() => {
    const [a, b, c] = __t.surface().page.strokes;
    return { closed: [!!a?.closed, !!b?.closed], from: c?.from === a?.id, to: c?.to === b?.id };
  });
  check("shapes from the library are placed with a tap, and an arrow drawn between them attaches to both", flow.closed.every(Boolean) && flow.from && flow.to, JSON.stringify(flow));
  await ev(() => __t.surface().setTools({ tool: "fill", fillColor: "#fff3bf", fillStyle: "solid" }));
  await pen([[200, 480], [200, 480]], { m });
  const filled = await ev(() => __t.surface().page.strokes[1].fill);
  check("the fill tool fills the decision", filled === "#fff3bf", filled);
  await ev(() => __t.surface().setTools({ tool: "text" }));
  await pen([[200, 200], [200, 200]], { m });
  await sleep(200);
  await page.keyboard.type("Start");
  await page.keyboard.press("Escape");
  const label = await ev(() => {
    const p = __t.surface().page;
    const t = p.texts[0];
    return { text: t?.text, inShape: t?.container === p.strokes[0].id, align: t?.align };
  });
  check("the text tool labels the shape it is tapped into", label.text === "Start" && label.inShape && label.align === "center", JSON.stringify(label));
  // a second shape, connected with an elbow arrow, and its label
  await page.click(`${panel} .ink-library-tile[aria-label='Start / end']`);
  await pen([[480, 700], [480, 700]], { m });
  await ev(() => __t.surface().setTools({ tool: "shape", shape: "elbow" }));
  await pen(along([[200, 480], [480, 700]], 8), { m });
  const elbow = await ev(() => {
    const p = __t.surface().page;
    const c = p.strokes.at(-1);
    const n = c.pts.length / 3;
    const pts = Array.from({ length: n }, (_, i) => [c.pts[i * 3], c.pts[i * 3 + 1]]);
    return { from: c.from === p.strokes[1].id, to: c.to === p.strokes.at(-2).id, square: pts.every((q, i) => i === 0 || q[0] === pts[i - 1][0] || q[1] === pts[i - 1][1]), n };
  });
  check("an elbow arrow attaches too and keeps right angles", elbow.from && elbow.to && elbow.square && elbow.n >= 3, JSON.stringify(elbow));
  await ev(() => __t.surface().setTools({ tool: "text" }));
  await pen([[480, 700], [480, 700]], { m });
  await sleep(200);
  await page.keyboard.type("Done");
  await page.keyboard.press("Escape");
  // keep the decision in My library
  await ev(() => __t.surface().setTools({ tool: "lasso" }));
  await pen([[110, 480], [110, 480]], { m });
  await page.click(".workspace-leaf.mod-active .ink-sel-library");
  await page.waitForSelector(".modal input", { timeout: 3000 });
  // the prompt focuses its field (and selects the name it suggests) a moment after it opens: type after that
  await page.waitForFunction(() => document.activeElement?.matches(".modal input"), null, { timeout: 3000 });
  await page.keyboard.type("Yellow decision");
  await page.keyboard.press("Enter");
  const mine = await ev(async () =>
    __t
      .waitFor(async () => {
        const f = app.vault.getAbstractFileByPath("Ink libraries/My library.excalidrawlib");
        return f && JSON.parse(await app.vault.read(f)).libraryItems.map((i) => ({ name: i.name, types: i.elements.map((e) => e.type), fill: i.elements[0]?.backgroundColor }));
      }, 5000, "My library")
      .catch((e) => String(e)),
  );
  check("“To library” keeps the selection in My library, as an Excalidraw library", Array.isArray(mine) && mine[0]?.name === "Yellow decision" && mine[0].types[0] === "diamond" && mine[0].fill === "#fff3bf", JSON.stringify(mine));
  await page.click(`${panel} .ink-library-source[aria-label='My library']`);
  await page.waitForSelector(`${panel} .ink-library-tile[aria-label='Yellow decision']`, { timeout: 5000 });
  // an item of the library in the vault
  await page.click(`${panel} .ink-library-source[aria-label='Servers']`);
  await page.waitForSelector(`${panel} .ink-library-tile[aria-label='Labelled box']`, { timeout: 5000 });
  await page.click(`${panel} .ink-library-tile[aria-label='Labelled box']`);
  await pen([[200, 900], [200, 900]], { m });
  const placed = await ev(() => {
    const p = __t.surface().page;
    const s = p.strokes.at(-1);
    const t = p.texts.at(-1);
    return { fill: s.fill, style: s.fillStyle, text: t.text, inBox: t.container === s.id };
  });
  check("an Excalidraw library item is placed with its hatching and label", placed.fill === "#a5d8ff" && placed.style === "hatch" && placed.text === "Server" && placed.inBox, JSON.stringify(placed));
  await ev(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
  await shot("12-flowchart.png");
  await ev(() => __t.surface().setTools({ tool: "pen" }));
  const saved = await ev(async (p) => {
    await __t.waitFor(async () => / f:a5d8ff s:h/.test(await __t.read(p)), 8000, "saved").catch(() => null);
    const text = await __t.read(p);
    return { fill: / f:fff3bf/.test(text), arrows: (text.match(/ a:\S+ b:\S+/g) ?? []).length, hatch: / f:a5d8ff s:h/.test(text), labels: (text.match(/"container":/g) ?? []).length };
  }, file);
  check("fills, the attached arrows and the labels are saved", saved.fill && saved.arrows === 2 && saved.hatch && saved.labels === 3, JSON.stringify(saved));
  await page.click(`${panel} .ink-library-close`);
};

steps.mermaid = async () => {
  console.log("\n▶ Mermaid diagrams in the object library");
  await setWindow(1100, 1180);
  // the diagram of the feature request, in a note; and a new ink page
  const CODE = `flowchart TD
    subgraph Notes
        B["Board object<br/>2D array, n × n"]
        P["Player object<br/>Lives on board, owns a logger"]
    end

    subgraph SU["Start up"]
        M["main(): random(n)"] --> D
        T["Tests: fixed(6, 6)"] --> D
        D["Create dice shaker<br/>DiceRollerFactory"] --> CP(["Create player"])
        CP --> AB["Add to board<br/>Place on start square"]
        AB --> CL["Create logger<br/>One per player"]

        subgraph LCF["Logger creation flow"]
            LF(["Logger creation flow"]) --> PV["Pass player var<br/>Through an interface"]
            PV --> AC["Assign log colour<br/>Unique per player"]
            AC --> LR["Logger ready<br/>Prints player + dice roll"]
        end

        CL --> LF

        LR --> MP{"More players?"}
        MP -- yes --> CP
    end

    MP -- no --> SG["Start game<br/>Game(shaker, players)"]

    classDef dice fill:#E1F5EE,stroke:#0F6E56,color:#085041
    classDef logger fill:#EEEDFE,stroke:#534AB7,color:#3C3489
    class M,T,D dice
    class LF,PV,AC,LR logger`;
  // (starting again: the diagrams of an earlier run go)
  fs.rmSync(path.join(VAULT, "Ink libraries", "Mermaid"), { recursive: true, force: true });
  fs.rmSync(path.join(VAULT, "Diagrams"), { recursive: true, force: true });
  await sleep(500);
  fs.mkdirSync(path.join(VAULT, "Games"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Games", "Snakes and ladders.md"), "# Snakes and ladders\n\nHow a game starts:\n\n```mermaid\n" + CODE + "\n```\n\nMore notes.\n");
  fs.mkdirSync(path.join(VAULT, "Diagrams", "Attachments"), { recursive: true });
  fs.writeFileSync(path.join(VAULT, "Diagrams", "Attachments", "Diagrams.ink.md"), "---\nink-notebook: 1\n---\n");
  await sleep(1500);

  // in a note: the diagram under the cursor fills the dialog
  const note = "Games/Snakes and ladders.md";
  await openFile(note, "markdown");
  await waitView("markdown", note);
  await ev(() => {
    const ed = app.workspace.activeEditor.editor;
    ed.setCursor(ed.offsetToPos(ed.getValue().indexOf("subgraph LCF")));
  });
  await ev(() => app.commands.executeCommandById("ink-notebook:add-mermaid"));
  await page.waitForSelector(".ink-mermaid-modal .ink-mermaid-code", { timeout: 5000 });
  await page.waitForFunction(() => /shapes/.test(document.querySelector(".ink-mermaid-status")?.textContent ?? ""), null, { timeout: 5000 });
  const pre = await ev(() => ({
    code: document.querySelector(".ink-mermaid-code").value,
    name: document.querySelector(".ink-mermaid-name input").value,
    status: document.querySelector(".ink-mermaid-status").textContent,
    preview: document.querySelector(".ink-mermaid-canvas").width,
  }));
  check("the Mermaid block under the cursor of a note fills the dialog, named after the note", pre.code.startsWith("flowchart TD") && pre.code.includes("class LF,PV,AC,LR logger") && pre.name === "Snakes and ladders", JSON.stringify({ ...pre, code: pre.code.slice(0, 40) }));
  check("the dialog shows it as ink, with what it holds", pre.status === "14 shapes, 12 arrows." && pre.preview > 100, JSON.stringify(pre.status));
  await shot("13-mermaid-dialog.png");
  await page.click(".ink-mermaid-modal button.mod-cta");
  const kept = await ev(async () =>
    __t.waitFor(async () => {
      const f = app.vault.getAbstractFileByPath("Ink libraries/Mermaid/Snakes and ladders.md");
      return f && (await app.vault.read(f));
    }, 5000, "the Mermaid note").catch((e) => String(e)),
  );
  check("“Add to library” keeps it as a note with a ```mermaid block in the library's Mermaid folder", /^```mermaid\nflowchart TD\n[\s\S]*class LF,PV,AC,LR logger\n```\n$/.test(kept), String(kept).slice(0, 80));

  // on an ink page: paste a diagram in the library panel, it is ready to be placed
  const file = "Diagrams/Attachments/Diagrams.ink.md";
  await openFile(file, "ink-notebook");
  await waitView("ink-notebook", file);
  await ev(() => app.commands.executeCommandById("ink-notebook:object-library"));
  const panel = ".workspace-leaf.mod-active .ink-library-panel";
  await page.click(`${panel} .ink-library-source[aria-label='Mermaid']`);
  await page.waitForSelector(`${panel} .ink-library-tile[aria-label='Snakes and ladders']`, { timeout: 5000 });
  await page.click(`${panel} button[aria-label='Add a Mermaid diagram…']`);
  await page.waitForSelector(".ink-mermaid-modal .ink-mermaid-code", { timeout: 5000 });
  await ev(() => {
    const ta = document.querySelector(".ink-mermaid-code");
    ta.value = "graph LR\n  A([Draft]) --> B{Review}\n  B -->|ok| C[(Publish)]\n  B -. changes .-> A";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForFunction(() => /shapes/.test(document.querySelector(".ink-mermaid-status")?.textContent ?? ""), null, { timeout: 5000 });
  await page.fill(".ink-mermaid-name input", "Review loop");
  await page.click(".ink-mermaid-modal button.mod-cta");
  await page.waitForSelector(`${panel} .ink-library-tile.is-active[aria-label='Review loop']`, { timeout: 5000, state: "attached" });
  const armed = await ev(() => ({ tool: __t.surface().tools.tool, stamp: __t.surface().stamp?.name }));
  check("a diagram added on an ink page is chosen to be placed right away", armed.tool === "stamp" && armed.stamp === "Review loop", JSON.stringify(armed));
  const m = await mapping();
  await pen([[500, 160], [500, 160]], { m });
  const small = await ev(() => {
    const p = __t.surface().page;
    return { arrows: p.strokes.filter((s) => s.from && s.to).length, labels: p.texts.filter((t) => t.container).map((t) => t.text) };
  });
  check("a tap puts it on the page: shapes, their labels and attached arrows", small.arrows === 3 && ["Draft", "Review", "Publish"].every((t) => small.labels.includes(t)), JSON.stringify(small));

  // the diagram of the note, on a page of its own, filling most of it
  const unfold = () =>
    ev((sel) => {
      const p = document.querySelector(sel);
      if (p?.classList.contains("is-folded")) p.querySelector(".ink-library-fold").click();
    }, panel);
  await ev(() => __t.surface().addPage("end"));
  await sleep(300);
  await unfold();
  await page.click(`${panel} .ink-library-tile[aria-label='Snakes and ladders']`);
  await pen([[500, 707], [500, 707]], { m: await mapping() });
  const big = await ev(() => {
    const p = __t.surface().page;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const s of p.strokes) for (let i = 1; i < s.pts.length; i += 3) (minY = Math.min(minY, s.pts[i])), (maxY = Math.max(maxY, s.pts[i]));
    const fills = new Set(p.strokes.map((s) => s.fill).filter(Boolean));
    return { strokes: p.strokes.length, arrows: p.strokes.filter((s) => s.from && s.to).length, labels: p.texts.filter((t) => t.container).length, h: maxY - minY, ph: p.h, dice: fills.has("#e1f5ee"), logger: fills.has("#eeedfe"), yes: p.texts.some((t) => t.text === "yes") };
  });
  check("the diagram of the request is placed whole: subgraphs, 14 shapes with labels, 12 attached arrows, its colours", big.strokes === 29 && big.arrows === 12 && big.labels === 14 && big.dice && big.logger && big.yes, JSON.stringify(big));
  check("it fills most of the page", big.h > big.ph * 0.7 && big.h < big.ph, JSON.stringify(big));
  await ev(() => __t.surface().setTools({ tool: "pen" }));
  await unfold();
  await ev(() => document.querySelectorAll(".notice").forEach((n) => n.remove()));
  await shot("14-mermaid.png");
  const saved = await ev(async (p) => {
    await __t.waitFor(async () => /f:e1f5ee/.test(await __t.read(p)), 8000, "saved").catch(() => null);
    const text = await __t.read(p);
    return { dice: / f:e1f5ee/.test(text), arrows: (text.match(/ a:\S+ b:\S+/g) ?? []).length, labels: (text.match(/"container":/g) ?? []).length };
  }, file);
  check("the placed diagrams are saved with their arrows and labels", saved.dice && saved.arrows === 15 && saved.labels === 17, JSON.stringify(saved));

  // the trash button takes a diagram out of the library (its note goes to the trash)
  await page.click(`${panel} .ink-library-tile[aria-label='Review loop'] .ink-library-remove`);
  const gone = await ev(async () =>
    __t
      .waitFor(() => !app.vault.getFiles().some((f) => f.path === "Ink libraries/Mermaid/Review loop.md") && !document.querySelector(".ink-library-tile[aria-label='Review loop']"), 5000, "removed")
      .then(() => true)
      .catch((e) => String(e)),
  );
  check("a diagram can be removed from the library", gone === true, String(gone));
  await page.click(`${panel} .ink-library-close`);
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

const order = ["setup", "createPage", "write", "speed", "flipToText", "flipToInk", "tools", "pages", "typedNotes", "pdf", "papers", "reload", "asMarkdown", "notes", "migrate", "flowchart", "mermaid", "eink"];
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
paperServer.close();
await browser.close();
process.exit(failures === 0 ? 0 : 1);
