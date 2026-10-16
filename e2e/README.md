# End-to-end tests

These tests run Ink Notebook inside a **real Obsidian desktop app** with its
**built-in Excalidraw**, driven through the Chrome DevTools protocol, with a
fake Azure server that genuinely looks at the uploaded handwriting images
(it finds ink, groups it into lines and words and labels the lines with texts
chosen by the test).

They cover: page creation, writing, flipping both ways, transcript layout,
diagram embeds, edits being preserved, typed notes ⇄ drawing card, clickable
handwritten links, undo safety, extra paper pages, diagram frames, offline
queue, Read 3.2 fallback, error recovery, Live Preview markers, the setup
assistant, PDF annotation + export (incl. a rotated page), image annotation,
rename sync, e-ink mode, plugin reload, the built-in Excalidraw (also while
the Excalidraw plugin is installed, enabled and disabled), Obsidian's mobile layout, the paper
picker, the current-folder/`Attachments` layout (incl. rename/move sync), adding,
inserting and changing pages, and that the bookmarks never overlap toolbars or
panels at many window sizes.

Linux only (uses Xvfb). Requirements: Node 20+, `xvfb`, the GTK/NSS libraries Electron needs.

```bash
npm run build                  # in the repo root
cd e2e
npm install                    # playwright-core, pngjs, pdf-lib
./scripts/download.sh          # Obsidian AppImage into e2e/bin
./scripts/fresh.sh             # fresh vault, start Obsidian + mock Azure
node scripts/e2e.mjs           # run everything (screenshots in e2e/shots)
node scripts/e2e.mjs pdf       # or a single step (after "setup")
```

To test with the Excalidraw plugin installed separately in the vault (it then takes
precedence over the built-in one), set `OWN_EXCALIDRAW=1` for both `fresh.sh` and `e2e.mjs`.
