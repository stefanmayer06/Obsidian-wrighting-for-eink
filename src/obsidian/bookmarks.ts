import { Menu, setIcon, type WorkspaceLeaf } from "obsidian";
import type InkNotebookPlugin from "../main";
import { EXCALIDRAW_VIEW_TYPE } from "./excalidrawBridge";

/**
 * The bookmark switcher: two ribbon bookmarks on the right edge of every ink
 * page – "Ink" (drawing) and "Text" (transcript). Tapping the other ribbon
 * flips the page in the same tab.
 */

interface BookmarkEls {
  root: HTMLElement;
  ink: HTMLButtonElement;
  text: HTMLButtonElement;
  badge: HTMLElement;
  textLabel: HTMLElement;
}

const STATE_LABEL: Record<string, string> = {
  working: "Transcribing…",
  pending: "Handwriting waiting to be transcribed",
  offline: "Offline – will transcribe when online",
  error: "Handwriting recognition failed",
  "not-configured": "Handwriting recognition is not set up",
};

export class BookmarkManager {
  private els = new Map<WorkspaceLeaf, BookmarkEls>();
  private busy = new Set<WorkspaceLeaf>();

  constructor(private plugin: InkNotebookPlugin) {}

  setBusy(leaf: WorkspaceLeaf, busy: boolean): void {
    if (busy) this.busy.add(leaf);
    else this.busy.delete(leaf);
    this.refresh(leaf);
  }

  refreshAll(): void {
    const leaves = new Set<WorkspaceLeaf>();
    for (const type of ["markdown", EXCALIDRAW_VIEW_TYPE]) {
      for (const leaf of this.plugin.app.workspace.getLeavesOfType(type)) leaves.add(leaf);
    }
    for (const leaf of leaves) this.refresh(leaf);
    for (const leaf of [...this.els.keys()]) {
      if (!leaves.has(leaf)) this.remove(leaf);
    }
  }

  remove(leaf: WorkspaceLeaf): void {
    const el = this.els.get(leaf);
    if (el) {
      el.root.remove();
      this.els.delete(leaf);
    }
    leaf.view?.containerEl?.removeClass("ink-has-bookmarks", "ink-text-page", "ink-ink-page");
  }

  removeAll(): void {
    for (const leaf of [...this.els.keys()]) this.remove(leaf);
  }

  refresh(leaf: WorkspaceLeaf): void {
    try {
      this.refreshUnsafe(leaf);
    } catch (e) {
      console.error("Ink Notebook: bookmark refresh failed", e);
    }
  }

  private refreshUnsafe(leaf: WorkspaceLeaf): void {
    const view = leaf.view as { file?: { path: string } | null; containerEl?: HTMLElement; getViewType(): string };
    const file = view && "file" in view ? (view.file as never) : null;
    const container = view?.containerEl;
    if (!file || !container) return this.remove(leaf);
    const info = this.plugin.pairs.pairOf(file);
    const settings = this.plugin.settings;
    if (!info) return this.remove(leaf);
    const isInkView = view.getViewType() === EXCALIDRAW_VIEW_TYPE;
    if (info.role === "ink" && !isInkView) return this.remove(leaf); // drawing opened as markdown
    if (info.role === "ink" && !info.pair.text && !this.plugin.pairs.isInkDrawing(info.pair.drawing) && !settings.showBookmarkOnAllDrawings) {
      return this.remove(leaf);
    }

    let els = this.els.get(leaf);
    if (!els || !container.contains(els.root)) {
      els?.root.remove();
      els = this.build(leaf, container);
      this.els.set(leaf, els);
    }
    container.addClass("ink-has-bookmarks");
    container.toggleClass("ink-text-page", info.role === "text");
    container.toggleClass("ink-ink-page", info.role === "ink");

    const { root, ink, text, badge, textLabel } = els;
    root.className = `ink-bookmarks ink-pos-${settings.bookmarkPosition}`;
    const onInk = info.role === "ink";
    ink.toggleClass("is-active", onInk);
    text.toggleClass("is-active", !onInk);
    ink.setAttr("aria-selected", String(onInk));
    text.setAttr("aria-selected", String(!onInk));
    const missingText = onInk && !info.pair.text;
    text.toggleClass("is-missing", missingText);
    textLabel.setText(missingText ? "+ Text" : "Text");
    text.setAttr("aria-label", missingText ? "Create a text page for this drawing" : onInk ? "Flip to the text page" : "Text page");
    ink.setAttr("aria-label", onInk ? "Ink page" : "Flip to the ink page");

    const busy = this.busy.has(leaf);
    const st = busy ? { state: "working" } : this.plugin.sync.statusOf(info.pair.drawing.path);
    const state = st?.state && st.state !== "idle" ? st.state : "";
    badge.className = `ink-bookmark-badge${state ? ` is-${state}` : ""}`;
    badge.setText(state === "working" ? "…" : state === "error" ? "!" : state ? "◦" : "");
    const tip = state ? STATE_LABEL[state] ?? "" : "";
    text.setAttr("title", tip || text.getAttr("aria-label") || "");
    root.toggleClass("is-busy", busy);
  }

