/**
 * Detection of e-ink devices (Onyx Boox and similar) from the user agent.
 * Obsidian on Android runs in the system WebView whose user agent contains
 * the device model, e.g. "Linux; Android 12; NoteAir3C Build/…; wv".
 */

export interface DeviceInfo {
  isEink: boolean;
  vendor?: string;
  model?: string;
}

const BOOX_MODEL_RE =
  /\b(BOOX[\w -]*|Onyx[\w -]*|Note\s?Air\s?\d?\s?C?|NoteAir\d?C?|Note\s?Max|NoteMax|Note\s?\d+\s?C?|Note\d+C?|Tab\s?(?:Ultra|Mini|X)\s?C?(?:\s?Pro)?|TabUltra\w*|TabMini\w*|TabX\w*|Palma\d?|Go\s?(?:Color\s?)?\d+(?:\.\d)?|GoColor\d+|Nova\s?\d*\s?\w*|Nova\w*|Leaf\s?\d*|Leaf\w*|Poke\s?\d*\w*|Poke\w*|Page|Max\s?Lumi\d?|MaxLumi\d?)\b/i;

const OTHER_EINK_RE = /\b(reMarkable|Kindle|Kobo|PocketBook|Bigme|Meebook|Hisense\s?A\d|Supernote|Remarkable|InkPad|Likebook)\b/i;

export function detectDevice(userAgent: string): DeviceInfo {
  const ua = userAgent ?? "";
  const androidModel = /Android [\d.]+;\s*([^;)]+?)(?:\s+Build\/|;|\))/i.exec(ua);
  const model = androidModel ? androidModel[1].trim() : undefined;
  if (/onyx|boox/i.test(ua) || (model && BOOX_MODEL_RE.test(model) && /Android/i.test(ua) && !/^(SM-|Pixel|Redmi|M2\d|HUAWEI|HONOR|moto|Nokia|OnePlus|Xiaomi|Galaxy|LM-|CPH|RMX|vivo|OPPO)/i.test(model))) {
    return { isEink: true, vendor: "Onyx Boox", model };
  }
  const other = OTHER_EINK_RE.exec(ua);
  if (other) return { isEink: true, vendor: other[1], model };
  return { isEink: false, model };
}
