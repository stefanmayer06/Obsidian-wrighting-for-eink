import { Menu, setIcon, type WorkspaceLeaf } from "obsidian";
import type InkNotebookPlugin from "../main";
import { DockLayout } from "./dockLayout";

/**
 * The bookmark switcher on the text page: two ribbon bookmarks on the right
 * edge – "Ink" (the handwritten pages) and "Text" (this page). Tapping "Ink"
 * flips back to the ink page in the same tab. (On the ink page, the toolbar's
 * "Text" button does the same the other way.) The stack stays clear of the
 * view header and the status bar (see DockLayout).
 */

interface BookmarkEls {
  root: HTMLElement;
  ink: HTMLButtonElement;
  text: HTMLButtonElement;
  badge: HTMLElement;
  layout: DockLayout;
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

  constructor(private plugin: InkNotebookPlugin) {}

  refreshAll(): void {
    const leaves = new Set(this.plugin.app.workspace.getLeavesOfType("markdown"));
    for (const leaf of leaves) this.refresh(leaf);
    for (const leaf of [...this.els.keys()]) {
      if (!leaves.has(leaf)) this.remove(leaf);
    }
  }

  remove(leaf: WorkspaceLeaf): void {
    const el = this.els.get(leaf);
    if (el) {
      el.layout.destroy();
      el.root.remove();
      this.els.delete(leaf);
    }
    leaf.view?.containerEl?.removeClass("ink-has-bookmarks", "ink-text-page");
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
    const view = leaf.view as { file?: unknown; containerEl?: HTMLElement; getViewType(): string };
    const container = view?.containerEl;
    if (!view || view.getViewType() !== "markdown" || !container) return this.remove(leaf);
    const file = view.file as Parameters<InkNotebookPlugin["pairs"]["pairOf"]>[0] | null;
    const info = file ? this.plugin.pairs.pairOf(file) : null;
    if (!info || info.role !== "text") return this.remove(leaf);

    let els = this.els.get(leaf);
    if (!els || !container.contains(els.root)) {
      els?.layout.destroy();
      els?.root.remove();
      els = this.build(leaf, container);
      this.els.set(leaf, els);
    }
    container.addClass("ink-has-bookmarks", "ink-text-page");
    const { root, badge, text } = els;
    const keep = ["is-compact", "is-cramped"].filter((c) => root.hasClass(c));
    root.className = ["ink-bookmarks", `ink-pos-${this.plugin.settings.bookmarkPosition}`, ...keep].join(" ");

    const busy = this.plugin.isBusy(info.pair.drawing);
    const st = busy ? { state: "working" } : this.plugin.sync.statusOf(info.pair.drawing.path);
    const state = st?.state && st.state !== "idle" ? st.state : "";
    badge.className = `ink-bookmark-badge${state ? ` is-${state}` : ""}`;
    badge.setText(state === "working" ? "…" : state === "error" ? "!" : state ? "◦" : "");
    text.setAttr("title", (state ? STATE_LABEL[state] : "") || "Text page");
    root.toggleClass("is-busy", busy);
    els.layout.schedule(0);
  }

  private build(leaf: WorkspaceLeaf, container: HTMLElement): BookmarkEls {
    const root = container.createDiv({ cls: "ink-bookmarks" });
    const tabs = root.createDiv({ cls: "ink-bookmark-tabs" });
    tabs.setAttr("role", "tablist");
    tabs.setAttr("aria-label", "Ink page / text page");
    const make = (cls: string, icon: string, label: string) => {
      const b = tabs.createEl("button", { cls: `ink-bookmark ${cls}` });
      b.setAttr("role", "tab");
      b.setAttr("type", "button");
      setIcon(b.createSpan({ cls: "ink-bookmark-icon" }), icon);
      b.createSpan({ cls: "ink-bookmark-label", text: label });
      return b;
    };
    const ink = make("ink-bookmark-ink", "pencil", "Ink");
    const text = make("ink-bookmark-text is-active", "file-text", "Text");
    ink.setAttr("aria-label", "Flip to the ink page");
    ink.setAttr("aria-selected", "false");
    text.setAttr("aria-selected", "true");
    const badge = text.createSpan({ cls: "ink-bookmark-badge" });

    // a long press opens the menu; the click/contextmenu events that follow it are ignored
    let longPressAt = 0;
    const justLongPressed = () => Date.now() - longPressAt < 800;
    ink.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (justLongPressed()) return;
      void this.plugin.switcher.flip(leaf);
    });
    text.addEventListener("click", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
    });
    root.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      if (justLongPressed()) return;
      this.showMenu(leaf, evt);
    });
    let pressTimer: number | null = null;
    root.addEventListener(
      "touchstart",
      (evt) => {
        pressTimer = window.setTimeout(() => {
          pressTimer = null;
          longPressAt = Date.now();
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
    const layout = new DockLayout(container, root, () => this.plugin.settings.bookmarkPosition);
    return { root, ink, text, badge, layout };
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
        .setIcon("columns-2")
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
