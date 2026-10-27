import { INK_COLORS, MARKER_COLORS, PENS } from "../../core/ink/pens";
import { SHAPES, type ShapeKind } from "../../core/ink/shapes";
import type { InkSurface } from "../surface";
import type { EraserMode, SurfaceSettings, ToolId, ToolState, WritingPen } from "../types";
import { button, el, menu, Popover, section, swatches, thickness, tiles, toggle, type IconFn, type MenuSection } from "./popover";

/**
 * The toolbar of the ink page, laid out like the Boox Notes app: tools on the
 * left (pen, highlighter, eraser, lasso, shapes, text, insert, two favourite
 * pens, undo/redo), the pages on the right (previous, "3 / 12", next, add)
 * and the text page and the menu at the end. Tapping the selected tool again
 * opens its options.
 */

export type ToolbarPosition = "top" | "bottom" | "left" | "right";

export interface ToolbarHost {
  icon: IconFn;
  /** The page grid (tap on "3 / 12"). */
  openPages(): void;
  insertMenu(): MenuSection[];
  moreMenu(): MenuSection[];
  /** Persist tool and behaviour changes. */
  toolsChanged(state: ToolState): void;
  settingsChanged(patch: Partial<SurfaceSettings>): void;
  /** Buttons at the end of the bar (typed notes, text page). */
  endButtons(): Array<{ id: string; icon: string; label: string; showLabel?: boolean; run(): void }>;
}

const WRITING_PENS: WritingPen[] = ["fountain", "ballpoint", "pencil", "brush", "calligraphy"];

const ERASERS: Array<{ value: EraserMode; icon: string; label: string }> = [
  { value: "partial", icon: "eraser", label: "Partial" },
  { value: "stroke", icon: "spline", label: "Whole stroke" },
  { value: "lasso", icon: "lasso", label: "Lasso" },
];

const ERASER_SIZES: Array<{ size: number; label: string }> = [
  { size: 5, label: "S" },
  { size: 10, label: "M" },
  { size: 18, label: "L" },
  { size: 32, label: "XL" },
];

const TEXT_SIZES: Array<{ size: number; label: string }> = [
  { size: 18, label: "S" },
  { size: 24, label: "M" },
  { size: 32, label: "L" },
  { size: 44, label: "XL" },
];

export class Toolbar {
  readonly el: HTMLElement;
  private toolButtons = new Map<string, HTMLButtonElement>();
  private favButtons: HTMLButtonElement[] = [];
  private undoBtn!: HTMLButtonElement;
  private redoBtn!: HTMLButtonElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;
  private pageLabel!: HTMLButtonElement;
  private endEl!: HTMLElement;
  private insertBtn!: HTMLButtonElement;
  private resizeObserver: ResizeObserver | null = null;
  /** How much was folded into the "More" menu to make the bar fit (0 = nothing). */
  private level = 0;
  position: ToolbarPosition = "top";

