#!/bin/bash
# Launch Obsidian under Xvfb with remote debugging on port 9222.
# SCALE=2 renders at twice the pixel density (for crisp screenshots).
E2E=$(cd "$(dirname "$0")/.." && pwd)
W=${W:-1404}; H=${H:-1872}; SCALE=${SCALE:-1}
export XDG_CONFIG_HOME="$E2E/config"
[ -f "$E2E/obsidian.pid" ] && kill $(cat "$E2E/obsidian.pid") 2>/dev/null
[ -f "$E2E/xvfb.pid" ] && kill $(cat "$E2E/xvfb.pid") 2>/dev/null
sleep 1
Xvfb :99 -screen 0 $((W * SCALE))x$((H * SCALE))x24 >/dev/null 2>&1 &
echo $! > "$E2E/xvfb.pid"
sleep 1
export DISPLAY=:99
nohup "$E2E/bin/squashfs-root/obsidian" --no-sandbox --disable-gpu --remote-debugging-port=9222 --force-device-scale-factor=$SCALE --window-size=${W},${H} > "$E2E/obsidian.log" 2>&1 &
echo $! > "$E2E/obsidian.pid"
echo "launched pid $(cat $E2E/obsidian.pid)"
