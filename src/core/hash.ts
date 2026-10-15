/** Small, fast, dependency-free string hashing (FNV-1a, 32 bit). */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Hex hash of the given length (max 8). */
export function shortHash(input: string, length = 8): string {
  return fnv1a(input).toString(16).padStart(8, "0").slice(0, Math.min(8, Math.max(4, length)));
}

/** Normalise text before hashing so whitespace-only edits do not count as changes. */
export function normalizeForHash(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

export function contentHash(text: string): string {
  return shortHash(normalizeForHash(text), 8);
}
