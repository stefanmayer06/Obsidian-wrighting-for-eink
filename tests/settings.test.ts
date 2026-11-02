import { describe, expect, it } from "vitest";
import { isOcrConfigured, loadSettings } from "../src/settings";

describe("recognition settings", () => {
  it("is configured with an Azure endpoint and key", () => {
    expect(isOcrConfigured(loadSettings({ azureEndpoint: "https://x.cognitiveservices.azure.com", azureKey: "k" }))).toBe(true);
    expect(isOcrConfigured(loadSettings({ azureEndpoint: "https://x.cognitiveservices.azure.com" }))).toBe(false);
    expect(isOcrConfigured(loadSettings({}))).toBe(false);
  });

  it("drops the settings of the removed Ink Notebook Cloud", () => {
    const s = loadSettings({ ocrProvider: "cloud", cloudLicenseKey: "INK_abc", cloudEndpoint: "https://x", azureEndpoint: "https://x.cognitiveservices.azure.com", azureKey: "k" });
    expect(s).not.toHaveProperty("ocrProvider");
    expect(s).not.toHaveProperty("cloudLicenseKey");
    expect(s).not.toHaveProperty("cloudEndpoint");
    expect(isOcrConfigured(s)).toBe(true);
  });

  it("marks uncertain words only when the user turned it on", () => {
    expect(loadSettings({}).highlightUncertain).toBe(false);
    // stored before version 2, when it was on by default
    expect(loadSettings({ highlightUncertain: true }).highlightUncertain).toBe(false);
    const turnedOn = loadSettings({ ...loadSettings({}), highlightUncertain: true });
    expect(turnedOn.highlightUncertain).toBe(true);
    expect(loadSettings(JSON.parse(JSON.stringify(turnedOn))).highlightUncertain).toBe(true);
  });

  it("asks for the name of a new page unless the user turned it off", () => {
    expect(loadSettings({}).askForPageName).toBe(true);
    // stored before version 4, when pages were named with the date and time by default
    expect(loadSettings({ askForPageName: false, settingsVersion: 3 }).askForPageName).toBe(true);
    const turnedOff = loadSettings({ ...loadSettings({}), askForPageName: false });
    expect(turnedOff.askForPageName).toBe(false);
    expect(loadSettings(JSON.parse(JSON.stringify(turnedOff))).askForPageName).toBe(false);
  });
});
