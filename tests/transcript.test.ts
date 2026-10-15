import { describe, expect, it } from "vitest";
import {
  blockHash,
  decodeState,
  encodeState,
  mergeTranscript,
  parseNote,
  splitBlocks,
  stripMarkers,
  writeRegion,
  START_MARKER,
} from "../src/core/transcript";
import type { TranscriptBlock } from "../src/core/layout";

const FM = '---\nink-drawing: "[[Page.excalidraw]]"\n---\n';

/** Simulate one sync: merge generated blocks into the note and write the region. */
function sync(md: string, generated: TranscriptBlock[]): string {
  const p = parseNote(md);
  const merged = mergeTranscript(p.inner, p.state, generated);
  return writeRegion(md, merged.blocks, merged.state);
}

function regionBlocks(md: string): string[] {
  return splitBlocks(parseNote(md).inner);
}

describe("note parsing", () => {
  it("splits frontmatter, region and typed notes", () => {
    const md = `${FM}typed above\n${START_MARKER}\nalpha\n\nbeta\n%% ink-notebook:end v1 k1.aaaaaa.aaaaaa %%\ntyped below\n`;
    const p = parseNote(md);
    expect(p.frontmatter).toBe(FM);
    expect(p.before).toBe("typed above");
    expect(p.inner).toBe("alpha\n\nbeta");
    expect(p.after).toBe("typed below\n");
    expect(p.state).toEqual([{ key: "k1", gen: "aaaaaa", emit: "aaaaaa" }]);
    expect(p.damaged).toBe(false);
  });

  it("reports damaged markers without losing text", () => {
    const md = `${FM}${START_MARKER}\nalpha\n${START_MARKER}\n`;
    const p = parseNote(md);
    expect(p.damaged).toBe(true);
    expect(p.hasRegion).toBe(false);
    expect(stripMarkers(md)).toBe(`${FM}alpha\n`);
  });

  it("handles notes without frontmatter or region", () => {
    const p = parseNote("just text");
    expect(p).toMatchObject({ frontmatter: "", before: "just text", hasRegion: false, damaged: false });
  });

  it("round-trips the state encoding", () => {
    const st = [
      { key: "pabc", gen: "123456", emit: "123456" },
      { key: "u99", gen: "", emit: "abcdef" },
      { key: "dxyz", gen: "111111", emit: "-" },
    ];
    expect(decodeState(`v1 ${encodeState(st)}`)).toEqual(st);
    expect(decodeState("garbage")).toBeNull();
    expect(decodeState("v1 bad|entry")).toBeNull();
  });

  it("keeps fenced code together when splitting blocks", () => {
    expect(splitBlocks("a\n\n```\nx\n\ny\n```\n\nb")).toEqual(["a", "```\nx\n\ny\n```", "b"]);
  });
});

describe("mergeTranscript", () => {
  const gen1: TranscriptBlock[] = [
    { key: "p1", md: "Hello wrld" },
    { key: "d1", md: "![[Page.excalidraw#^area=R1|300]]" },
    { key: "p2", md: "Second paragraph" },
  ];

  it("creates a region at the top and keeps typed notes", () => {
    const md = sync(`${FM}my typed notes\n`, gen1);
    expect(md.startsWith(`${FM}${START_MARKER}\nHello wrld\n\n![[Page`)).toBe(true);
    expect(md.trimEnd().endsWith("my typed notes")).toBe(true);
    expect(regionBlocks(md)).toEqual(gen1.map((g) => g.md));
  });

  it("is idempotent", () => {
    const once = sync(`${FM}`, gen1);
    expect(sync(once, gen1)).toBe(once);
  });

  it("replaces unedited blocks with new content", () => {
    const once = sync(FM, gen1);
    const gen2 = [{ key: "p1", md: "Hello world" }, ...gen1.slice(1)];
    expect(regionBlocks(sync(once, gen2))[0]).toBe("Hello world");
  });

  it("preserves a user's correction while the ink is unchanged", () => {
    const once = sync(FM, gen1);
    const edited = once.replace("Hello wrld", "Hello world (fixed)");
    const twice = sync(edited, gen1);
    expect(regionBlocks(twice)).toEqual(["Hello world (fixed)", gen1[1].md, gen1[2].md]);
    // and keeps it on further syncs
    expect(regionBlocks(sync(twice, gen1))).toEqual(regionBlocks(twice));
  });

  it("drops the correction when the handwriting changed (new key)", () => {
    const edited = sync(FM, gen1).replace("Hello wrld", "Hello world (fixed)");
    const gen2 = [{ key: "p1b", md: "Hello wonderful world" }, ...gen1.slice(1)];
    expect(regionBlocks(sync(edited, gen2))).toEqual(["Hello wonderful world", gen1[1].md, gen1[2].md]);
  });

  it("remembers deleted blocks", () => {
    const once = sync(FM, gen1);
    const deleted = once.replace("![[Page.excalidraw#^area=R1|300]]\n\n", "");
    const twice = sync(deleted, gen1);
    expect(regionBlocks(twice)).toEqual(["Hello wrld", "Second paragraph"]);
    expect(regionBlocks(sync(twice, gen1))).toEqual(["Hello wrld", "Second paragraph"]);
  });

  it("keeps user insertions in place, even when their anchor disappears", () => {
    const once = sync(FM, gen1);
    const inserted = once.replace("Hello wrld\n\n", "Hello wrld\n\nMy own remark about this\n\n");
    const twice = sync(inserted, gen1);
    expect(regionBlocks(twice)).toEqual(["Hello wrld", "My own remark about this", gen1[1].md, gen1[2].md]);
    // anchor p1 disappears: the remark moves to the start, but is not lost
    const gen2 = gen1.slice(1);
    expect(regionBlocks(sync(twice, gen2))).toEqual(["My own remark about this", gen1[1].md, gen1[2].md]);
  });

  it("handles a block split by the user (correction + insertion)", () => {
    const once = sync(FM, gen1);
    const split = once.replace("Hello wrld", "Hello\n\nworld");
    const twice = sync(split, gen1);
    expect(regionBlocks(twice)).toEqual(["Hello", "world", gen1[1].md, gen1[2].md]);
  });

  it("does not duplicate content when the state was lost", () => {
    const once = sync(FM, gen1);
    const noState = once.replace(/%% ink-notebook:end.*%%/, "%% ink-notebook:end %%");
    expect(regionBlocks(sync(noState, gen1))).toEqual(gen1.map((g) => g.md));
  });

  it("treats unknown content in a fresh region as user text", () => {
    const md = `${FM}${START_MARKER}\nSomething I wrote\n%% ink-notebook:end %%\n`;
    expect(regionBlocks(sync(md, gen1))).toEqual(["Something I wrote", ...gen1.map((g) => g.md)]);
  });

  it("de-duplicates colliding keys", () => {
    const merged = mergeTranscript("", [], [
      { key: "x", md: "a" },
      { key: "x", md: "b" },
    ]);
    expect(merged.state.map((s) => s.key)).toEqual(["x", "x1"]);
  });

  it("uses short hashes", () => {
    expect(blockHash("abc")).toMatch(/^[0-9a-f]{6}$/);
    expect(blockHash("abc  \n")).toBe(blockHash("abc"));
  });
});