  constructor(
    parent: HTMLElement,
    private surface: InkSurface,
    private host: ToolbarHost,
  ) {
    this.el = el(parent, "div", "ink-toolbar ink-ui");
    this.el.setAttribute("role", "toolbar");
    this.el.dataset.fold = "0";
    this.build();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.fit());
      this.resizeObserver.observe(this.el);
    }
  }

  destroy(): void {
    this.resizeObserver?.disconnect();
    Popover.closeAll();
    this.el.remove();
  }

  /**
   * Make the bar fit its width (or height): first the favourite pens, the
   * "add page" and typed-notes buttons and the text label go (into the menu),
   * then the buttons get a little smaller, then the insert button goes, then
   * the page arrows (swipe instead), and last undo/redo (two- and three-finger taps).
   */
  fit(): void {
    const vertical = this.el.hasAttribute("data-vertical");
    const overflows = () => (vertical ? this.el.scrollHeight > this.el.clientHeight + 1 : this.el.scrollWidth > this.el.clientWidth + 1);
    for (let level = 0; level <= 5; level++) {
      this.el.dataset.fold = String(level);
      this.level = level;
      if (!overflows()) break;
    }
  }

  private get icon(): IconFn {
    return this.host.icon;
  }

  private build(): void {
    const tools = el(this.el, "div", "ink-tb-group ink-tb-tools");
    const tool = (id: ToolId, icon: string, label: string) => {
      const b = button(tools, this.icon, { icon, label, cls: `ink-tb-btn ink-tool-${id}`, onClick: () => this.pickTool(id, b) });
      el(b, "span", "ink-tb-caret");
      this.toolButtons.set(id, b);
      return b;
    };
    tool("pen", "pen-tool", "Pen");
    tool("marker", "highlighter", "Highlighter");
    tool("eraser", "eraser", "Eraser");
    tool("lasso", "lasso", "Lasso");
    tool("shape", "shapes", "Shapes");
    tool("text", "type", "Text");
    const ins = button(tools, this.icon, { icon: "image-plus", label: "Insert", cls: "ink-tb-btn ink-tb-insert", onClick: () => this.openMenu(ins, this.host.insertMenu()) });
    this.insertBtn = ins;

    const favs = el(this.el, "div", "ink-tb-group ink-tb-favs");
    for (let i = 0; i < 2; i++) {
      const b = button(favs, this.icon, { label: `Favourite pen ${i + 1}`, cls: "ink-tb-btn ink-tb-fav", onClick: () => this.useFavorite(i) });
      el(b, "span", "ink-fav-stroke");
      this.favButtons.push(b);
    }

    const hist = el(this.el, "div", "ink-tb-group ink-tb-history");
    this.undoBtn = button(hist, this.icon, { icon: "undo-2", label: "Undo", cls: "ink-tb-btn", onClick: () => this.surface.undo() });
    this.redoBtn = button(hist, this.icon, { icon: "redo-2", label: "Redo", cls: "ink-tb-btn", onClick: () => this.surface.redo() });

    el(this.el, "div", "ink-tb-spacer");

    const pages = el(this.el, "div", "ink-tb-group ink-tb-pages");
    this.prevBtn = button(pages, this.icon, { icon: "chevron-left", label: "Previous page", cls: "ink-tb-btn", onClick: () => this.surface.prev() });
    this.pageLabel = button(pages, this.icon, { label: "Pages", showLabel: true, cls: "ink-tb-btn ink-tb-pagelabel", onClick: () => this.host.openPages() });
    this.nextBtn = button(pages, this.icon, { icon: "chevron-right", label: "Next page", cls: "ink-tb-btn", onClick: () => this.surface.next() });
    button(pages, this.icon, { icon: "file-plus-2", label: "Add a page after this one", cls: "ink-tb-btn ink-tb-addpage", onClick: () => this.surface.addPage("after") });

    this.endEl = el(this.el, "div", "ink-tb-group ink-tb-end");
    this.renderEnd();
    this.refreshTools();
  }

  /** Rebuild the end buttons (their badges/labels change). */
  renderEnd(): void {
    this.endEl.replaceChildren();
    for (const b of this.host.endButtons()) {
      button(this.endEl, this.icon, { icon: b.icon, label: b.label, showLabel: b.showLabel, cls: `ink-tb-btn ink-tb-${b.id}`, onClick: () => b.run() });
    }
    const more = button(this.endEl, this.icon, { icon: "ellipsis-vertical", label: "More", cls: "ink-tb-btn ink-tb-more", onClick: () => this.openMenu(more, this.moreSections()) });
  }

  /** The menu, with whatever was folded out of the bar. */
  private moreSections(): MenuSection[] {
    const folded: MenuSection[] = [];
    if (this.level >= 1) {
      const t = this.surface.tools;
      folded.push({
        title: "Favourite pens",
        items: t.favorites.map((f, i) => ({ icon: "star", label: `${PENS[f.pen].label} · ${INK_COLORS.find((c) => c.color === f.color)?.label ?? f.color}`, run: () => this.useFavorite(i) })),
      });
    }
    if (this.level >= 1) {
      const notes = this.host.endButtons().find((b) => b.id === "notes");
      if (notes) folded.push({ items: [{ icon: notes.icon, label: notes.label, run: () => notes.run() }] });
    }
    if (this.level >= 3) folded.push(...this.host.insertMenu().map((s) => ({ ...s, title: s.title ?? "Insert" })));
    if (this.level >= 5) folded.push({ items: [{ icon: "undo-2", label: "Undo", run: () => this.surface.undo() }, { icon: "redo-2", label: "Redo", run: () => this.surface.redo() }] });
    return [...folded, ...this.host.moreMenu()];
  }

  setPosition(p: ToolbarPosition): void {
    this.position = p;
    this.el.toggleAttribute("data-vertical", p === "left" || p === "right");
  }

  private side(): "below" | "above" | "right" | "left" {
    return this.position === "bottom" ? "above" : this.position === "left" ? "right" : this.position === "right" ? "left" : "below";
  }

  // ------------------------------------------------------------------ state

  refreshTools(): void {
    const t = this.surface.tools;
    for (const [id, b] of this.toolButtons) {
      const active = id === t.tool;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", String(active));
    }
    // the pen button shows the selected pen and colour
    const pen = this.toolButtons.get("pen");
    if (pen) {
      const i = pen.querySelector(".ink-btn-icon") as HTMLElement | null;
      if (i && i.dataset.icon !== PENS[t.pen].icon) {
        i.replaceChildren();
        this.icon(i, PENS[t.pen].icon);
        i.dataset.icon = PENS[t.pen].icon;
      }
      pen.style.setProperty("--ink-pen-color", t.color);
      pen.title = `${PENS[t.pen].label} – tap again for options`;
    }
    this.toolButtons.get("marker")?.style.setProperty("--ink-pen-color", t.markerColor);
    const shape = this.toolButtons.get("shape");
    if (shape) {
      const i = shape.querySelector(".ink-btn-icon") as HTMLElement | null;
      const icon = SHAPES[t.shape].icon;
      if (i && i.dataset.icon !== icon) {
        i.replaceChildren();
        this.icon(i, icon);
        i.dataset.icon = icon;
      }
    }
    t.favorites.forEach((f, i) => {
      const b = this.favButtons[i];
      if (!b) return;
      b.style.setProperty("--ink-pen-color", f.color);
      b.style.setProperty("--ink-fav-width", `${Math.max(2, Math.min(8, f.width * 1.6))}px`);
      const active = t.tool === "pen" && t.pen === f.pen && t.color.toLowerCase() === f.color.toLowerCase() && Math.abs(t.widths[t.pen] - f.width) < 1e-6;
      b.classList.toggle("is-active", active);
      b.title = `${PENS[f.pen].label}, ${INK_COLORS.find((c) => c.color === f.color)?.label ?? f.color} (long-press the pen options to change)`;
    });
  }

  /**
   * These run after every stroke: only touch the toolbar when something it
   * shows changed (on e-ink, every change of the page is a screen refresh).
   */
  refreshPage(index: number, count: number): void {
    const label = this.pageLabel.querySelector(".ink-btn-label");
    const text = `${index + 1} / ${count}`;
    if (label && label.textContent !== text) label.textContent = text;
    if (this.pageLabel.title !== "All pages") this.pageLabel.title = "All pages";
    setDisabled(this.prevBtn, index <= 0);
    setDisabled(this.nextBtn, index >= count - 1);
  }

  refreshHistory(canUndo: boolean, canRedo: boolean): void {
    setDisabled(this.undoBtn, !canUndo);
    setDisabled(this.redoBtn, !canRedo);
  }

  private setTools(patch: Partial<ToolState>): void {
    this.surface.setTools(patch);
    this.refreshTools();
    this.host.toolsChanged(this.surface.tools);
  }

  private useFavorite(i: number): void {
    const f = this.surface.tools.favorites[i];
    if (!f) return;
    this.setTools({ tool: "pen", pen: f.pen, color: f.color, widths: { ...this.surface.tools.widths, [f.pen]: f.width } });
  }

  /** Select a tool; the selected tool's button opens its options. */
  private pickTool(id: ToolId, b: HTMLButtonElement): void {
    const wasActive = this.surface.tools.tool === id;
    if (Popover.current) {
      const same = b.classList.contains("is-open");
      Popover.closeAll();
      if (same) return;
    }
    if (!wasActive) {
      this.setTools({ tool: id });
      // tools whose options matter first open them right away
      if (id !== "shape") return;
    }
    this.openOptions(id, b);
  }

  private openMenu(anchor: HTMLButtonElement, sections: MenuSection[]): void {
    if (anchor.classList.contains("is-open")) {
      Popover.closeAll();
      return;
    }
    const host = this.el.parentElement ?? this.el;
    const pop = new Popover(host, anchor, "ink-pop-menu");
    menu(pop.el, this.icon, sections, () => pop.close());
    pop.place(this.side());
  }

  private openOptions(id: ToolId, anchor: HTMLButtonElement): void {
    const host = this.el.parentElement ?? this.el;
    const pop = new Popover(host, anchor, `ink-pop-${id}`);
    const render = () => {
      pop.el.replaceChildren();
      this.fillOptions(id, pop.el, () => {
        render();
        pop.place(this.side());
      }, () => pop.close());
    };
    render();
    pop.place(this.side());
  }

  private fillOptions(id: ToolId, root: HTMLElement, rerender: () => void, close: () => void): void {
    const t = this.surface.tools;
    const set = (patch: Partial<ToolState>) => {
      this.setTools(patch);
      rerender();
    };
    const setting = (patch: Partial<SurfaceSettings>) => {
      this.surface.setSettings(patch);
      this.host.settingsChanged(patch);
      rerender();
    };
    switch (id) {
      case "pen": {
        tiles(
          section(root, "Pen"),
          this.icon,
          WRITING_PENS.map((p) => ({ value: p, icon: PENS[p].icon, label: PENS[p].label.replace(/ pen$/, "") })),
          t.pen,
          (p) => set({ pen: p }),
        );
        thickness(section(root, "Thickness"), this.icon, PENS[t.pen].presets, t.widths[t.pen], t.color, (w) => set({ widths: { ...t.widths, [t.pen]: w } }));
        swatches(section(root, "Colour"), INK_COLORS, t.color, (c) => set({ color: c }));
        const opts = section(root);
        toggle(opts, "Pressure sensitivity", this.surface.settings.pressure, (v) => setting({ pressure: v }), "Lines get wider the harder you press");
        const favRow = el(section(root, "Favourite pens"), "div", "ink-pop-row");
        for (let i = 0; i < 2; i++) {
          button(favRow, this.icon, {
            icon: "star",
            label: `Save as favourite ${i + 1}`,
            showLabel: true,
            cls: "ink-pop-wide",
            onClick: () => {
              const favorites = t.favorites.slice();
              favorites[i] = { pen: t.pen, color: t.color, width: t.widths[t.pen] };
              set({ favorites });
            },
          });
        }
        break;
      }
      case "marker": {
        thickness(section(root, "Highlighter thickness"), this.icon, PENS.marker.presets, t.widths.marker, t.markerColor, (w) => set({ widths: { ...t.widths, marker: w } }));
        swatches(section(root, "Colour"), MARKER_COLORS, t.markerColor, (c) => set({ markerColor: c }));
        el(section(root), "p", "ink-pop-hint", "Highlights stay underneath your writing.");
        break;
      }
      case "eraser": {
        tiles(section(root, "Eraser"), this.icon, ERASERS, t.eraser, (v) => set({ eraser: v }));
        const sizes = el(section(root, "Size"), "div", "ink-size-row");
        for (const s of ERASER_SIZES) {
          button(sizes, this.icon, { label: s.label, showLabel: true, cls: `ink-size-btn${s.size === t.eraserSize ? " is-active" : ""}`, onClick: () => set({ eraserSize: s.size }) });
        }
        toggle(section(root), "Scribble to erase", this.surface.settings.scribbleErase, (v) => setting({ scribbleErase: v }), "Scratch over writing with the pen to erase it");
        const clear = section(root);
        button(clear, this.icon, {
          icon: "trash-2",
          label: "Clear this page",
          showLabel: true,
          cls: "ink-pop-wide is-danger",
          onClick: () => {
            close();
            this.confirmClear();
          },
        });
        break;
      }
      case "lasso": {
        const row = el(section(root, "Lasso"), "div", "ink-pop-row");
        button(row, this.icon, { icon: "box-select", label: "Select all", showLabel: true, cls: "ink-pop-wide", onClick: () => (close(), this.surface.selectAll()) });
        const paste = button(row, this.icon, { icon: "clipboard-paste", label: "Paste", showLabel: true, cls: "ink-pop-wide", onClick: () => (close(), this.surface.paste()) });
        paste.disabled = !this.surface.canPaste;
        el(section(root), "p", "ink-pop-hint", "Draw a loop around writing to select it, or tap one item. Drag the selection to move it, the corner to resize, the top handle to rotate.");
        break;
      }
      case "shape": {
        tiles(
          section(root, "Shape"),
          this.icon,
          (Object.keys(SHAPES) as ShapeKind[]).map((k) => ({ value: k, icon: SHAPES[k].icon, label: SHAPES[k].label })),
          t.shape,
          (k) => {
            set({ shape: k, tool: "shape" });
            close();
          },
        );
        toggle(section(root), "Snap shapes when you hold the pen", this.surface.settings.holdToShape, (v) => setting({ holdToShape: v }), "Draw a line, box, triangle or circle with the pen tool and keep the pen still at the end");
        break;
      }
      case "text": {
        const sizes = el(section(root, "Text size"), "div", "ink-size-row");
        for (const s of TEXT_SIZES) {
          button(sizes, this.icon, { label: s.label, showLabel: true, cls: `ink-size-btn${s.size === t.textSize ? " is-active" : ""}`, onClick: () => set({ textSize: s.size }) });
        }
        swatches(section(root, "Colour"), INK_COLORS, t.color, (c) => set({ color: c }));
        el(section(root), "p", "ink-pop-hint", "Tap the page where the text should go, or tap a text to change it.");
        break;
      }
      default:
        break;
    }
  }

  private confirmClear(): void {
    const host = this.el.parentElement ?? this.el;
    const anchor = this.toolButtons.get("eraser") as HTMLButtonElement;
    const pop = new Popover(host, anchor, "ink-pop-confirm");
    el(pop.el, "p", "ink-pop-text", "Erase everything on this page? (You can undo this.)");
    const row = el(pop.el, "div", "ink-pop-row");
    button(row, this.icon, { label: "Cancel", showLabel: true, cls: "ink-pop-wide", onClick: () => pop.close() });
    button(row, this.icon, {
      icon: "trash-2",
      label: "Clear page",
      showLabel: true,
      cls: "ink-pop-wide is-danger",
      onClick: () => {
        pop.close();
        this.surface.clearPage();
      },
    });
    pop.place(this.side());
  }
}

function setDisabled(b: HTMLButtonElement, disabled: boolean): void {
  if (b.disabled !== disabled) b.disabled = disabled;
}
