/**
 * Popover cards for the toolbar: big, flat, high-contrast panels that open
 * next to their button (no animation, no shadow – made for e-ink).
 */

export interface MenuItem {
  icon: string;
  label: string;
  run(): void;
  disabled?: boolean;
  danger?: boolean;
  /** Shows a check mark (toggles, choices). */
  checked?: boolean;
  /** Small text under the label. */
  hint?: string;
}

export interface MenuSection {
  title?: string;
  items: MenuItem[];
}

export type IconFn = (el: HTMLElement, name: string) => void;

let open: Popover | null = null;

export class Popover {
  readonly el: HTMLElement;
  private outside = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (t && (this.el.contains(t) || this.anchor.contains(t))) return;
    this.close();
  };
  private keys = (e: KeyboardEvent) => {
    if (e.key === "Escape") this.close();
  };
  onClose: (() => void) | null = null;

  constructor(
    private host: HTMLElement,
    private anchor: HTMLElement,
    cls = "",
  ) {
    open?.close();
    open = this;
    this.el = host.ownerDocument.createElement("div");
    this.el.className = `ink-popover ink-ui ${cls}`.trim();
    this.el.setAttribute("role", "dialog");
    host.appendChild(this.el);
    // capture: decide before the page sees the press
    host.ownerDocument.addEventListener("pointerdown", this.outside, true);
    host.ownerDocument.addEventListener("keydown", this.keys, true);
    anchor.classList.add("is-open");
  }

  static get current(): Popover | null {
    return open;
  }

  static closeAll(): void {
    open?.close();
  }

  /** Put the card next to its button, inside the host (side depends on where the toolbar is). */
  place(side: "below" | "above" | "right" | "left"): void {
    const host = this.host.getBoundingClientRect();
    const a = this.anchor.getBoundingClientRect();
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const gap = 6;
    let x: number;
    let y: number;
    if (side === "below" || side === "above") {
      x = a.left - host.left + a.width / 2 - w / 2;
      y = side === "below" ? a.bottom - host.top + gap : a.top - host.top - h - gap;
    } else {
      y = a.top - host.top + a.height / 2 - h / 2;
      x = side === "right" ? a.right - host.left + gap : a.left - host.left - w - gap;
    }
    x = Math.max(6, Math.min(host.width - w - 6, x));
    y = Math.max(6, Math.min(host.height - h - 6, y));
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
    this.el.style.maxHeight = `${Math.max(160, host.height - 12)}px`;
  }

  close(): void {
    if (open === this) open = null;
    this.host.ownerDocument.removeEventListener("pointerdown", this.outside, true);
    this.host.ownerDocument.removeEventListener("keydown", this.keys, true);
    this.anchor.classList.remove("is-open");
    this.el.remove();
    this.onClose?.();
  }
}

// ------------------------------------------------------------------ building blocks

export function el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = parent.ownerDocument.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent.appendChild(e);
  return e;
}

export function button(parent: HTMLElement, icon: IconFn, opts: { icon?: string; label: string; cls?: string; showLabel?: boolean; onClick: (e: MouseEvent) => void }): HTMLButtonElement {
  const b = el(parent, "button", `ink-btn ${opts.cls ?? ""}`.trim());
  b.type = "button";
  b.setAttribute("aria-label", opts.label);
  b.title = opts.label;
  if (opts.icon) {
    const i = el(b, "span", "ink-btn-icon");
    icon(i, opts.icon);
  }
  if (opts.showLabel) el(b, "span", "ink-btn-label", opts.label);
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!b.disabled) opts.onClick(e);
  });
  return b;
}

export function section(parent: HTMLElement, title?: string): HTMLElement {
  const s = el(parent, "div", "ink-pop-section");
  if (title) el(s, "div", "ink-pop-title", title);
  return s;
}

