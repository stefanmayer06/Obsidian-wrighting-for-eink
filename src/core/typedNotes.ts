import { contentHash } from "./hash";
import { parseNote } from "./transcript";

/**
 * "Typed notes" are everything on the text page outside the handwriting
 * transcript region. They are mirrored onto the ink page as a text card.
 */

/** Remove Obsidian comments (%%…%%) and trailing whitespace; keep everything else verbatim. */
export function cleanTypedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/%%[\s\S]*?%%/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTypedNotes(md: string): string {
  const p = parseNote(md);
  if (!p.hasRegion) return cleanTypedText(p.before);
  const parts = [cleanTypedText(p.before), cleanTypedText(p.after)].filter(Boolean);
  return parts.join("\n\n");
}

export function typedHash(text: string): string {
  return contentHash(cleanTypedText(text));
}

/**
 * Write typed notes edited on the ink page back into the text page.
 * The transcript region and frontmatter are kept. When typed notes exist both
 * above and below the region, we try to keep that split; otherwise the notes go
 * below the transcript.
 */
export function applyTypedNotes(md: string, newTyped: string): string {
  const p = parseNote(md);
  const text = newTyped.replace(/\r\n/g, "\n").trim();
  if (!p.hasRegion) {
    return `${p.frontmatter}${text}${text ? "\n" : ""}`;
  }
  const before = cleanTypedText(p.before);
  const after = cleanTypedText(p.after);
  let newBefore = "";
  let newAfter = text;
  if (before && after) {
    if (text.startsWith(before)) {
      newBefore = p.before.trim();
      newAfter = text.slice(before.length).trim();
    } else if (text.endsWith(after)) {
      newAfter = p.after.trim();
      newBefore = text.slice(0, text.length - after.length).trim();
    }
  } else if (before && !after) {
    newBefore = text;
    newAfter = "";
  }
  const region = p.regionRaw;
  return `${p.frontmatter}${newBefore ? newBefore + "\n\n" : ""}${region}\n${newAfter ? "\n" + newAfter + "\n" : ""}`;
}
