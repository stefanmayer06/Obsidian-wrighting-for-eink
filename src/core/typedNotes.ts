import { parseNote } from "./transcript";

/**
 * "Typed notes" are everything on the text page outside the handwriting
 * transcript region. The ink page shows them (and lets you edit them) in its
 * typed-notes panel.
 */

/**
 * Normalise typed notes. Deliberately lossless (comments, hard line breaks and
 * blank lines are kept) so that editing them on the ink page and writing them
 * back never drops anything; only line endings and outer blank lines are normalised.
 */
export function cleanTypedText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^\s*\n/, "").replace(/\n\s*$/, "").replace(/^\s+$/, "");
}

export function extractTypedNotes(md: string): string {
  const p = parseNote(md);
  if (!p.hasRegion) return cleanTypedText(p.before);
  const parts = [cleanTypedText(p.before), cleanTypedText(p.after)].filter(Boolean);
  return parts.join("\n\n");
}

/**
 * Write typed notes edited on the ink page back into the text page.
 * The transcript region and frontmatter are kept. When typed notes exist both
 * above and below the region, we try to keep that split; otherwise the notes go
 * below the transcript.
 */
export function applyTypedNotes(md: string, newTyped: string): string {
  const p = parseNote(md);
  const text = cleanTypedText(newTyped);
  if (!p.hasRegion) {
    return `${p.frontmatter}${text}${text ? "\n" : ""}`;
  }
  const before = cleanTypedText(p.before);
  const after = cleanTypedText(p.after);
  let newBefore = "";
  let newAfter = text;
  if (before && after) {
    // keep the split only at a line boundary
    if (text === before || text.startsWith(`${before}\n`)) {
      newBefore = cleanTypedText(p.before);
      newAfter = cleanTypedText(text.slice(before.length));
    } else if (text === after || text.endsWith(`\n${after}`)) {
      newAfter = cleanTypedText(p.after);
      newBefore = cleanTypedText(text.slice(0, text.length - after.length));
    }
  } else if (before && !after) {
    newBefore = text;
    newAfter = "";
  }
  const region = p.regionRaw;
  return `${p.frontmatter}${newBefore ? newBefore + "\n\n" : ""}${region}\n${newAfter ? "\n" + newAfter + "\n" : ""}`;
}
