import { Setting } from "obsidian";
import type InkNotebookPlugin from "../main";
import { normalizeEndpoint } from "../core/azureParse";
import { testImagePng } from "./azureClient";

export const AZURE_PORTAL_URL = "https://portal.azure.com/#create/Microsoft.CognitiveServicesComputerVision";
export const README_URL = "https://github.com/stefanmayer06/Obsidian-writing-for-eink#readme";

/**
 * Handwriting recognition settings (Azure AI Vision with the user's own key),
 * shared by the settings tab and the setup assistant.
 */
export function renderRecognitionSettings(container: HTMLElement, plugin: InkNotebookPlugin, opts: { advanced?: boolean } = {}): void {
  const s = plugin.settings;
  const intro = container.createDiv({ cls: "setting-item-description ink-block-desc" });
  intro.appendText("Azure AI Vision with your own key. The free tier (F0) covers 5,000 images per month. ");
  intro.createEl("a", { text: "Create a resource", href: AZURE_PORTAL_URL });
  intro.appendText(" · ");
  intro.createEl("a", { text: "Step-by-step guide", href: README_URL });
  renderAzureSettings(container, plugin);
  if (!opts.advanced) return;
  new Setting(container)
    .setName("API version")
    .setDesc("Automatic tries Image Analysis 4.0 first and falls back to Read 3.2 (available in more regions).")
    .addDropdown((d) =>
      d
        .addOptions({ auto: "Automatic", v4: "Image Analysis 4.0", "v3.2": "Read 3.2" })
        .setValue(s.azureApi)
        .onChange(async (v) => {
          s.azureApi = v as typeof s.azureApi;
          s.azureDetectedApi = "";
          await plugin.saveSettings();
        }),
    );
  new Setting(container)
    .setName("Language hint")
    .setDesc('Optional two-letter code such as "de" or "en" (Read 3.2 only). Leave empty for automatic detection.')
    .addText((t) =>
      t
        .setPlaceholder("auto")
        .setValue(s.azureLanguage)
        .onChange(async (v) => {
          s.azureLanguage = v.trim();
          await plugin.saveSettings();
        }),
    );
  new Setting(container)
    .setName("Requests per minute")
    .setDesc("The free tier allows 20 per minute.")
    .addText((t) =>
      t.setValue(String(s.requestsPerMinute)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n > 0) {
          s.requestsPerMinute = n;
          await plugin.saveSettings();
        }
      }),
    );
}

/** The Azure endpoint and key fields and the connection test. */
function renderAzureSettings(container: HTMLElement, plugin: InkNotebookPlugin): void {
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
        });
      t.inputEl.addClass("ink-wide-input");
      t.inputEl.addEventListener("blur", () => {
        const n = normalizeEndpoint(t.getValue());
        if (n && n !== t.getValue()) {
          t.setValue(n);
          s.azureEndpoint = n;
          void plugin.saveSettings();
        }
      });
    });
  new Setting(container)
    .setName("Azure key")
    .setDesc(`KEY 1 or KEY 2 of the same resource. It is stored in this vault's plugin settings (${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/data.json).`)
    .addText((t) => {
      t.setPlaceholder("Paste your key")
        .setValue(s.azureKey)
        .onChange(async (v) => {
          s.azureKey = v.trim();
          await plugin.saveSettings();
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
