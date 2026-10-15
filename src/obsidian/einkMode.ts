import { Platform } from "obsidian";
import { detectDevice, type DeviceInfo } from "../core/device";
import type { InkSettings } from "../settings";

/** Detect the current device once. */
export function currentDevice(): DeviceInfo {
  try {
    return detectDevice(typeof navigator !== "undefined" ? navigator.userAgent : "");
  } catch {
    return { isEink: false };
  }
}

export function einkActive(settings: InkSettings): boolean {
  if (settings.einkMode === "on") return true;
  if (settings.einkMode === "off") return false;
  return currentDevice().isEink;
}

/** Apply (or remove) the e-ink body classes. */
export function applyEinkClasses(settings: InkSettings): void {
  const body = document.body;
  const on = einkActive(settings);
  body.toggleClass("ink-eink", on);
  body.toggleClass("ink-large-targets", settings.largeTouchTargets && (on || Platform.isMobile));
}

export function removeEinkClasses(): void {
  document.body.removeClass("ink-eink", "ink-large-targets");
}
