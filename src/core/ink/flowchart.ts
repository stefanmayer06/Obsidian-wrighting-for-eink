import type { Pt } from "../geometry";
import type { LibraryItem } from "./excalidrawLib";
import { makeStroke, q, type Items, type Stroke } from "./model";
import { ellipsePoints } from "./shapes";

/**
 * The built-in object library: the shapes of a flowchart (ISO 5807 / the
 * usual flowchart symbols). They are drawn in the pen colour and thickness
 * (and the shape fill) chosen when they are placed; connect them with the
 * arrow or elbow arrow of the shape tool.
 */

export const FLOWCHART_LIBRARY_ID = "builtin-flowchart";

const W = 2;

function poly(points: ReadonlyArray<Pt>, closed = true): Stroke {
  const pts = new Float32Array(points.length * 3);
  points.forEach((p, i) => {
    pts[i * 3] = q(p.x);
    pts[i * 3 + 1] = q(p.y);
    pts[i * 3 + 2] = 0.5;
  });
  return makeStroke({ pen: "ballpoint", color: "#000000", width: W, pts, poly: true, closed });
}

function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number, steps = 16): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    out.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return out;
}

function item(id: string, name: string, strokes: Stroke[]): LibraryItem {
  const items: Items = { strokes, texts: [], images: [], links: [], figures: [] };
  return { id: `flow-${id}`, name, items, restyle: true };
}

const P = (x: number, y: number): Pt => ({ x, y });

/** The flowchart shapes (new copies every time: they get new ids when placed anyway). */
export function flowchartLibrary(): LibraryItem[] {
  const wave: Pt[] = [];
  for (let i = 0; i <= 24; i++) wave.push(P(180 - (180 * i) / 24, 84 + 9 * Math.sin((Math.PI * 2 * i) / 24)));
  return [
    item("process", "Process", [poly([P(0, 0), P(180, 0), P(180, 90), P(0, 90)])]),
    item("decision", "Decision", [poly([P(90, 0), P(180, 60), P(90, 120), P(0, 60)])]),
    item("terminator", "Start / end", [poly([...arc(140, 40, 40, 40, -Math.PI / 2, Math.PI / 2), ...arc(40, 40, 40, 40, Math.PI / 2, (3 * Math.PI) / 2)])]),
    item("data", "Input / output", [poly([P(36, 0), P(190, 0), P(154, 90), P(0, 90)])]),
    item("document", "Document", [poly([P(0, 0), P(180, 0), ...wave])]),
    item("predefined", "Predefined process", [poly([P(0, 0), P(180, 0), P(180, 90), P(0, 90)]), poly([P(16, 0), P(16, 90)], false), poly([P(164, 0), P(164, 90)], false)]),
    item("database", "Database", [
      poly([...arc(60, 16, 60, 16, Math.PI, 2 * Math.PI), ...arc(60, 96, 60, 16, 0, Math.PI)]),
      poly(arc(60, 16, 60, 16, Math.PI, 0), false),
    ]),
    item("manual-input", "Manual input", [poly([P(0, 30), P(180, 0), P(180, 90), P(0, 90)])]),
    item("preparation", "Preparation", [poly([P(32, 0), P(148, 0), P(180, 40), P(148, 80), P(32, 80), P(0, 40)])]),
    item("manual-operation", "Manual operation", [poly([P(0, 0), P(180, 0), P(148, 80), P(32, 80)])]),
    item("delay", "Delay", [poly([P(0, 0), ...arc(125, 45, 45, 45, -Math.PI / 2, Math.PI / 2), P(0, 90)])]),
    item("display", "Display", [poly([P(40, 0), ...arc(140, 45, 40, 45, -Math.PI / 2, Math.PI / 2), P(40, 90), P(0, 45)])]),
    item("connector", "Connector", [poly(ellipsePoints(28, 28, 28, 28))]),
    item("off-page", "Off-page connector", [poly([P(0, 0), P(80, 0), P(80, 56), P(40, 84), P(0, 56)])]),
    item("merge", "Merge", [poly([P(0, 0), P(120, 0), P(60, 90)])]),
    item("extract", "Extract", [poly([P(60, 0), P(120, 90), P(0, 90)])]),
    item("comment", "Comment", [poly([P(36, 0), P(0, 0), P(0, 90), P(36, 90)], false)]),
  ];
}
