import { WorkspaceLeaf, type Plugin, type ViewState } from "obsidian";

/**
 * Ink pages are Markdown files (so they sync everywhere and have properties and
 * backlinks), but they must open in the ink view. Obsidian opens every ".md"
 * file in its Markdown view, so opening one is redirected here – the same way
 * the Kanban plugin opens its boards. "Open as Markdown" bypasses it.
 */

type SetViewState = (this: WorkspaceLeaf, state: ViewState, eState?: unknown) => Promise<void>;

export function redirectInkFiles(plugin: Plugin, viewType: string, isInkPath: (path: string) => boolean): { asMarkdown: (fn: () => Promise<void>) => Promise<void> } {
  const proto = WorkspaceLeaf.prototype as unknown as { setViewState: SetViewState };
  const original = proto.setViewState;
  let active = true;
  let bypass = 0;
  const patched: SetViewState = function (this: WorkspaceLeaf, state: ViewState, eState?: unknown) {
    try {
      const file = (state?.state as { file?: unknown } | undefined)?.file;
      if (active && bypass === 0 && state?.type === "markdown" && typeof file === "string" && isInkPath(file)) {
        state = { ...state, type: viewType };
      }
    } catch (e) {
      console.error("Ink Notebook: opening the ink page failed", e);
    }
    return original.call(this, state, eState);
  };
  proto.setViewState = patched;
  plugin.register(() => {
    // another plugin may have wrapped it after us: then only switch ours off
    if (proto.setViewState === patched) proto.setViewState = original;
    else active = false;
  });
  return {
    async asMarkdown(fn) {
      bypass++;
      try {
        await fn();
      } finally {
        bypass--;
      }
    },
  };
}
