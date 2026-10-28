import { App, Modal, Setting } from "obsidian";
import {
  normalizePaperSpec,
  PAPER_COLORS,
  PAPER_ORIENTATIONS,
  PAPER_SPACINGS,
  PAPER_STYLES,
  paperSvg,
  type PaperSpec,
  type PaperStyle,
} from "../core/paper";
import { FolderPickModal } from "./modals";

export type PagePosition = "after" | "before" | "end";

/**
 * Choose a paper template, like the template picker in GoodNotes: a grid of
 * page previews plus line spacing, colour and orientation.
 */

/** new: a new ink page; attach: an ink page for a note that exists. */
export type PaperPickerMode = "new" | "attach" | "add" | "change" | "default";

export interface PaperPickerOptions {
  mode: PaperPickerMode;
  initial: PaperSpec;
  /** Also ask for the page name (new pages), pre-filled with this. */
  name?: string;
  /** Show where the page goes (vault path, "" = root), with a button to choose another folder. */
  folder?: string;
  /** Folders not to offer (ink subfolders). */
  hideFolder?: (path: string) => boolean;
  /** Offer "after / before this page" (adding to a page that already has pages). */
  canInsert?: boolean;
}

export interface PaperChoice {
  spec: PaperSpec;
  name?: string;
  /** The folder chosen for the page (when `folder` was given). */
  folder?: string;
  position: PagePosition;
  /** Remember the paper for new pages. */
  makeDefault: boolean;
}

const TITLES: Record<PaperPickerMode, string> = {
  new: "New ink page",
  attach: "Add an ink page to this note",
  add: "Add a page",
  change: "Change the paper of this page",
  default: "Paper for new pages",
};

const CONFIRM: Record<PaperPickerMode, string> = {
  new: "Create page",
  attach: "Add ink page",
  add: "Add page",
  change: "Change paper",
  default: "Use this paper",
};

const POSITIONS: Record<PagePosition, string> = {
  after: "After this page",
  before: "Before this page",
  end: "At the end",
};

