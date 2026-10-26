import { Modal, Notice, Platform, setIcon, type TFile } from "obsidian";
import type InkNotebookPlugin from "../main";
import { baseArxivId, shortAuthors, type Paper } from "../core/arxiv";
import type { InkView } from "./inkView";
import { importPaper, openImported, PAPERS_PER_PAGE } from "./papers";

/**
 * Find a paper on arXiv and import it. With nothing searched the most popular
 * papers are listed; each card shows title, authors and abstract, with an
 * Import button that makes an ink page of the paper's PDF (or, from an ink
 * page's Insert menu, adds the paper's pages to it).
 */
export class PaperSearchModal extends Modal {
  private input!: HTMLInputElement;
  private clearBtn!: HTMLButtonElement;
  private headingEl!: HTMLElement;
  private subEl!: HTMLElement;
  private listEl!: HTMLElement;
  private moreBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;

  /** What the list shows: "" = popular papers, otherwise the search. */
  private query = "";
  private next = 0;
  private total = -1;
  private seen = new Set<string>();
  /** Bumped for every new list, so answers for an older one are dropped. */
  private token = 0;
  private loading = false;
  private importing = false;
  private imported = new Map<string, TFile>();

  constructor(
    private plugin: InkNotebookPlugin,
    private into: InkView | null = null,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.modalEl.addClass("ink-modal", "ink-arxiv-modal");
    this.titleEl.setText(this.into ? "Add the pages of a paper from arXiv" : "Papers from arXiv");
    this.imported = this.plugin.papers.imported();

    const form = this.contentEl.createEl("form", { cls: "ink-arxiv-search" });
    const field = form.createDiv({ cls: "ink-arxiv-field" });
    setIcon(field.createSpan({ cls: "ink-arxiv-field-icon" }), "search");
    this.input = field.createEl("input", {
      type: "search",
      cls: "ink-arxiv-input",
      attr: { placeholder: "Search arXiv – words, au:author, or a link", enterkeyhint: "search", autocomplete: "off", spellcheck: "false" },
    });
    this.clearBtn = field.createEl("button", { cls: "ink-arxiv-clear", attr: { type: "button", "aria-label": "Clear the search" } });
    setIcon(this.clearBtn, "x");
    form.createEl("button", { cls: "ink-arxiv-go mod-cta", text: "Search", attr: { type: "submit" } });
    this.clearBtn.hidden = true;
    this.input.addEventListener("input", () => (this.clearBtn.hidden = this.input.value === ""));
    this.clearBtn.addEventListener("click", () => {
      this.input.value = "";
      this.clearBtn.hidden = true;
      if (this.query !== "") this.show("");
      if (!Platform.isMobile) this.input.focus();
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      // hide the on-screen keyboard so the results can be seen
      if (Platform.isMobile) this.input.blur();
      this.show(this.input.value.trim());
    });

    const head = this.contentEl.createDiv({ cls: "ink-arxiv-heading" });
    this.headingEl = head.createDiv({ cls: "ink-arxiv-title" });
    this.subEl = head.createDiv({ cls: "ink-arxiv-sub" });
    this.listEl = this.contentEl.createDiv({ cls: "ink-arxiv-list" });
    const foot = this.listEl.createDiv({ cls: "ink-arxiv-foot" });
    this.statusEl = foot.createDiv({ cls: "ink-arxiv-status" });
    this.moreBtn = foot.createEl("button", { cls: "ink-arxiv-more", text: "Load more" });
    this.moreBtn.addEventListener("click", () => void this.load());

    this.show("");
    if (!Platform.isMobile) window.setTimeout(() => this.input.focus(), 0);
  }

  onClose(): void {
    this.token++;
    this.contentEl.empty();
  }

