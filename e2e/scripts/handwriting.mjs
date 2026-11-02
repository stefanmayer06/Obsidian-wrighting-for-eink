// Handwriting for the screenshots: text traced with the single-stroke Hershey
// "cursive" font, smoothed and given a little wobble, slant and pen pressure so
// it reads like real writing with a stylus.
//
// The Hershey Fonts were originally created by Dr. A. V. Hershey while working
// at the U. S. National Bureau of Standards. The format of the Font data in
// this distribution was originally created by James Hurt, Cognition, Inc.,
// 900 Technology Park Drive, Billerica, Massachusetts 01821.
// (hershey-cursive.json is that data converted to JSON.)
//
//   const strokes = handwriting("Meeting with Anna", { x: 120, y: 198, size: 1.55, seed: 3 });
//   // → [[x, y, pressure, x, y, pressure, …], …] in page units
import fs from "fs";
import path from "path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const FONT = JSON.parse(fs.readFileSync(path.join(HERE, "hershey-cursive.json"), "utf8"));

// The font draws brackets with doubled lines; a hand draws them once.
FONT.glyphs["["] = { w: 9, s: [[[7, -22], [2, -22], [2, 6], [7, 6]]] };
FONT.glyphs["]"] = { w: 9, s: [[[2, -22], [7, -22], [7, 6], [2, 6]]] };
// a shorter dash, like a list bullet written by hand
FONT.glyphs["-"] = { w: 12, s: [[[2, -5], [9, -5.6]]] };
// digits sit closer together than the font sets them
for (const d of "0123456789") FONT.glyphs[d] = { ...FONT.glyphs[d], w: Math.round(FONT.glyphs[d].w * 0.8) };

/** Small deterministic random numbers (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Chaikin corner cutting: turns the font's polylines into smooth pen curves. */
function smooth(pts, rounds = 2) {
  let p = pts;
  for (let r = 0; r < rounds && p.length > 2; r++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      const [ax, ay] = p[i];
      const [bx, by] = p[i + 1];
      out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

/** Points no further apart than `step`, so the pen engine gets a dense, even stroke. */
function densify(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  return out;
}

/**
 * The strokes of `text` written on a baseline at (x, y).
 * size: page units per font unit (x-height is about 9 font units).
 * Returns { strokes, width } – strokes as flat [x, y, pressure, …] arrays.
 */
export function handwriting(text, { x = 0, y = 0, size = 1.5, seed = 1, slant = 0.06, wobble = 1, spacing = 1 } = {}) {
  const rand = rng(seed);
  const strokes = [];
  let pen = 0; // font units along the line
  const words = text.split(/( +)/);
  for (const word of words) {
    if (/^ +$/.test(word)) {
      pen += word.length * (11 + rand() * 3) * spacing;
      continue;
    }
    if (!word) continue;
    // every word sits a little differently: scale, baseline, tilt
    const k = size * (1 + (rand() - 0.5) * 0.06 * wobble);
    const dy = (rand() - 0.5) * 2.2 * wobble;
    const rot = (rand() - 0.5) * 0.025 * wobble;
    const x0 = x + pen * size;
    let lines = [];
    let cx = 0;
    for (const ch of word) {
      const g = FONT.glyphs[ch] ?? FONT.glyphs["?"];
      for (const s of g.s) lines.push(s.map(([gx, gy]) => [cx + gx, gy]));
      cx += g.w + (rand() - 0.5) * 1.2 * wobble;
    }
    pen += cx;
    // join strokes that continue each other (cursive letters flow into the next one)
    const joined = [];
    for (const s of lines) {
      const last = joined[joined.length - 1];
      if (last) {
        const [lx, ly] = last[last.length - 1];
        const [sx, sy] = s[0];
        if (Math.hypot(lx - sx, ly - sy) <= 1.6) {
          last.push(...s.slice(1));
          continue;
        }
      }
      joined.push(s.slice());
    }
    lines = joined;
    // a gentle, smooth tremor along the stroke
    const ph = [rand() * 6.3, rand() * 6.3, rand() * 6.3, rand() * 6.3];
    const tremor = (u, v, i) => [0.35 * wobble * Math.sin(u * 0.21 + ph[0]) + 0.2 * wobble * Math.sin(v * 0.37 + ph[1] + i), 0.35 * wobble * Math.sin(u * 0.17 + ph[2]) + 0.2 * wobble * Math.sin(v * 0.31 + ph[3] - i)];
    lines.forEach((s, si) => {
      const pts = densify(smooth(s.map(([gx, gy]) => {
        const [tx, ty] = tremor(gx, gy, si);
        // slant (the font leans already; this adds the writer's own lean) and tilt
        const fx = gx + tx - (gy + ty) * slant;
        const fy = gy + ty;
        return [fx * Math.cos(rot) - fy * Math.sin(rot), fx * Math.sin(rot) + fy * Math.cos(rot)];
      }), 3), 0.9);
      const n = pts.length;
      const flat = [];
      const pPhase = rand() * 6.3;
      for (let i = 0; i < n; i++) {
        const [px, py] = pts[i];
        // heavier on down strokes, lighter on up strokes, tapering at both ends
        const next = pts[Math.min(n - 1, i + 1)];
        const prev = pts[Math.max(0, i - 1)];
        const down = Math.max(-1, Math.min(1, (next[1] - prev[1]) / (Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1)));
        const taper = Math.min(1, (i + 1) / 6, (n - i) / 5);
        const p = (0.5 + 0.14 * down + 0.06 * Math.sin(i * 0.15 + pPhase)) * (0.45 + 0.55 * taper);
        flat.push(+(x0 + px * k).toFixed(2), +(y + dy + py * k).toFixed(2), +Math.max(0.12, Math.min(0.95, p)).toFixed(3));
      }
      if (flat.length >= 6) strokes.push(flat);
    });
  }
  return { strokes, width: pen * size };
}

/** A hand-drawn polyline (lines, boxes, ticks, underlines): straight-ish with a slight wobble and pressure. */
export function handLine(points, { seed = 1, wobble = 1, step = 2, rounds = 1 } = {}) {
  const rand = rng(seed);
  const ph = [rand() * 6.3, rand() * 6.3];
  const pts = densify(smooth(points, rounds), step);
  const n = pts.length;
  const flat = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[i];
    const t = i / Math.max(1, n - 1);
    const wx = 0.6 * wobble * Math.sin(t * 7 + ph[0]);
    const wy = 0.6 * wobble * Math.sin(t * 9 + ph[1]);
    const taper = Math.min(1, (i + 1) / 5, (n - i) / 4);
    flat.push(+(px + wx).toFixed(2), +(py + wy).toFixed(2), +((0.5 + 0.1 * Math.sin(t * 5 + ph[1])) * (0.5 + 0.5 * taper)).toFixed(3));
  }
  return flat;
}
