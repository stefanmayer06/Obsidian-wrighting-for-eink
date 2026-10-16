#!/bin/bash
# Fresh vault + a single Obsidian instance with both plugins enabled, plus the mock Azure and Ink Notebook Cloud servers.
E2E=$(cd "$(dirname "$0")/.." && pwd)
pkill -f -- "--remote-debugging-port=9222" 2>/dev/null
[ -f "$E2E/mock.pid" ] && kill $(cat "$E2E/mock.pid") 2>/dev/null
[ -f "$E2E/cloud.pid" ] && kill $(cat "$E2E/cloud.pid") 2>/dev/null
[ -f "$E2E/xvfb.pid" ] && kill $(cat "$E2E/xvfb.pid") 2>/dev/null
for i in $(seq 1 20); do
  curl -s -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1 || break
  sleep 1
done
if curl -s -m 1 http://127.0.0.1:9222/json/version >/dev/null 2>&1; then echo "port 9222 still in use"; exit 1; fi
"$E2E/scripts/setup-vault.sh" >/dev/null
(cd "$E2E" && nohup node scripts/mock-azure.mjs > "$E2E/mock.log" 2>&1 & echo $! > "$E2E/mock.pid")
(cd "$E2E" && nohup node --experimental-strip-types scripts/mock-cloud.mjs > "$E2E/cloud.log" 2>&1 & echo $! > "$E2E/cloud.pid")
W=1024 H=1300 "$E2E/scripts/launch.sh" >/dev/null
for i in $(seq 1 40); do curl -s http://127.0.0.1:9222/json/list | grep -q index.html && break; sleep 1; done
sleep 4
cd "$E2E" && node scripts/cdp.mjs eval 'await app.plugins.setEnable(true); await new Promise(r=>setTimeout(r,6000)); return Object.keys(app.plugins.plugins)'
for i in 1 2 3 4; do node scripts/cdp.mjs key Escape >/dev/null 2>&1; done
# the loaded build must be the one on disk
node scripts/cdp.mjs eval 'const fs = window.require("fs"); const p = app.plugins.plugins["ink-notebook"]; const disk = fs.readFileSync(app.vault.adapter.getFullPath(".obsidian/plugins/ink-notebook/main.js"), "utf8"); return { linkSetting: "linkHandwriting" in p.settings, diskHasCommit: disk.includes("inkNotebookLink") }'
ps -eo pid,lstart,cmd | grep -- "--remote-debugging-port=9222" | grep -v grep | grep -v "type=" 
