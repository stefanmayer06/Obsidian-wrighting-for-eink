#!/bin/bash
# Download Obsidian (AppImage) used by the tests.
set -e
E2E=$(cd "$(dirname "$0")/.." && pwd)
OBSIDIAN_VERSION=${OBSIDIAN_VERSION:-1.14.4}
mkdir -p "$E2E/bin"
cd "$E2E/bin"
curl -sSL -o Obsidian.AppImage "https://github.com/obsidianmd/obsidian-releases/releases/download/v$OBSIDIAN_VERSION/Obsidian-$OBSIDIAN_VERSION.AppImage"
chmod +x Obsidian.AppImage
rm -rf squashfs-root && ./Obsidian.AppImage --appimage-extract >/dev/null
echo "Obsidian $OBSIDIAN_VERSION ready in $E2E/bin"
