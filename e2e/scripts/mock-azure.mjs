// Fake Azure AI Vision server for end-to-end tests.
// It really looks at the uploaded PNG: finds ink components, groups them into
// lines and words, and labels the lines with texts supplied by the test.
//
//   POST /__config  {"responses": [["line 1", "line 2"], [...]], "mode": "ok"|"401"|"500"}
//                   {"pool": [[...], [...]]}: for each image the texts with as many lines as it has
//   POST /computervision/imageanalysis:analyze   (Image Analysis 4.0)
//   POST /vision/v3.2/read/analyze + GET /vision/v3.2/read/analyzeResults/:id
//   MOCK_DUMP=<dir>: keep every image it is sent there (img1.png, …)
import http from "http";
import { PNG } from "pngjs";
import fs from "fs";

const PORT = Number(process.env.PORT ?? 8765);
let responses = [];
let fallbackTexts = null;
let pool = [];
let mode = "ok";
let lastImages = [];
const results = new Map();
let requestCount = 0;

function analyze(buf) {
  const png = PNG.sync.read(buf);
  const { width, height, data } = png;
  const dark = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
    const lum = a < 10 ? 255 : 0.3 * r + 0.59 * g + 0.11 * b;
    dark[i] = lum < 140 ? 1 : 0;
  }
  const label = new Int32Array(width * height);
  const comps = [];
  const stack = [];
  for (let start = 0; start < width * height; start++) {
    if (!dark[start] || label[start]) continue;
    const id = comps.length + 1;
    let minX = width, minY = height, maxX = 0, maxY = 0, count = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % width, y = (p - x) / width;
      count++;
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        if (dark[q] && !label[q]) { label[q] = id; stack.push(q); }
      }
    }
    if (count >= 4) comps.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
  }
  // marks much smaller than the rest (i-dots, full stops) join the line they sit on
  const all = comps.map((c) => Math.max(c.w, c.h)).sort((a, b) => a - b);
  const medAll = all.length ? all[Math.floor(all.length / 2)] : 0;
  const isMark = (c) => Math.max(c.w, c.h) < 0.3 * medAll;
  const hs = comps.filter((c) => !isMark(c)).map((c) => c.h).sort((a, b) => a - b);
  const medH = hs.length ? hs[Math.floor(hs.length / 4)] : 0; // lower quartile: robust to big drawings
  const midH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  // big shapes (hand-drawn boxes, circles) are drawings, not text (a big heading is text)
  const textComps = comps.filter((c) => !(c.h > 2.5 * medH && c.w > 2.5 * medH && c.h > 3 * midH));
  textComps.sort((a, b) => isMark(a) - isMark(b) || a.y + a.h / 2 - (b.y + b.h / 2));
  const lines = [];
  for (const c of textComps) {
    const cy = c.y + c.h / 2;
    const slack = isMark(c) ? medH * 0.5 : 0;
    // on the line: its centre is, or it overlaps the line enough (a big word's descenders);
    // of several such lines the one whose middle is nearest
    const overlap = (l) => Math.min(l.y + l.h, c.y + c.h) - Math.max(l.y, c.y);
    const on = (l) =>
      slack ? cy >= l.y - slack && cy <= l.y + l.h + slack && c.x + c.w >= l.x - medH && c.x <= l.x + l.w + medH : (cy >= l.y && cy <= l.y + l.h) || overlap(l) >= 0.35 * c.h;
    const dist = (l) => Math.abs(l.y + l.h / 2 - cy);
    const line = lines.filter(on).sort((a, b) => dist(a) - dist(b))[0];
    if (line) {
      line.comps.push(c);
      const x2 = Math.max(line.x + line.w, c.x + c.w), y2 = Math.max(line.y + line.h, c.y + c.h);
      line.x = Math.min(line.x, c.x); line.y = Math.min(line.y, c.y);
      line.w = x2 - line.x; line.h = y2 - line.y;
    } else lines.push({ x: c.x, y: c.y, w: c.w, h: c.h, comps: [c] });
  }
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const l of lines) {
    l.comps.sort((a, b) => a.x - b.x);
    // words: components close together (a cursive word, its dots and crossings) form one word
    const gap = 0.3 * medH;
    l.clusters = [];
    for (const c of l.comps) {
      const w = l.clusters[l.clusters.length - 1];
      if (w && c.x <= w.x + w.w + gap) {
        const x2 = Math.max(w.x + w.w, c.x + c.w), y2 = Math.max(w.y + w.h, c.y + c.h);
        w.x = Math.min(w.x, c.x); w.y = Math.min(w.y, c.y);
        w.w = x2 - w.x; w.h = y2 - w.y;
      } else l.clusters.push({ ...c });
    }
  }
  return { width, height, lines };
}

