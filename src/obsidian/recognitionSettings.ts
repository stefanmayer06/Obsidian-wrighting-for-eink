import type InkNotebookPlugin from "../main";
import { normalizeEndpoint } from "../core/azureParse";
import { testImagePng } from "./azureClient";
import { positiveInt, renderSettingItems, settingStore, trimmed, type InkSetting } from "./settingItems";

export const AZURE_PORTAL_URL = "https://portal.azure.com/#create/Microsoft.CognitiveServicesComputerVision";
export const README_URL = "https://github.com/stefanmayer06/Obsidian-writing-for-eink#readme";

/**
 * Handwriting recognition settings (Azure AI Vision with the user's own key),
 * shared by the settings tab and the setup assistant.
 */
export function recognitionItems(plugin: InkNotebookPlugin, opts: { advanced?: boolean } = {}): InkSetting[] {
  const s = plugin.settings;
  const items: InkSetting[] = [
    {
      name: "Azure AI Vision",
      desc: "Handwriting recognition with your own key. The free tier (F0) covers 5,000 images per month.",
      aliases: ["OCR", "handwriting", "Azure"],
      render: (setting) => {
        setting.descEl.appendText(" ");
        setting.descEl.createEl("a", { text: "Create a resource", href: AZURE_PORTAL_URL });
        setting.descEl.appendText(" · ");
        setting.descEl.createEl("a", { text: "Step-by-step guide", href: README_URL });
      },
    },
    {
      name: "Azure endpoint",
      desc: "From your Azure AI Vision (Computer Vision) resource → Keys and Endpoint. Example: https://my-notes.cognitiveservices.azure.com",
      render: (setting) => {
        setting.addText((t) => {
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
      },
    },
    {
      name: "Azure key",
      desc: `KEY 1 or KEY 2 of the same resource. It is stored in this vault's plugin settings (${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/data.json).`,
      render: (setting) => {
        setting.addText((t) => {
          t.setPlaceholder("Paste your key")
            .setValue(s.azureKey)
            .onChange(async (v) => {
              s.azureKey = v.trim();
              await plugin.saveSettings();
            });
          t.inputEl.type = "password";
          t.inputEl.addClass("ink-wide-input");
        });
      },
    },
    {
      name: "Test connection",
      desc: "Sends a tiny test image to Azure.",
      render: (setting) => {
        const status = setting.descEl.createDiv({ cls: "ink-test-status" });
        setting.addButton((b) =>
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
      },
    },
  ];
  if (!opts.advanced) return items;
  items.push(
    {
      name: "API version",
      desc: "Automatic tries Image Analysis 4.0 first and falls back to Read 3.2 (available in more regions).",
      control: {
        type: "dropdown",
        key: "azureApi",
        options: { auto: "Automatic", v4: "Image Analysis 4.0", "v3.2": "Read 3.2" },
        after: async () => {
          s.azureDetectedApi = "";
          await plugin.saveSettings();
        },
      },
    },
    {
      name: "Language hint",
      desc: 'Optional two-letter code such as "de" or "en" (Read 3.2 only). Leave empty for automatic detection.',
      control: { type: "text", key: "azureLanguage", placeholder: "auto", parse: trimmed },
    },
    {
      name: "Requests per minute",
      desc: "The free tier allows 20 per minute.",
      control: { type: "number", key: "requestsPerMinute", min: 1, parse: positiveInt },
    },
  );
  return items;
}

/** The recognition settings for the setup assistant. */
export function renderRecognitionSettings(container: HTMLElement, plugin: InkNotebookPlugin): void {
  renderSettingItems(container, recognitionItems(plugin), settingStore(plugin));
}
