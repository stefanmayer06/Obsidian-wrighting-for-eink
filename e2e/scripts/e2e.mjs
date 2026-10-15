// End-to-end test of Ink Notebook inside a real Obsidian + Excalidraw.
import { chromium } from "playwright-core";
import fs from "fs";
import path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";

const E2E = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const VAULT = path.join(E2E, "vault");
const SHOTS = path.join(E2E, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const MOCK = "http://127.0.0.1:8765";
const only = process.argv[2]; // optional: run a single step

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
  await setSettings({ setupDone: true, azureEndpoint: MOCK, azureKey: "test-key", azureApi: "auto", azureDetectedApi: "", einkMode: "off", queue: [] });
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
      bookmarks: document.querySelectorAll(".workspace-leaf.mod-active .ink-bookmark").length,
      activeBookmark: document.querySelector(".workspace-leaf.mod-active .ink-bookmark.is-active")?.textContent,
    };
  }, state);
  check("text page was created next to the drawing", info.textExists, JSON.stringify(info));
  check("text page links to the drawing", /ink-drawing: "\[\[.*\.excalidraw\]\]"/.test(info.textContent ?? ""), info.textContent);
  check("drawing links back to the text page", typeof info.drawingFm?.["ink-text"] === "string" && info.drawingFm["ink-text"].includes("[["), JSON.stringify(info.drawingFm));
  check("lined paper page added, locked, A4 size", info.paper.length === 1 && info.paper[0].locked && info.paper[0].w === 1000, JSON.stringify(info.paper));
  check("two bookmarks shown, Ink active", info.bookmarks === 2 && /Ink/.test(info.activeBookmark ?? ""), JSON.stringify(info));
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
  check("links updated both ways", info.drawingFm?.["ink-text"] === "[[Shopping list]]" && /Shopping list\.excalidraw/.test(info.textFm?.["ink-drawing"] ?? ""), JSON.stringify(info));
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
  console.log("\n▶ add a paper page");
  await ev(() => app.commands.executeCommandById("ink-notebook:add-paper-page"));
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
  const n = await ev(() => document.querySelectorAll(".workspace-leaf.mod-active .ink-bookmark").length);
  check("bookmarks shown in mobile layout", n === 2, n);
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
  await ev(async () => {
    await app.plugins.disablePlugin("ink-notebook");
    await app.plugins.enablePlugin("ink-notebook");
  });
  await page.waitForTimeout(1500);
  const info = await ev(() => {
    const leaves = [...app.workspace.getLeavesOfType("excalidraw"), ...app.workspace.getLeavesOfType("markdown")];
    const p = __t.plugin();
    const inkLeaves = leaves.filter((l) => l.view.file && p.pairs.pairOf(l.view.file) && (l.view.getViewType() === "excalidraw" || p.pairs.isTextPage(l.view.file)));
    return { inkLeaves: inkLeaves.length, perLeaf: inkLeaves.map((l) => l.view.containerEl.querySelectorAll(".ink-bookmarks").length) };
  });
  check("bookmarks restored after plugin reload, one set per ink page tab", info.inkLeaves > 0 && info.perLeaf.every((n) => n === 1), JSON.stringify(info));
};

const order = ["setup", "createPage", "write", "flipToText", "editText", "flipToInk", "flipBack", "editCard", "updateTyped", "undoSafety", "addPage", "markDiagram", "offline", "v3", "errors", "livePreview", "wizardTest", "pdf", "image", "rename", "eink", "reopen", "mobile"];
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
