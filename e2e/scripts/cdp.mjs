// Usage: node cdp.mjs eval '<js expression returning a value or promise>'
//        node cdp.mjs evalfile file.js
//        node cdp.mjs shot out.png
import { chromium } from "playwright-core";
import fs from "fs";

const [, , cmd, arg] = process.argv;
const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().includes("index.html")) ?? pages[0];
try {
  if (cmd === "eval" || cmd === "evalfile") {
    const code = cmd === "eval" ? arg : fs.readFileSync(arg, "utf8");
    const result = await page.evaluate(`(async () => { ${code.includes("return") ? code : `return (${code});`} })()`);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } else if (cmd === "shot") {
    await page.screenshot({ path: arg });
    console.log("saved", arg);
  } else if (cmd === "resize") {
    const [w, h] = arg.split("x").map(Number);
    const pageSession = await page.context().newCDPSession(page);
    const { targetInfo } = await pageSession.send("Target.getTargetInfo");
    const session = await browser.newBrowserCDPSession();
    const { windowId } = await session.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
    await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    await session.send("Browser.setWindowBounds", { windowId, bounds: { width: w, height: h, left: 0, top: 0 } });
    await new Promise((r) => setTimeout(r, 800));
    console.log("resized", await page.evaluate("[innerWidth, innerHeight]"));
  } else if (cmd === "key") {
    await page.keyboard.press(arg);
    console.log("pressed", arg);
  } else if (cmd === "click") {
    await page.click(arg, { timeout: 5000 });
    console.log("clicked", arg);
  } else if (cmd === "console") {
    page.on("console", (m) => console.log(`[${m.type()}] ${m.text()}`));
    await new Promise((r) => setTimeout(r, Number(arg ?? 5000)));
  }
} catch (e) {
  console.error("ERROR:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
}
