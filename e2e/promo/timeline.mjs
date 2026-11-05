// The edit of the promo video: which recorded frames play when and how fast,
// where the camera looks, the captions and the feature wall. Shared by
// compose.html (the pictures) and render.mjs / sound.py (the sound follows the
// pen, the cuts and the beat).
//
// The music is 120 bpm: a beat is 15 frames at 30 fps. Every clip lasts a whole
// number of beats, so every cut lands on a beat, the wall on a downbeat and the
// end card on the downbeat after it.
//
// Ranges refer to the named marks of a scene's manifest (record.mjs), with an
// optional offset in frames: "tapText+2", "loop-3"; "end" is the last frame.
// Camera keys: b in beats from the start of the clip; x, y the point of the
// tablet's screen (CSS pixels of the 702 × 936 window) in the middle of the
// picture; z the zoom (1: the whole tablet below the captions); r a tilt in degrees.

export const FPS = 30;
export const BPM = 120;
export const BEAT = (FPS * 60) / BPM; // 15 frames
export const VIDEO = { w: 1080, h: 1350 };
export const SCREEN = { w: 702, h: 936 };

const WIDE = { z: 1, x: 351, y: 468 };

export const CLIPS = [
  {
    id: "write",
    count: 1,
    beats: 4,
    pen: true,
    ranges: [
      { scene: "write", from: "writeStart-2", to: "writeEnd", rate: 1.85 },
      { scene: "write", from: "writeEnd+1", to: "tapText+2", rate: 1.1 },
    ],
    camera: [
      { b: 0, z: 1.95, x: 290, y: 500, r: -2.2 },
      { b: 2.6, z: 1.95, x: 280, y: 520, r: -1.4 },
      { b: 3.2, z: 1.8, x: 270, y: 560, r: -0.8 },
      { b: 3.75, z: 1.3, x: 430, y: 380, r: 0 },
      { b: 4, z: 1.28, x: 440, y: 370, r: 0 },
    ],
  },
  {
    id: "text",
    count: 2,
    beats: 4,
    in: "eink",
    ranges: [{ scene: "text", from: 0, to: 60, rate: 1 }],
    camera: [
      { b: 0, z: 1.15, x: 351, y: 440, r: 0 },
      { b: 0.9, z: 1.2, x: 340, y: 420, r: 0.4 },
      { b: 3.3, z: 1.72, x: 300, y: 300, r: 1.2 },
      { b: 4, z: 1.76, x: 300, y: 298, r: 1.4 },
    ],
  },
  {
    id: "pens",
    count: 3,
    beats: 3,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "pens", from: "open", to: "picked+3", rate: 1.9 },
      { scene: "pens", from: "write", to: "written+2", rate: 2.3, cut: 3 },
    ],
    camera: [
      { b: 0, z: 1.5, x: 210, y: 390, r: -1.5 },
      { b: 1.15, z: 1.55, x: 215, y: 400, r: -1 },
      { b: 1.25, z: 1.6, x: 250, y: 500, r: 0.5 },
      { b: 3, z: 1.68, x: 260, y: 510, r: 1 },
    ],
  },
  {
    id: "smart",
    count: 4,
    beats: 4,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "smart", from: "loop-1", to: "snapped-3", rate: 1.6 },
      { scene: "smart", hold: "snapped-3", frames: 6 },
      { scene: "smart", from: "snapped-2", to: "scribble", rate: 1.2 },
      { scene: "smart", from: "scribble", to: "erased+12", rate: 1.25 },
    ],
    camera: [
      { b: 0, z: 2.1, x: 225, y: 470, r: 1.5 },
      { b: 1.35, z: 2.2, x: 220, y: 466, r: 1.2 },
      { b: 1.85, z: 2.15, x: 460, y: 570, r: -0.6 },
      { b: 4, z: 2.1, x: 465, y: 572, r: -1 },
    ],
  },
  {
    id: "lasso",
    count: 6,
    beats: 4,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "lasso", from: "loop-1", to: "moved+2", rate: 1.85 },
      { scene: "lasso", from: "tapToText-6", to: "typed+12", rate: 1.2, cut: 3 },
    ],
    camera: [
      { b: 0, z: 1.75, x: 300, y: 580, r: -1.5 },
      { b: 1.4, z: 1.7, x: 320, y: 540, r: -0.5 },
      { b: 2.3, z: 1.85, x: 320, y: 530, r: 0.4 },
      { b: 4, z: 1.95, x: 300, y: 535, r: 1 },
    ],
  },
  {
    id: "flow",
    count: 8,
    beats: 4,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "flow", from: "tapTile-2", to: "placed+1", rate: 2.1 },
      { scene: "flow", from: "arrow", to: "filled+1", rate: 2.0, cut: 2 },
      { scene: "flow", from: "lasso", to: "moved+3", rate: 1.9, cut: 2 },
    ],
    camera: [
      { b: 0, z: 1.3, x: 420, y: 560, r: 1.2 },
      { b: 0.9, z: 1.5, x: 380, y: 690, r: 0.6 },
      { b: 1.6, z: 1.55, x: 300, y: 660, r: 0 },
      { b: 2.45, z: 1.6, x: 250, y: 560, r: -0.4 },
      { b: 4, z: 1.55, x: 270, y: 470, r: -1.2 },
    ],
  },
  {
    id: "mermaid",
    count: 9,
    beats: 4,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "mermaid", from: "type", to: "typed", rate: 2.3 },
      { scene: "mermaid", from: "place-2", to: "placed+2", rate: 1.6, cut: 3 },
      { scene: "mermaid", from: "drag", to: "moved+4", rate: 1.5, cut: 2 },
    ],
    camera: [
      { b: 0, z: 1.28, x: 351, y: 420, r: -1 },
      { b: 2.0, z: 1.34, x: 351, y: 470, r: -0.4 },
      { b: 2.1, z: 1.4, x: 330, y: 430, r: 0.4 },
      { b: 3.0, z: 1.5, x: 300, y: 500, r: 0.8 },
      { b: 4, z: 1.7, x: 250, y: 600, r: 1.2 },
    ],
  },
  {
    id: "table",
    count: 10,
    beats: 3,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "table", from: "write-1", to: "tapText+2", rate: 1.6 },
      { scene: "tabletext", from: 0, to: 40, rate: 1, cut: "eink" },
    ],
    camera: [
      { b: 0, z: 1.6, x: 380, y: 500, r: 1.2 },
      { b: 0.55, z: 1.4, x: 420, y: 420, r: 0.6 },
      { b: 0.7, z: 2.3, x: 150, y: 262, r: 0 },
      { b: 3, z: 2.42, x: 150, y: 262, r: -0.8 },
    ],
  },
  {
    id: "arxiv",
    count: 11,
    beats: 3,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "arxiv", from: 0, to: "tapImport+1", rate: 0.9 },
      { scene: "arxiv", from: "opened", to: "end", rate: 1.1, cut: "eink" },
    ],
    camera: [
      { b: 0, z: 1.35, x: 350, y: 390, r: -1.2 },
      { b: 1.7, z: 1.42, x: 380, y: 360, r: -0.6 },
      { b: 1.85, z: 1.3, x: 351, y: 380, r: 0 },
      { b: 3, z: 1.38, x: 351, y: 360, r: 0.8 },
    ],
  },
  {
    id: "pdf",
    count: 12,
    beats: 4,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "pdf", from: "marker-1", to: "noteEnd+1", rate: 2.75 },
      { scene: "pdf", from: "menu", to: "end", rate: 1.2, cut: 2 },
    ],
    camera: [
      { b: 0, z: 1.95, x: 400, y: 410, r: 1.2 },
      { b: 2.7, z: 2.0, x: 410, y: 430, r: 0.4 },
      { b: 2.85, z: 1.45, x: 470, y: 330, r: -0.6 },
      { b: 4, z: 1.5, x: 480, y: 320, r: -1 },
    ],
  },
  {
    id: "paper",
    count: 13,
    beats: 4,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "picker", from: 0, to: "end", rate: 3.4 },
      { scene: "paper", steps: ["dots", "grid", "isometric", "cornell", "music", "checklist"], each: 7.5 },
    ],
    camera: [
      { b: 0, z: 1.25, x: 346, y: 420, r: -1 },
      { b: 1, z: 1.28, x: 346, y: 420, r: -0.5 },
      { b: 1.05, z: 1.2, x: 351, y: 480, r: 0.5 },
      { b: 4, z: 1.28, x: 351, y: 480, r: 1.2 },
    ],
  },
  {
    id: "pages",
    count: 14,
    beats: 3,
    pen: true,
    in: "eink",
    ranges: [
      { scene: "pages", from: "swipe-2", to: "turned+3", rate: 1.1 },
      { scene: "pages", from: "tapPages-6", to: "overview+30", rate: 1.0, cut: 2 },
    ],
    camera: [
      { b: 0, z: 1.12, x: 351, y: 470, r: 1 },
      { b: 0.55, z: 1.12, x: 351, y: 470, r: 0.5 },
      { b: 0.7, z: 1.15, x: 350, y: 480, r: -0.4 },
      { b: 3, z: 1.22, x: 350, y: 480, r: -1 },
    ],
  },
  { id: "wall", count: 24, beats: 4, in: "wall" },
  { id: "end", beats: 9, in: "end" },
];

