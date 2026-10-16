# Ink Notebook for Obsidian

**Handwritten notebook pages for Obsidian, built on top of [Excalidraw](https://github.com/zsviczian/obsidian-excalidraw-plugin), made for e‑ink tablets such as the Onyx Boox.** Excalidraw is included – install Ink Notebook and start writing.

Write by hand on the **ink page**, tap the **Text** bookmark, and read the same page as clean Markdown: handwriting transcribed, flowcharts and sketches embedded live from your drawing, links working like everywhere else in Obsidian. Type on the **text page** and your typed notes show up on the ink page too.

```
 ┌──────────────────────────────┐   ┌──────────────────────────────┐
 │  Ink page (Excalidraw)   ▶Ink│   │  Text page (Markdown)     Ink│
 │                         ◀Text│   │                         ▶Text│
 │  Meeting with [[Anna]]       │   │  Meeting with [[Anna]]       │
 │  - budget                    │ ⇄ │  - budget                    │
 │   ┌─────┐                    │   │  ![[…#^area=…]]  ← live      │
 │   │Start│──▶ …               │   │                   diagram    │
 │                              │   │  Typed notes … (also shown   │
 │   [typed notes card]         │   │  on the ink page)            │
 └──────────────────────────────┘   └──────────────────────────────┘
```

## Screenshots

Taken by the automated end-to-end tests in real Obsidian + Excalidraw (the "handwriting" is generated test strokes).

| Ink page | Text page (e-ink mode, mobile layout) |
| --- | --- |
| ![Ink page with handwriting, a diagram and the typed-notes card](docs/ink-page.png) | ![Text page with transcript, live diagram embed and typed notes](docs/text-page-eink.png) |
| **Paper picker** (e-ink mode) | **Pages: dotted, an inserted squared page, ruled** |
| ![Choosing the paper for a new page](docs/paper-picker.png) | ![An ink page with several kinds of paper](docs/pages.png) |
| **PDF annotation** | **Setup assistant** |
| ![Annotating PDF pages](docs/pdf-annotation.png) | ![Setup assistant](docs/setup-assistant.png) |

## Features

- **Bookmark switcher** – two ribbon bookmarks on the right edge of every ink page: *Ink* (the drawing) and *Text* (the Markdown page). Tap to flip the page in the same tab. A third ribbon, *+ Page*, adds a page. Long‑press (or right‑click) for more: transcribe now, re‑transcribe, open side by side, add a page, change the paper. The bookmarks measure Excalidraw's toolbars and panels, the view header and the status bar and always sit clear of them, on any screen (on very short screens they shrink to icons).
- **Handwriting → text with Azure AI Vision** – with your own free Azure key, or with the optional *Ink Notebook Cloud* subscription (no Azure account needed). Supports both *Image Analysis 4.0* and *Read 3.2* (picked automatically). Lines become paragraphs, `-`/`•` lines become lists, a box drawn in front of a line (or a written `[ ]`) becomes a task you can tick in Obsidian – `- [x]` if you ticked or crossed the box –, bigger writing becomes a heading, handwritten `[[links]]` become real Obsidian links – on the text page, and as a tappable link icon right on your handwriting on the ink page. Uncertain words can be highlighted for proofreading.
- **Hand-drawn tables become Markdown tables** – draw the lines of a table (a line under the headings and lines between the columns is enough, like a T-chart or a table of values) and write in the cells: the text page gets a real Markdown table. Rows come from the row lines you drew, or – where only the header is ruled off – from your lines of writing. Lines may be drawn in several strokes or with the border in one go; writing that could not be read shows as a highlighted `?` so you can correct it.
- **Drawings embedded live** – flowcharts, boxes, arrows and sketches are detected automatically and embedded on the text page with Excalidraw's area embeds (`![[page.excalidraw#^area=…]]`). Change the drawing and the text page shows the change. Put something in a frame named *Diagram …* (or use *Turn the selection into a diagram*) to force it.
- **Your edits are kept** – fix a recognition mistake directly on the text page; the correction stays until you change that handwriting. Deleted or added paragraphs are remembered too.
- **Typed notes on the drawing** – anything you type on the text page (outside the transcript) appears on the ink page as a text card, and edits to that card flow back.
- **Works offline** – drawing, flipping, reading and typing all work without a connection. Handwriting that could not be transcribed is shown as a picture with a short note, queued, and transcribed automatically once you're back online.
- **PDF and image annotation like in the Boox Notes app** – put PDF pages (or an image) on an ink page as locked backgrounds, write on them, and *Export annotated PDF*: you get a new PDF with the original pages (text stays selectable) and your ink on top. Rotated pages are handled.
- **Paper like in GoodNotes** – pick the paper for every new page from a template gallery: blank, ruled, dotted, squared, graph paper, isometric, Cornell notes, checklist or music staff, each with narrow/normal/wide spacing, white/ivory/yellow/blue paper and portrait or landscape. Add pages after or before the page you're on or at the end (pages and writing below move down to make room), and change the paper of a page later – your writing stays.
- **Tidy folders** – a new page goes into the folder of the note you're in: the text page (`Week 1.md`) sits next to your other notes, the drawing and its paper go into a subfolder (`Attachments/` by default), so the folder only shows your notes.
- **E‑ink mode** – detected automatically on Boox: no animations or shadows, high contrast, larger touch targets, and one‑tap recommended stylus settings for Excalidraw (pen draws, finger pans, double‑tap erases).
- Everything stays plain Obsidian: two normal files per page, frontmatter links between them, backlinks and graph work as usual.

```
003 - University/
└── Computer Architecture/
    ├── Attachments/
    │   ├── Week 1.excalidraw.md      ← the ink page (drawing)
    │   └── ink-paper-dots.svg        ← its paper
    ├── Computer Architecture.md
    └── Week 1.md                     ← the text page
```

## Installation

You need **Obsidian 1.8.7+** – that's all. **Excalidraw is built into Ink Notebook**, so there is no second plugin to install.

Already using the Excalidraw plugin? If it is installed and enabled in your vault, Ink Notebook uses your Excalidraw instead of its built‑in copy (Excalidraw 2.0+ is needed, PDF export needs 2.20+). If you disable or uninstall it, the built‑in Excalidraw takes over. The built‑in Excalidraw keeps its settings in `.obsidian/plugins/ink-notebook/excalidraw/` (on its first start it copies the settings of an Excalidraw plugin you used before) and has its own tab in Obsidian's settings, as usual.

### Option A – BRAT (easiest, also on the Boox)
1. In Obsidian: *Settings → Community plugins → Browse*, install and enable **BRAT**.
2. *Settings → BRAT → Add beta plugin* and enter `stefanmayer06/Obsidian-wrighting-for-eink`.
3. Enable **Ink Notebook** under *Community plugins*.

### Option B – manual
1. Download `main.js`, `manifest.json` and `styles.css` from the [latest release](https://github.com/stefanmayer06/Obsidian-wrighting-for-eink/releases).
2. Copy them to `<your vault>/.obsidian/plugins/ink-notebook/`.
3. Restart Obsidian and enable **Ink Notebook**.

When Ink Notebook starts the first time, a **setup assistant** opens (you can reopen it from the settings or the command *Open setup assistant*). It shows which Excalidraw is used, turns on the e‑ink optimisations, offers the recommended pen settings, connects handwriting recognition and creates your first page.

## Setting up handwriting recognition

Handwriting recognition is optional. Without it, the text page shows your handwriting as a picture (still with typed notes, links and diagrams). There are two ways to turn it on – choose under *Settings → Ink Notebook → Handwriting recognition → Service* (or in the setup assistant):

### Ink Notebook Cloud (subscription)

No Azure account needed: subscribe, paste the license key from your purchase e-mail, press **Check** – done. The subscription includes a monthly allowance of recognitions (each changed writing area of a page counts as one); *Check* shows how much is used. Subscriptions are sold through [Polar](https://polar.sh), which also handles invoices and taxes; you manage or cancel yours in Polar's customer portal (linked in the settings). The option appears in the plugin while the service is open for subscriptions.

### Your own Azure key (free tier)

1. Sign in at the [Azure portal](https://portal.azure.com) (a free account is enough).
2. Open [**Create Computer Vision**](https://portal.azure.com/#create/Microsoft.CognitiveServicesComputerVision).
   - *Region*: one close to you, e.g. **West Europe** or **East US**. (Image Analysis 4.0 is only offered in some regions; Ink Notebook falls back to Read 3.2 automatically.)
   - *Pricing tier*: **Free F0** – 5,000 images per month, 20 per minute.
3. After deployment open the resource → **Keys and Endpoint**. Copy the **Endpoint** and **KEY 1**.
4. In Obsidian: *Settings → Ink Notebook → Handwriting recognition*, paste both and press **Test**.

How many requests are used? One per *writing area* that changed since the last time (a page is split into areas so that writing in one corner does not re‑send the whole page). Results are cached, so flipping back and forth costs nothing.

Privacy: only your handwriting strokes are rendered and sent (black on white – never the PDF or paper background, never your typed text) – with your own key to the Azure region you picked, with Ink Notebook Cloud to the Ink Notebook server (EU), which passes them to Azure AI Vision and keeps nothing; Azure deletes them within 24 hours. The key (Azure key or license key) is stored in `.obsidian/plugins/ink-notebook/data.json` inside your vault – keep that in mind if you share your vault.

## Using it on a Boox (Note Air, Tab Ultra, Go, …)

1. Install **Obsidian** from the Play Store (enable Google Play in the Boox settings if needed), open your vault and install Ink Notebook as above.
2. In the setup assistant press **Apply** next to *Stylus settings for Excalidraw*: the pen draws, one finger pans/zooms, double‑tapping with the pen switches to the eraser.
3. Recommended Boox app optimisation for Obsidian (long‑press the Obsidian icon → *Optimize* / *E‑Ink Center*):
   - refresh mode **Fast** or **Balanced** for writing (**HD** if you mostly read),
   - use a light Obsidian theme (Ink Notebook's e‑ink mode makes it pure black on white).
4. Write on lined paper with normal letter size; recognition works best with words that don't touch the lines above and below.

## Daily use

| What | How |
| --- | --- |
| New page | Ribbon pencil icon, command **New ink page**, or right‑click a folder → *New ink page*. Choose the paper (and name, if enabled) in the picker; double‑tap a template to take it right away |
| Flip ink ⇄ text | Tap the other bookmark, or command **Flip between ink and text page** |
| Transcribe again | Long‑press the bookmark → *Transcribe handwriting now* (normally this happens automatically when you flip or leave the drawing) |
| Start over | *Re‑transcribe from scratch* discards edits made inside the transcript |
| Side by side | Long‑press the bookmark → *Open ink and text side by side* (typed notes update live) |
| Link pages | Write `[[Page name]]` by hand (after the next flip it gets a link icon you can tap), or type links in Excalidraw text or on the text page |
| Tasks | Draw a small box in front of the line (`- [ ]` on the text page); tick or cross it when done (`- [x]`) |
| Tables | Draw a line under the headings and lines between the columns, write in the cells |
| Diagrams | Draw anything – it is detected. To force: frame named *Diagram …*, or select strokes → command **Turn the selection into a diagram** |
| More pages | Tap the **+ Page** bookmark (or command **Add a page…**): choose the paper and *after this page*, *before this page* or *at the end*. Command **Add a page after this one (same paper)** skips the picker |
| Change paper | Long‑press the bookmark → *Change the paper of this page…* (or the command of the same name) for the page in the middle of the screen |
| Annotate a PDF | Right‑click a PDF → *Annotate with Ink Notebook*, or command **Annotate a PDF…** |
| Save annotated PDF | On the ink page: command **Export annotated PDF** (creates `<name> (annotated).pdf`) |
| Annotate an image | Right‑click an image → *Annotate with Ink Notebook*; export with **Export annotated image** |
| Existing drawing | On any Excalidraw drawing tap the **+ Text** bookmark to give it a text page |
| Offline | Just keep working. Pages waiting for recognition show a small ◦ on the Text bookmark; command **Transcribe pages waiting for a connection** retries immediately |

### The text page

```markdown
---
ink-drawing: "[[Notes/Attachments/My page.excalidraw]]"
---
%% ink-notebook:start %%
…your transcribed handwriting, lists, diagrams…
%% ink-notebook:end … %%

Anything you type below (or above) the transcript is a typed note.
```

The two `%% … %%` lines mark the transcript; in Live Preview they are shown as a small "✍ From your handwriting" label and they are invisible in Reading view. Please don't delete them – if you do, Ink Notebook rebuilds the transcript and keeps your text.

## Settings

- **Excalidraw** – which Excalidraw is used (built in, or your own Excalidraw plugin) and a shortcut to its settings.
- **Pages** – where new pages go (folder of the current note, or a fixed folder), the subfolder for ink files (`Attachments` by default; empty = next to the text page), paper for new pages and whether to choose it every time, ask for a name, open the text page in reading or editing view, keep names in sync on rename/move.
- **Handwriting recognition** – service (Ink Notebook Cloud or your own Azure key), license key or endpoint and key, API version, language hint, highlight uncertain words, transcribe while writing, how long to wait when flipping, requests per minute, clickable handwritten links, diagram detection sensitivity, offline queue and cache.
- **Typed notes** – show them on the ink page, font and width of the card.
- **Display & e‑ink** – e‑ink mode (automatic / on / off), large touch targets, Excalidraw stylus settings, preferred bookmark position (they still move out of the way of toolbars), bookmark on all drawings.
- **PDF annotation** – page width on the ink page, how many pages to import without asking.

## Troubleshooting

- **Excalidraw does not start** – the setup assistant (step 1) shows why and has a *Try again* button. If you also have the Excalidraw plugin installed, Ink Notebook uses that one: make sure it is enabled and up to date, or disable it to use the built‑in Excalidraw.
- **"This license key is not active"** (Ink Notebook Cloud) – check the key in the settings (press *Check*), or renew the subscription in Polar's customer portal. Pages are transcribed automatically once the key works again.
- **"You have used all … recognitions for this month"** – the allowance renews on the first of the month; until then pages are kept as pictures and queued.
- **Test connection fails** – 401 means a wrong key; 404 a wrong endpoint (copy it exactly from *Keys and Endpoint*); 429 means the free tier's 20 requests/minute were reached (it retries automatically).
- **Something was embedded as a picture instead of text** – that area was recognised as a drawing. Change *Diagram detection* to *Only clear drawings*, or write a little larger. Unrecognised handwriting is always shown as a picture rather than lost.
- **A table is shown as a picture** – the lines of a table have to be long and fairly straight and cross each other (or nearly touch), and the writing in at least two cells has to be readable. A drawing running across the lines (a chart with axes and a curve) or a shape inside keeps it a picture; so does a single cross unless the horizontal line is near the top, like a T-chart. Single letters are the hardest to read – a cell that could not be read shows `?`.
- **A box in front of a line did not become a task** – the box has to be closed, about as high as the writing (up to about twice), right in front of the first word and empty or ticked (writing inside makes it a diagram box). Round circles stay what they are.
- **Text on the text page is wrong** – just correct it there; your correction stays.
- **Typed notes changed on both pages** – the text page wins; you get a notice.
- Developer console: `app.plugins.plugins["ink-notebook"].internals` exposes the recognition pipeline for debugging.

## How it works

- Each ink page is two files: `Attachments/Name.excalidraw.md` (the drawing) and `Name.md` (the text page), linked through the `ink-text` / `ink-drawing` frontmatter properties. The links use full paths, so pages called "Week 1" in different folders never get mixed up. Renaming or moving one renames/moves the other – moving `Week 1.md` to another folder moves the drawing into that folder's `Attachments/`. Pages made with older versions (both files side by side) keep working.
- Paper pages are locked SVG images (a few KB, stored once per folder) that remember their template, so *+ Page* suggests the paper of the page you're on.
- On a flip, your freedraw strokes are grouped into writing areas, rendered black on white (without long straight lines such as table lines and underlines, which only confuse OCR) and sent to Azure; the returned word boxes are mapped back onto the strokes to separate handwriting from drawings. Drawings are clustered into diagrams.
- Each diagram gets an invisible, locked rectangle in the drawing; the text page embeds that area with `#^area=<id>`, so the picture is always live.
- The transcript region stores a compact fingerprint of what was generated, which is how your corrections, deletions and additions are recognised and kept.
- Ink Notebook never edits the drawing file directly: all changes go through Excalidraw's scripting API (ExcalidrawAutomate) while the drawing is open.
- The built‑in Excalidraw is the unmodified Excalidraw plugin release (in `vendor/excalidraw`), embedded in Ink Notebook's `main.js`. Ink Notebook starts it the way Obsidian starts a community plugin, under Excalidraw's own plugin id, so Excalidraw scripts and other plugins that work with Excalidraw find it as usual. It is not started when your own Excalidraw plugin is enabled.

## Development

```bash
npm install
npm test          # unit tests (vitest)
npm run build     # type-check + bundle main.js
```

The pure logic (OCR parsing, classification, layout, transcript merging, PDF maths) lives in `src/core` and is covered by unit tests; Obsidian/Excalidraw integration is in `src/obsidian`.

The built‑in Excalidraw lives in `vendor/excalidraw` (the release files, unmodified). To move to another Excalidraw release run `npm run update-excalidraw -- <version>`, then `npm run check` and the end‑to‑end tests.

**Releasing:** run `npm run set-version -- 1.3.1` (it updates `manifest.json`, `package.json`, `package-lock.json` and `versions.json`) and commit, then on GitHub create a release with the tag `1.3.1` – just the version, without a "v" – or open *Actions → Build & release → Run workflow*. The workflow runs the tests, builds and publishes the release with `main.js`, `manifest.json` and `styles.css` – which is what BRAT and manual installs download – plus the license of the built‑in Excalidraw. It writes the tag's version into the released `manifest.json`, so a release always matches its tag; Obsidian's community plugin list reads the version from the repository, though, so keep `manifest.json` bumped there too.

`e2e/` contains end-to-end tests that run the plugin inside the real Obsidian desktop app (with its built‑in Excalidraw, or with the Excalidraw plugin installed separately) and a fake Azure server (see `e2e/README.md`).

`supabase/` is the Ink Notebook Cloud server (a Supabase Edge Function and its database migrations); [docs/cloud-setup.md](docs/cloud-setup.md) explains how it is configured and run.

## Payments, accounts and network use

- **Payment:** Ink Notebook Cloud is an optional paid subscription. Everything else – including handwriting recognition with your own Azure key – is free.
- **Account:** Ink Notebook Cloud needs a license key from a purchase (sold through Polar). Nothing else needs an account.
- **Network use:** Ink Notebook works offline. Its own code connects to the internet only for handwriting recognition: with your own key it sends handwriting images to *your* Azure AI Vision resource; with Ink Notebook Cloud it sends handwriting images and your license key to the Ink Notebook server (Supabase, Frankfurt), which checks the key with Polar and passes the images to Azure AI Vision. When you open the handwriting recognition settings or the setup assistant, the plugin asks the Ink Notebook server whether the subscription is offered (no personal data is sent). There is no telemetry and no ads. The built‑in Excalidraw is the unmodified Excalidraw plugin; some of its own features may load content from the internet (see its documentation).

## License

Copyright (C) 2026 Stefan Mayer

Ink Notebook – the plugin and the Ink Notebook Cloud server in `supabase/` – is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version (`AGPL-3.0-or-later`, see [`LICENSE`](LICENSE)). It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the license for details.

Releases up to and including 1.1.0 were published under the MIT license and remain available under it.

The built‑in Excalidraw is the [Excalidraw plugin for Obsidian](https://github.com/zsviczian/obsidian-excalidraw-plugin) by Zsolt Viczian, included unmodified and licensed under the GNU AGPL v3.0 (`vendor/excalidraw/LICENSE`; [`vendor/excalidraw/README.md`](vendor/excalidraw/README.md) names the included version and where its source code is). The license texts of Ink Notebook and of all third‑party code in the released `main.js` – the built‑in Excalidraw, pdf-lib and the libraries it uses – are appended to the end of that file.