/** Large tiles with icon and label; one can be selected. */
export function tiles<T extends string>(
  parent: HTMLElement,
  icon: IconFn,
  options: ReadonlyArray<{ value: T; icon: string; label: string }>,
  current: T,
  onPick: (v: T) => void,
): void {
  const grid = el(parent, "div", "ink-tiles");
  for (const o of options) {
    const b = button(grid, icon, { icon: o.icon, label: o.label, showLabel: true, cls: `ink-tile${o.value === current ? " is-active" : ""}`, onClick: () => onPick(o.value) });
    b.setAttribute("aria-pressed", String(o.value === current));
  }
}

export function swatches(parent: HTMLElement, colors: ReadonlyArray<{ color: string; label: string }>, current: string, onPick: (c: string) => void): void {
  const row = el(parent, "div", "ink-swatches");
  for (const c of colors) {
    const b = el(row, "button", `ink-swatch-btn${c.color.toLowerCase() === current.toLowerCase() ? " is-active" : ""}`);
    b.type = "button";
    b.title = c.label;
    b.setAttribute("aria-label", c.label);
    b.style.setProperty("--swatch", c.color);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onPick(c.color);
    });
  }
}

/** Five thickness buttons drawn as dots of growing size, plus − / + for fine steps. */
export function thickness(parent: HTMLElement, icon: IconFn, presets: readonly number[], current: number, color: string, onPick: (w: number) => void): void {
  const row = el(parent, "div", "ink-thickness");
  const max = Math.max(...presets);
  const dots = el(row, "div", "ink-thickness-dots");
  presets.forEach((w, i) => {
    const b = el(dots, "button", `ink-dot-btn${Math.abs(w - current) < 1e-6 ? " is-active" : ""}`);
    b.type = "button";
    b.title = `Thickness ${i + 1}`;
    b.setAttribute("aria-label", `Thickness ${i + 1}`);
    const d = el(b, "span", "ink-dot");
    const px = 4 + (i / (presets.length - 1)) * 18;
    d.style.width = `${px}px`;
    d.style.height = `${px}px`;
    d.style.background = color;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      onPick(w);
    });
  });
  const fine = el(row, "div", "ink-fine");
  const step = max / 20;
  button(fine, icon, { icon: "minus", label: "Thinner", onClick: () => onPick(Math.max(0.3, Math.round((current - step) * 10) / 10)) });
  el(fine, "span", "ink-fine-value", (Math.round(current * 10) / 10).toString());
  button(fine, icon, { icon: "plus", label: "Thicker", onClick: () => onPick(Math.min(max * 2, Math.round((current + step) * 10) / 10)) });
}

export function toggle(parent: HTMLElement, label: string, value: boolean, onChange: (v: boolean) => void, hint?: string): void {
  const row = el(parent, "label", "ink-toggle-row");
  const text = el(row, "span", "ink-toggle-text");
  el(text, "span", "ink-toggle-label", label);
  if (hint) el(text, "span", "ink-toggle-hint", hint);
  const box = el(row, "input", "ink-toggle");
  box.type = "checkbox";
  box.checked = value;
  box.addEventListener("change", () => onChange(box.checked));
}

/** A list of menu rows. */
export function menu(parent: HTMLElement, icon: IconFn, sections: MenuSection[], close: () => void): void {
  for (const s of sections) {
    if (s.items.length === 0) continue;
    const sec = section(parent, s.title);
    const list = el(sec, "div", "ink-menu");
    for (const it of s.items) {
      const b = el(list, "button", `ink-menu-item${it.danger ? " is-danger" : ""}${it.checked ? " is-checked" : ""}`);
      b.type = "button";
      b.disabled = !!it.disabled;
      const i = el(b, "span", "ink-menu-icon");
      icon(i, it.checked ? "check" : it.icon);
      const t = el(b, "span", "ink-menu-text");
      el(t, "span", "ink-menu-label", it.label);
      if (it.hint) el(t, "span", "ink-menu-hint", it.hint);
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (it.disabled) return;
        close();
        it.run();
      });
    }
  }
}
