import { describe, expect, it } from "vitest";
import {
  ArxivError,
  arxivApiUrl,
  arxivIdFrom,
  arxivSearchQuery,
  baseArxivId,
  paperFileName,
  paperFrontmatter,
  paperNoteBody,
  parseArxivFeed,
  parseHfPapers,
  shortAuthors,
} from "../src/core/arxiv";

// trimmed from a real answer of export.arxiv.org/api/query
const FEED = `<?xml version='1.0' encoding='UTF-8'?>
<feed xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns="http://www.w3.org/2005/Atom">
  <id>https://arxiv.org/api/87r5S/TyOKYyrYIazmFgkV2whgk</id>
  <title>arXiv Query: search_query=all:"diffusion models"&amp;id_list=&amp;start=0&amp;max_results=3</title>
  <opensearch:itemsPerPage>3</opensearch:itemsPerPage>
  <opensearch:totalResults>20492</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <entry>
    <id>http://arxiv.org/abs/2405.03150v2</id>
    <title>Video Diffusion Models:
  A Survey</title>
    <updated>2024-11-17T00:40:09Z</updated>
    <link href="https://arxiv.org/abs/2405.03150v2" rel="alternate" type="text/html"/>
    <link href="https://arxiv.org/pdf/2405.03150v2" rel="related" type="application/pdf" title="pdf"/>
    <summary>Diffusion generative models have recently become a powerful technique
  for creating &amp; modifying video &lt;content&gt;.</summary>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CV" scheme="http://arxiv.org/schemas/atom"/>
    <published>2024-05-06T04:01:42Z</published>
    <arxiv:comment>https://github.com/ndrwmlnk/Awesome-Video-Diffusion-Models</arxiv:comment>
    <arxiv:primary_category term="cs.CV"/>
    <arxiv:journal_ref>TMLR 2024</arxiv:journal_ref>
    <author>
      <name>Andrew Melnik</name>
    </author>
    <author>
      <name>Michal Ljubljanac</name>
      <arxiv:affiliation>Somewhere</arxiv:affiliation>
    </author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/hep-th/9901001v1</id>
    <title>An old one</title>
    <summary>Old style id.</summary>
    <published>1999-01-01T00:00:00Z</published>
    <author><name>Jos&#233; G&#xF6;del</name></author>
  </entry>
</feed>`;

