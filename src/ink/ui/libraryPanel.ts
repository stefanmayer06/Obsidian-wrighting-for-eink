import type { LibraryItem } from "../../core/ink/excalidrawLib";
import { itemsBounds } from "../../core/ink/transform";
import { drawItems } from "../render";
import type { InkSurface } from "../surface";
import type { ToolState } from "../types";
import { button, el, type IconFn } from "./popover";

/**
 * The object library next to the page: shapes for flowcharts and the items of
 * Excalidraw libraries. Tap an item, then tap the page to put it there – as
 * often as needed, until another tool is chosen.
 */

export interface LibrarySource {
  id: string;
  name: string;
  /** The built-in flowchart shapes: shows the connector buttons. */
  flowchart?: boolean;
  /** Items can be removed (the user's own library). */
  editable?: boolean;
  /** What to show while the library has no items. */
  emptyHint?: string;
}

export interface LibraryHost {
  icon: IconFn;
  sources(): Promise<LibrarySource[]>;
  items(sourceId: string): Promise<LibraryItem[]>;
  /** Change the tools (and remember the change). */
  setTools(patch: Partial<ToolState>): void;
  /** Buttons under the items (importing libraries…). */
  actions(): Array<{ icon: string; label: string; run(): void }>;
  /** Remove an item from an editable library. */
  removeItem?(sourceId: string, itemId: string): Promise<void>;
  /** The library shown last (remembered between sessions). */
  lastSource?: string;
  sourceChanged?(id: string): void;
}

const THUMB_W = 132;
const THUMB_H = 84;

export class LibraryPanel {
  readonly el: HTMLElement;
  private sourcesEl: HTMLElement;
  private connectEl: HTMLElement;
  private grid: HTMLElement;
  private hint: HTMLElement;
  private sources: LibrarySource[] = [];
  private current = "";
  private items: LibraryItem[] = [];
  private tiles = new Map<string, HTMLButtonElement>();
  private renderTimer: number | null = null;
  private closed = false;
  private title: HTMLElement;
  private foldBtn: HTMLButtonElement;

  constructor(
    parent: HTMLElement,
    private surface: InkSurface,
    private host: LibraryHost,
    private onClose: () => void,
  ) {
    this.el = el(parent, "div", "ink-library-panel ink-ui");
    const head = el(this.el, "div", "ink-library-head");
    this.title = el(head, "span", "ink-library-title", "Object library");
    // folded, only this bar is left: the whole page can be reached
    this.title.addEventListener("click", () => this.folded && this.fold(false));
    this.foldBtn = button(head, host.icon, { icon: "chevron-up", label: "Fold the library away", cls: "ink-library-fold", onClick: () => this.fold(!this.folded) });
    button(head, host.icon, { icon: "x", label: "Close", cls: "ink-library-close", onClick: () => this.close() });
    this.sourcesEl = el(this.el, "div", "ink-library-sources");
    this.connectEl = el(this.el, "div", "ink-library-connect");
    this.hint = el(this.el, "p", "ink-library-hint");
    this.grid = el(this.el, "div", "ink-library-grid");
    const foot = el(this.el, "div", "ink-library-actions");
    for (const a of host.actions()) button(foot, host.icon, { icon: a.icon, label: a.label, showLabel: true, cls: "ink-library-action", onClick: () => a.run() });
    // the page must not see presses on the panel
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.current = host.lastSource ?? "";
    void this.reload();
  }

  /** Read the list of libraries again (after an import); `pick` an item of it to place. */
  async reload(select?: string, pick?: string): Promise<void> {
    this.sources = await this.host.sources();
    if (this.closed) return;
    if (select) this.current = select;
    if (!this.sources.some((s) => s.id === this.current)) this.current = this.sources[0]?.id ?? "";
    this.renderSources();
    await this.show(this.current);
    const item = pick ? this.items.find((it) => it.id === pick) : undefined;
    if (item && !this.closed && !(this.surface.tools.tool === "stamp" && this.surface.stamp?.id === item.id)) {
      this.pick(item);
      this.tiles.get(item.id)?.scrollIntoView({ block: "nearest" });
    }
  }

  private renderSources(): void {
    this.sourcesEl.replaceChildren();
    for (const src of this.sources) {
      const b = button(this.sourcesEl, this.host.icon, {
        label: src.name,
        showLabel: true,
        cls: `ink-library-source${src.id === this.current ? " is-active" : ""}`,
        onClick: () => void this.show(src.id),
      });
      b.setAttribute("aria-pressed", String(src.id === this.current));
    }
  }

