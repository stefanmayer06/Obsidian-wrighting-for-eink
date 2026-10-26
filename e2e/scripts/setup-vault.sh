#!/bin/bash
# Creates a fresh vault + Obsidian config with Ink Notebook installed.
set -e
E2E=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$E2E/.." && pwd)
rm -rf "$E2E/vault" "$E2E/config"
mkdir -p "$E2E/vault/.obsidian/plugins/ink-notebook" "$E2E/config/obsidian"
cp "$REPO/main.js" "$REPO/manifest.json" "$REPO/styles.css" "$E2E/vault/.obsidian/plugins/ink-notebook/"
echo '["ink-notebook"]' > "$E2E/vault/.obsidian/community-plugins.json"
echo '{"promptDelete":false}' > "$E2E/vault/.obsidian/app.json"
echo "# Welcome" > "$E2E/vault/Welcome.md"
cat > "$E2E/config/obsidian/obsidian.json" <<JSON
{"vaults":{"e2evault0000001":{"path":"$E2E/vault","ts":$(date +%s)000,"open":true}},"updateDisabled":true}
JSON
echo "vault ready at $E2E/vault"
