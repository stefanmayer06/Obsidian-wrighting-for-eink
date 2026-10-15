import { App, Modal, Notice, Platform, Setting } from "obsidian";
import type InkNotebookPlugin from "../main";
import { PAPER_STYLES, type PaperStyle } from "../core/paper";
import { normalizeEndpoint } from "../core/azureParse";
import { currentDevice, applyEinkClasses } from "./einkMode";
import {
  applyEinkExcalidrawSettings,
  compareVersions,
  excalidrawSettingsDiff,
  excalidrawVersion,
  isExcalidrawInstalled,
  isExcalidrawReady,
  EXCALIDRAW_PLUGIN_ID,
  MIN_EXCALIDRAW_VERSION,
} from "./excalidrawBridge";
import { testImagePng } from "./azureClient";

export const AZURE_PORTAL_URL = "https://portal.azure.com/#create/Microsoft.CognitiveServicesComputerVision";
export const README_URL = "https://github.com/stefanmayer06/Obsidian-wrighting-for-eink#readme";

/** Opens Excalidraw in Obsidian's community plugin browser. */
export function openExcalidrawInstall(app: App): void {
  const setting = (app as unknown as { setting?: { open(): void; openTabById(id: string): unknown } }).setting;
  try {
    window.open(`obsidian://show-plugin?id=${EXCALIDRAW_PLUGIN_ID}`);
  } catch {
    setting?.open();
    setting?.openTabById("community-plugins");
  }
}

export async function enableExcalidraw(app: App): Promise<boolean> {
  const plugins = (app as unknown as { plugins?: { enablePluginAndSave?(id: string): Promise<boolean> } }).plugins;
  if (!plugins?.enablePluginAndSave) return false;
  try {
    await plugins.enablePluginAndSave(EXCALIDRAW_PLUGIN_ID);
    return true;
  } catch {
    return false;
  }
}

/** Render the "Handwriting recognition" settings + test button into a container. */
export function renderAzureSettings(container: HTMLElement, plugin: InkNotebookPlugin, onChange?: () => void): void {
  const s = plugin.settings;
  new Setting(container)
    .setName("Azure endpoint")
    .setDesc("From your Azure AI Vision (Computer Vision) resource → Keys and Endpoint. Example: https://my-notes.cognitiveservices.azure.com")
    .addText((t) => {
      t.setPlaceholder("https://<name>.cognitiveservices.azure.com")
        .setValue(s.azureEndpoint)
        .onChange(async (v) => {
          s.azureEndpoint = v.trim();
          s.azureDetectedApi = "";
          await plugin.saveSettings();
          onChange?.();
        });
      t.inputEl.addClass("ink-wide-input");
      t.inputEl.addEventListener("blur", async () => {
        const n = normalizeEndpoint(t.getValue());
        if (n && n !== t.getValue()) {
          t.setValue(n);
          s.azureEndpoint = n;
          await plugin.saveSettings();
        }
      });
    });
  new Setting(container)
    .setName("Azure key")
    .setDesc("KEY 1 or KEY 2 of the same resource. It is stored in this vault's plugin settings (.obsidian/plugins/ink-notebook/data.json).")
    .addText((t) => {
      t.setPlaceholder("Paste your key")
        .setValue(s.azureKey)
        .onChange(async (v) => {
          s.azureKey = v.trim();
          await plugin.saveSettings();
          onChange?.();
        });
      t.inputEl.type = "password";
      t.inputEl.addClass("ink-wide-input");
    });
  const status = container.createDiv({ cls: "ink-test-status" });
  new Setting(container)
    .setName("Test connection")
    .setDesc("Sends a tiny test image to Azure.")
    .addButton((b) =>
      b.setButtonText("Test").onClick(async () => {
        status.setText("Testing…");
        status.className = "ink-test-status";
        b.setDisabled(true);
        try {
          const png = await testImagePng();
          const r = await plugin.ocr.testConnection(png);
          status.setText(`✓ Connected (API ${r.api}). Azure read: "${r.text || "(nothing)"}"`);
          status.addClass("is-ok");
          void plugin.processQueue();
        } catch (e) {
          status.setText(`✗ ${e instanceof Error ? e.message : String(e)}`);
          status.addClass("is-error");
        } finally {
          b.setDisabled(false);
        }
      }),
    );
}

/**
 * First-run setup: Excalidraw check, device (e-ink) setup, optional handwriting
 * recognition and where pages go. Everything can be changed later in settings.
 */
