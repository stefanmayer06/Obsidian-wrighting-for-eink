import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type InkNotebookPlugin from "../main";
import { paperLabel } from "../core/paper";
import { cleanSubfolder } from "../core/folders";
import { PaperPickerModal } from "./paperPicker";
import { applyEinkClasses } from "./einkMode";
import { applyEinkExcalidrawSettings, excalidrawSettingsDiff, isExcalidrawReady } from "./excalidrawBridge";
import { SetupWizard } from "./setupWizard";
import { renderRecognitionSettings } from "./recognitionSettings";
import type { BookmarkPosition, DiagramSensitivity, PageLocation, TextViewMode } from "../settings";

export class InkSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: InkNotebookPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ink-settings");
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl)
      .setName("Setup assistant")
      .setDesc("Walk through the setup again (Excalidraw, e-ink, handwriting recognition).")
      .addButton((b) => b.setButtonText("Open").onClick(() => new SetupWizard(this.plugin).open()));

    // ------------------------------------------------------------------ pages
    new Setting(containerEl).setName("Pages").setHeading();
    new Setting(containerEl)
      .setName("Where new pages go")
      .setDesc("The folder of the note you are in, or always the same folder.")
      .addDropdown((d) =>
        d
          .addOptions({ current: "Folder of the current note", fixed: "Fixed folder" })
          .setValue(s.pageLocation)
          .onChange(async (v) => {
            s.pageLocation = v as PageLocation;
            await save();
            this.display();
          }),
      );
    new Setting(containerEl)
      .setName(s.pageLocation === "fixed" ? "Folder for new pages" : "Folder when no note is open")
      .addText((t) =>
        t.setValue(s.folder).onChange(async (v) => {
          s.folder = v.trim().replace(/^\/+|\/+$/g, "") || "Ink";
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Subfolder for ink files")
      .setDesc("Drawings and paper backgrounds go into this subfolder of the text page's folder, so your folders only show your notes. Leave empty to keep them next to the text page.")
      .addText((t) =>
        t
          .setPlaceholder("next to the text page")
          .setValue(s.inkSubfolder)
          .onChange(async (v) => {
            s.inkSubfolder = cleanSubfolder(v);
            await save();
          }),
      );
    const paperSetting = new Setting(containerEl)
      .setName("Paper for new pages")
      .setDesc(paperLabel(s.paper))
      .addButton((b) =>
        b.setButtonText("Choose…").onClick(async () => {
          const choice = await PaperPickerModal.pick(this.app, { mode: "default", initial: s.paper });
          if (!choice) return;
          s.paper = choice.spec;
          await save();
          paperSetting.setDesc(paperLabel(s.paper));
        }),
      );
    new Setting(containerEl)
      .setName("Choose the paper for every new page")
      .setDesc("Show the paper picker (ruled, dotted, squared, … with spacing, colour and orientation) when creating a page.")
      .addToggle((t) =>
        t.setValue(s.askForPaper).onChange(async (v) => {
          s.askForPaper = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Ask for a name when creating a page")
      .setDesc("Otherwise pages are named with the date and time; rename them any time.")
      .addToggle((t) =>
        t.setValue(s.askForPageName).onChange(async (v) => {
          s.askForPageName = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Open the text page in")
      .addDropdown((d) =>
        d
          .addOptions({ reading: "Reading view (calm, best on e-ink)", editing: "Editing view", keep: "Obsidian default" })
          .setValue(s.textViewMode)
          .onChange(async (v) => {
            s.textViewMode = v as TextViewMode;
            await save();
          }),
      );
    new Setting(containerEl)
      .setName("Keep names in sync")
      .setDesc("Renaming or moving the ink or text page renames/moves the other one too.")
      .addToggle((t) =>
        t.setValue(s.keepNamesInSync).onChange(async (v) => {
          s.keepNamesInSync = v;
          await save();
        }),
      );

    // ------------------------------------------------------------------ handwriting
    new Setting(containerEl).setName("Handwriting recognition").setHeading();
    renderRecognitionSettings(containerEl, this.plugin, { advanced: true });
    new Setting(containerEl)
      .setName("Mark uncertain words")
      .setDesc("Highlight words the recognition is unsure about (==like this==) so they are easy to proofread.")
      .addToggle((t) =>
        t.setValue(s.highlightUncertain).onChange(async (v) => {
          s.highlightUncertain = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Transcribe while writing")
      .setDesc("Also update the text page whenever the drawing is saved (uses more requests). Otherwise it updates when you flip the bookmark or leave the page.")
      .addToggle((t) =>
        t.setValue(s.autoTranscribe).onChange(async (v) => {
          s.autoTranscribe = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Wait for recognition when flipping (seconds)")
      .setDesc("If recognition takes longer, the text page opens anyway and updates when the result arrives.")
      .addSlider((sl) =>
        sl
          .setLimits(3, 60, 1)
          .setValue(s.transcribeTimeoutSec)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.transcribeTimeoutSec = v;
            await save();
          }),
      );
    new Setting(containerEl)
      .setName("Clickable handwritten links")
      .setDesc("A handwritten [[Page]] gets a link icon on the ink page, so you can jump to the page from your handwriting.")
      .addToggle((t) =>
        t.setValue(s.linkHandwriting).onChange(async (v) => {
          s.linkHandwriting = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Diagram detection")
      .setDesc("How eagerly drawings (not text) are turned into embedded diagrams on the text page. Tip: put a drawing in a frame named \"Diagram …\" to force it.")
      .addDropdown((d) =>
        d
          .addOptions({ low: "Only clear drawings", normal: "Normal", high: "Also small sketches" })
          .setValue(s.diagramSensitivity)
          .onChange(async (v) => {
            s.diagramSensitivity = v as DiagramSensitivity;
            await save();
          }),
      );
    new Setting(containerEl)
      .setName("Offline queue")
      .setDesc(`${s.queue.length} page(s) waiting for handwriting recognition.`)
      .addButton((b) => b.setButtonText("Retry now").onClick(() => void this.plugin.processQueue(true)))
      .addButton((b) =>
        b.setButtonText("Clear recognition cache").onClick(() => {
          this.plugin.ocr.clearCache();
          new Notice("Recognition cache cleared. Pages are recognised again the next time you flip them.");
        }),
      );

    // ------------------------------------------------------------------ typed notes
    new Setting(containerEl).setName("Typed notes").setHeading();
    new Setting(containerEl)
      .setName("Show typed notes on the ink page")
      .setDesc("Text you type on the text page appears as a text card on the drawing (and edits to the card come back).")
      .addToggle((t) =>
        t.setValue(s.syncTypedNotes).onChange(async (v) => {
          s.syncTypedNotes = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Font of the typed notes card")
      .addDropdown((d) =>
        d
          .addOptions({ "6": "Nunito (clean)", "5": "Excalifont (hand-drawn)", "2": "Helvetica", "3": "Cascadia (monospace)" })
          .setValue(String(s.typedFontFamily))
          .onChange(async (v) => {
            s.typedFontFamily = parseInt(v, 10);
            await save();
          }),
      );
    new Setting(containerEl)
      .setName("Card width")
      .addSlider((sl) =>
        sl
          .setLimits(300, 1200, 20)
          .setValue(s.typedWidth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.typedWidth = v;
            await save();
          }),
      );

    // ------------------------------------------------------------------ display
    new Setting(containerEl).setName("Display & e-ink").setHeading();
    new Setting(containerEl)
      .setName("E-ink optimisations")
      .setDesc("No animations or shadows, high contrast, larger touch targets. Automatic turns this on for Boox and other e-ink devices.")
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Automatic", on: "Always on", off: "Off" })
          .setValue(s.einkMode)
          .onChange(async (v) => {
            s.einkMode = v as typeof s.einkMode;
            await save();
            applyEinkClasses(s);
          }),
      );
    new Setting(containerEl)
      .setName("Large touch targets")
      .setDesc("Bigger buttons on phones, tablets and e-ink devices.")
      .addToggle((t) =>
        t.setValue(s.largeTouchTargets).onChange(async (v) => {
          s.largeTouchTargets = v;
          await save();
          applyEinkClasses(s);
        }),
      );
    if (isExcalidrawReady(this.app)) {
      const diff = excalidrawSettingsDiff(this.app);
      new Setting(containerEl)
        .setName("Excalidraw stylus settings")
        .setDesc(diff.length === 0 ? "✓ Using the recommended e-ink pen settings." : "Pen draws, one finger pans, double-tap with the pen erases.")
        .addButton((b) =>
          b
            .setButtonText(diff.length === 0 ? "Applied" : "Apply")
            .setDisabled(diff.length === 0)
            .onClick(async () => {
              await applyEinkExcalidrawSettings(this.app);
              new Notice("Excalidraw pen settings updated.");
              this.display();
            }),
        );
    }
    new Setting(containerEl)
      .setName("Bookmark position")
      .setDesc("Where the bookmarks prefer to sit on the right edge of the page. They always move out of the way of toolbars and panels.")
      .addDropdown((d) =>
        d
          .addOptions({ top: "Upper", middle: "Middle", bottom: "Lower" })
          .setValue(s.bookmarkPosition)
          .onChange(async (v) => {
            s.bookmarkPosition = v as BookmarkPosition;
            await save();
            this.plugin.bookmarks.refreshAll();
          }),
      );
    new Setting(containerEl)
      .setName("Bookmark on every drawing")
      .setDesc("Also show a \"+ Text\" bookmark on Excalidraw drawings that do not have a text page yet.")
      .addToggle((t) =>
        t.setValue(s.showBookmarkOnAllDrawings).onChange(async (v) => {
          s.showBookmarkOnAllDrawings = v;
          await save();
        }),
      );

    // ------------------------------------------------------------------ pdf
    new Setting(containerEl).setName("PDF annotation").setHeading();
    new Setting(containerEl)
      .setName("Page width on the ink page")
      .addSlider((sl) =>
        sl
          .setLimits(600, 2000, 50)
          .setValue(s.pdfPageWidth)
          .setDynamicTooltip()
          .onChange(async (v) => {
            s.pdfPageWidth = v;
            await save();
          }),
      );
    new Setting(containerEl)
      .setName("Ask which pages to import above")
      .setDesc("PDFs with more pages ask for a page range (big PDFs are slow on e-ink devices).")
      .addText((t) =>
        t.setValue(String(s.pdfMaxPagesWithoutAsking)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (Number.isFinite(n) && n > 0) {
            s.pdfMaxPagesWithoutAsking = n;
            await save();
          }
        }),
      );
  }
}