  /** Start a new list: popular papers ("") or a search. */
  private show(query: string): void {
    this.token++;
    this.query = query;
    this.next = 0;
    this.total = -1;
    this.seen.clear();
    this.loading = false;
    for (const card of Array.from(this.listEl.querySelectorAll(".ink-arxiv-card, .ink-arxiv-empty"))) card.remove();
    this.headingEl.setText(!query ? "Most popular papers" : query.includes('"') ? `Results for ${query}` : `Results for “${query}”`);
    this.subEl.setText(query ? "" : "Trending on Hugging Face Papers");
    this.listEl.scrollTop = 0;
    void this.load();
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    const token = this.token;
    const query = this.query;
    this.moreBtn.hidden = true;
    this.status(query ? "Searching arXiv…" : "Loading popular papers…");
    let papers: Paper[];
    let more: boolean;
    try {
      if (query) {
        const page = await this.plugin.papers.search(query, this.next);
        papers = page.papers;
        this.total = page.total;
        // arXiv sometimes sends fewer papers than asked for: continue after the last one received
        this.next += page.papers.length;
        more = page.papers.length > 0 && this.next < page.total;
      } else {
        papers = await this.plugin.papers.popular(this.next);
        this.next += 1;
        more = papers.length >= PAPERS_PER_PAGE;
      }
    } catch (e) {
      if (token !== this.token) return;
      this.loading = false;
      this.status(e instanceof Error ? e.message : String(e), "Try again");
      return;
    }
    if (token !== this.token) return;
    this.loading = false;
    const fresh = papers.filter((p) => !this.seen.has(baseArxivId(p.id)));
    for (const p of fresh) {
      this.seen.add(baseArxivId(p.id));
      this.statusEl.parentElement?.before(this.card(p));
    }
    if (this.seen.size === 0) {
      this.statusEl.parentElement?.before(
        createDiv({ cls: "ink-arxiv-empty", text: query ? `No papers found for “${query}”.` : "No popular papers right now – search arXiv above." }),
      );
    }
    if (query && this.total >= 0) this.subEl.setText(`${this.total.toLocaleString()} paper${this.total === 1 ? "" : "s"} on arXiv`);
    this.status("");
    this.moreBtn.hidden = !more || (papers.length > 0 && fresh.length === 0 && !query);
  }

  private status(text: string, retry?: string): void {
    this.statusEl.empty();
    this.statusEl.toggleClass("is-error", !!retry);
    if (!text) return;
    this.statusEl.createSpan({ text });
    if (retry) {
      const b = this.statusEl.createEl("button", { text: retry });
      b.addEventListener("click", () => void this.load());
    }
  }

  private card(p: Paper): HTMLElement {
    const card = createDiv({ cls: "ink-arxiv-card" });
    const head = card.createDiv({ cls: "ink-arxiv-card-head" });
    const title = head.createDiv({ cls: "ink-arxiv-card-title", text: p.title || p.id });
    const action = head.createEl("button", { cls: "ink-arxiv-import" });
    const done = !this.into ? this.imported.get(baseArxivId(p.id)) : undefined;
    const label = (text: string, icon: string) => {
      action.empty();
      setIcon(action.createSpan({ cls: "ink-arxiv-import-icon" }), icon);
      action.createSpan({ text });
    };
    if (done) {
      label("Open", "pencil-line");
      action.addClass("is-imported");
    } else label(this.into ? "Add pages" : "Import", "download");

    const meta = card.createDiv({ cls: "ink-arxiv-card-meta" });
    meta.createSpan({ text: shortAuthors(p.authors) });
    const facts = [p.published, p.categories[0], p.upvotes !== undefined ? `▲ ${p.upvotes}` : ""].filter(Boolean);
    if (facts.length) meta.createSpan({ cls: "ink-arxiv-card-facts", text: facts.join(" · ") });
    const link = meta.createEl("a", { cls: "ink-arxiv-card-link", text: `arXiv:${p.id}`, href: p.absUrl });
    link.addEventListener("click", (e) => {
      e.preventDefault();
      window.open(p.absUrl);
    });

    if (p.summary) {
      const abs = card.createDiv({ cls: "ink-arxiv-card-abstract", text: p.summary });
      const toggle = () => card.toggleClass("is-open", !card.hasClass("is-open"));
      abs.addEventListener("click", toggle);
      title.addEventListener("click", toggle);
    }

    action.addEventListener("click", async () => {
      if (this.importing) return;
      if (done) {
        this.close();
        await openImported(this.plugin, done);
        return;
      }
      this.importing = true;
      this.modalEl.addClass("is-importing");
      action.disabled = true;
      label("Downloading…", "loader");
      try {
        if (await importPaper(this.plugin, p, { into: this.into })) {
          this.close();
          return;
        }
      } catch (e) {
        console.error("Ink Notebook: importing the paper failed", e);
        new Notice(`Ink Notebook: ${e instanceof Error ? e.message : String(e)}`, 8000);
      } finally {
        this.importing = false;
        this.modalEl.removeClass("is-importing");
      }
      action.disabled = false;
      label(this.into ? "Add pages" : "Import", "download");
    });
    return card;
  }
}
