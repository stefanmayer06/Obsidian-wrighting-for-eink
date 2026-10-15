import { RangeSetBuilder, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorLivePreviewField } from "obsidian";

/**
 * In Live Preview, show the transcript region markers as a quiet label
 * ("✍ From your handwriting") instead of raw `%% … %%` comments with state.
 * Source mode shows the raw text so nothing is hidden from power users.
 */

const START_RE = /^%%\s*ink-notebook:start\b.*%%\s*$/;
const END_RE = /^%%\s*ink-notebook:end\b.*%%\s*$/;

class MarkerWidget extends WidgetType {
  constructor(private kind: "start" | "end") {
    super();
  }

  eq(other: MarkerWidget): boolean {
    return other.kind === this.kind;
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = `ink-transcript-marker ink-transcript-${this.kind}`;
    el.textContent = this.kind === "start" ? "✍ From your handwriting – edits here are kept" : "";
    el.setAttribute("aria-hidden", "true");
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function build(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  let livePreview = false;
  try {
    livePreview = view.state.field(editorLivePreviewField, false) ?? false;
  } catch {
    livePreview = false;
  }
  if (!livePreview) return builder.finish();
  const doc = view.state.doc;
  // markers are near the top of the note; scanning visible ranges keeps this cheap
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      const text = line.text.trim();
      if (START_RE.test(text)) {
        builder.add(line.from, line.to, Decoration.replace({ widget: new MarkerWidget("start") }));
      } else if (END_RE.test(text)) {
        builder.add(line.from, line.to, Decoration.replace({ widget: new MarkerWidget("end") }));
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

export function transcriptEditorExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.startState.field(editorLivePreviewField, false) !== u.state.field(editorLivePreviewField, false)) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
