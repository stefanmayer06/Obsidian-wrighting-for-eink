import { type App, Modal, Setting, TFile } from "obsidian";
import { mermaidToItems, type MermaidInk, type TextMeasure } from "../core/ink/fromMermaid";
import { mermaidBlocks, mermaidName } from "../core/ink/mermaid";
import { itemsBounds } from "../core/ink/transform";
import { drawItems } from "../ink/render";
import { FilePickModal } from "./modals";

/**
 * Add a Mermaid diagram to the object library: paste its code (or choose a
 * file on the device or a note in the vault – a Markdown note with several
 * ```mermaid blocks lets you pick one), see it as ink, give it a name.
 */

export interface MermaidDraft {
  name: string;
  code: string;
}

const EXAMPLE = `flowchart TD
    A[Start] --> B{Is it working?}
    B -- yes --> C[Great]
    B -- no --> D[Fix it]
    D --> B`;

const FILE_TYPES = ".mmd,.mermaid,.md,.markdown,.txt,text/plain,text/markdown";

export class MermaidModal extends Modal {
  private name: string;
  private code: string;
  /** The name was typed (it no longer follows the diagram's title). */
  private nameTyped = false;
  private resolved = false;
  private nameInput!: HTMLInputElement;
  private codeEl!: HTMLTextAreaElement;
  private pickEl!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private status!: HTMLElement;
  private addBtn!: HTMLButtonElement;
  private timer: number | null = null;
  private result: MermaidInk | null = null;

  private constructor(
    app: App,
    initial: Partial<MermaidDraft>,
    private measure: TextMeasure,
    private resolve: (d: MermaidDraft | null) => void,
  ) {
    super(app);
    this.name = initial.name ?? "";
    this.code = initial.code ?? "";
    this.nameTyped = !!initial.name;
  }

  /** Ask for a diagram (prefilled with `initial`); null when cancelled. */
  static ask(app: App, measure: TextMeasure, initial: Partial<MermaidDraft> = {}): Promise<MermaidDraft | null> {
    return new Promise((resolve) => new MermaidModal(app, initial, measure, resolve).open());
  }

  onOpen(): void {
    this.titleEl.setText("Add a Mermaid diagram");
    this.modalEl.addClass("ink-modal", "ink-mermaid-modal");
    const c = this.contentEl;
    c.createEl("p", {
      cls: "ink-mermaid-intro",
      text: "Paste the Mermaid code of a flowchart (flowchart TD / graph LR …) or choose a file. It is kept in the Mermaid library as shapes with their labels, arrows attached to them, subgraphs and colours – tap it there, then tap the page.",
    });

    const name = new Setting(c).setName("Name").addText((t) => {
      t.setPlaceholder("Mermaid diagram")
        .setValue(this.name)
        .onChange((v) => {
          this.name = v;
          this.nameTyped = v.trim() !== "";
        });
      t.inputEl.addClass("ink-wide-input");
      this.nameInput = t.inputEl;
    });
    name.settingEl.addClass("ink-mermaid-name");

    const sources = c.createDiv({ cls: "ink-mermaid-sources" });
    const btn = (label: string, run: () => void) => {
      const b = sources.createEl("button", { text: label, cls: "ink-mermaid-source" });
      b.addEventListener("click", (e) => {
        e.preventDefault();
        run();
      });
      return b;
    };
    btn("Paste", () => void this.paste());
    btn("Choose a file…", () => this.chooseFile());
    btn("From the vault…", () => void this.chooseNote());
    btn("Example", () => this.setCode(EXAMPLE, "Example"));
    this.pickEl = c.createDiv({ cls: "ink-mermaid-pick" });
    this.pickEl.hidden = true;

    this.codeEl = c.createEl("textarea", { cls: "ink-mermaid-code" });
    this.codeEl.placeholder = EXAMPLE;
    this.codeEl.spellcheck = false;
    this.codeEl.setAttr("autocapitalize", "off");
    this.codeEl.setAttr("autocomplete", "off");
    this.codeEl.value = this.code;
    this.codeEl.addEventListener("input", () => {
      this.code = this.codeEl.value;
      this.pickEl.hidden = true;
      this.schedule();
    });

    const preview = c.createDiv({ cls: "ink-mermaid-preview" });
    this.canvas = preview.createEl("canvas", { cls: "ink-mermaid-canvas" });
    this.status = c.createDiv({ cls: "ink-mermaid-status" });

    new Setting(c)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
      .addButton((b) => {
        b.setButtonText("Add to library")
          .setCta()
          .onClick(() => this.add());
        this.addBtn = b.buttonEl;
      });
    this.update();
    window.setTimeout(() => (this.code ? this.nameInput : this.codeEl).focus(), 50);
  }

