import { describe, expect, it } from "vitest";
import { cleanSubfolder, homeFolder, inkFolderOf, isInkSubfolder, joinPath, pairPaths, parentPath, partnerTarget, plainName, withoutTextSuffix } from "../src/core/folders";

describe("folder helpers", () => {
  it("joins and splits vault paths", () => {
    expect(joinPath("003 - University/Computer Architecture", "Attachments")).toBe("003 - University/Computer Architecture/Attachments");
    expect(joinPath("", "Attachments")).toBe("Attachments");
    expect(joinPath("/", "a/", "/b")).toBe("a/b");
    expect(parentPath("a/b/c.md")).toBe("a/b");
    expect(parentPath("c.md")).toBe("");
    expect(plainName("a/Week 1.ink.md")).toBe("Week 1");
    expect(plainName("a/Week 1.md")).toBe("Week 1");
  });

  it("cleans the subfolder setting", () => {
    expect(cleanSubfolder("./Attachments/")).toBe("Attachments");
    expect(cleanSubfolder("  ")).toBe("");
    expect(cleanSubfolder("../x")).toBe("x");
    expect(cleanSubfolder("Ink\\Drawings")).toBe("Ink/Drawings");
  });

  it("finds the home folder of an ink subfolder", () => {
    expect(isInkSubfolder("Uni/CA/Attachments", "Attachments")).toBe(true);
    expect(isInkSubfolder("Uni/CA/attachments", "Attachments")).toBe(true);
    expect(isInkSubfolder("Attachments", "Attachments")).toBe(true);
    expect(isInkSubfolder("Uni/MyAttachments", "Attachments")).toBe(false);
    expect(isInkSubfolder("Uni/CA", "")).toBe(false);
    expect(homeFolder("Uni/CA/Attachments", "Attachments")).toBe("Uni/CA");
    expect(homeFolder("Attachments", "Attachments")).toBe("");
    expect(homeFolder("Uni/CA", "Attachments")).toBe("Uni/CA");
  });
});

describe("keeping a pair together on rename/move", () => {
  const CA = "003 - University/Computer Architecture";

  it("renames the drawing in the ink subfolder when the text page is renamed", () => {
    expect(partnerTarget({ role: "text", oldPath: `${CA}/Week 1.md`, newPath: `${CA}/Week 1 - Intro.md`, partnerPath: `${CA}/Attachments/Week 1.ink.md` })).toBe(
      `${CA}/Attachments/Week 1 - Intro.ink.md`,
    );
  });

  it("moves the drawing into the new folder's ink subfolder when the text page moves", () => {
    expect(partnerTarget({ role: "text", oldPath: `${CA}/Week 1.md`, newPath: "Archive/Week 1.md", partnerPath: `${CA}/Attachments/Week 1.ink.md` })).toBe(
      "Archive/Attachments/Week 1.ink.md",
    );
  });

  it("renames the text page in the folder above when the drawing is renamed", () => {
    expect(partnerTarget({ role: "ink", oldPath: `${CA}/Attachments/Week 1.ink.md`, newPath: `${CA}/Attachments/Week 2.ink.md`, partnerPath: `${CA}/Week 1.md` })).toBe(
      `${CA}/Week 2.md`,
    );
  });

  it("follows a drawing moved into another folder's ink subfolder", () => {
    expect(partnerTarget({ role: "ink", oldPath: `${CA}/Attachments/Week 1.ink.md`, newPath: "Maths/Attachments/Week 1.ink.md", partnerPath: `${CA}/Week 1.md` })).toBe(
      "Maths/Week 1.md",
    );
    // moved somewhere unrelated: the text page stays where it is
    expect(partnerTarget({ role: "ink", oldPath: `${CA}/Attachments/Week 1.ink.md`, newPath: "Drawings/Week 1.ink.md", partnerPath: `${CA}/Week 1.md` })).toBeNull();
  });

  it("does nothing when a whole folder moved (both files already moved)", () => {
    expect(partnerTarget({ role: "text", oldPath: `${CA}/Week 1.md`, newPath: "Uni/CA/Week 1.md", partnerPath: "Uni/CA/Attachments/Week 1.ink.md" })).toBeNull();
    expect(partnerTarget({ role: "ink", oldPath: `${CA}/Attachments/Week 1.ink.md`, newPath: "Uni/CA/Attachments/Week 1.ink.md", partnerPath: "Uni/CA/Week 1.md" })).toBeNull();
  });

  it("keeps the old side-by-side layout working", () => {
    expect(partnerTarget({ role: "ink", oldPath: "Ink/Page.ink.md", newPath: "Ink/Shopping list.ink.md", partnerPath: "Ink/Page.md" })).toBe("Ink/Shopping list.md");
    expect(partnerTarget({ role: "text", oldPath: "Ink/Page.md", newPath: "Notes/Page.md", partnerPath: "Ink/Page.ink.md" })).toBe("Notes/Page.ink.md");
  });

  it("leaves partners with a different name alone", () => {
    expect(partnerTarget({ role: "text", oldPath: "Ink/Page.md", newPath: "Ink/Other.md", partnerPath: "Ink/Drawing.ink.md" })).toBeNull();
  });

  it("works at the vault root", () => {
    expect(partnerTarget({ role: "text", oldPath: "Week 1.md", newPath: "Week 2.md", partnerPath: "Attachments/Week 1.ink.md" })).toBe("Attachments/Week 2.ink.md");
    expect(partnerTarget({ role: "ink", oldPath: "Attachments/Week 1.ink.md", newPath: "Attachments/Week 2.ink.md", partnerPath: "Week 1.md" })).toBe("Week 2.md");
  });

  it("knows where the files of an ink page belong", () => {
    expect(inkFolderOf("Uni/CA", "Attachments")).toBe("Uni/CA/Attachments");
    expect(inkFolderOf("", "Attachments")).toBe("Attachments");
    expect(inkFolderOf("Uni/CA/Attachments", "Attachments")).toBe("Uni/CA/Attachments");
    expect(inkFolderOf("Uni/CA", "")).toBe("Uni/CA");
    expect(withoutTextSuffix("2026-10-27 (text)")).toBe("2026-10-27");
    expect(withoutTextSuffix("Week 1 (text 3)")).toBe("Week 1");
    expect(withoutTextSuffix("Notes (textbook)")).toBe("Notes (textbook)");
    // a daily note that was the drawing itself, with "(text)" text page next to it
    expect(pairPaths({ textPath: "2026-10-27 (text).md", drawingPath: "2026-10-27.md", sub: "Attachments" })).toEqual({
      text: "2026-10-27.md",
      drawing: "Attachments/2026-10-27.ink.md",
    });
    // already in place
    expect(pairPaths({ textPath: "Uni/Week 1.md", drawingPath: "Uni/Attachments/Week 1.ink.md", sub: "Attachments" })).toEqual({
      text: "Uni/Week 1.md",
      drawing: "Uni/Attachments/Week 1.ink.md",
    });
    // the text page was renamed: the drawing follows its name
    expect(pairPaths({ textPath: "Uni/Lecture.md", drawingPath: "Uni/Attachments/Ink 2026-10-27 1122.ink.md", sub: "Attachments" }).drawing).toBe("Uni/Attachments/Lecture.ink.md");
    // a name that really ends in "(text)" stays
    expect(pairPaths({ textPath: "Diary (text).md", drawingPath: "Attachments/Diary (text).ink.md", sub: "Attachments" }).text).toBe("Diary (text).md");
  });
});