describe("review regressions", () => {
  const gen1: TranscriptBlock[] = [
    { key: "p1", md: "Meetng notes" },
    { key: "p2", md: "Second paragraph" },
    { key: "p3", md: "Third" },
  ];

  function syncWith(md: string, generated: TranscriptBlock[], keepMissing = false): string {
    const p = parseNote(md);
    const merged = mergeTranscript(p.inner, p.state, generated, { keepMissing });
    return writeRegion(md, merged.blocks, merged.state);
  }

  it("keeps corrections and deletions through a sync where the ink is pending", () => {
    let md = syncWith(FM, gen1);
    md = md.replace("Meetng notes", "Meeting notes").replace("Third\n\n", "").replace("\n\nThird", "");
    md = syncWith(md, gen1);
    expect(regionBlocks(md)).toEqual(["Meeting notes", "Second paragraph"]);
    // offline: nothing recognised, only a status block and a page embed are generated
    const offline: TranscriptBlock[] = [
      { key: "status", md: "> [!ink-status] waiting" },
      { key: "e1", md: "![[Page.excalidraw]]" },
    ];
    md = syncWith(md, offline, true);
    expect(regionBlocks(md)).toEqual(["> [!ink-status] waiting", "Meeting notes", "Second paragraph", "![[Page.excalidraw]]"]);
    // back online: the correction and the deletion are still remembered
    md = syncWith(md, gen1);
    expect(regionBlocks(md)).toEqual(["Meeting notes", "Second paragraph"]);
  });

  it("preserves a blank line between typed text and the transcript", () => {
    const md = `${FM}- item\n\n${START_MARKER}\nA\n%% ink-notebook:end v1 %%\n`;
    const once = syncWith(md, [{ key: "a", md: "A" }]);
    expect(once).toContain("- item\n\n%% ink-notebook:start %%");
    expect(syncWith(once, [{ key: "a", md: "A" }])).toBe(once);
  });

  it("ignores marker lines inside code blocks and extra markers", () => {
    const md = `${FM}${START_MARKER}\nA\n%% ink-notebook:end v1 %%\n\n\`\`\`\n${START_MARKER}\n\`\`\`\n`;
    const p = parseNote(md);
    expect(p.damaged).toBe(false);
    expect(p.inner).toBe("A");
    expect(stripMarkers(md)).toContain(`\`\`\`\n${START_MARKER}\n\`\`\``);
    const twice = `${FM}${START_MARKER}\nA\n%% ink-notebook:end v1 %%\n${START_MARKER}\nB\n%% ink-notebook:end v1 %%\n`;
    expect(parseNote(twice)).toMatchObject({ damaged: false, inner: "A" });
  });

  it("recognises frontmatter with a BOM, CRLF or trailing spaces on the fence", () => {
    for (const fm of ["﻿---\na: 1\n---\n", "---\r\na: 1\r\n---\r\n", "---\na: 1\n---  \n"]) {
      const out = syncWith(`${fm}hello\n`, [{ key: "a", md: "A" }]);
      expect(out.replace("﻿", "").startsWith("---\na: 1\n---")).toBe(true);
      expect(out).toContain(`${START_MARKER}\nA\n`);
      expect(out.trimEnd().endsWith("hello")).toBe(true);
    }
  });
});
