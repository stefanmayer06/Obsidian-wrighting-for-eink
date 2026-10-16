#!/bin/bash
# Replace the Excalidraw plugin built into Ink Notebook (vendor/excalidraw) with
# another release of https://github.com/zsviczian/obsidian-excalidraw-plugin.
#   npm run update-excalidraw -- 2.29.0
# Afterwards run `npm run check` and the end-to-end tests (e2e/README.md).
set -euo pipefail
VERSION=${1:?usage: update-excalidraw.sh <excalidraw version, e.g. 2.29.0>}
REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT="$REPO/vendor/excalidraw"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

BASE="https://github.com/zsviczian/obsidian-excalidraw-plugin"
for f in main.js styles.css manifest.json; do
  curl -fsSL -o "$TMP/$f" "$BASE/releases/download/$VERSION/$f"
done
curl -fsSL -o "$TMP/LICENSE" "https://raw.githubusercontent.com/zsviczian/obsidian-excalidraw-plugin/$VERSION/LICENSE"

node - "$TMP" "$REPO" "$VERSION" <<'JS'
const fs = require("fs");
const [tmp, repo, version] = process.argv.slice(2);
const ex = JSON.parse(fs.readFileSync(`${tmp}/manifest.json`, "utf8"));
const ours = JSON.parse(fs.readFileSync(`${repo}/manifest.json`, "utf8"));
const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};
if (ex.id !== "obsidian-excalidraw-plugin") throw new Error(`unexpected plugin id ${ex.id}`);
if (ex.version !== version) throw new Error(`release ${version} contains manifest version ${ex.version}`);
if (!fs.readFileSync(`${tmp}/main.js`, "utf8").includes(`PLUGIN_VERSION="${version}"`)) throw new Error("main.js does not match the version");
if (cmp(ex.minAppVersion, ours.minAppVersion) > 0) {
  throw new Error(`Excalidraw ${version} needs Obsidian ${ex.minAppVersion}; raise minAppVersion in manifest.json (now ${ours.minAppVersion}) first`);
}
JS

cp "$TMP/main.js" "$TMP/styles.css" "$TMP/manifest.json" "$TMP/LICENSE" "$OUT/"
sed -i.bak -E -e "s/^(- Version: ).*/\1$VERSION/" -e "s#(obsidian-excalidraw-plugin/tree/)[^ ]+#\1$VERSION#" "$OUT/README.md" && rm -f "$OUT/README.md.bak"
SUM="sha256sum"; command -v sha256sum >/dev/null || SUM="shasum -a 256"
(cd "$OUT" && $SUM main.js styles.css manifest.json > SHA256SUMS)
echo "Excalidraw $VERSION is now built in. Run: npm run check"