const ERROR_FEED = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_abc</id><title>Error</title><summary>incorrect id format for abc</summary></entry></feed>`;

describe("arXiv ids", () => {
  it("finds the id in what is typed or pasted", () => {
    expect(arxivIdFrom("2405.03150")).toBe("2405.03150");
    expect(arxivIdFrom(" arXiv:2405.03150v2 ")).toBe("2405.03150v2");
    expect(arxivIdFrom("https://arxiv.org/abs/2405.03150v2")).toBe("2405.03150v2");
    expect(arxivIdFrom("https://arxiv.org/pdf/2405.03150v2.pdf")).toBe("2405.03150v2");
    expect(arxivIdFrom("arxiv.org/pdf/2405.03150")).toBe("2405.03150");
    expect(arxivIdFrom("https://www.arxiv.org/abs/1706.03762?context=cs")).toBe("1706.03762");
    expect(arxivIdFrom("hep-th/9901001")).toBe("hep-th/9901001");
    expect(arxivIdFrom("math.GT/0309136v2")).toBe("math.GT/0309136v2");
  });

  it("everything else is a search", () => {
    expect(arxivIdFrom("diffusion models")).toBeNull();
    expect(arxivIdFrom("2405.03150 survey")).toBeNull();
    expect(arxivIdFrom("1234")).toBeNull();
  });

  it("drops the version", () => {
    expect(baseArxivId("2405.03150v12")).toBe("2405.03150");
    expect(baseArxivId("hep-th/9901001v1")).toBe("hep-th/9901001");
  });
});

describe("arXiv queries", () => {
  it("every word must match, phrases stay together", () => {
    expect(arxivSearchQuery("diffusion models")).toBe("all:diffusion AND all:models");
    expect(arxivSearchQuery('"attention is all you need" transformer')).toBe('all:"attention is all you need" AND all:transformer');
  });

  it("field prefixes are kept", () => {
    expect(arxivSearchQuery("au:hinton cat:cs.LG")).toBe("au:hinton AND cat:cs.LG");
    expect(arxivSearchQuery('ti:"graph neural" survey')).toBe('ti:"graph neural" AND all:survey');
  });

  it("characters that break the query are dropped", () => {
    expect(arxivSearchQuery('(foo) bar" and')).toBe("all:foo AND all:bar");
    expect(arxivSearchQuery("   ")).toBe("");
  });

  it("builds the request", () => {
    expect(arxivApiUrl("https://export.arxiv.org/api/query", "2405.03150", 0, 20)).toBe(
      "https://export.arxiv.org/api/query?id_list=2405.03150&start=0&max_results=20",
    );
    expect(arxivApiUrl("https://x/api", "graph nets", 20, 20)).toBe(
      "https://x/api?search_query=all%3Agraph%20AND%20all%3Anets&sortBy=relevance&sortOrder=descending&start=20&max_results=20",
    );
  });
});

describe("reading arXiv answers", () => {
  it("reads the papers", () => {
    const { total, papers } = parseArxivFeed(FEED);
    expect(total).toBe(20492);
    expect(papers).toHaveLength(2);
    const p = papers[0];
    expect(p.id).toBe("2405.03150v2");
    expect(p.title).toBe("Video Diffusion Models: A Survey");
    expect(p.authors).toEqual(["Andrew Melnik", "Michal Ljubljanac"]);
    expect(p.summary).toBe("Diffusion generative models have recently become a powerful technique for creating & modifying video <content>.");
    expect(p.published).toBe("2024-05-06");
    expect(p.categories).toEqual(["cs.CV", "cs.LG"]);
    expect(p.absUrl).toBe("https://arxiv.org/abs/2405.03150v2");
    expect(p.pdfUrl).toBe("https://arxiv.org/pdf/2405.03150v2");
    expect(p.journalRef).toBe("TMLR 2024");
  });

  it("fills in what is missing and decodes characters", () => {
    const p = parseArxivFeed(FEED).papers[1];
    expect(p.id).toBe("hep-th/9901001v1");
    expect(p.authors).toEqual(["José Gödel"]);
    expect(p.pdfUrl).toBe("https://arxiv.org/pdf/hep-th/9901001v1");
    expect(p.categories).toEqual([]);
  });

  it("reports arXiv's errors", () => {
    expect(() => parseArxivFeed(ERROR_FEED)).toThrow(ArxivError);
    expect(() => parseArxivFeed(ERROR_FEED)).toThrow(/incorrect id format/);
  });

  it("no results", () => {
    expect(parseArxivFeed(`<feed><opensearch:totalResults>0</opensearch:totalResults></feed>`)).toEqual({ total: 0, papers: [] });
  });
});

describe("popular papers (Hugging Face)", () => {
  it("reads the trending list", () => {
    const papers = parseHfPapers([
      {
        paper: {
          id: "2610.14224",
          title: "A  popular\npaper",
          summary: "Abstract.",
          authors: [{ _id: "x", name: "Ada" }, { name: "Alan" }, {}],
          publishedAt: "2026-10-09T00:00:00.000Z",
          upvotes: 123,
        },
        title: "ignored",
      },
      { paper: { id: "not-an-arxiv-id", title: "skipped" } },
      null,
    ]);
    expect(papers).toEqual([
      {
        id: "2610.14224",
        title: "A popular paper",
        authors: ["Ada", "Alan"],
        summary: "Abstract.",
        published: "2026-10-09",
        categories: [],
        absUrl: "https://arxiv.org/abs/2610.14224",
        pdfUrl: "https://arxiv.org/pdf/2610.14224",
        upvotes: 123,
      },
    ]);
  });

  it("rejects answers that are not a list", () => {
    expect(() => parseHfPapers({ error: "x" })).toThrow(ArxivError);
  });
});

describe("the imported paper", () => {
  const paper = parseArxivFeed(FEED).papers[0];

  it("short author lists", () => {
    expect(shortAuthors([])).toBe("Unknown authors");
    expect(shortAuthors(["A", "B"])).toBe("A, B");
    expect(shortAuthors(["A", "B", "C", "D"])).toBe("A, B, C et al.");
  });

  it("file names from titles", () => {
    expect(paperFileName("Video Diffusion Models: A Survey")).toBe("Video Diffusion Models - A Survey");
    expect(paperFileName("Is $\\mathcal{O}(n)$ enough? A/B tests [v2]")).toBe("Is O(n) enough A B tests v2");
    expect(paperFileName("...")).toBe("Paper");
    const long = paperFileName("word ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(100);
    expect(long.endsWith("word")).toBe(true);
  });

  it("properties and the start of the text page", () => {
    expect(paperFrontmatter(paper)).toEqual({
      title: "Video Diffusion Models: A Survey",
      authors: ["Andrew Melnik", "Michal Ljubljanac"],
      arxiv: "2405.03150v2",
      url: "https://arxiv.org/abs/2405.03150v2",
      published: "2024-05-06",
      categories: ["cs.CV", "cs.LG"],
    });
    expect(paperNoteBody(paper)).toBe(
      [
        "Andrew Melnik, Michal Ljubljanac · 2024-05-06 · [arXiv:2405.03150v2](https://arxiv.org/abs/2405.03150v2)",
        "",
        "*TMLR 2024*",
        "",
        "> [!abstract]- Abstract",
        "> Diffusion generative models have recently become a powerful technique for creating & modifying video &lt;content>.",
      ].join("\n"),
    );
  });
});
