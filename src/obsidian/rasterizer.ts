import type { SceneElement } from "../core/scene";
import { renderStrokeWidth, strokeImagePoints, type RenderPlan } from "../core/rasterPlan";

/**
 * Renders handwriting strokes to a black-on-white PNG for OCR.
 * We draw the strokes ourselves so that the mapping between image pixels and
 * scene coordinates is exact and so it also works for ink pages that are not
 * open in a view.
 */
export async function renderStrokesPng(plan: RenderPlan, strokes: ReadonlyArray<SceneElement>): Promise<ArrayBuffer> {
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
    // exact polyline: the image must cover every recorded point, because the
    // OCR word boxes are later compared against these points
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("Could not render handwriting image");
  return blob.arrayBuffer();
}
