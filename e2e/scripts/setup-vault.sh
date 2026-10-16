#!/bin/bash
# Creates a fresh vault + Obsidian config with Ink Notebook installed (Excalidraw is built in).
# OWN_EXCALIDRAW=1 also installs the Excalidraw plugin itself (the same release, from
# vendor/excalidraw), to test that a user's own Excalidraw takes precedence.
set -e
E2E=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$E2E/.." && pwd)
rm -rf "$E2E/vault" "$E2E/config"
mkdir -p "$E2E/vault/.obsidian/plugins/ink-notebook" "$E2E/config/obsidian"
cp "$REPO/main.js" "$REPO/manifest.json" "$REPO/styles.css" "$E2E/vault/.obsidian/plugins/ink-notebook/"
if [ -n "$OWN_EXCALIDRAW" ]; then
  mkdir -p "$E2E/vault/.obsidian/plugins/obsidian-excalidraw-plugin"
  cp "$REPO/vendor/excalidraw/main.js" "$REPO/vendor/excalidraw/manifest.json" "$REPO/vendor/excalidraw/styles.css" "$E2E/vault/.obsidian/plugins/obsidian-excalidraw-plugin/"
  echo '["obsidian-excalidraw-plugin","ink-notebook"]' > "$E2E/vault/.obsidian/community-plugins.json"
else
  echo '["ink-notebook"]' > "$E2E/vault/.obsidian/community-plugins.json"
fi
echo '{"promptDelete":false}' > "$E2E/vault/.obsidian/app.json"
echo "# Welcome" > "$E2E/vault/Welcome.md"
cat > "$E2E/config/obsidian/obsidian.json" <<JSON
{"vaults":{"e2evault0000001":{"path":"$E2E/vault","ts":$(date +%s)000,"open":true}},"updateDisabled":true}
JSON
echo "vault ready at $E2E/vault"