  private build(leaf: WorkspaceLeaf, container: HTMLElement): BookmarkEls {
    const root = container.createDiv({ cls: "ink-bookmarks" });
    root.setAttr("role", "tablist");
    root.setAttr("aria-label", "Ink page / text page");
    const make = (cls: string, icon: string, label: string) => {
      const b = root.createEl("button", { cls: `ink-bookmark ${cls}` });
      b.setAttr("role", "tab");
      b.setAttr("type", "button");
      const iconEl = b.createSpan({ cls: "ink-bookmark-icon" });
      setIcon(iconEl, icon);
      const labelEl = b.createSpan({ cls: "ink-bookmark-label", text: label });
      return { b, labelEl };
    };
    const ink = make("ink-bookmark-ink", "pencil", "Ink");
    const text = make("ink-bookmark-text", "file-text", "Text");
    const badge = text.b.createSpan({ cls: "ink-bookmark-badge" });

    const onClick = (target: "ink" | "text") => (evt: MouseEvent) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (this.busy.has(leaf)) return;
      const file = (leaf.view as { file?: never }).file;
      if (!file) return;
      const info = this.plugin.pairs.pairOf(file);
      if (!info) return;
      if ((target === "ink" && info.role === "ink") || (target === "text" && info.role === "text")) return;
      void this.plugin.switcher.flip(leaf);
    };
    ink.b.addEventListener("click", onClick("ink"));
    text.b.addEventListener("click", onClick("text"));
    // keep pen/touch input on the bookmarks from reaching the canvas below
    for (const evName of ["pointerdown", "touchstart", "mousedown"] as const) {
      root.addEventListener(evName, (e) => e.stopPropagation(), { passive: true });
    }
    root.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      this.showMenu(leaf, evt);
    });
    let pressTimer: number | null = null;
    root.addEventListener(
      "touchstart",
      (evt) => {
        pressTimer = window.setTimeout(() => {
          pressTimer = null;
          const t = evt.touches[0];
          this.showMenu(leaf, new MouseEvent("contextmenu", { clientX: t?.clientX ?? 0, clientY: t?.clientY ?? 0 }));
        }, 600);
      },
      { passive: true },
    );
    const cancel = () => {
      if (pressTimer !== null) window.clearTimeout(pressTimer);
      pressTimer = null;
    };
    root.addEventListener("touchend", cancel, { passive: true });
    root.addEventListener("touchmove", cancel, { passive: true });
    return { root, ink: ink.b, text: text.b, badge, textLabel: text.labelEl };
  }

  private showMenu(leaf: WorkspaceLeaf, evt: MouseEvent): void {
    const file = (leaf.view as { file?: never }).file;
    if (!file) return;
    const info = this.plugin.pairs.pairOf(file);
    if (!info) return;
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Transcribe handwriting now")
        .setIcon("refresh-cw")
        .onClick(() => void this.plugin.switcher.transcribeNow(info.pair.drawing, false)),
    );
    menu.addItem((i) =>
      i
        .setTitle("Re-transcribe from scratch (discard edits in the transcript)")
        .setIcon("rotate-ccw")
        .onClick(() => void this.plugin.switcher.transcribeNow(info.pair.drawing, true)),
    );
    menu.addItem((i) =>
      i
        .setTitle("Open ink and text side by side")
        .setIcon("columns")
        .onClick(() => void this.plugin.switcher.openSideBySide(leaf)),
    );
    menu.addSeparator();
    const st = this.plugin.sync.statusOf(info.pair.drawing.path);
    if (st?.message) menu.addItem((i) => i.setTitle(`Last error: ${st.message}`).setIcon("alert-triangle").setDisabled(true));
    menu.addItem((i) =>
      i
        .setTitle("Ink Notebook settings")
        .setIcon("settings")
        .onClick(() => this.plugin.openSettings()),
    );
    menu.showAtMouseEvent(evt);
  }
}
