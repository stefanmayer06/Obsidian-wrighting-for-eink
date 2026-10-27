import { describe, expect, it } from "vitest";
import { dailyConfigFrom, dailyNoteDatePart, dailyNotePath } from "../src/core/dailyNotes";

describe("daily notes", () => {
  it("reads the plugins' settings", () => {
    expect(dailyConfigFrom(undefined)).toEqual({ folder: "", format: "YYYY-MM-DD" });
    expect(dailyConfigFrom({ folder: " /Journal/ ", format: "" })).toEqual({ folder: "Journal", format: "YYYY-MM-DD" });
    expect(dailyConfigFrom({ folder: "Journal/Daily", format: "YYYY/MM/DD" })).toEqual({ folder: "Journal/Daily", format: "YYYY/MM/DD" });
  });

  it("finds the date part of a note's path", () => {
    expect(dailyNoteDatePart("2026-10-27.md", "")).toBe("2026-10-27");
    expect(dailyNoteDatePart("Journal/2026-10-27.md", "Journal")).toBe("2026-10-27");
    expect(dailyNoteDatePart("Journal/2026/10/2026-10-27.md", "Journal")).toBe("2026/10/2026-10-27");
    expect(dailyNoteDatePart("Other/2026-10-27.md", "Journal")).toBeNull();
    expect(dailyNoteDatePart("Journal/2026-10-27.pdf", "Journal")).toBeNull();
    expect(dailyNoteDatePart("JournalX/2026-10-27.md", "Journal")).toBeNull();
  });

  it("knows where a daily note goes", () => {
    expect(dailyNotePath({ folder: "", format: "YYYY-MM-DD" }, "2026-10-27")).toBe("2026-10-27.md");
    expect(dailyNotePath({ folder: "Journal", format: "YYYY/YYYY-MM-DD" }, "2026/2026-10-27")).toBe("Journal/2026/2026-10-27.md");
  });
});
