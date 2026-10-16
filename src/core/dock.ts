/**
 * Placement of the bookmark stack on the right edge of a page so that it never
 * covers other controls (Excalidraw's tool panels, the view header, the status
 * bar, …), whatever the screen size. Pure geometry – the DOM side measures the
 * boxes and applies the result.
 */

/** A box in viewport coordinates. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DockSize {
  width: number;
  height: number;
}

export type DockPreference = "top" | "middle" | "bottom";

export interface DockInput {
  /** The page (view) the stack lives in. */
  container: Box;
  /** Controls the stack must not cover. */
  obstacles: ReadonlyArray<Box>;
  /** Size of the stack with labels. */
  full: DockSize;
  /** Size of the stack in compact mode (icons only). */
  compact: DockSize;
  preferred: DockPreference;
  /** Minimum distance to obstacles and to the top/bottom edge. */
  gap?: number;
}

export interface DockPlacement {
  /** Distance from the container's top edge. */
  top: number;
  /** Distance from the container's right edge. */
  right: number;
  compact: boolean;
  /** false when nothing fits without overlap (very small screens): least overlap is used. */
  fits: boolean;
}

/** Where the preferred position puts the stack's top edge. */
function targetTop(preferred: DockPreference, containerHeight: number, stackHeight: number): number {
  if (preferred === "middle") return (containerHeight - stackHeight) / 2;
  if (preferred === "bottom") return containerHeight * 0.72 - stackHeight;
  return containerHeight * 0.25;
}

type Interval = [number, number];

/** Vertical intervals (relative to the container top) blocked inside the strip [left, right]. */
function blockedIntervals(input: DockInput, left: number, right: number, gap: number): Interval[] {
  const { container } = input;
  const out: Interval[] = [];
  for (const o of input.obstacles) {
    if (o.right <= o.left || o.bottom <= o.top) continue;
    if (o.left >= right || o.right <= left) continue;
    if (o.bottom <= container.top || o.top >= container.bottom) continue;
    out.push([o.top - container.top - gap, o.bottom - container.top + gap]);
  }
  out.sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

function freeIntervals(blocked: Interval[], from: number, to: number): Interval[] {
  const free: Interval[] = [];
  let cur = from;
  for (const [a, b] of blocked) {
    if (a > cur) free.push([cur, Math.min(a, to)]);
    cur = Math.max(cur, b);
    if (cur >= to) break;
  }
  if (cur < to) free.push([cur, to]);
  return free.filter(([a, b]) => b > a);
}

/** Best top position for a stack of `size` at `inset` from the right edge, or null if it does not fit. */
function findSlot(input: DockInput, size: DockSize, inset: number, gap: number): number | null {
  const { container } = input;
  const height = container.bottom - container.top;
  const right = container.right - inset;
  const left = right - size.width;
  if (left < container.left) return null;
  const free = freeIntervals(blockedIntervals(input, left, right, gap), gap, height - gap);
  const target = targetTop(input.preferred, height, size.height);
  let best: number | null = null;
  for (const [a, b] of free) {
    if (b - a < size.height) continue;
    const top = Math.min(Math.max(target, a), b - size.height);
    if (best === null || Math.abs(top - target) < Math.abs(best - target)) best = top;
  }
  return best;
}

/** Overlap (in px) of a stack at `top` with the blocked intervals. */
function overlapAt(blocked: Interval[], top: number, height: number): number {
  let sum = 0;
  for (const [a, b] of blocked) sum += Math.max(0, Math.min(b, top + height) - Math.max(a, top));
  return sum;
}

export function placeDock(input: DockInput): DockPlacement {
  const gap = input.gap ?? 8;
  const { container } = input;
  const height = container.bottom - container.top;

  // Moving away from the edge is only worth it to clear something that runs along it
  // (a docked sidebar, a tall tool panel) – try the edge first, then just left of obstacles.
  const insets = [0];
  for (const o of input.obstacles) {
    if (o.left >= container.right || o.right <= container.right - input.full.width) continue;
    if (o.bottom <= container.top || o.top >= container.bottom) continue;
    const inset = Math.ceil(container.right - o.left + gap);
    if (inset > 0 && !insets.includes(inset)) insets.push(inset);
  }
  insets.sort((a, b) => a - b);

  for (const size of [input.full, input.compact]) {
    const top = findSlot(input, size, 0, gap);
    if (top !== null) return { top: Math.round(top), right: 0, compact: size === input.compact, fits: true };
  }
  for (const inset of insets.slice(1)) {
    for (const size of [input.full, input.compact]) {
      const top = findSlot(input, size, inset, gap);
      if (top !== null) return { top: Math.round(top), right: inset, compact: size === input.compact, fits: true };
    }
  }

  // Nothing fits: compact stack on the edge where it covers the least.
  const size = input.compact;
  const blocked = blockedIntervals(input, container.right - size.width, container.right, gap);
  const target = targetTop(input.preferred, height, size.height);
  const maxTop = Math.max(0, height - size.height);
  let best = Math.min(Math.max(0, target), maxTop);
  let bestOverlap = overlapAt(blocked, best, size.height);
  for (let top = 0; top <= maxTop; top += 4) {
    const ov = overlapAt(blocked, top, size.height);
    if (ov < bestOverlap - 0.5 || (Math.abs(ov - bestOverlap) <= 0.5 && Math.abs(top - target) < Math.abs(best - target))) {
      best = top;
      bestOverlap = ov;
    }
  }
  return { top: Math.round(best), right: 0, compact: true, fits: false };
}

/** Do two boxes overlap (touching edges do not count)? */
export function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}
