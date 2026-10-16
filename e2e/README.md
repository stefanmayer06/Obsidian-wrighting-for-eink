# End-to-end tests

These tests run Ink Notebook inside a **real Obsidian desktop app** with the
**real Excalidraw plugin**, driven through the Chrome DevTools protocol, with a
fake Azure server that genuinely looks at the uploaded handwriting images
(it finds ink, groups it into lines and words and labels the lines with texts
chosen by the test).

They cover: page creation, writing, flipping both ways, transcript layout,
diagram embeds, edits being preserved, typed notes ⇄ drawing card, clickable
handwritten links, undo safety, extra paper pages, diagram frames, offline
queue, Read 3.2 fallback, error recovery, Ink Notebook Cloud (the real server
code from `supabase/functions/ocr` with a fake Polar, see `scripts/mock-cloud.mjs`), Live Preview markers, the setup
assistant, PDF annotation + export (incl. a rotated page), image annotation,
rename sync, e-ink mode, plugin reload, Obsidian's mobile layout, the paper
picker, the current-folder/`Attachments` layout (incl. rename/move sync), adding,
inserting and changing pages, and that the bookmarks never overlap toolbars or
panels at many window sizes.

Linux only (uses Xvfb). Requirements: Node 20+, `xvfb`, the GTK/NSS libraries Electron needs.

```bash
npm run build                  # in the repo root
cd e2e
npm install                    # playwright-core, pngjs, pdf-lib
./scripts/download.sh          # Obsidian AppImage + Excalidraw release into e2e/bin
./scripts/fresh.sh             # fresh vault, start Obsidian + mock Azure
node scripts/e2e.mjs           # run everything (screenshots in e2e/shots)
node scripts/e2e.mjs pdf       # or a single step (after "setup")
```
