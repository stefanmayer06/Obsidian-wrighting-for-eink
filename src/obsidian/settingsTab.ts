import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type InkNotebookPlugin from "../main";
import { paperLabel } from "../core/paper";
import { cleanSubfolder } from "../core/folders";
import { PaperPickerModal } from "./paperPicker";
import { SetupWizard } from "./setupWizard";
import { renderRecognitionSettings } from "./recognitionSettings";
import { DAILY_INK_OPTIONS, type BookmarkPosition, type DailyInk, type DiagramSensitivity, type InkSettings, type LowLatencyMode, type PageLocation, type TextViewMode } from "../settings";
import { dailyNoteSettings } from "./dailyNotes";

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

    const apply = async () => {
      await save();
      this.plugin.applyInkSettings();
    };
    const toggle = (name: string, desc: string, key: { [K in keyof InkSettings]: InkSettings[K] extends boolean ? K : never }[keyof InkSettings]) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = v;
            await apply();
          }),
        );

    new Setting(containerEl)
      .setName("Setup assistant")
      .setDesc("Walk through the setup again (writing, e-ink, handwriting recognition).")
      .addButton((b) => b.setButtonText("Open").onClick(() => new SetupWizard(this.plugin).open()));

    // ------------------------------------------------------------------ writing
    new Setting(containerEl).setName("Writing").setHeading();
    new Setting(containerEl)
      .setName("Pen side button")
      .setDesc("What holding the button on the side of the pen does (the eraser end of the pen always erases).")
      .addDropdown((d) =>
        d
          .addOptions({ eraser: "Erase", lasso: "Lasso (select)", none: "Nothing" })
          .setValue(s.sideButton)
          .onChange(async (v) => {
            s.sideButton = v as InkSettings["sideButton"];
            await apply();
          }),
      );
    toggle("Draw with a finger", "Off: only the pen writes; fingers turn pages, scroll and zoom (best with a stylus – your palm can rest on the screen).", "fingerDrawing");
    toggle("Pressure sensitivity", "Lines get wider the harder you press (fountain pen, brush, pencil).", "pressure");
    toggle("Scribble to erase", "Scratch quickly back and forth over writing with the pen to erase it.", "scribbleErase");
    toggle("Snap shapes when holding the pen", "Draw a line, rectangle, triangle or circle and keep the pen still at the end: it becomes a clean shape.", "holdToShape");
    toggle("Swipe to turn pages", "Swipe left/right (or up/down) with one finger.", "swipePages");
    toggle("Two-finger tap undoes", "", "twoFingerUndo");
    toggle("Three-finger tap redoes", "", "threeFingerRedo");
    new Setting(containerEl)
      .setName("Page on screen")
      .addDropdown((d) =>
        d
          .addOptions({ page: "Whole page", width: "Page width (scroll down)" })
          .setValue(s.fit)
          .onChange(async (v) => {
            s.fit = v === "width" ? "width" : "page";
            await apply();
          }),
      );
    new Setting(containerEl)
      .setName("Toolbar")
      .addDropdown((d) =>
        d
          .addOptions({ top: "Top", bottom: "Bottom", left: "Left", right: "Right" })
          .setValue(s.toolbarPosition)
          .onChange(async (v) => {
            s.toolbarPosition = v as InkSettings["toolbarPosition"];
            await apply();
          }),
      );
    new Setting(containerEl)
      .setName("Low-latency drawing")
      .setDesc("Draws the ink straight to the screen. Automatic leaves it off on e-ink screens, where it can show colours and the highlighter with a stripy pattern. Turn it off if the page flickers on your device.")
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Automatic", on: "Always on", off: "Off" })
          .setValue(s.lowLatency)
          .onChange(async (v) => {
            s.lowLatency = v as LowLatencyMode;
            await apply();
          }),
      );

    // ------------------------------------------------------------------ pages
    new Setting(containerEl).setName("Pages").setHeading();
    new Setting(containerEl)
      .setName("Where new pages go")
      .setDesc("The folder of the note you are in, always the same folder, or choose the folder for each page. (When the paper picker is on, it shows the folder too, with a button to choose another.)")
      .addDropdown((d) =>
        d
          .addOptions({ current: "Folder of the current note", fixed: "Fixed folder", ask: "Ask every time" })
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
      .setDesc("The ink pages (Name.ink.md) go into this subfolder of the text page's folder, so your folders only show your notes. Leave empty to keep them next to the text page.")
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
    const dailyAvailable = !!dailyNoteSettings(this.app);
    new Setting(containerEl)
      .setName("Daily notes")
      .setDesc(
        dailyAvailable
          ? "A new daily note gets an ink page (in its ink subfolder) when it opens. \"Opened to write on\" shows the ink page in its place. The command \"Open today's daily note on the ink page\" works with every option."
          : "Turn on the Daily notes core plugin (or Periodic Notes) – then new daily notes can come with an ink page.",
      )
      .addDropdown((d) =>
        d
          .addOptions(DAILY_INK_OPTIONS)
          .setValue(s.dailyInk)
          .onChange(async (v) => {
            s.dailyInk = v as DailyInk;
            await save();
          }),
      );
    new Setting(containerEl)
      .setName("Match up ink and text pages")
      .setDesc("Rename ink pages so that each text page Name.md has its ink page Name.ink.md in the ink subfolder next to it (e.g. a \"2026-10-27 (text)\" text page becomes \"2026-10-27\"). You see the list before anything is renamed.")
      .addButton((b) => b.setButtonText("Match up…").onClick(() => void this.plugin.matchUpPages()));
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
      .setDesc(
        "Highlight words the recognition is unsure about (==like this==) on the text page so they are easy to proofread – also words it read correctly but found hard to read. The highlights stay in the note until you remove them.",
      )
      .addToggle((t) =>
        t.setValue(s.highlightUncertain).onChange(async (v) => {
          s.highlightUncertain = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Transcribe while writing")
      .setDesc("Also update the text page a few seconds after you stop writing (uses more requests). Otherwise it updates when you open the text page or leave the ink page.")
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
      .setDesc("A handwritten [[Page]] gets a link button on the ink page, so you can jump to the page from your handwriting.")
      .addToggle((t) =>
        t.setValue(s.linkHandwriting).onChange(async (v) => {
          s.linkHandwriting = v;
          await save();
        }),
      );
    new Setting(containerEl)
      .setName("Diagram detection")
      .setDesc("How eagerly drawings (not text) are shown as pictures on the text page. Tip: select a drawing with the lasso and tap \"Figure\" to force it.")
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
            await apply();
          }),
      );
    new Setting(containerEl)
      .setName("Large touch targets")
      .setDesc("Bigger buttons on phones, tablets and e-ink devices.")
      .addToggle((t) =>
        t.setValue(s.largeTouchTargets).onChange(async (v) => {
          s.largeTouchTargets = v;
          await apply();
        }),
      );
    new Setting(containerEl)
      .setName("Bookmark position")
      .setDesc("Where the Ink/Text bookmarks prefer to sit on the right edge of the text page.")
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
    // ------------------------------------------------------------------ pdf
    new Setting(containerEl).setName("PDF annotation").setHeading();
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
    new Setting(containerEl)
      .setName("Folder for papers from arXiv")
      .setDesc("Imported papers get a text page here (with title, authors and abstract); the PDF and the ink page go into its subfolder for ink files.")
      .addText((t) =>
        t.setValue(s.papersFolder).onChange(async (v) => {
          s.papersFolder = v.trim().replace(/^\/+|\/+$/g, "") || "Papers";
          await save();
        }),
      );
  }
}
