import { App, Modal, setIcon } from "obsidian";
import { renderPageCanvas } from "../ink/render";
import type { InkView } from "./inkView";

/**
 * All pages of the notebook as thumbnails, like the page overview of the Boox
 * Notes app: tap a page to go there; move, duplicate or delete pages; add one.
 */
export class PageOverviewModal extends Modal {
  private grid!: HTMLElement;
  private idleHandles: number[] = [];

  constructor(
    app: App,
    private view: InkView,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("ink-modal", "ink-pages-modal");
    this.titleEl.setText("Pages");
    this.grid = this.contentEl.createDiv({ cls: "ink-pages-grid" });
    this.render();
  }

  onClose(): void {
    for (const h of this.idleHandles) window.clearTimeout(h);
    this.contentEl.empty();
  }

  private render(): void {
    for (const h of this.idleHandles) window.clearTimeout(h);
    this.idleHandles = [];
    this.grid.empty();
    const s = this.view.surface;
    const pages = s.document.pages;
    const thumbW = Math.round(150 * Math.min(2, window.devicePixelRatio || 1));
    pages.forEach((page, i) => {
      const tile = this.grid.createDiv({ cls: `ink-page-tile${i === s.pageIndex ? " is-current" : ""}` });
      const thumb = tile.createEl("button", { cls: "ink-page-thumb", attr: { "aria-label": `Go to page ${i + 1}`, type: "button" } });
      thumb.style.aspectRatio = `${page.w} / ${page.h}`;
      thumb.addEventListener("click", () => {
        this.close();
        s.goTo(i);
      });
      // draw the thumbnails one after another so the dialog opens at once
      this.idleHandles.push(
        window.setTimeout(() => {
          try {
            const c = renderPageCanvas(page, thumbW, { images: this.view.surface.images, handLinks: s.meta.handLinks });
            c.addClass("ink-page-canvas");
            thumb.appendChild(c);
          } catch (e) {
            console.warn("Ink Notebook: thumbnail failed", e);
          }
        }, 20 + i * 15),
      );
      const bar = tile.createDiv({ cls: "ink-page-bar" });
      bar.createSpan({ cls: "ink-page-num", text: String(i + 1) });
      const act = (icon: string, label: string, run: () => void, disabled = false) => {
        const b = bar.createEl("button", { cls: "ink-page-act", attr: { "aria-label": label, title: label, type: "button" } });
        setIcon(b, icon);
        b.disabled = disabled;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          run();
        });
      };
      act("chevron-left", "Move earlier", () => (s.movePage(i, i - 1), this.render()), i === 0);
      act("chevron-right", "Move later", () => (s.movePage(i, i + 1), this.render()), i === pages.length - 1);
      act("copy", "Duplicate", () => (s.duplicatePage(i), this.render()));
      act("trash-2", "Delete", () => {
        if (pages.length <= 1) return;
        s.deletePage(i);
        this.render();
      }, pages.length <= 1);
    });
    const add = this.grid.createEl("button", { cls: "ink-page-tile ink-page-add", attr: { type: "button", "aria-label": "Add a page at the end" } });
    const icon = add.createSpan();
    setIcon(icon, "plus");
    add.createSpan({ text: "Add a page" });
    add.addEventListener("click", () => {
      this.close();
      s.addPage("end");
    });
  }
}
