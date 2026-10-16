import { Setting } from "obsidian";
import type InkNotebookPlugin from "../main";
import { normalizeEndpoint } from "../core/azureParse";
import { formatCloudStatus } from "../core/cloud";
import { cloudEndpointFor } from "../settings";
import { testImagePng } from "./azureClient";
import { getCloudInfo } from "./cloudClient";

export const AZURE_PORTAL_URL = "https://portal.azure.com/#create/Microsoft.CognitiveServicesComputerVision";
export const README_URL = "https://github.com/stefanmayer06/Obsidian-wrighting-for-eink#readme";

/**
 * Handwriting recognition settings, shared by the settings tab and the setup
 * assistant: the choice between Ink Notebook Cloud (offered once the service
 * is open) and the user's own Azure resource, and the fields for each.
 */
export function renderRecognitionSettings(container: HTMLElement, plugin: InkNotebookPlugin, opts: { advanced?: boolean } = {}): void {
  const s = plugin.settings;
  const choiceEl = container.createDiv();
  const bodyEl = container.createDiv();
  const renderBody = () => {
    bodyEl.empty();
    if (s.ocrProvider === "cloud") renderCloudSettings(bodyEl, plugin);
    else renderAzureSection(bodyEl, plugin, !!opts.advanced);
  };
  const renderChoice = (offerCloud: boolean) => {
    choiceEl.empty();
    if (!offerCloud && s.ocrProvider !== "cloud") return;
    new Setting(choiceEl)
      .setName("Service")
      .setDesc("Ink Notebook Cloud works right away with a subscription. Your own Azure resource is free for up to 5,000 images a month, but you set it up yourself.")
      .addDropdown((d) =>
        d
          .addOptions({ cloud: "Ink Notebook Cloud (subscription)", azure: "My own Azure key" })
          .setValue(s.ocrProvider)
          .onChange(async (v) => {
            s.ocrProvider = v === "cloud" ? "cloud" : "azure";
            await plugin.saveSettings();
            renderBody();
          }),
      );
  };
  renderChoice(false);
  renderBody();
  void getCloudInfo(cloudEndpointFor(s)).then((info) => {
    if (choiceEl.isConnected) renderChoice(!!info?.available);
  });
}

function renderCloudSettings(container: HTMLElement, plugin: InkNotebookPlugin): void {
  const s = plugin.settings;
  const intro = container.createDiv({ cls: "setting-item-description ink-block-desc", text: "Checking Ink Notebook Cloud…" });
  const links = container.createDiv({ cls: "ink-links" });
  void getCloudInfo(cloudEndpointFor(s)).then((info) => {
    links.empty();
    if (!info) {
      intro.setText("Ink Notebook Cloud can't be reached right now. Check your internet connection.");
      return;
    }
    intro.setText(
      info.available
        ? `No Azure account needed: subscribe, paste the license key from your email, done. Includes ${info.monthlyLimit.toLocaleString()} recognitions a month (each changed writing area of a page counts as one). Your handwriting strokes are sent as an image to the Ink Notebook server and Azure AI Vision for recognition; the server does not keep them and Azure deletes them within 24 hours.`
        : "Ink Notebook Cloud is not open for subscriptions at the moment.",
    );
    const link = (text: string, href: string) => {
      if (!href) return;
      if (links.childElementCount) links.createSpan({ text: " · " });
      links.createEl("a", { text, href });
    };
    if (info.available) link("Subscribe", info.checkoutUrl);
    link("Manage subscription", info.portalUrl);
    link("Privacy policy", info.privacyUrl);
  });
  new Setting(container)
    .setName("License key")
    .setDesc("From your purchase email. It is stored in this vault's plugin settings (.obsidian/plugins/ink-notebook/data.json).")
    .addText((t) => {
      t.setPlaceholder("Paste your license key")
        .setValue(s.cloudLicenseKey)
        .onChange(async (v) => {
          s.cloudLicenseKey = v.trim();
          await plugin.saveSettings();
        });
      t.inputEl.type = "password";
      t.inputEl.addClass("ink-wide-input");
    });
  const status = container.createDiv({ cls: "ink-test-status" });
  new Setting(container)
    .setName("Check subscription")
    .setDesc("Shows whether the key works and how much of this month's allowance is used.")
    .addButton((b) =>
      b.setButtonText("Check").onClick(async () => {
        status.setText("Checking…");
        status.className = "ink-test-status";
        b.setDisabled(true);
        try {
          const st = await plugin.ocr.cloudStatus();
          status.setText(`✓ Active – ${formatCloudStatus(st)}`);
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

function renderAzureSection(container: HTMLElement, plugin: InkNotebookPlugin, advanced: boolean): void {
  const s = plugin.settings;
  const intro = container.createDiv({ cls: "setting-item-description ink-block-desc" });
  intro.appendText("Azure AI Vision with your own key. The free tier (F0) covers 5,000 images per month. ");
  intro.createEl("a", { text: "Create a resource", href: AZURE_PORTAL_URL });
  intro.appendText(" · ");
  intro.createEl("a", { text: "Step-by-step guide", href: README_URL });
  renderAzureSettings(container, plugin);
  if (!advanced) return;
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