export function paperDataUrl(spec: PaperSpec, strokeScale = 2.5): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(paperSvg(spec, { strokeScale }))}`;
}

interface Segment {
  buttons: Map<string, HTMLButtonElement>;
  row: Setting;
}

export class PaperPickerModal extends Modal {
  private spec: PaperSpec;
  private name: string | undefined;
  private folder: string | undefined;
  private position: PagePosition;
  private makeDefault = false;
  private done = false;
  private grid!: HTMLElement;
  private nameInput: HTMLInputElement | null = null;
  private cards = new Map<PaperStyle, { card: HTMLButtonElement; img: HTMLImageElement }>();
  private segments: Record<string, Segment> = {};

  private constructor(
    app: App,
    private opts: PaperPickerOptions,
    private resolve: (choice: PaperChoice | null) => void,
  ) {
    super(app);
    this.spec = normalizePaperSpec(opts.initial);
    this.name = opts.name;
    this.folder = opts.folder;
    this.position = opts.mode === "add" && opts.canInsert ? "after" : "end";
  }

  static pick(app: App, opts: PaperPickerOptions): Promise<PaperChoice | null> {
    return new Promise((resolve) => new PaperPickerModal(app, opts, resolve).open());
  }

  onOpen(): void {
    const { contentEl, opts } = this;
    this.modalEl.addClass("ink-modal", "ink-paper-picker");
    this.titleEl.setText(TITLES[opts.mode]);

    if (this.name !== undefined) {
      const s = new Setting(contentEl).setName("Name").addText((t) => {
        t.setValue(this.name ?? "")
          .setPlaceholder("Name of the page")
          .onChange((v) => (this.name = v));
        t.inputEl.addClass("ink-wide-input");
        this.nameInput = t.inputEl;
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            this.finish(true);
          }
        });
        window.setTimeout(() => t.inputEl.select(), 50);
      });
      s.settingEl.addClass("ink-paper-name-row");
    }

    if (this.folder !== undefined) {
      const label = (f: string) => f || "/ (vault root)";
      const row = new Setting(contentEl)
        .setName("Folder")
        .setDesc(label(this.folder))
        .addButton((b) =>
          b.setButtonText("Change…").onClick(async () => {
            const picked = await FolderPickModal.pick(this.app, { initial: this.folder ?? "", hide: this.opts.hideFolder });
            if (picked === null) return;
            this.folder = picked;
            row.setDesc(label(picked));
          }),
        );
      row.settingEl.addClass("ink-paper-folder-row");
    }

    this.grid = contentEl.createDiv({ cls: "ink-paper-grid", attr: { role: "listbox", "aria-label": "Paper" } });
    for (const [style, label] of Object.entries(PAPER_STYLES) as Array<[PaperStyle, string]>) {
      const card = this.grid.createEl("button", { cls: "ink-paper-card", attr: { type: "button", role: "option", "data-style": style } });
      const thumb = card.createDiv({ cls: "ink-paper-thumb" });
      const img = thumb.createEl("img", { attr: { alt: "", draggable: "false" } });
      card.createDiv({ cls: "ink-paper-label", text: label });
      card.addEventListener("click", () => {
        this.spec = normalizePaperSpec({ ...this.spec, style });
        this.refresh();
      });
      // double tap on a template takes it right away
      card.addEventListener("dblclick", () => this.finish(true));
      this.cards.set(style, { card, img });
    }

    this.segments.spacing = this.segmented("Line spacing", PAPER_SPACINGS, (v) => (this.spec = normalizePaperSpec({ ...this.spec, spacing: v })));
    const colors = Object.fromEntries(Object.entries(PAPER_COLORS).map(([k, v]) => [k, v.label]));
    this.segments.color = this.segmented("Colour", colors, (v) => (this.spec = normalizePaperSpec({ ...this.spec, color: v })));
    for (const [key, btn] of this.segments.color.buttons) {
      const swatch = createSpan({ cls: "ink-swatch" });
      swatch.style.background = PAPER_COLORS[key as keyof typeof PAPER_COLORS].fill;
      btn.prepend(swatch);
    }
    this.segments.orientation = this.segmented("Orientation", PAPER_ORIENTATIONS, (v) => (this.spec = normalizePaperSpec({ ...this.spec, orientation: v })));
    if (opts.mode === "add" && opts.canInsert) {
      this.segments.position = this.segmented("Where", POSITIONS, (v) => (this.position = v as PagePosition));
    }
    if (opts.mode !== "default") {
      new Setting(contentEl)
        .setName("Use this paper for new pages")
        .addToggle((t) => t.setValue(this.makeDefault).onChange((v) => (this.makeDefault = v)));
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
      .addButton((b) =>
        b
          .setButtonText(CONFIRM[opts.mode])
          .setCta()
          .onClick(() => this.finish(true)),
      );
    this.refresh();
  }

  /** A row of toggle buttons (one active). */
  private segmented<T extends string>(label: string, options: Record<T, string>, set: (v: T) => void): Segment {
    const row = new Setting(this.contentEl).setName(label);
    row.settingEl.addClass("ink-paper-option");
    const group = row.controlEl.createDiv({ cls: "ink-segmented", attr: { role: "radiogroup", "aria-label": label } });
    const buttons = new Map<string, HTMLButtonElement>();
    for (const [value, text] of Object.entries(options) as Array<[T, string]>) {
      const b = group.createEl("button", { attr: { type: "button", role: "radio", "data-value": value } });
      b.createSpan({ text });
      b.addEventListener("click", () => {
        set(value);
        this.refresh();
      });
      buttons.set(value, b);
    }
    return { buttons, row };
  }

  private refresh(): void {
    const { spec } = this;
    this.grid.toggleClass("is-landscape", spec.orientation === "landscape");
    for (const [style, { card, img }] of this.cards) {
      const selected = style === spec.style;
      card.toggleClass("is-selected", selected);
      card.setAttr("aria-selected", String(selected));
      img.src = paperDataUrl(normalizePaperSpec({ ...spec, style }));
    }
    const mark = (seg: Segment | undefined, value: string) => {
      if (!seg) return;
      for (const [v, b] of seg.buttons) {
        b.toggleClass("is-active", v === value);
        b.setAttr("aria-checked", String(v === value));
      }
    };
    mark(this.segments.spacing, spec.spacing);
    mark(this.segments.color, spec.color);
    mark(this.segments.orientation, spec.orientation);
    mark(this.segments.position, this.position);
    // spacing means nothing on blank paper
    this.segments.spacing?.row.settingEl.toggleClass("is-disabled", spec.style === "blank");
  }

  private finish(ok: boolean): void {
    if (this.done) return;
    this.done = true;
    const name = this.name?.trim();
    if (ok && this.opts.name !== undefined && !name) {
      // a page needs a name
      this.done = false;
      this.nameInput?.focus();
      return;
    }
    this.resolve(ok ? { spec: this.spec, name: name || undefined, folder: this.folder, position: this.position, makeDefault: this.makeDefault } : null);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.done) {
      this.done = true;
      this.resolve(null);
    }
  }
}
