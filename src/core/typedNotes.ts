import { contentHash } from "./hash";
import { parseNote } from "./transcript";

/**
 * "Typed notes" are everything on the text page outside the handwriting
 * transcript region. They are mirrored onto the ink page as a text card.
 */

/**
 * Normalise typed notes for the card. Deliberately lossless (comments, hard line
 * breaks and blank lines are kept) so that editing the card and writing it back
 * never drops anything; only line endings and outer blank lines are normalised.
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

/**
 * What to do with the typed notes, given the hash of the card on the drawing
 * (null = no card), the hash of the text page's typed notes and the hash both
 * had when they were last in sync (the "base").
 *
 *  - none      both sides agree and the base is current
 *  - mark      both sides agree, only the base needs updating
 *  - pull      only the card changed → copy the card to the text page
 *  - push      only the text page changed (or nothing is known) → update the card
 *  - conflict  both changed differently → the text page wins (with a notice)
 */
export type TypedSyncAction = "none" | "mark" | "pull" | "push" | "conflict";

export function decideTypedSync(cardHash: string | null, textHash: string, base: string | undefined): TypedSyncAction {
  const empty = typedHash("");
  if (cardHash === null) return textHash === empty ? "none" : "push";
  if (cardHash === textHash) return base === textHash ? "none" : "mark";
  if (base === undefined) return "push";
  if (textHash === base) return "pull";
  if (cardHash === base) return "push";
  return "conflict";
}