const poly = (r) => [
  { x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h },
];
const flat = (r) => [r.x, r.y, r.x + r.w, r.y, r.x + r.w, r.y + r.h, r.x, r.y + r.h];

function recognise(buf) {
  const { width, height, lines } = analyze(buf);
  // responses in order; else the texts of the pool with as many lines as the image has
  const texts = responses.length ? responses.shift() : pool.find((t) => t.length === lines.length) ?? fallbackTexts ?? lines.map((_, i) => `line ${i + 1}`);
  lastImages.push({ width, height, lines: lines.length, texts, boxes: lines.map((l) => [l.x, l.y, l.w, l.h, l.clusters.length]) });
  if (process.env.MOCK_DUMP) fs.writeFileSync(`${process.env.MOCK_DUMP}/img${lastImages.length}.png`, buf);
  const out = [];
  lines.forEach((l, i) => {
    const text = texts[i] ?? `extra ${i + 1}`;
    const words = text.split(/\s+/).filter(Boolean);
    let boxes;
    if (words.length === l.comps.length) boxes = l.comps;
    else if (words.length === l.clusters.length) boxes = l.clusters;
    else {
      const ww = l.w / words.length;
      boxes = words.map((_, k) => ({ x: l.x + k * ww, y: l.y, w: ww * 0.95, h: l.h }));
    }
    out.push({ text, box: l, words: words.map((w, k) => ({ text: w, box: boxes[k], confidence: w.startsWith("~") ? 0.3 : 0.97 })) });
  });
  return { width, height, lines: out.map((l) => ({ ...l, words: l.words.map((w) => ({ ...w, text: w.text.replace(/^~/, "") })), text: l.text.replace(/(^|\s)~/g, "$1") })) };
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const body = await readBody(req);
  const send = (status, obj, headers = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(obj === undefined ? "" : JSON.stringify(obj));
  };
  if (url.pathname === "/__config") {
    const cfg = JSON.parse(body.toString() || "{}");
    if (cfg.responses) responses = cfg.responses;
    if ("fallback" in cfg) fallbackTexts = cfg.fallback;
    if ("pool" in cfg) pool = cfg.pool ?? [];
    if (cfg.mode) mode = cfg.mode;
    if (cfg.reset) { lastImages = []; requestCount = 0; }
    return send(200, { ok: true });
  }
  if (url.pathname === "/__stats") return send(200, { requestCount, lastImages, pending: responses.length });
  requestCount++;
  if (req.headers["ocp-apim-subscription-key"] !== "test-key" || mode === "401") {
    return send(401, { error: { code: "401", message: "Access denied due to invalid subscription key or wrong API endpoint." } });
  }
  if (mode === "500") return send(500, { error: { code: "InternalServerError", message: "Simulated failure" } });
  if (mode === "v4-unsupported" && url.pathname.includes("imageanalysis")) {
    return send(404, { error: { code: "404", message: "Resource not found" } });
  }
  try {
    if (req.method === "POST" && url.pathname === "/computervision/imageanalysis:analyze") {
      const r = recognise(body);
      return send(200, {
        modelVersion: "2023-10-01",
        metadata: { width: r.width, height: r.height },
        readResult: {
          blocks: [{ lines: r.lines.map((l) => ({ text: l.text, boundingPolygon: poly(l.box), words: l.words.map((w) => ({ text: w.text, boundingPolygon: poly(w.box), confidence: w.confidence })) })) }],
        },
      });
    }
    if (req.method === "POST" && url.pathname === "/vision/v3.2/read/analyze") {
      const id = `op${Date.now()}${Math.random().toString(16).slice(2)}`;
      results.set(id, recognise(body));
      return send(202, undefined, { "Operation-Location": `http://127.0.0.1:${PORT}/vision/v3.2/read/analyzeResults/${id}` });
    }
    const m = /^\/vision\/v3\.2\/read\/analyzeResults\/(.+)$/.exec(url.pathname);
    if (req.method === "GET" && m) {
      const r = results.get(m[1]);
      if (!r) return send(404, { error: { code: "NotFound", message: "no such operation" } });
      return send(200, {
        status: "succeeded",
        analyzeResult: {
          version: "3.2.0",
          readResults: [{ page: 1, angle: 0, width: r.width, height: r.height, unit: "pixel", lines: r.lines.map((l) => ({ boundingBox: flat(l.box), text: l.text, words: l.words.map((w) => ({ boundingBox: flat(w.box), text: w.text, confidence: w.confidence })) })) }],
        },
      });
    }
  } catch (e) {
    console.error(e);
    return send(400, { error: { code: "InvalidImage", message: String(e) } });
  }
  send(404, { error: { code: "404", message: "Resource not found" } });
});
server.listen(PORT, "127.0.0.1", () => console.log(`mock azure on ${PORT}`));