  private async show(id: string): Promise<void> {
    this.current = id;
    this.host.sourceChanged?.(id);
    this.renderSources();
    const src = this.sources.find((s) => s.id === id);
    this.renderConnect(!!src?.flowchart);
    this.grid.replaceChildren();
    this.tiles.clear();
    if (!src) {
      this.hint.textContent = "No libraries yet.";
      return;
    }
    this.hint.textContent = "Loading…";
    try {
      this.items = await this.host.items(id);
    } catch (e) {
      if (this.current !== id) return;
      this.items = [];
      this.hint.textContent = `This library could not be read: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    if (this.current !== id || this.closed) return;
    this.hint.textContent =
      this.items.length === 0
        ? (src.emptyHint ??
          (src.editable ? "Nothing here yet. Select something on the page with the lasso and tap “To library” to keep it here." : "This library has no items that can be drawn."))
        : "Tap an item, then tap the page where it should go – as often as you like. Choose a tool to stop.";
    this.renderItems(src);
  }

  private renderConnect(show: boolean): void {
    this.connectEl.replaceChildren();
    this.connectEl.hidden = !show;
    if (!show) return;
    el(this.connectEl, "span", "ink-library-connect-label", "Connect:");
    const t = this.surface.tools;
    const pick = (shape: "arrow" | "elbow") => {
      this.host.setTools({ tool: "shape", shape });
      this.markActive();
      this.renderConnect(true);
    };
    const active = (shape: string) => (t.tool === "shape" && t.shape === shape ? " is-active" : "");
    button(this.connectEl, this.host.icon, { icon: "move-up-right", label: "Arrow", showLabel: true, cls: `ink-library-tool${active("arrow")}`, onClick: () => pick("arrow") });
    button(this.connectEl, this.host.icon, { icon: "corner-down-right", label: "Elbow arrow", showLabel: true, cls: `ink-library-tool${active("elbow")}`, onClick: () => pick("elbow") });
  }

  private renderItems(src: LibrarySource): void {
    const queue: Array<{ canvas: HTMLCanvasElement; item: LibraryItem }> = [];
    for (const it of this.items) {
      const tile = this.grid.ownerDocument.createElement("button");
      tile.type = "button";
      tile.className = "ink-library-tile";
      tile.title = it.name;
      tile.setAttribute("aria-label", it.name);
      const canvas = this.grid.ownerDocument.createElement("canvas");
      canvas.className = "ink-library-thumb";
      tile.appendChild(canvas);
      const name = this.grid.ownerDocument.createElement("span");
      name.className = "ink-library-name";
      name.textContent = it.name;
      tile.appendChild(name);
      tile.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.pick(it);
      });
      const remove = this.host.removeItem;
      if (src.editable && remove) {
        const x = this.grid.ownerDocument.createElement("span");
        x.className = "ink-library-remove";
        x.setAttribute("role", "button");
        x.setAttribute("aria-label", `Remove “${it.name}”`);
        x.title = "Remove from the library";
        this.host.icon(x, "trash-2");
        x.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          void remove(src.id, it.id).then(() => this.show(src.id));
        });
        tile.appendChild(x);
      }
      this.grid.appendChild(tile);
      this.tiles.set(it.id, tile);
      queue.push({ canvas, item: it });
    }
    this.markActive();
    // draw the thumbnails a few at a time: a big library must not block the page
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    const step = () => {
      this.renderTimer = null;
      for (const job of queue.splice(0, 16)) drawThumb(job.canvas, job.item);
      if (queue.length > 0 && !this.closed) this.renderTimer = window.setTimeout(step, 16);
    };
    step();
  }

  private pick(it: LibraryItem): void {
    const placing = this.surface.tools.tool === "stamp" && this.surface.stamp?.id === it.id;
    if (placing) this.surface.setStamp(null);
    else this.surface.setStamp({ id: it.id, name: it.name, items: it.items, restyle: !!it.restyle, fitPage: !!it.fitPage });
    this.host.setTools({});
    this.markActive();
    this.renderConnect(!!this.sources.find((s) => s.id === this.current)?.flowchart);
    // on a narrow screen the panel covers much of the page: fold it while placing
    if (!placing && this.surface.width < 900) this.fold(true);
  }

  get folded(): boolean {
    return this.el.classList.contains("is-folded");
  }

  /** Fold the panel down to its title bar (or open it again). */
  fold(folded: boolean): void {
    this.el.classList.toggle("is-folded", folded);
    this.foldBtn.replaceChildren();
    this.host.icon(this.foldBtn, folded ? "chevron-down" : "chevron-up");
    const label = folded ? "Show the library" : "Fold the library away";
    this.foldBtn.setAttribute("aria-label", label);
    this.foldBtn.title = label;
    this.markActive();
  }

  /** Show which item is being placed (after the tool changed elsewhere too). */
  markActive(): void {
    const stamp = this.surface.tools.tool === "stamp" ? this.surface.stamp : null;
    for (const [key, tile] of this.tiles) {
      tile.classList.toggle("is-active", key === stamp?.id);
      tile.setAttribute("aria-pressed", String(key === stamp?.id));
    }
    const title = this.folded && stamp ? `Placing “${stamp.name}”` : "Object library";
    if (this.title.textContent !== title) this.title.textContent = title;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.el.remove();
    this.onClose();
  }
}

/** A library item drawn small, on white. */
export function drawThumb(canvas: HTMLCanvasElement, it: LibraryItem): void {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.round(THUMB_W * dpr);
  canvas.height = Math.round(THUMB_H * dpr);
  canvas.style.width = `${THUMB_W}px`;
  canvas.style.height = `${THUMB_H}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const box = itemsBounds(it.items);
  if (!box) return;
  const pad = 8;
  const k = Math.min((THUMB_W - 2 * pad) / Math.max(1, box.w), (THUMB_H - 2 * pad) / Math.max(1, box.h), 1.5) * dpr;
  const ox = (canvas.width - box.w * k) / 2 - box.x * k;
  const oy = (canvas.height - box.h * k) / 2 - box.y * k;
  ctx.setTransform(k, 0, 0, k, ox, oy);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  // thin lines would disappear when made small
  const minWidth = 1.2 / k;
  drawItems(ctx, { ...it.items, strokes: it.items.strokes.map((s) => (s.width < minWidth && !s.area ? { ...s, width: minWidth } : s)) });
}
