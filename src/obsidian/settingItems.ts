import { Setting } from "obsidian";
import type InkNotebookPlugin from "../main";
import type { InkSettings } from "../settings";

/**
 * Ink Notebook's settings, described once. The description is a subset of
 * Obsidian's declarative settings (getSettingDefinitions, Obsidian 1.13+):
 * newer versions render it themselves – and find the settings in the settings
 * search – while `renderSettingItems` draws the same items with `Setting` for
 * older versions and in the setup assistant.
 */

type Key = keyof InkSettings;
type BoolKey = { [K in Key]: InkSettings[K] extends boolean ? K : never }[Key];

interface ControlEffects {
  /** Turns what the control holds into the value to store; undefined leaves the stored value as it is. */
  parse?: (value: unknown) => unknown;
  /** Runs after the value is saved. */
  after?: () => void | Promise<void>;
}

export type InkControl = ControlEffects &
  (
    | { type: "toggle"; key: BoolKey }
    | { type: "dropdown"; key: Key; options: Record<string, string> }
    | { type: "text"; key: Key; placeholder?: string }
    | { type: "number"; key: Key; min?: number; placeholder?: string }
    | { type: "slider"; key: Key; min: number; max: number; step: number }
  );

interface ItemBase {
  name: string;
  desc?: string;
  /** More words the settings search finds the setting by. */
  aliases?: string[];
}

/** A setting with one control that reads and writes a value of the settings. */
export interface ControlItem extends ItemBase {
  control: InkControl;
}

/** A setting whose controls (buttons, special inputs) are added by hand. */
export interface RenderItem extends ItemBase {
  render: (setting: Setting) => void;
}

export type InkSetting = ControlItem | RenderItem;

export interface InkGroup {
  type: "group";
  heading?: string;
  items: InkSetting[];
}

export type InkSettingItem = InkSetting | InkGroup;

/** Reads and saves the values of the settings for the controls. */
export interface SettingStore {
  get(key: Key): unknown;
  set(control: InkControl, value: unknown): Promise<void>;
}

/** The store for the plugin's settings: checks a value, saves it, then runs the control's `after`. */
export function settingStore(plugin: InkNotebookPlugin): SettingStore {
  return {
    get: (key) => plugin.settings[key],
    set: async (control, value) => {
      const v = control.parse ? control.parse(value) : value;
      if (v === undefined || !fitsControl(control, v)) return;
      Reflect.set(plugin.settings, control.key, v);
      await plugin.saveSettings();
      await control.after?.();
    },
  };
}

function fitsControl(control: InkControl, value: unknown): boolean {
  switch (control.type) {
    case "toggle":
      return typeof value === "boolean";
    case "dropdown":
      return typeof value === "string" && Object.prototype.hasOwnProperty.call(control.options, value);
    case "text":
      return typeof value === "string";
    case "number":
    case "slider":
      return typeof value === "number" && Number.isFinite(value);
  }
}

/** The controls of the items by the key they store. */
export function controlsByKey(items: ReadonlyArray<InkSettingItem>): Map<string, InkControl> {
  const out = new Map<string, InkControl>();
  for (const item of items) {
    for (const s of "type" in item ? item.items : [item]) {
      if ("control" in s) out.set(s.control.key, s.control);
    }
  }
  return out;
}

/** Draw the items with `Setting` (Obsidian before 1.13, and the setup assistant). */
export function renderSettingItems(container: HTMLElement, items: ReadonlyArray<InkSettingItem>, store: SettingStore): void {
  for (const item of items) {
    if ("type" in item) {
      if (item.heading) new Setting(container).setName(item.heading).setHeading();
      renderSettingItems(container, item.items, store);
      continue;
    }
    const setting = new Setting(container).setName(item.name);
    if (item.desc) setting.setDesc(item.desc);
    if ("render" in item) item.render(setting);
    else addControl(setting, item.control, store);
  }
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function addControl(setting: Setting, control: InkControl, store: SettingStore): void {
  const value = store.get(control.key);
  const save = (v: unknown) => void store.set(control, v);
  switch (control.type) {
    case "toggle":
      setting.addToggle((t) => t.setValue(value === true).onChange(save));
      break;
    case "dropdown":
      setting.addDropdown((d) => d.addOptions(control.options).setValue(asText(value)).onChange(save));
      break;
    case "text":
      setting.addText((t) => t.setPlaceholder(control.placeholder ?? "").setValue(asText(value)).onChange(save));
      break;
    case "number":
      setting.addText((t) => {
        t.inputEl.type = "number";
        if (control.min !== undefined) t.inputEl.min = String(control.min);
        t.setPlaceholder(control.placeholder ?? "")
          .setValue(asText(value))
          .onChange((v) => save(v.trim() === "" ? NaN : Number(v)));
      });
      break;
    case "slider": {
      // the value next to the slider (as Obsidian 1.13+ shows it)
      const shown = setting.controlEl.createSpan({ cls: "ink-slider-value", text: asText(value) });
      setting.addSlider((sl) =>
        sl
          .setLimits(control.min, control.max, control.step)
          .setValue(typeof value === "number" ? value : control.min)
          .onChange((v) => {
            shown.setText(String(v));
            save(v);
          }),
      );
      break;
    }
  }
}

// ---------------------------------------------------------------- values

/** A folder path from a text field (no slashes around it); empty gives `fallback`. */
export function folderValue(fallback: string): (value: unknown) => string | undefined {
  return (value) => (typeof value === "string" ? value.trim().replace(/^\/+|\/+$/g, "") || fallback : undefined);
}

/** A whole number above 0 (from a number or a text field); anything else is ignored. */
export function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? Math.round(value) : typeof value === "string" ? parseInt(value, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Text without spaces around it. */
export function trimmed(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}
