#!/bin/bash
# Download Obsidian (AppImage) and the Excalidraw plugin release used by the tests.
set -e
E2E=$(cd "$(dirname "$0")/.." && pwd)
OBSIDIAN_VERSION=${OBSIDIAN_VERSION:-1.14.4}
EXCALIDRAW_VERSION=${EXCALIDRAW_VERSION:-2.29.0}
mkdir -p "$E2E/bin/excalidraw"
cd "$E2E/bin"
curl -sSL -o Obsidian.AppImage "https://github.com/obsidianmd/obsidian-releases/releases/download/v$OBSIDIAN_VERSION/Obsidian-$OBSIDIAN_VERSION.AppImage"
chmod +x Obsidian.AppImage
rm -rf squashfs-root && ./Obsidian.AppImage --appimage-extract >/dev/null
for f in main.js manifest.json styles.css; do
  curl -sSL -o "excalidraw/$f" "https://github.com/zsviczian/obsidian-excalidraw-plugin/releases/download/$EXCALIDRAW_VERSION/$f"
done
echo "Obsidian $OBSIDIAN_VERSION and Excalidraw $EXCALIDRAW_VERSION ready in $E2E/bin"
