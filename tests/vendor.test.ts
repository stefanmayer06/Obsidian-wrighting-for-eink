import { createHash } from "crypto";
import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";

/** The Excalidraw release built into Ink Notebook (vendor/excalidraw, see scripts/update-excalidraw.sh). */
const read = (file: string) => readFileSync(new URL(`../vendor/excalidraw/${file}`, import.meta.url));
const manifest = JSON.parse(read("manifest.json").toString("utf8"));
const ours = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

const compare = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

describe("built-in Excalidraw", () => {
  it("is the Excalidraw plugin release its manifest names", () => {
    expect(manifest.id).toBe("obsidian-excalidraw-plugin");
    expect(read("main.js").toString("utf8")).toContain(`PLUGIN_VERSION="${manifest.version}"`);
    expect(read("README.md").toString("utf8")).toContain(`Version: ${manifest.version}`);
  });

  it("files are unmodified (SHA256SUMS)", () => {
    const sums = read("SHA256SUMS").toString("utf8").trim().split("\n");
    expect(sums).toHaveLength(3);
    for (const line of sums) {
      const [hash, file] = line.split(/\s+/);
      expect(createHash("sha256").update(read(file)).digest("hex"), file).toBe(hash);
    }
  });

  it("runs on every Obsidian version Ink Notebook supports", () => {
    expect(compare(manifest.minAppVersion, ours.minAppVersion)).toBeLessThanOrEqual(0);
  });
});
