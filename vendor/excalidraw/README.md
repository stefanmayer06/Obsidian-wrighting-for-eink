# Excalidraw for Obsidian (built in)

The unmodified release files of the Excalidraw plugin for Obsidian, built into
Ink Notebook so that users do not have to install Excalidraw separately.

- Project: [zsviczian/obsidian-excalidraw-plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin) by Zsolt Viczian
- Version: 2.29.0
- License: GNU Affero General Public License v3.0 – see [LICENSE](LICENSE)
- Source code of this version: https://github.com/zsviczian/obsidian-excalidraw-plugin/tree/2.29.0

| File | What |
| --- | --- |
| `main.js`, `styles.css`, `manifest.json` | the release assets, byte for byte (checksums in `SHA256SUMS`) |
| `LICENSE` | the plugin's license at that version |

`esbuild.config.mjs` embeds these files into Ink Notebook's `main.js`;
`src/obsidian/bundledExcalidraw.ts` starts them the same way Obsidian starts a
community plugin (when the user has not installed and enabled Excalidraw
themselves – then their own copy is used).

To move to another Excalidraw release:

```bash
npm run update-excalidraw -- <version>
npm run check
```

then run the end-to-end tests (`e2e/README.md`).