/** Captions: from `at` beats into their clip until the next caption. `mark` gets the highlighter. */
export const CAPTIONS = [
  { clip: "write", at: 0, main: "Write by hand.", mark: "hand", sub: "In Obsidian – on your e‑ink tablet" },
  { clip: "text", at: 0, main: "Get Markdown.", mark: "Markdown", sub: "Headings · lists · tasks · [[links]] · live sketches", foot: "Handwriting recognition: Azure AI Vision with your own free key" },
  { clip: "pens", at: 0, main: "5 pens. 10 colours.", mark: "5 pens.", sub: "Pressure, highlighter, favourite pens" },
  { clip: "smart", at: 0, main: "Hold to snap.", mark: "snap", sub: "Draw a shape, rest the pen – it's perfect" },
  { clip: "smart", at: 1.85, main: "Scribble to erase.", mark: "erase", sub: "Scratch it out, like on paper" },
  { clip: "lasso", at: 0, main: "Lasso. Move.", mark: "Lasso.", sub: "Resize, rotate, recolour, duplicate" },
  { clip: "lasso", at: 2.2, main: "…or make it text.", mark: "text", sub: "Handwriting → a typed text box" },
  { clip: "flow", at: 0, main: "Arrows that stick.", mark: "stick", sub: "Flowchart shapes · fills · object library" },
  { clip: "mermaid", at: 0, main: "Mermaid → ink.", mark: "ink", sub: "Paste the code, get real, editable shapes" },
  { clip: "table", at: 0, main: "Draw a table.", mark: "table", sub: "It becomes a Markdown table" },
  { clip: "arxiv", at: 0, main: "arXiv, built in.", mark: "arXiv", sub: "Find a paper, import it, write on it" },
  { clip: "pdf", at: 0, main: "Mark up any PDF.", mark: "PDF", sub: "Export it with your ink as vectors" },
  { clip: "paper", at: 0, main: "9 paper templates.", mark: "9", sub: "", ticker: true },
  { clip: "pages", at: 0, main: "A real notebook.", mark: "notebook", sub: "Swipe through pages · all pages at a glance" },
  { clip: "wall", at: 0, main: "…and so much more.", mark: "more", sub: "" },
  { clip: "end", at: 0 },
];

