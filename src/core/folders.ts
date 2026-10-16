/**
 * Folder layout of ink pages. The text page lives in a "home" folder (e.g. the
 * folder of the note you were in) and the ink files – the drawing and its paper
 * backgrounds – in a subfolder of it, like Obsidian's "attachments in a
 * subfolder under the current folder":
 *
 *   Computer Architecture/
 *     Attachments/
 *       Week 1.excalidraw.md
 *       ink-paper-lined.svg
 *     Week 1.md
 *
 * Paths are vault paths without leading/trailing slashes; "" is the vault root.
 */

export function joinPath(...parts: ReadonlyArray<string>): string {
  return parts
    .flatMap((p) => p.split("/"))
    .filter((p) => p !== "" && p !== ".")
    .join("/");
}

export function parentPath(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

export function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A subfolder name as typed in the settings, made safe ("./Ink/" → "Ink"; no ".." or illegal characters). */
export function cleanSubfolder(raw: string): string {
  return raw
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.replace(/[:*?"<>|]/g, "").trim())
    .filter((p) => p !== "" && p !== "." && p !== "..")
    .join("/");
}

/** Is `folder` the ink subfolder of some home folder? */
export function isInkSubfolder(folder: string, sub: string): boolean {
  if (!sub) return false;
  const f = folder.toLowerCase();
  const s = sub.toLowerCase();
  return f === s || f.endsWith(`/${s}`);
}

/** The home folder for a folder: the folder itself, or its parent when it is the ink subfolder. */
export function homeFolder(folder: string, sub: string): string {
  return isInkSubfolder(folder, sub) ? folder.slice(0, Math.max(0, folder.length - sub.length - 1)) : folder;
}

/** "a/Week 1.excalidraw.md" → "Week 1" */
export function plainName(path: string): string {
  return lastSegment(path).replace(/\.md$/i, "").replace(/\.excalidraw$/i, "");
}

/** ".excalidraw.md", ".excalidraw" or ".md" */
function pageSuffix(path: string): string {
  const m = /(\.excalidraw\.md|\.excalidraw|\.md)$/i.exec(path);
  return m ? m[1] : "";
}

/**
 * Where the partner of a renamed/moved page should go so the pair stays together,
 * or null when it should stay. `role` is the role of the file that was renamed.
 * Only a partner with the same name is moved, and only when it sat next to the
 * file, in its ink subfolder (text page moved) or in its home folder (drawing moved).
 */
export function partnerTarget(args: { role: "ink" | "text"; oldPath: string; newPath: string; partnerPath: string }): string | null {
  const { role, oldPath, newPath, partnerPath } = args;
  if (plainName(partnerPath) !== plainName(oldPath)) return null;
  const oldFolder = parentPath(oldPath);
  const newFolder = parentPath(newPath);
  const partnerFolder = parentPath(partnerPath);
  let target: string | null = null;
  if (partnerFolder === oldFolder) {
    target = newFolder;
  } else if (role === "text" && partnerFolder !== "" && parentPath(partnerFolder) === oldFolder) {
    // the drawing is in a subfolder of the text page's folder: keep it in the same subfolder
    target = joinPath(newFolder, lastSegment(partnerFolder));
  } else if (role === "ink" && oldFolder !== "" && parentPath(oldFolder) === partnerFolder) {
    // the drawing sat in the ink subfolder of the text page's folder
    if (newFolder !== oldFolder && newFolder !== "" && lastSegment(newFolder) === lastSegment(oldFolder)) target = parentPath(newFolder);
    else target = partnerFolder;
  }
  if (target === null) return null;
  const path = joinPath(target, plainName(newPath) + pageSuffix(partnerPath));
  return path === partnerPath ? null : path;
}
