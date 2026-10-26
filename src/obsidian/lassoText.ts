import { Notice } from "obsidian";
import type InkNotebookPlugin from "../main";
import { median } from "../core/geometry";
import { addItems, newId, removeItems, type Page } from "../core/ink/model";
import { isMarker } from "../core/ink/pens";
import { inkScene } from "../core/ink/scene";
import { itemsBounds } from "../core/ink/transform";
import { isInkStroke, planOcrUnits } from "../core/rasterPlan";
import { measureTextHeight } from "../ink/render";
import type { InkView } from "./inkView";

/**
 * "To text" in the lasso menu (Boox Notes' lasso recognition): the selected
 * handwriting is recognised and replaced by a typed text box (undo brings the
 * handwriting back).
 */
export async function selectionToText(plugin: InkNotebookPlugin, view: InkView): Promise<void> {
  const s = view.surface;
  const items = s.selectedItems();
  const strokes = items.strokes.filter((st) => !isMarker(st));
  if (strokes.length === 0) {
    new Notice("Select some handwriting first.");
    return;
  }
  const notice = new Notice("Recognising handwriting…", 0);
  try {
    const page = s.page;
    const only: Page = { ...page, strokes, texts: [], images: [], links: [], figures: [] };
    const { elements } = inkScene({ pages: [only] }, { regions: [], handLinks: {} });
    const inkEls = elements.filter((e) => isInkStroke(e));
    const units = planOcrUnits(inkEls, 150);
    const outcome = await plugin.ocr.recognizeUnits(units, new Map(elements.map((e) => [e.id, e] as const)), { network: true, deadline: Date.now() + 60000 });
    notice.hide();
    if (outcome.lines.length === 0) {
      new Notice(outcome.error ? `Could not recognise the handwriting: ${outcome.error}` : "No handwriting was recognised.", 6000);
      return;
    }
    const lines = [...outcome.lines].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
    const text = lines.map((l) => l.text).join("\n");
    const box = itemsBounds({ ...items, strokes }) ?? { x: 40, y: 40, w: 400, h: 40 };
    const size = Math.max(14, Math.min(64, Math.round(median(lines.map((l) => l.box.h)) * 0.75)));
    const w = Math.max(160, Math.min(page.w - box.x - 10, box.w + size * 2));
    const t = { id: newId(), x: box.x, y: box.y, w, h: measureTextHeight(text, w, size), text, size, color: strokes[0].color };
    const sel = { ...s.selection, strokes: new Set(strokes.map((st) => st.id)), texts: new Set<string>(), images: new Set<string>(), links: new Set<string>(), figures: new Set<string>() };
    const next = addItems(removeItems(page, sel), { texts: [t] });
    s.commitPage(next, { x: Math.min(box.x, t.x) - 4, y: Math.min(box.y, t.y) - 4, w: Math.max(box.w, t.w) + 8, h: Math.max(box.h, t.h) + 8 });
  } catch (e) {
    notice.hide();
    plugin.switcher.reportError("Recognition failed", e);
  }
}
