// The edit of the promo video: which recorded frames play when, at what speed,
// where the camera looks, and the captions. Shared by compose.html (pictures)
// and render.mjs / sound.py (the sound follows the pen and the cuts).
//
// Every clip lasts a whole number of beats of the music (90 bpm: a beat is 20
// frames), so the cuts fall on the beat and the end card on a downbeat.
//
// Camera keys: t in seconds from the start of the clip; x, y the point of the
// tablet's screen (CSS pixels of the 702 × 936 window) in the middle of the
// picture; z the zoom (1: the whole tablet below the caption).

export const FPS = 30;
export const BPM = 90;
export const BEAT = (FPS * 60) / BPM; // frames
export const VIDEO = { w: 1080, h: 1350 };
export const SCREEN = { w: 702, h: 936 };

const WIDE = { z: 1, x: 351, y: 468 };

export const CLIPS = [
  {
    id: "write",
    scene: "write",
    pen: true,
    beats: 5,
    ranges: [
      { from: 0, to: 124, rate: 1.6 },
      { from: 124, to: 148, rate: 1.15 },
    ],
    camera: [
      { t: 0, z: 1.75, x: 322, y: 440 },
      { t: 2.2, z: 1.7, x: 334, y: 432 },
      { t: 3.05, ...WIDE },
    ],
  },
  {
    id: "text",
    scene: "text",
    pen: false,
    beats: 7,
    in: { type: "turn", dur: 0.5 },
    ranges: [{ from: 0, to: 120, rate: 1 }],
    camera: [
      { t: 0, ...WIDE },
      { t: 0.55, ...WIDE },
      { t: 3.9, z: 1.5, x: 351, y: 285 },
      { t: 4.7, z: 1.52, x: 351, y: 282 },
    ],
  },
  {
    id: "diagram",
    scene: "diagram",
    pen: true,
    beats: 5,
    in: { type: "fade", dur: 0.3 },
    ranges: [
      { from: 0, to: 46, rate: 1.25 },
      { from: 81, to: 168, rate: 1.45, in: 4 },
    ],
    camera: [
      { t: 0, z: 1.12, x: 430, y: 470 },
      { t: 1.15, z: 1.3, x: 380, y: 520 },
      { t: 1.5, z: 1.55, x: 300, y: 430 },
      { t: 3.4, z: 1.5, x: 300, y: 450 },
    ],
  },
  {
    id: "pdf",
    scene: "pdf",
    pen: true,
    beats: 5,
    in: { type: "fade", dur: 0.3 },
    ranges: [
      { from: 2, to: 73, rate: 1.7 },
      { from: 73, to: 196, rate: 2.0 },
    ],
    camera: [
      { t: 0, z: 1.55, x: 330, y: 360 },
      { t: 1.6, z: 1.6, x: 355, y: 395 },
      { t: 3.4, z: 1.55, x: 380, y: 400 },
    ],
  },
  {
    id: "pages",
    scene: "pages",
    pen: true,
    beats: 3,
    in: { type: "fade", dur: 0.3 },
    ranges: [{ from: 0, to: 78, rate: 1.3 }],
    camera: [
      { t: 0, z: 1.05, x: 351, y: 440 },
      { t: 1.9, z: 1.12, x: 300, y: 380 },
    ],
  },
  {
    id: "paper",
    scene: "paper",
    pen: true,
    beats: 3,
    in: { type: "fade", dur: 0.2 },
    ranges: [{ from: 4, to: 70, rate: 1.4 }],
    camera: [
      { t: 0, z: 1.12, x: 340, y: 380 },
      { t: 2, z: 1.17, x: 350, y: 370 },
    ],
  },
  { id: "end", scene: null, pen: false, beats: 10, in: { type: "end", dur: 0.7 } },
];

/** Captions: from the start of a clip until the next caption. `mark` is highlighted. */
export const CAPTIONS = [
  { clip: "write", main: "Write by hand in Obsidian", mark: "by hand", sub: "A fast pen engine, made for e‑ink tablets" },
  { clip: "text", main: "Flip it — it's Markdown", mark: "Markdown", sub: "Headings, lists, tasks & [[links]] from your handwriting", foot: "Handwriting recognition: Azure AI Vision with your own free key" },
  { clip: "diagram", main: "Mermaid diagrams as real ink", mark: "real ink", sub: "Move a shape – its arrows follow" },
  { clip: "pdf", main: "Mark up PDFs & papers", mark: "PDFs", sub: "Highlight, circle, write in the margin" },
  { clip: "pages", main: "A real notebook", mark: "notebook", sub: "Pages on ruled, dotted, squared, Cornell paper…" },
  { clip: "end" },
];

/**
 * Every frame of the video: which clip, which recorded frame, the pen.
 * manifests: { scene: manifest.json } as written by record.mjs.
 */
export function build(manifests) {
  const frames = [];
  const clips = [];
  for (const clip of CLIPS) {
    const start = frames.length;
    const want = Math.round(clip.beats * BEAT);
    if (!clip.scene) {
      for (let i = 0; i < want; i++) frames.push({ clip: clip.id, local: i });
    } else {
      const m = manifests[clip.scene];
      // the speeds are scaled a little so the clip lasts exactly its beats
      const natural = clip.ranges.reduce((a, r) => a + (r.to - r.from) / r.rate, 0);
      const k = natural / want;
      let prev = null;
      for (const r of clip.ranges) {
        const rate = r.rate * k;
        const n = Math.round((r.to - r.from) / rate);
        for (let i = 0; i < n; i++) {
          const src = Math.min(m.frames.length - 1, Math.floor(r.from + i * rate));
          // a tap between two shown frames is still shown; the ink the pen laid
          // down since the last shown frame (for the sound), at the recorded rate
          let tap = false;
          const ink = { down: false, dist: 0 };
          const from = prev === null || src < prev ? src : prev + 1;
          for (let j = from; j <= src; j++) {
            const q = m.frames[j];
            tap ||= !!q?.tap;
            if (q?.pen?.down) {
              ink.down = true;
              const p = m.frames[j - 1]?.pen;
              if (p?.down && j > from - 1) ink.dist += Math.hypot(q.pen.x - p.x, q.pen.y - p.y);
            }
          }
          const f = m.frames[src];
          frames.push({ clip: clip.id, local: frames.length - start, src, file: `${clip.scene}/${f.file}`, pen: clip.pen ? f.pen : null, tap, ink: clip.pen ? ink : null, cutIn: i < (r.in ?? 0) && prev !== null ? { file: `${clip.scene}/${m.frames[prev].file}`, u: (i + 1) / ((r.in ?? 0) + 1) } : null });
          prev = src;
        }
      }
      // exactly `want` frames: hold the last one, or drop the extra
      while (frames.length - start < want) frames.push({ ...frames[frames.length - 1], local: frames.length - start, tap: false, ink: null, cutIn: null });
      frames.length = start + want;
    }
    clips.push({ ...clip, start, frames: frames.length - start });
  }
  return { frames, clips, total: frames.length };
}

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** The camera at time t (seconds): eased between keys. */
export function cameraAt(keys, t) {
  if (t <= keys[0].t) return keys[0];
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (t <= b.t) {
      const u = ease((t - a.t) / Math.max(1e-6, b.t - a.t));
      const z = a.z * Math.pow(b.z / a.z, u);
      return { z, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
    }
  }
  return keys[keys.length - 1];
}