/** The names shown under "9 paper templates" while the paper changes (scene "paper" steps). */
export const PAPER_NAMES = { picker: "Ruled · dotted · squared · Cornell · music…", dots: "Dotted", grid: "Squared", isometric: "Isometric", cornell: "Cornell notes", music: "Music staff", checklist: "Checklist" };

/**
 * The feature wall: a tile per feature, a crop of a recorded frame
 * (scene, frame or mark, and the rectangle of the screen it shows in CSS px).
 */
export const WALL = [
  { label: "Fast pen engine", scene: "write", at: "writeEnd", crop: [30, 300, 450, 308] },
  { label: "5 pens", scene: "pens", at: "end", crop: [40, 290, 520, 356] },
  { label: "Highlighter", scene: "pdf", at: "markerEnd", crop: [250, 303, 330, 226] },
  { label: "3 erasers", scene: "still-eraser", at: 0, crop: [10, 150, 430, 295] },
  { label: "Hold to snap", scene: "smart", at: "snapped", crop: [80, 370, 270, 185] },
  { label: "Scribble to erase", scene: "smart", at: "scribble+3", crop: [340, 490, 270, 185] },
  { label: "Lasso & move", scene: "lasso", at: "moved", crop: [60, 380, 560, 384] },
  { label: "Handwriting → text", scene: "lasso", at: "typed", crop: [110, 420, 420, 288] },
  { label: "Shapes & fills", scene: "flow", at: "filled", crop: [40, 390, 320, 219] },
  { label: "Attached arrows", scene: "flow", at: "end", crop: [60, 250, 440, 300] },
  { label: "Object library", scene: "flow", at: 0, crop: [290, 140, 410, 280] },
  { label: "Excalidraw libraries", scene: "still-excalidraw", at: 0, crop: [362, 330, 328, 225] },
  { label: "Mermaid → ink", scene: "mermaid", at: "placed", crop: [150, 300, 380, 260] },
  { label: "Markdown text page", scene: "text", at: 0, crop: [0, 120, 440, 300] },
  { label: "Tables", scene: "tabletext", at: 0, crop: [10, 130, 300, 205] },
  { label: "Live sketches", scene: "text", at: 0, crop: [10, 300, 600, 410] },
  { label: "Typed notes", scene: "still-notes", at: 0, crop: [274, 150, 420, 288] },
  { label: "PDF markup", scene: "pdf", at: "noteEnd", crop: [300, 370, 400, 274] },
  { label: "Export to PDF", scene: "pdf", at: "menu", crop: [258, 170, 436, 298] },
  { label: "arXiv papers", scene: "arxiv", at: 0, crop: [72, 60, 556, 380] },
  { label: "9 paper templates", scene: "picker", at: "end", crop: [68, 60, 557, 380] },
  { label: "Page overview", scene: "pages", at: "overview", crop: [71, 90, 557, 380] },
  { label: "Daily notes", scene: "still-daily", at: 0, crop: [0, 40, 600, 411] },
  { label: "Plain Markdown files", scene: "still-files", at: 0, crop: [20, 160, 440, 300] },
];

