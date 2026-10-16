import { placeDock, type Box, type DockPreference, type DockSize } from "../core/dock";

/**
 * Keeps the bookmark stack clear of every other control on the page – the view
 * header, Excalidraw's toolbars and tool panels (desktop, tray and mobile
 * layouts), the status bar – on any screen size. It measures those controls and
 * re-places the stack whenever the page is resized or the controls change.
 */

/** Controls inside the page. Excalidraw's canvas, embeds and hints are not controls. */
const LOCAL_OBSTACLES = [
  ".view-header",
  ".excalidraw .Island",
  '.excalidraw [class*="misc-tools-container"]',
  ".excalidraw .App-toolbar",
  ".excalidraw .sidebar",
  ".excalidraw .sidebar-trigger",
  ".excalidraw .layer-ui__wrapper__top-right",
  ".excalidraw .layer-ui__wrapper__footer-right",
  ".excalidraw .ToolIcon",
  ".excalidraw button",
].join(", ");
const NOT_OBSTACLES = ".ink-bookmarks, .excalidraw__embeddable-container, .HintViewer";
/** App chrome that can float over the page. */
const GLOBAL_OBSTACLES = ".status-bar, .mobile-navbar, .mobile-toolbar";

const DEBOUNCE_MS = 120;
const MAX_WAIT_MS = 600;

function boxOf(el: Element): Box | null {
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return null;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

export class DockLayout {
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private timer: number | null = null;
  private firstScheduledAt = 0;
  private sizes: { key: string; full: DockSize; compact: DockSize } | null = null;
  private applied: { top: number; right: number; compact: boolean; fits: boolean } | null = null;
  private destroyed = false;

  constructor(
    private container: HTMLElement,
    private root: HTMLElement,
    private preferred: () => DockPreference,
  ) {
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.schedule());
      this.resizeObserver.observe(container);
    }
    // Excalidraw's panels come and go (tray/mobile layouts, zen mode, sidebars)
    this.mutationObserver = new MutationObserver((records) => {
      for (const r of records) {
        const t = r.target instanceof Element ? r.target : r.target.parentElement;
        if (!t || root.contains(t) || t.tagName === "CANVAS" || t.closest(".HintViewer")) continue;
        this.schedule();
        return;
      }
    });
    this.mutationObserver.observe(container, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"] });
    this.schedule(0);
  }

  /** Re-place the stack soon (debounced, but at least every MAX_WAIT_MS while things keep changing). */
  schedule(delay = DEBOUNCE_MS): void {
    if (this.destroyed) return;
    const now = Date.now();
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      if (now - this.firstScheduledAt >= MAX_WAIT_MS) delay = 0;
    } else {
      this.firstScheduledAt = now;
    }
    this.timer = window.setTimeout(() => {
      this.timer = null;
      try {
        this.update();
      } catch (e) {
        console.warn("Ink Notebook: placing the bookmarks failed", e);
      }
    }, delay);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
  }

  /** Sizes of the stack with and without labels (measured, so themes and large touch targets just work). */
  private measure(): { full: DockSize; compact: DockSize } {
    const root = this.root;
    const hidden = root.querySelectorAll(".is-hidden").length;
    const key = `${document.body.className}|${root.className.replace(/\bis-(compact|cramped|measuring)\b/g, "")}|${root.textContent ?? ""}|${hidden}`;
    if (this.sizes?.key === key) return this.sizes;
    const wasCompact = root.hasClass("is-compact");
    root.addClass("is-measuring"); // no transitions, or we would measure their start
    root.removeClass("is-compact");
    const f = root.getBoundingClientRect();
    root.addClass("is-compact");
    const c = root.getBoundingClientRect();
    root.toggleClass("is-compact", wasCompact);
    root.removeClass("is-measuring");
    this.sizes = { key, full: { width: f.width, height: f.height }, compact: { width: c.width, height: c.height } };
    return this.sizes;
  }

  private obstacles(container: Box): Box[] {
    const out: Box[] = [];
    // only the right half matters; skip the rest before asking for computed styles
    const mid = (container.left + container.right) / 2;
    const consider = (el: Element) => {
      const b = boxOf(el);
      if (!b || b.right <= mid || b.left >= container.right || b.bottom <= container.top || b.top >= container.bottom) return;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) < 0.05) return;
      out.push(b);
    };
    for (const el of Array.from(this.container.querySelectorAll(LOCAL_OBSTACLES))) {
      if (!el.closest(NOT_OBSTACLES)) consider(el);
    }
    for (const el of Array.from(document.querySelectorAll(GLOBAL_OBSTACLES))) {
      if (!this.container.contains(el)) consider(el);
    }
    return out;
  }

  update(): void {
    if (this.destroyed || !this.root.isConnected || !this.container.isConnected) return;
    const container = boxOf(this.container);
    if (!container) return; // tab in the background
    const { full, compact } = this.measure();
    if (full.height < 1) return;
    const p = placeDock({ container, obstacles: this.obstacles(container), full, compact, preferred: this.preferred(), gap: 8 });
    const a = this.applied;
    // avoid tiny moves: every repaint costs a refresh on e-ink screens
    if (a && a.compact === p.compact && a.right === p.right && a.fits === p.fits && Math.abs(a.top - p.top) < 3) return;
    this.applied = p;
    this.root.style.top = `${p.top}px`;
    this.root.style.right = `${p.right}px`;
    this.root.toggleClass("is-compact", p.compact);
    this.root.toggleClass("is-cramped", !p.fits);
  }
}
