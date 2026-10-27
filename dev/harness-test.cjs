// Drives dev/harness.html in Chromium with real pen/touch input (CDP) and checks the ink surface.
// Run: node dev/build-harness.mjs && node dev/harness-test.cjs [shots-dir]
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const SHOTS = process.argv[2] || path.join(__dirname, "out", "shots");
fs.mkdirSync(SHOTS, { recursive: true });

let failures = 0;
function check(name, cond, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 760, height: 1000 }, deviceScaleFactor: 2, hasTouch: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("file://" + path.join(__dirname, "harness.html"));
  await page.waitForTimeout(300);
  const cdp = await context.newCDPSession(page);

  // instrument the move handler
  await page.evaluate(() => {
    window.domChanges = 0;
    new MutationObserver((list) => (window.domChanges += list.length)).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    const input = window.surface.input;
    const orig = input.onMove.bind(input);
    window.moveTimes = [];
    input.onMove = (e, raw) => {
      const t0 = performance.now();
      orig(e, raw);
      window.moveTimes.push(performance.now() - t0);
    };
  });

  const box = await page.evaluate(() => {
    const r = window.surface.el.getBoundingClientRect();
    const v = window.surface.view;
    return { left: r.left, top: r.top, scale: v.scale, ox: v.ox, oy: v.oy };
  });
  const toScreen = (x, y) => ({ x: box.left + box.ox + x * box.scale, y: box.top + box.oy + y * box.scale });

  const pen = async (pts, opts = {}) => {
    // CDP cannot send the eraser end (buttons 32); the side button erases by default
    const buttons = opts.side ? 2 : 1;
    const base = { pointerType: "pen", button: opts.side ? "right" : "left", buttons, tiltX: 0, tiltY: 0 };
    const [x0, y0] = pts[0];
    const s0 = toScreen(x0, y0);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s0.x, y: s0.y, pointerType: "pen", buttons: 0, force: 0 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: s0.x, y: s0.y, clickCount: 1, force: opts.p ?? 0.5, ...base });
    for (let i = 1; i < pts.length; i++) {
      const s = toScreen(pts[i][0], pts[i][1]);
      const p = pts[i][2] ?? opts.p ?? 0.3 + 0.5 * Math.abs(Math.sin(i / 5));
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x, y: s.y, force: p, ...base });
    }
    const last = toScreen(...pts[pts.length - 1]);
    if (opts.hold) await page.waitForTimeout(opts.hold);
    if (opts.beforeUp) await opts.beforeUp();
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: last.x, y: last.y, clickCount: 1, force: 0, ...base, buttons: 0 });
  };
  const along = (corners, step = 3) => {
    const out = [corners[0]];
    for (let i = 1; i < corners.length; i++) {
      const [ax, ay] = corners[i - 1];
      const [bx, by] = corners[i];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
      for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
    }
    return out;
  };
  const word = (x, y, w, h) => {
    const pts = [];
    for (let i = 0; i <= 40; i++) pts.push([x + (w * i) / 40, y + h / 2 + (h / 2) * Math.sin(i * 0.9)]);
    return pts;
  };
  const state = () =>
    page.evaluate(() => {
      const s = window.surface;
      return {
        pages: s.document.pages.length,
        page: s.pageIndex,
        strokes: s.page.strokes.length,
        texts: s.page.texts.length,
        sel: s.selection.strokes.size,
        tool: s.tools.tool,
        undo: s.history.canUndo,
        session: s.input.session?.constructor?.name ?? null,
        gesture: !!s.input.gesture,
        link: !!s.input.link,
      };
    });

  console.log("writing");
  for (let line = 0; line < 6; line++) {
    for (let w = 0; w < 5; w++) await pen(word(80 + w * 160, 150 + line * 60, 120, 30));
  }
  let st = await state();
  check("30 words become 30 strokes", st.strokes === 30, JSON.stringify(st));
  const domChanges = await page.evaluate(() => window.domChanges);
  // only the undo button turns on; e-ink screens refresh wherever the page changes
  check("writing leaves the rest of the page alone", domChanges <= 2, `${domChanges} DOM changes`);
  const times = await page.evaluate(() => {
    const t = window.moveTimes.slice().sort((a, b) => a - b);
    return { n: t.length, median: t[Math.floor(t.length / 2)], p95: t[Math.floor(t.length * 0.95)], max: t[t.length - 1] };
  });
  console.log(`   move handler: ${JSON.stringify(times)} ms`);
  check("a pen move is handled in well under a millisecond (median)", times.median < 0.5, JSON.stringify(times));
  await page.screenshot({ path: path.join(SHOTS, "01-writing.png") });

  // pressure makes the fountain pen vary

  console.log("hold to snap");
  await pen(along([[100, 600], [400, 604], [402, 800], [98, 798], [101, 606]], 4), { hold: 900 });
  st = await state();
  const last = await page.evaluate(() => {
    const s = window.surface.page.strokes.at(-1);
    return { poly: !!s.poly, closed: !!s.closed, n: s.pts.length / 3 };
  });
  check("a rectangle held at the end snaps to a clean rectangle", last.poly && last.closed && last.n === 4, JSON.stringify(last));

  console.log("scribble to erase");
  await pen(word(600, 600, 120, 30));
  st = await state();
  const before = st.strokes;
  const zig = [];
  for (let i = 0; i <= 12; i++) zig.push(...along([[i % 2 ? 730 : 590, 595 + i * 3], [i % 2 ? 590 : 730, 598 + i * 3]], 6));
  await pen(zig);
  st = await state();
  check("scratching over a word erases it", st.strokes === before - 1, `${before} -> ${st.strokes}`);

  console.log("side button of the pen erases");
  const beforeErase = st.strokes;
  // across the second word of the first line: it is cut in two
  await pen(along([[300, 128], [300, 188]], 4), { side: true });
  st = await state();
  check("the partial eraser cuts a word in two", st.strokes === beforeErase + 1, `${beforeErase} -> ${st.strokes}`);
  await page.screenshot({ path: path.join(SHOTS, "02-erased.png") });

  console.log("palm rejection, undo with two fingers");
  const undoBefore = st.strokes;
  const t1 = toScreen(500, 1000);
  const t2 = toScreen(600, 1000);
  const twoFingerTap = async () => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: t1.x, y: t1.y, id: 1 }, { x: t2.x, y: t2.y, id: 2 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  // a palm landing while the pen is near the screen is ignored
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: t1.x, y: t1.y - 200, pointerType: "pen", buttons: 0, force: 0 });
  await twoFingerTap();
  st = await state();
  check("touches right after the pen are ignored (palm)", st.strokes === undoBefore, `${undoBefore} -> ${st.strokes}`);
  await page.waitForTimeout(800);
  await twoFingerTap();
  await page.waitForTimeout(100);
  st = await state();
  check("a two-finger tap undoes the erasing", st.strokes === beforeErase, `${undoBefore} -> ${st.strokes}`);
  const base1 = st.strokes;

  console.log("lasso");
  await page.evaluate(() => window.surface.setTools({ tool: "lasso" }));
  await pen(along([[60, 260], [900, 260], [900, 330], [60, 330], [60, 262]], 6));
  st = await state();
  check("the lasso selects the third line of words", st.sel === 5, JSON.stringify(st));
  await page.screenshot({ path: path.join(SHOTS, "03-lasso.png") });
  const yBefore = await page.evaluate(() => window.surface.selectedItems().strokes[0].pts[1]);
  await pen(along([[300, 300], [300, 450]], 5));
  const yAfter = await page.evaluate(() => window.surface.selectedItems().strokes[0].pts[1]);
  check("dragging the selection moves it", Math.abs(yAfter - yBefore - 150) < 2, `${yBefore} -> ${yAfter}`);
  await page.evaluate(() => window.surface.deleteSelection());
  st = await state();
  check("deleting the selection", st.strokes === base1 - 5 && st.sel === 0, JSON.stringify(st));

  console.log("pages");
  await page.evaluate(() => window.surface.setTools({ tool: "pen" }));
  await page.evaluate(() => window.surface.addPage("after"));
  st = await state();
  check("adding a page goes to it", st.pages === 2 && st.page === 1 && st.strokes === 0, JSON.stringify(st));
  await page.waitForTimeout(800);
  const s1 = toScreen(200, 700);
  const swipe = async (dx) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: s1.x, y: s1.y, id: 3 }] });
    for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: s1.x + (dx * i) / 8, y: s1.y, id: 3 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  await swipe(250);
  st = await state();
  check("swiping right turns back to page 1", st.page === 0 && st.strokes === base1 - 5, JSON.stringify(st));
  await swipe(-250);
  st = await state();
  check("swiping left turns to page 2", st.page === 1, JSON.stringify(st));

  console.log("pinch zoom");
  const c = toScreen(500, 700);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: c.x - 40, y: c.y, id: 4 }, { x: c.x + 40, y: c.y, id: 5 }] });
  for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: c.x - 40 - i * 15, y: c.y, id: 4 }, { x: c.x + 40 + i * 15, y: c.y, id: 5 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const zoom = await page.evaluate(() => window.surface.view.scale / window.surface.fitScale);
  check("pinching zooms in", zoom > 2, `zoom ${zoom}`);
  await page.evaluate(() => window.surface.resetZoom());

  console.log("text box");

  await page.evaluate(() => window.surface.setTools({ tool: "text" }));
  await pen([[100, 100], [100, 100]]);
  await page.waitForTimeout(50);
  await page.keyboard.type("Hello from the keyboard");
  await page.keyboard.press("Escape");
  st = await state();
  check("tapping with the text tool and typing adds a text box", st.texts === 1, JSON.stringify(st));

  console.log("shapes, highlighter");
  await page.evaluate(() => window.surface.setTools({ tool: "shape", shape: "ellipse" }));
  await pen(along([[200, 300], [500, 500]], 10));
  await page.evaluate(() => window.surface.setTools({ tool: "marker" }));
  let wetWhileDrawing = "";
  await pen(along([[90, 115], [420, 118]], 4), {
    beforeUp: async () => {
      wetWhileDrawing = await page.evaluate(() => window.surface.wet.style.display);
    },
  });
  st = await state();
  check("ellipse and highlighter are added", st.strokes === 2, JSON.stringify(st));
  const wetAfter = await page.evaluate(() => window.surface.wet.style.display);
  check("the preview layer shows the highlighter, then goes away", wetWhileDrawing === "" && wetAfter === "none", `${wetWhileDrawing} / ${wetAfter}`);
  await page.screenshot({ path: path.join(SHOTS, "04-page2.png") });

  console.log("save and load");
  const roundtrip = await page.evaluate(() => {
    const s = window.surface;
    const text = window.serializeInkFile("", s.file);
    const back = window.parseInkFile(text);
    return { size: text.length, pages: back.doc.pages.length, strokes: back.doc.pages.map((p) => p.strokes.length) };
  });
  console.log(`   file: ${roundtrip.size} bytes`);
  check("the notebook survives saving", roundtrip.pages === 2 && roundtrip.strokes[0] === base1 - 5, JSON.stringify(roundtrip));

  console.log("toolbar");
  await page.evaluate(() => window.surface.setTools({ tool: "pen" }));
  await page.click(".ink-tool-pen");
  await page.waitForTimeout(100);
  check("tapping the selected pen opens its options", (await page.$(".ink-pop-pen")) !== null);
  await page.screenshot({ path: path.join(SHOTS, "05-pen-options.png") });
  await page.click(".ink-pop-pen .ink-tile[aria-label='Brush']");
  const penType = await page.evaluate(() => window.surface.tools.pen);
  check("picking a pen in the card", penType === "brush", penType);
  await page.mouse.click(5, 990);
  check("tapping outside closes the card", (await page.$(".ink-popover")) === null);

  check("no errors in the page", errors.length === 0, errors.join("\n"));
  await browser.close();
  console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
})();
