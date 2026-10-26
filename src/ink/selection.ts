import type { Rect } from "../core/geometry";
import { selectionSize } from "../core/ink/model";
import { INK_COLORS } from "../core/ink/pens";
import { apply, canRotate, type Matrix } from "../core/ink/transform";
import type { InkSurface } from "./surface";
import type { SelectionAction } from "./types";

/**
 * The lasso selection on screen: a dashed box with a resize handle (bottom
 * right) and a rotate handle (top), and a bar of large buttons for what can be
 * done with it, like the lasso menu of the Boox Notes app.
 */

const HANDLE_PX = 30;

export class SelectionOverlay {
  private box: HTMLElement;
  private scaleHandle: HTMLElement;
  private rotateHandle: HTMLElement;
  private bar: HTMLElement;
  private palette: HTMLElement;
  private screenBox: Rect | null = null;
  private barFor = "";

  constructor(private s: InkSurface) {
    const doc = s.el.ownerDocument;
    const make = (cls: string, parent: HTMLElement = s.overlay) => {
      const d = doc.createElement("div");
      d.className = cls;
      parent.appendChild(d);
      return d;
    };
    this.box = make("ink-selection");
    this.scaleHandle = make("ink-handle ink-handle-scale");
    this.rotateHandle = make("ink-handle ink-handle-rotate");
    this.bar = make("ink-selection-bar ink-ui");
    this.palette = make("ink-selection-palette ink-ui");
    for (const el of [this.box, this.scaleHandle, this.rotateHandle, this.bar, this.palette]) el.hidden = true;
    // buttons react on pointerup (pointerdown would reach the page on some WebViews)
    for (const el of [this.bar, this.palette]) {
      el.addEventListener("pointerdown", (e) => e.stopPropagation());
    }
  }

  /** Which handle is at a screen position (client coordinates). */
  handleAt(clientX: number, clientY: number): "scale" | "rotate" | null {
    const b = this.screenBox;
    if (!b) return null;
    const rect = this.s.el.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const near = (hx: number, hy: number) => Math.abs(x - hx) <= HANDLE_PX && Math.abs(y - hy) <= HANDLE_PX;
    if (near(b.x + b.w, b.y + b.h)) return "scale";
    if (!this.rotateHandle.hidden && near(b.x + b.w / 2, b.y - 34)) return "rotate";
    return null;
  }

  /** Place the box (optionally as transformed by a running drag). */
  update(matrix?: Matrix): void {
    const sel = this.s.selection;
    const bounds = selectionSize(sel) > 0 ? this.s.selectionBounds() : null;
    if (!bounds) {
      this.screenBox = null;
      for (const el of [this.box, this.scaleHandle, this.rotateHandle, this.bar, this.palette]) el.hidden = true;
      this.barFor = "";
      return;
    }
    let r = bounds;
    if (matrix) {
      const pts = [
        { x: r.x, y: r.y },
        { x: r.x + r.w, y: r.y },
        { x: r.x + r.w, y: r.y + r.h },
        { x: r.x, y: r.y + r.h },
      ].map((p) => apply(matrix, p));
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      r = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    const tl = this.s.toScreen({ x: r.x, y: r.y });
    const sb = { x: tl.x - 6, y: tl.y - 6, w: r.w * this.s.view.scale + 12, h: r.h * this.s.view.scale + 12 };
    this.screenBox = sb;
    const place = (el: HTMLElement, x: number, y: number, w?: number, h?: number) => {
      el.hidden = false;
      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
      if (w !== undefined) el.style.width = `${Math.round(w)}px`;
      if (h !== undefined) el.style.height = `${Math.round(h)}px`;
    };
    place(this.box, sb.x, sb.y, sb.w, sb.h);
    place(this.scaleHandle, sb.x + sb.w - 11, sb.y + sb.h - 11);
    const items = this.s.selectedItems();
    if (canRotate(items)) place(this.rotateHandle, sb.x + sb.w / 2 - 11, sb.y - 45);
    else this.rotateHandle.hidden = true;
    if (matrix) {
      this.bar.hidden = true;
      this.palette.hidden = true;
      return;
    }
    const key = [...sel.strokes, ...sel.texts, ...sel.images, ...sel.links, ...sel.figures].join(",");
    if (key !== this.barFor) {
      this.barFor = key;
      this.buildBar();
      this.palette.hidden = true;
    }
    this.bar.hidden = false;
    // above the selection if there is room, else below it
    const barH = this.bar.offsetHeight || 56;
    const barW = this.bar.offsetWidth || 300;
    let y = sb.y - barH - (this.rotateHandle.hidden ? 12 : 58);
    if (y < 4) y = sb.y + sb.h + 14;
    if (y + barH > this.s.height - 4) y = Math.max(4, this.s.height - barH - 4);
    const x = Math.max(4, Math.min(this.s.width - barW - 4, sb.x + sb.w / 2 - barW / 2));
    place(this.bar, x, y);
    if (!this.palette.hidden) place(this.palette, x, y + barH + 6 > this.s.height - 60 ? y - 64 : y + barH + 6);
  }

  private buildBar(): void {
    const s = this.s;
    this.bar.replaceChildren();
    const actions: SelectionAction[] = [
      { id: "delete", icon: "trash-2", label: "Delete", run: () => s.deleteSelection() },
      { id: "cut", icon: "scissors", label: "Cut", run: () => s.cutSelection() },
      { id: "copy", icon: "copy", label: "Copy", run: () => s.copySelection() },
      { id: "duplicate", icon: "copy-plus", label: "Duplicate", run: () => s.duplicateSelection() },
      { id: "color", icon: "palette", label: "Colour", run: () => this.togglePalette() },
      { id: "figure", icon: "frame", label: "Figure", run: () => s.makeFigure() },
      ...(s.host.selectionActions?.() ?? []),
      { id: "done", icon: "x", label: "Done", run: () => s.setSelection({ strokes: new Set(), texts: new Set(), images: new Set(), links: new Set(), figures: new Set() }) },
    ];
    for (const a of actions) {
      const b = this.bar.ownerDocument.createElement("button");
      b.className = `ink-sel-btn ink-sel-${a.id}`;
      b.type = "button";
      b.setAttribute("aria-label", a.label);
      b.title = a.label;
      const icon = this.bar.ownerDocument.createElement("span");
      icon.className = "ink-sel-icon";
      s.host.icon(icon, a.icon);
      const label = this.bar.ownerDocument.createElement("span");
      label.className = "ink-sel-label";
      label.textContent = a.label;
      b.append(icon, label);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        a.run();
        this.update();
      });
      this.bar.appendChild(b);
    }
  }

  private togglePalette(): void {
    if (!this.palette.hidden) {
      this.palette.hidden = true;
      return;
    }
    this.palette.replaceChildren();
    for (const c of INK_COLORS) {
      const b = this.palette.ownerDocument.createElement("button");
      b.className = "ink-swatch-btn";
      b.type = "button";
      b.title = c.label;
      b.setAttribute("aria-label", c.label);
      b.style.setProperty("--swatch", c.color);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.s.recolorSelection(c.color);
        this.palette.hidden = true;
        this.update();
      });
      this.palette.appendChild(b);
    }
    this.palette.hidden = false;
    this.update();
  }
}
