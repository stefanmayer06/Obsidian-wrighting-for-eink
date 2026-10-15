import { App, FuzzySuggestModal, Modal, Setting, TFile } from "obsidian";

/** Simple text prompt that resolves to the entered text (or null when cancelled). */
export class TextPromptModal extends Modal {
  private value: string;
  private resolved = false;

  private constructor(
    app: App,
    private titleText: string,
    initial: string,
    private resolve: (v: string | null) => void,
  ) {
    super(app);
    this.value = initial;
  }

  static ask(app: App, title: string, initial = ""): Promise<string | null> {
    return new Promise((resolve) => new TextPromptModal(app, title, initial, resolve).open());
  }

  onOpen(): void {
    this.titleEl.setText(this.titleText);
    this.modalEl.addClass("ink-modal");
    const s = new Setting(this.contentEl).addText((t) => {
      t.setValue(this.value).onChange((v) => (this.value = v));
      t.inputEl.addClass("ink-wide-input");
      t.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          this.finish(this.value.trim() || null);
        }
      });
      window.setTimeout(() => {
        t.inputEl.focus();
        t.inputEl.select();
      }, 50);
    });
    s.infoEl.remove();
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
      .addButton((b) =>
        b
          .setButtonText("OK")
          .setCta()
          .onClick(() => this.finish(this.value.trim() || null)),
      );
  }

  private finish(v: string | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(v);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }
}

/** Pick a file with given extensions from the vault. */
export class FilePickModal extends FuzzySuggestModal<TFile> {
  private picked = false;

  private constructor(
    app: App,
    private files: TFile[],
    placeholder: string,
    private resolve: (f: TFile | null) => void,
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  static pick(app: App, extensions: string[], placeholder: string): Promise<TFile | null> {
    const exts = extensions.map((e) => e.toLowerCase());
    const files = app.vault
      .getFiles()
      .filter((f) => exts.includes(f.extension.toLowerCase()))
      .sort((a, b) => b.stat.mtime - a.stat.mtime);
    return new Promise((resolve) => new FilePickModal(app, files, placeholder, resolve).open());
  }

  getItems(): TFile[] {
    return this.files;
  }

  getItemText(f: TFile): string {
    return f.path;
  }

  onChooseItem(f: TFile): void {
    this.picked = true;
    this.resolve(f);
  }

  onClose(): void {
    super.onClose();
    // onChooseItem runs after onClose in some Obsidian versions – defer the "cancelled" answer
    window.setTimeout(() => {
      if (!this.picked) this.resolve(null);
    }, 50);
  }
}

/** Options for importing a PDF to annotate. */
export class PdfImportModal extends Modal {
  private range: string;
  private done = false;

  private constructor(
    app: App,
    private fileName: string,
    private pageCount: number,
    initialRange: string,
    private resolve: (v: string | null) => void,
  ) {
    super(app);
    this.range = initialRange;
  }

  static ask(app: App, fileName: string, pageCount: number, initialRange: string): Promise<string | null> {
    return new Promise((resolve) => new PdfImportModal(app, fileName, pageCount, initialRange, resolve).open());
  }

  onOpen(): void {
    this.titleEl.setText(`Annotate "${this.fileName}"`);
    this.modalEl.addClass("ink-modal");
    this.contentEl.createEl("p", {
      text: `The PDF has ${this.pageCount} page${this.pageCount === 1 ? "" : "s"}. Choose which pages to put on the ink page. Large selections take longer to open on e-ink devices.`,
    });
    new Setting(this.contentEl)
      .setName("Pages")
      .setDesc('e.g. "all", "1-5" or "1, 3, 8-10"')
      .addText((t) => t.setValue(this.range).onChange((v) => (this.range = v)));
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
      .addButton((b) =>
        b
          .setButtonText("Annotate")
          .setCta()
          .onClick(() => this.finish(this.range)),
      );
  }

  private finish(v: string | null): void {
    if (this.done) return;
    this.done = true;
    this.resolve(v);
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
