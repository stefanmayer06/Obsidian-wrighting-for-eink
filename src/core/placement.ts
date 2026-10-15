import { getInkData, type ExElement } from "../types/excalidraw";
import { bottom, elementRect, right, type Rect } from "./geometry";

/** Default position for typed notes when the ink page has no paper page. */
const DEFAULT_CARD_X = 40;

/** Where to put a new typed-notes card: below the content, inside the last used page. */
export function cardPosition(elements: ReadonlyArray<ExElement>, preferredWidth: number): { x: number; y: number; width: number } {
  const content = elements.filter((e) => {
    const role = getInkData(e)?.role;
    return !e.isDeleted && role !== "region" && role !== "paper" && role !== "pdf-page" && role !== "image-page" && role !== "typed";
  });
  const pages: Rect[] = elements
    .filter((e) => {
      const role = getInkData(e)?.role;
      return role === "paper" || role === "pdf-page" || role === "image-page";
    })
    .map((e) => elementRect(e))
    .sort((a, b) => a.y - b.y);
  const contentRects = content.map((e) => elementRect(e));
  const contentBottom = contentRects.reduce((acc, r) => Math.max(acc, bottom(r)), -Infinity);

  if (pages.length > 0) {
    // the page holding the lowest content, or the first page
    let page: Rect = pages[0];
    if (contentRects.length > 0) {
      const lowest = contentRects.reduce((a, b) => (bottom(b) > bottom(a) ? b : a));
      page = pages.find((p) => lowest.y + lowest.h / 2 >= p.y && lowest.y + lowest.h / 2 <= bottom(p)) ?? pages[pages.length - 1];
    }
    const inPage = contentRects.filter((r) => r.y >= page.y && r.y <= bottom(page));
    const yBelow = inPage.length > 0 ? Math.max(...inPage.map((r) => bottom(r))) + 40 : page.y + 110;
    const x = page.x + Math.min(100, page.w * 0.1);
    return { x, y: Math.max(page.y + 110, yBelow), width: Math.min(preferredWidth, Math.max(200, right(page) - x - 40)) };
  }
  if (contentRects.length === 0) return { x: DEFAULT_CARD_X, y: DEFAULT_CARD_X, width: preferredWidth };
  const minX = Math.min(...contentRects.map((r) => r.x));
  return { x: minX, y: contentBottom + 60, width: preferredWidth };
}
