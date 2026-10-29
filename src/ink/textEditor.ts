import type { Pt } from "../core/geometry";
import { addItems, newId, replaceItems, withText, type Stroke, type TextBox } from "../core/ink/model";
import { unionRect } from "../core/ink/geom";
import { labelBox } from "../core/ink/connectors";
import { measureTextHeight, TEXT_FONT, TEXT_LINE_HEIGHT } from "./render";
import type { InkSurface } from "./surface";

/**
 * Typing text on the page: a text area laid over the page where the text box
 * is, in the same font and size, so that what you type is what stays.
 */

interface Editing {
  box: TextBox;
  isNew: boolean;
}

export class TextEditor {
  private ta: HTMLTextAreaElement | null = null;
  private editing: Editing | null = null;

  constructor(private s: InkSurface) {}

  get active(): boolean {
    return !!this.editing;
  }

  create(at: Pt): void {
    const page = this.s.page;
    const size = this.s.tools.textSize;
    const x = Math.max(0, Math.min(page.w - 120, at.x));
    const y = Math.max(0, Math.min(page.h - size, at.y));
    const w = Math.max(120, Math.min(560, page.w - x - 30));
    this.open({ box: { id: newId(), x, y, w, h: size * TEXT_LINE_HEIGHT, text: "", size, color: this.s.tools.color }, isNew: true });
  }

  /** Type the label of a shape: centred in it, it moves with the shape. */
  createLabel(shape: Stroke): void {
    const size = this.s.tools.textSize;
    const h = size * TEXT_LINE_HEIGHT;
    this.open({ box: { id: newId(), ...labelBox(shape, h), h, text: "", size, color: this.s.tools.color, align: "center", container: shape.id }, isNew: true });
  }

  edit(t: TextBox): void {
    this.open({ box: t, isNew: false });
    this.s.hidden.add(t.id);
    this.s.renderRect({ x: t.x, y: t.y, w: t.w, h: t.h });
  }

  private open(e: Editing): void {
    this.commit();
    this.editing = e;
    const ta = this.s.el.ownerDocument.createElement("textarea");
    ta.className = "ink-text-editor ink-ui";
    ta.value = e.box.text;
    ta.spellcheck = true;
    ta.style.fontFamily = TEXT_FONT;
    ta.style.color = e.box.color;
    ta.style.textAlign = e.box.align ?? "left";
    ta.addEventListener("input", () => this.autosize());
    ta.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Escape") {
        ev.preventDefault();
        this.commit();
      }
    });
    ta.addEventListener("blur", () => window.setTimeout(() => this.commit(), 0));
    ta.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    this.s.overlay.appendChild(ta);
    this.ta = ta;
    this.position();
    window.setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }, 0);
  }

  /** Follow zoom and scrolling. */
  position(): void {
    const e = this.editing;
    const ta = this.ta;
    if (!e || !ta) return;
    const k = this.s.view.scale;
    const p = this.s.toScreen({ x: e.box.x, y: e.box.y });
    ta.style.left = `${p.x}px`;
    ta.style.top = `${p.y}px`;
    ta.style.width = `${e.box.w * k}px`;
    ta.style.fontSize = `${e.box.size * k}px`;
    ta.style.lineHeight = String(TEXT_LINE_HEIGHT);
    this.autosize();
  }

  private autosize(): void {
    const ta = this.ta;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.max(ta.scrollHeight, (this.editing?.box.size ?? 20) * this.s.view.scale * TEXT_LINE_HEIGHT)}px`;
  }

  /** Put the typed text on the page (an emptied text box is removed). */
  commit(): void {
    const e = this.editing;
    const ta = this.ta;
    if (!e || !ta) return;
    this.editing = null;
    this.ta = null;
    const text = ta.value.replace(/\s+$/, "");
    ta.remove();
    this.s.hidden.delete(e.box.id);
    const old = e.box;
    const page = this.s.page;
    const oldRect = { x: old.x, y: old.y, w: old.w, h: old.h };
    if (!text.trim()) {
      if (e.isNew) return;
      this.s.commitPage({ ...page, texts: page.texts.filter((t) => t.id !== old.id) }, oldRect);
      return;
    }
    if (!e.isNew && text === old.text) {
      this.s.renderRect(oldRect);
      return;
    }
    const h = Math.round(measureTextHeight(text, old.w, old.size) * 10) / 10;
    // a label stays centred in its shape
    const shape = old.container ? page.strokes.find((st) => st.id === old.container) : undefined;
    const box: TextBox = withText({ ...old, text, h }, shape ? labelBox(shape, h) : {});
    const next = e.isNew ? addItems(page, { texts: [box] }) : replaceItems(page, { texts: [box] });
    this.s.commitPage(next, unionRect(oldRect, { x: box.x, y: box.y, w: box.w, h: box.h }));
  }

  /** Close without keeping the changes. */
  cancel(): void {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    this.ta?.remove();
    this.ta = null;
    this.s.hidden.delete(e.box.id);
    this.s.renderRect({ x: e.box.x, y: e.box.y, w: e.box.w, h: e.box.h });
  }
}
