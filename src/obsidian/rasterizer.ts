import type { ExElement } from "../types/excalidraw";
import { renderStrokeWidth, strokeImagePoints, type RenderPlan } from "../core/rasterPlan";

/**
 * Renders handwriting strokes to a black-on-white PNG for OCR.
 * We draw the strokes ourselves (instead of using Excalidraw's exporter) so
 * that the mapping between image pixels and scene coordinates is exact and so
 * it also works for drawings that are not open in a view.
 */
export async function renderStrokesPng(plan: RenderPlan, strokes: ReadonlyArray<ExElement>): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = plan.width;
  canvas.height = plan.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not available");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, plan.width, plan.height);
  ctx.strokeStyle = "#000000";
  ctx.fillStyle = "#000000";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of strokes) {
    const pts = strokeImagePoints(plan, s);
    if (pts.length === 0) continue;
    const width = Math.max(1.2, renderStrokeWidth(s) * plan.scale);
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    // smooth with quadratic curves through midpoints
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
    ctx.stroke();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not render handwriting image");
  return blob.arrayBuffer();
}
