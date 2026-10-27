import { joinPath } from "./folders";

/**
 * Daily notes, as the core Daily notes plugin (or Periodic Notes) makes them:
 * `<folder>/<date in format>.md`, where the format may contain folders
 * ("YYYY/MM/YYYY-MM-DD").
 */

export const DEFAULT_DAILY_FORMAT = "YYYY-MM-DD";

export interface DailyNoteConfig {
  /** Vault path of the folder ("" = root). */
  folder: string;
  /** Moment.js format of the note's path inside the folder. */
  format: string;
}

/** The settings as the plugins store them (any field may be missing). */
export function dailyConfigFrom(raw: { folder?: unknown; format?: unknown } | null | undefined): DailyNoteConfig {
  const folder = typeof raw?.folder === "string" ? joinPath(raw.folder.trim()) : "";
  const format = typeof raw?.format === "string" && raw.format.trim() ? raw.format.trim() : DEFAULT_DAILY_FORMAT;
  return { folder, format };
}

/**
 * The part of a note's path that is its date ("2026/10/2026-10-27" for
 * "Journal/2026/10/2026-10-27.md" in "Journal"), or null for a file outside
 * the folder. Whether it is a date is for the caller to check (with moment).
 */
export function dailyNoteDatePart(path: string, folder: string): string | null {
  if (!/\.md$/i.test(path)) return null;
  const rel = path.slice(0, -3);
  if (!folder) return rel;
  const prefix = `${folder}/`;
  return rel.toLowerCase().startsWith(prefix.toLowerCase()) ? rel.slice(prefix.length) : null;
}

/** Where the daily note for a date goes (`formatted` is the date in the config's format). */
export function dailyNotePath(cfg: DailyNoteConfig, formatted: string): string {
  return `${joinPath(cfg.folder, formatted)}.md`;
}