export class SetupWizard extends Modal {
  constructor(private plugin: InkNotebookPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("ink-modal", "ink-setup");
    this.titleEl.setText("Welcome to Ink Notebook");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const s = this.plugin.settings;
    contentEl.createEl("p", {
      text: "Write by hand on the ink page, flip the bookmark, and read your notes as text. Four quick steps – you can change everything later in the settings.",
    });

    // ---- Step 1: Excalidraw ----
    const step1 = this.step(contentEl, "1", "Excalidraw (required)");
    const ready = isExcalidrawReady(this.app);
    const version = excalidrawVersion(this.app);
    if (ready) {
      const old = version && compareVersions(version, MIN_EXCALIDRAW_VERSION) < 0;
      step1.createEl("p", {
        cls: old ? "ink-warn" : "ink-ok",
        text: old ? `Excalidraw ${version} is installed but too old – please update it.` : `✓ Excalidraw ${version ?? ""} is installed and enabled.`,
      });
    } else if (isExcalidrawInstalled(this.app)) {
      step1.createEl("p", { cls: "ink-warn", text: "Excalidraw is installed but not enabled." });
      new Setting(step1).addButton((b) =>
        b
          .setButtonText("Enable Excalidraw")
          .setCta()
          .onClick(async () => {
            await enableExcalidraw(this.app);
            window.setTimeout(() => this.render(), 800);
          }),
      );
    } else {
      step1.createEl("p", { cls: "ink-warn", text: "Ink Notebook is built on the Excalidraw plugin. Please install it first (free, from Community plugins)." });
      new Setting(step1)
        .addButton((b) =>
          b
            .setButtonText("Install Excalidraw")
            .setCta()
            .onClick(() => openExcalidrawInstall(this.app)),
        )
        .addButton((b) => b.setButtonText("I installed it – check again").onClick(() => this.render()));
    }

    // ---- Step 2: device ----
    const step2 = this.step(contentEl, "2", "Your device");
    const dev = currentDevice();
    step2.createEl("p", {
      text: dev.isEink
        ? `Detected an e-ink device (${dev.vendor ?? "e-ink"}${dev.model ? ` ${dev.model}` : ""}). E-ink optimisations are on.`
        : Platform.isMobile
          ? "On a Boox or other e-ink tablet, turn on the e-ink optimisations."
          : "E-ink optimisations are meant for Boox and other e-ink tablets.",
    });
    new Setting(step2)
      .setName("E-ink optimisations")
      .setDesc("No animations or shadows, high contrast, larger touch targets.")
      .addDropdown((d) =>
        d
          .addOptions({ auto: "Automatic (detect e-ink)", on: "Always on", off: "Off" })
          .setValue(s.einkMode)
          .onChange(async (v) => {
            s.einkMode = v as typeof s.einkMode;
            await this.plugin.saveSettings();
            applyEinkClasses(s);
          }),
      );
    if (ready) {
      const diff = excalidrawSettingsDiff(this.app);
      new Setting(step2)
        .setName("Stylus settings for Excalidraw")
        .setDesc(
          diff.length === 0
            ? "✓ Excalidraw already uses the recommended pen settings."
            : "Recommended for Boox: pen draws, one finger pans, double-tap with the pen erases, plain toolbar colours.",
        )
        .addButton((b) =>
          b
            .setButtonText(diff.length === 0 ? "Applied" : "Apply")
            .setDisabled(diff.length === 0)
            .onClick(async () => {
              await applyEinkExcalidrawSettings(this.app);
              new Notice("Excalidraw pen settings updated.");
              this.render();
            }),
        );
    }

    // ---- Step 3: handwriting recognition ----
    const step3 = this.step(contentEl, "3", "Handwriting → text (optional)");
    step3.createEl("p", {
      text: "Uses Azure AI Vision. The free tier (F0) covers 5,000 pages per month. Without it, your handwriting is shown as an image on the text page. Offline, pages are queued and transcribed when you're back online.",
    });
    const links = step3.createDiv({ cls: "ink-links" });
    links.createEl("a", { text: "Create a free Azure Vision resource", href: AZURE_PORTAL_URL });
    links.createSpan({ text: " · " });
    links.createEl("a", { text: "Step-by-step guide", href: `${README_URL}` });
    renderAzureSettings(step3, this.plugin);

    // ---- Step 4: pages ----
    const step4 = this.step(contentEl, "4", "Your pages");
    new Setting(step4)
      .setName("Folder for ink pages")
      .addText((t) =>
        t.setValue(s.folder).onChange(async (v) => {
          s.folder = v.trim().replace(/^\/+|\/+$/g, "") || "Ink";
          await this.plugin.saveSettings();
        }),
      );
    new Setting(step4)
      .setName("Paper")
      .setDesc("Lined paper helps handwriting recognition.")
      .addDropdown((d) =>
        d
          .addOptions(PAPER_STYLES)
          .setValue(s.paperStyle)
          .onChange(async (v) => {
            s.paperStyle = v as PaperStyle;
            await this.plugin.saveSettings();
          }),
      );

    // ---- Finish ----
    new Setting(contentEl)
      .addButton((b) =>
        b.setButtonText("Close").onClick(async () => {
          s.setupDone = true;
          await this.plugin.saveSettings();
          this.close();
        }),
      )
      .addButton((b) =>
        b
          .setButtonText("Create my first ink page")
          .setCta()
          .setDisabled(!ready)
          .onClick(async () => {
            s.setupDone = true;
            await this.plugin.saveSettings();
            this.close();
            await this.plugin.switcher.createPage();
          }),
      );
  }

  private step(parent: HTMLElement, n: string, title: string): HTMLElement {
    const box = parent.createDiv({ cls: "ink-step" });
    const h = box.createDiv({ cls: "ink-step-title" });
    h.createSpan({ cls: "ink-step-num", text: n });
    h.createSpan({ text: title });
    return box;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