/** A frame reference of a manifest: a number, a mark ("name", "name+2", "name-3") or "end". */
export function frameOf(m, ref) {
  if (typeof ref === "number") return Math.max(0, Math.min(m.frames.length - 1, ref));
  const r = /^([A-Za-z0-9]+)([+-]\d+)?$/.exec(ref);
  if (!r) throw new Error(`bad frame reference ${ref}`);
  const base = r[1] === "end" ? m.frames.length - 1 : m.marks[r[1]];
  if (base === undefined) throw new Error(`${m.name} has no mark ${r[1]}`);
  return Math.max(0, Math.min(m.frames.length - 1, base + Number(r[2] ?? 0)));
}

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
    if (!clip.ranges) {
      for (let i = 0; i < want; i++) frames.push({ clip: clip.id, local: i });
    } else {
      // the speeds are scaled a little so that the clip lasts exactly its beats
      const len = (r) => {
        if (r.hold) return r.frames;
        if (r.steps) return Math.round(r.steps.length * r.each);
        const m = manifests[r.scene];
        return (frameOf(m, r.to) - frameOf(m, r.from)) / r.rate;
      };
      const fixed = clip.ranges.filter((r) => r.hold || r.steps).reduce((a, r) => a + len(r), 0);
      const free = clip.ranges.filter((r) => !r.hold && !r.steps).reduce((a, r) => a + len(r), 0);
      const k = free / Math.max(1, want - fixed);
      let prev = null;
      for (const [ri, r] of clip.ranges.entries()) {
        const m = manifests[r.scene];
        const push = (src, extra = {}) => {
          const f = m.frames[src];
          // a tap between two shown frames is still shown; the ink the pen laid down since the last shown frame (for the sound)
          let tap = false;
          const ink = { down: false, dist: 0 };
          const from = prev === null || prev.scene !== r.scene || src < prev.src ? src : prev.src + 1;
          for (let j = from; j <= src; j++) {
            const q = m.frames[j];
            tap ||= !!q?.tap;
            if (q?.pen?.down) {
              ink.down = true;
              const p = m.frames[j - 1]?.pen;
              if (p?.down && j > from - 1) ink.dist += Math.hypot(q.pen.x - p.x, q.pen.y - p.y);
            }
          }
          frames.push({ clip: clip.id, local: frames.length - start, range: ri, scene: r.scene, src, file: `${r.scene}/${f.file}`, pen: clip.pen ? f.pen : null, touch: f.touch ?? null, tap: clip.pen && tap, ink: clip.pen ? ink : null, ...extra });
          prev = { scene: r.scene, src };
        };
        const firstOfRange = frames.length;
        if (r.hold) {
          const src = frameOf(m, r.hold);
          for (let i = 0; i < r.frames; i++) push(src);
        } else if (r.steps) {
          let acc = 0;
          r.steps.forEach((name, si) => {
            const n = Math.round((si + 1) * r.each) - Math.round(si * r.each);
            const src = frameOf(m, name);
            for (let i = 0; i < n; i++) push(src, { step: name, stepLocal: i });
            acc += n;
          });
        } else {
          const rate = r.rate * k;
          const a = frameOf(m, r.from);
          const b = frameOf(m, r.to);
          const n = Math.max(1, Math.round((b - a) / rate));
          for (let i = 0; i < n; i++) push(Math.min(b, Math.floor(a + i * rate)));
        }
        // a cut inside the clip: "eink" refreshes the screen, a number dissolves over that many frames
        if (r.cut && firstOfRange > start) frames[firstOfRange].cut = { type: r.cut === "eink" ? "eink" : "dissolve", frames: typeof r.cut === "number" ? r.cut : 4, from: frames[firstOfRange - 1].file };
      }
      // exactly `want` frames: hold the last one, or drop the extra
      while (frames.length - start < want) frames.push({ ...frames[frames.length - 1], local: frames.length - start, tap: false, ink: null, cut: null });
      frames.length = start + want;
    }
    clips.push({ ...clip, start, frames: frames.length - start });
  }
  return { frames, clips, total: frames.length };
}

const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** The camera at beat b of a clip: eased between keys. */
export function cameraAt(keys, b) {
  if (!keys?.length) return { ...WIDE, r: 0 };
  if (b <= keys[0].b) return { r: 0, ...keys[0] };
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const c = keys[i];
    if (b <= c.b) {
      const u = ease((b - a.b) / Math.max(1e-6, c.b - a.b));
      return { z: a.z * Math.pow(c.z / a.z, u), x: a.x + (c.x - a.x) * u, y: a.y + (c.y - a.y) * u, r: (a.r ?? 0) + ((c.r ?? 0) - (a.r ?? 0)) * u };
    }
  }
  return { r: 0, ...keys[keys.length - 1] };
}