  private schedule(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.update();
    }, 250);
  }

  private setCode(code: string, fallbackName?: string): void {
    this.code = code.replace(/\r\n?/g, "\n").trim();
    this.codeEl.value = this.code;
    if (!this.nameTyped) {
      this.name = mermaidName(this.code, fallbackName) ?? this.name;
      this.nameInput.value = this.name;
    }
    this.update();
  }

  /** Text of a file or note (`name`; null for the clipboard): its diagrams; several let you choose one. */
  private loadText(text: string, name: string | null): void {
    const what = name ? `“${name}”` : "The clipboard";
    const blocks = mermaidBlocks(text);
    this.pickEl.empty();
    this.pickEl.hidden = true;
    if (blocks.length === 0) {
      this.code = "";
      this.codeEl.value = "";
      this.result = null;
      this.drawPreview();
      this.setStatus(`${what} has no Mermaid diagram (no flowchart, and no \`\`\`mermaid code block).`, true);
      this.addBtn.disabled = true;
      return;
    }
    if (blocks.length > 1) {
      this.pickEl.hidden = false;
      this.pickEl.createSpan({ text: `${blocks.length} diagrams in ${name ? what : "the clipboard"}:` });
      blocks.forEach((code, i) => {
        const b = this.pickEl.createEl("button", { text: mermaidName(code) ?? `Diagram ${i + 1}`, cls: "ink-mermaid-source" });
        b.addEventListener("click", (e) => {
          e.preventDefault();
          this.pickEl.findAll("button").forEach((x) => x.removeClass("is-active"));
          b.addClass("is-active");
          this.setCode(code, name ? `${name} ${i + 1}` : undefined);
        });
        if (i === 0) b.addClass("is-active");
      });
    }
    this.setCode(blocks[0], name ? (blocks.length > 1 ? `${name} 1` : name) : undefined);
  }

  private async paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) {
        this.loadText(text, null);
        return;
      }
      this.setStatus("The clipboard is empty.", true);
    } catch {
      // no access to the clipboard: paste into the box by hand
      this.codeEl.focus();
      this.setStatus("Paste the code into the box (long press, or Ctrl/Cmd+V).", true);
    }
  }

  private chooseFile(): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = FILE_TYPES;
    input.addEventListener("change", () => {
      const f = input.files?.[0];
      if (!f) return;
      void f.text().then(
        (text) => this.loadText(text, f.name.replace(/\.(mmd|mermaid|md|markdown|txt)$/i, "")),
        (e: unknown) => this.setStatus(`The file could not be read: ${e instanceof Error ? e.message : String(e)}`, true),
      );
    });
    input.click();
  }

  private async chooseNote(): Promise<void> {
    const file = await FilePickModal.pick(this.app, ["md", "mmd", "mermaid"], "A note with a Mermaid diagram, or a .mmd file");
    if (!(file instanceof TFile)) return;
    this.loadText(await this.app.vault.cachedRead(file), file.basename);
  }

  private setStatus(text: string, error = false): void {
    this.status.setText(text);
    this.status.toggleClass("is-error", error);
  }

  private update(): void {
    const code = this.code.trim();
    this.result = null;
    if (!code) {
      this.setStatus("Paste Mermaid code or choose a file to see the diagram here.");
    } else {
      try {
        this.result = mermaidToItems(code, this.measure);
        const r = this.result;
        this.setStatus(`${r.shapes} shape${r.shapes === 1 ? "" : "s"}, ${r.arrows} arrow${r.arrows === 1 ? "" : "s"}.`);
        if (!this.nameTyped && !this.name) {
          const title = mermaidName(code);
          if (title) {
            this.name = title;
            this.nameInput.value = title;
          }
        }
      } catch (e) {
        this.setStatus(e instanceof Error ? e.message : String(e), true);
      }
    }
    this.addBtn.disabled = !this.result;
    this.drawPreview();
  }

  private drawPreview(): void {
    const items = this.result?.items;
    const box = items ? itemsBounds(items) : null;
    const wrap = this.canvas.parentElement as HTMLElement;
    const cssW = Math.max(200, wrap.clientWidth || 600);
    const cssH = box ? Math.min(420, Math.max(120, (cssW * box.h) / Math.max(1, box.w))) : 120;
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!items || !box) return;
    const pad = 10;
    const k = Math.min((cssW - 2 * pad) / Math.max(1, box.w), (cssH - 2 * pad) / Math.max(1, box.h), 1.2) * dpr;
    ctx.setTransform(k, 0, 0, k, (this.canvas.width - box.w * k) / 2 - box.x * k, (this.canvas.height - box.h * k) / 2 - box.y * k);
    drawItems(ctx, items);
  }

  private add(): void {
    if (!this.result) return;
    const name = this.name.trim() || mermaidName(this.code) || "Mermaid diagram";
    this.finish({ name, code: this.code.trim() });
  }

  private finish(d: MermaidDraft | null): void {
    if (this.resolved) return;
    this.resolved = true;
    this.resolve(d);
    this.close();
  }

  onClose(): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolve(null);
    }
  }
}
