import { describe, expect, it } from "vitest";
import { azureErrorMessage, normalizeEndpoint, parseAzureV3, parseAzureV4, readV3Status } from "../src/core/azureParse";

// Shapes taken from the Azure AI Vision documentation.
const v4 = {
  modelVersion: "2023-10-01",
  metadata: { width: 1000, height: 600 },
  readResult: {
    blocks: [
      {
        lines: [
          {
            text: "Meeting with [[Anna]]",
            boundingPolygon: [
              { x: 10, y: 20 },
              { x: 400, y: 22 },
              { x: 400, y: 60 },
              { x: 10, y: 58 },
            ],
            words: [
              { text: "Meeting", boundingPolygon: [{ x: 10, y: 20 }, { x: 150, y: 20 }, { x: 150, y: 60 }, { x: 10, y: 60 }], confidence: 0.99 },
              { text: "with", boundingPolygon: [{ x: 160, y: 20 }, { x: 240, y: 20 }, { x: 240, y: 60 }, { x: 160, y: 60 }], confidence: 0.97 },
              { text: "[[Anna]]", boundingPolygon: [{ x: 250, y: 20 }, { x: 400, y: 20 }, { x: 400, y: 60 }, { x: 250, y: 60 }], confidence: 0.6 },
            ],
          },
          { text: "", boundingPolygon: [] },
          { text: "broken", boundingPolygon: "nope" },
        ],
      },
    ],
  },
};

const v3 = {
  status: "succeeded",
  analyzeResult: {
    version: "3.2.0",
    readResults: [
      {
        page: 1,
        angle: 0,
        width: 800,
        height: 400,
        unit: "pixel",
        lines: [
          {
            boundingBox: [5, 10, 300, 12, 300, 50, 5, 48],
            text: "Einkaufsliste",
            appearance: { style: { name: "handwriting", confidence: 0.9 } },
            words: [{ boundingBox: [5, 10, 300, 12, 300, 50, 5, 48], text: "Einkaufsliste", confidence: 0.88 }],
          },
        ],
      },
    ],
  },
};

describe("Azure parsers", () => {
  it("parses Image Analysis 4.0 read results", () => {
    const r = parseAzureV4(v4);
    expect(r.provider).toBe("azure-v4");
    expect(r.width).toBe(1000);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].text).toBe("Meeting with [[Anna]]");
    expect(r.lines[0].box).toEqual({ x: 10, y: 20, w: 390, h: 40 });
    expect(r.lines[0].words.map((w) => w.confidence)).toEqual([0.99, 0.97, 0.6]);
  });

  it("parses Read 3.2 results", () => {
    expect(readV3Status(v3)).toBe("succeeded");
    expect(readV3Status({ status: "running" })).toBe("running");
    expect(readV3Status(null)).toBe("unknown");
    const r = parseAzureV3(v3);
    expect(r.lines[0]).toMatchObject({ text: "Einkaufsliste", box: { x: 5, y: 10, w: 295, h: 40 } });
    expect(r.width).toBe(800);
  });

  it("never throws on garbage", () => {
    for (const junk of [null, undefined, 42, "x", [], { readResult: 5 }, { analyzeResult: { readResults: [null] } }]) {
      expect(parseAzureV4(junk).lines).toEqual([]);
      expect(parseAzureV3(junk).lines).toEqual([]);
    }
  });

  it("builds readable error messages", () => {
    expect(azureErrorMessage({ error: { code: "401", message: "Access denied due to invalid subscription key." } }, 401)).toContain("invalid subscription key");
    expect(azureErrorMessage(null, 404)).toContain("endpoint");
    expect(azureErrorMessage("", 429)).toContain("rate limit");
  });

  it("normalises endpoints", () => {
    expect(normalizeEndpoint("myres.cognitiveservices.azure.com/")).toBe("https://myres.cognitiveservices.azure.com");
    expect(normalizeEndpoint(" https://westeurope.api.cognitive.microsoft.com/vision/v3.2 ")).toBe("https://westeurope.api.cognitive.microsoft.com");
    expect(normalizeEndpoint("http://127.0.0.1:8123")).toBe("http://127.0.0.1:8123");
    expect(normalizeEndpoint("")).toBe("");
  });
});
