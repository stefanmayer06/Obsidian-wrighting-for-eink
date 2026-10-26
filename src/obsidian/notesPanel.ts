import { Component, MarkdownRenderer, setIcon, TFile } from "obsidian";
import type InkNotebookPlugin from "../main";
import { applyTypedNotes, extractTypedNotes } from "../core/typedNotes";

/**
 * "Typed notes" next to the handwriting: everything typed on the text page
 * (outside the transcript of the handwriting), shown and edited in a panel on
 * the ink page.
 */
export class NotesPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private component = new Component();
  private editing = false;
  private textarea: HTMLTextAreaElement | null = null;
  private editBtn: HTMLButtonElement;

  constructor(
    private plugin: InkNotebookPlugin,
    parent: HTMLElement,
    private drawing: TFile | null,
    private onClose: () => void,
  ) {
    this.el = parent.createDiv({ cls: "ink-notes-panel ink-ui" });
    const head = this.el.createDiv({ cls: "ink-notes-head" });
    head.createSpan({ cls: "ink-notes-title", text: "Typed notes" });
    this.editBtn = head.createEl("button", { cls: "ink-notes-btn", text: "Edit", attr: { type: "button" } });
    this.editBtn.addEventListener("click", () => void (this.editing ? this.save() : this.edit()));
    const close = head.createEl("button", { cls: "ink-notes-btn", attr: { type: "button", "aria-label": "Close" } });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      void this.save().then(() => this.close());
    });
    this.body = this.el.createDiv({ cls: "ink-notes-body" });
    this.component.load();
    void this.refresh();
  }

  private get text(): TFile | null {
    return this.drawing ? this.plugin.pairs.textFor(this.drawing) : null;
  }

  setFile(drawing: TFile | null): void {
    this.drawing = drawing;
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.editing) return;
    this.body.empty();
    const text = this.text;
    if (!text) {
      this.body.createEl("p", { cls: "ink-notes-empty", text: "This ink page has no text page yet. Tap Edit to type notes – the text page is created for them." });
      return;
    }
    const typed = extractTypedNotes(await this.plugin.app.vault.read(text));
    if (!typed.trim()) {
      this.body.createEl("p", { cls: "ink-notes-empty", text: "Nothing typed yet. Tap Edit to add notes; they are kept on the text page." });
      return;
    }
    this.component.unload();
    this.component = new Component();
    this.component.load();
    await MarkdownRenderer.render(this.plugin.app, typed, this.body.createDiv({ cls: "markdown-rendered" }), text.path, this.component);
  }

  private async edit(): Promise<void> {
    let text = this.text;
    if (!text && this.drawing) text = await this.plugin.pairs.createTextPage(this.drawing);
    if (!text) return;
    this.editing = true;
    this.editBtn.setText("Save");
    this.body.empty();
    const ta = this.body.createEl("textarea", { cls: "ink-notes-input" });
    ta.value = extractTypedNotes(await this.plugin.app.vault.read(text));
    this.textarea = ta;
    window.setTimeout(() => ta.focus(), 0);
  }

  private async save(): Promise<void> {
    if (!this.editing || !this.textarea) return;
    const value = this.textarea.value;
    const text = this.text;
    this.editing = false;
    this.textarea = null;
    this.editBtn.setText("Edit");
    if (text) await this.plugin.app.vault.process(text, (cur) => (extractTypedNotes(cur) === value ? cur : applyTypedNotes(cur, value)));
    await this.refresh();
  }

  close(): void {
    this.component.unload();
    this.el.remove();
    this.onClose();
  }
}
