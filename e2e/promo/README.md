# Promo video

A 25-second video of Ink Notebook for Reddit and other feeds: 1080 × 1350
(4:5, the size feeds show largest on phones), 30 fps, H.264 + AAC, with
captions burnt in so it works muted. The finished video is
[`docs/ink-notebook-promo.mp4`](../../docs/ink-notebook-promo.mp4).

Everything on the tablet's screen is the real plugin in a real Obsidian, in
Obsidian's tablet layout (mobile emulation) at the size of a Boox Note Air
(702 × 936 CSS pixels at 2×), with Ink Notebook's e-ink look turned on. The
staging is the same as for the README screenshots: the handwriting is traced
from a single-stroke script font (`../scripts/handwriting.mjs`) and sent as real
pen events with pressure, and the text page is filled in by the local stand-in
for Azure (`../scripts/mock-azure.mjs`). The tablet frame, the stylus, the
captions and the end card are drawn around the footage. The music and sounds are
synthesised (`sound.py`) – no samples, nothing to license.

| Clip | Shows |
| --- | --- |
| Write | the pen writes a list item and ticks a task, taps **Text** |
| Text | the page turns to the text page: heading, list, tasks, link, live figure |
| Diagram | a Mermaid diagram placed as ink from the object library; the lasso moves a shape and its arrows follow |
| PDF | the highlighter, a circle and a note in the margin of a PDF |
| Pages | the page overview, the paper templates |
| End | the name written by hand, "Community plugins → Browse → Ink Notebook" |

## Making it

Linux, with what `e2e/` needs (Xvfb, the Obsidian AppImage), ffmpeg, Python 3
with numpy, and a Chromium for Playwright (`CHROMIUM=/path/to/chrome`, default
`/opt/pw-browsers/chromium`).

```bash
npm run build                                   # in the repo root
cd e2e
npm install
./scripts/download.sh
SCALE=2 W=1000 H=1300 ./scripts/fresh.sh        # Obsidian at twice the pixel density + mock Azure
node promo/record.mjs                           # footage → shots/promo/<scene>/ (about 10 minutes)
node promo/render.mjs                           # → shots/promo/video/ink-notebook-promo.mp4 (about 3 minutes)
node promo/render.mjs --frames 0,120,600        # or a few frames as PNGs, to look at
```

- `record.mjs` drives Obsidian frame by frame in "virtual time": for every
  frame (1/30 s) it sends the pen events of that moment and captures the window,
  so the writing has an even pace on any machine. Each scene gets numbered PNGs
  and a `manifest.json` with the pen's position per frame.
- `timeline.mjs` is the edit: which frames play, how fast, the camera, the
  captions. Every clip lasts a whole number of beats of the 90 bpm music, so the
  cuts fall on the beat.
- `compose.html` draws one frame of the video: the footage in a tablet, the
  stylus where the pen is, the captions, the end card.
- `render.mjs` renders every frame in a headless Chromium into ffmpeg, writes
  `cues.json` (the pen and the cuts per frame) and runs `sound.py`, which makes
  the music and the sounds that follow the picture (the pen scratching while it
  writes, taps, the page turn), then puts picture and sound together.
