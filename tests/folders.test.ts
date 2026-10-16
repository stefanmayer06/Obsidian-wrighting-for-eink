import { describe, expect, it } from "vitest";
import { cleanSubfolder, homeFolder, isInkSubfolder, joinPath, parentPath, partnerTarget, plainName } from "../src/core/folders";

describe("folder helpers", () => {
  it("joins and splits vault paths", () => {
    expect(joinPath("003 - University/Computer Architecture", "Attachments")).toBe("003 - University/Computer Architecture/Attachments");
    expect(joinPath("", "Attachments")).toBe("Attachments");
    expect(joinPath("/", "a/", "/b")).toBe("a/b");
    expect(parentPath("a/b/c.md")).toBe("a/b");
    expect(parentPath("c.md")).toBe("");
    expect(plainName("a/Week 1.excalidraw.md")).toBe("Week 1");
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
    expect(partnerTarget({ role: "text", oldPath: `${CA}/Week 1.md`, newPath: `${CA}/Week 1 - Intro.md`, partnerPath: `${CA}/Attachments/Week 1.excalidraw.md` })).toBe(
      `${CA}/Attachments/Week 1 - Intro.excalidraw.md`,
    );
  });

  it("moves the drawing into the new folder's ink subfolder when the text page moves", () => {
    expect(partnerTarget({ role: "text", oldPath: `${CA}/Week 1.md`, newPath: "Archive/Week 1.md", partnerPath: `${CA}/Attachments/Week 1.excalidraw.md` })).toBe(
      "Archive/Attachments/Week 1.excalidraw.md",
    );
  });

  it("renames the text page in the folder above when the drawing is renamed", () => {
    expect(partnerTarget({ role: "ink", oldPath: `${CA}/Attachments/Week 1.excalidraw.md`, newPath: `${CA}/Attachments/Week 2.excalidraw.md`, partnerPath: `${CA}/Week 1.md` })).toBe(
      `${CA}/Week 2.md`,
    );
  });

  it("follows a drawing moved into another folder's ink subfolder", () => {
    expect(partnerTarget({ role: "ink", oldPath: `${CA}/Attachments/Week 1.excalidraw.md`, newPath: "Maths/Attachments/Week 1.excalidraw.md", partnerPath: `${CA}/Week 1.md` })).toBe(
      "Maths/Week 1.md",
    );
    // moved somewhere unrelated: the text page stays where it is
    expect(partnerTarget({ role: "ink", oldPath: `${CA}/Attachments/Week 1.excalidraw.md`, newPath: "Drawings/Week 1.excalidraw.md", partnerPath: `${CA}/Week 1.md` })).toBeNull();
  });

  it("does nothing when a whole folder moved (both files already moved)", () => {
    expect(partnerTarget({ role: "text", oldPath: `${CA}/Week 1.md`, newPath: "Uni/CA/Week 1.md", partnerPath: "Uni/CA/Attachments/Week 1.excalidraw.md" })).toBeNull();
    expect(partnerTarget({ role: "ink", oldPath: `${CA}/Attachments/Week 1.excalidraw.md`, newPath: "Uni/CA/Attachments/Week 1.excalidraw.md", partnerPath: "Uni/CA/Week 1.md" })).toBeNull();
  });

  it("keeps the old side-by-side layout working", () => {
    expect(partnerTarget({ role: "ink", oldPath: "Ink/Page.excalidraw.md", newPath: "Ink/Shopping list.excalidraw.md", partnerPath: "Ink/Page.md" })).toBe("Ink/Shopping list.md");
    expect(partnerTarget({ role: "text", oldPath: "Ink/Page.md", newPath: "Notes/Page.md", partnerPath: "Ink/Page.excalidraw.md" })).toBe("Notes/Page.excalidraw.md");
  });

  it("leaves partners with a different name alone", () => {
    expect(partnerTarget({ role: "text", oldPath: "Ink/Page.md", newPath: "Ink/Other.md", partnerPath: "Ink/Drawing.excalidraw.md" })).toBeNull();
  });

  it("works at the vault root", () => {
    expect(partnerTarget({ role: "text", oldPath: "Week 1.md", newPath: "Week 2.md", partnerPath: "Attachments/Week 1.excalidraw.md" })).toBe("Attachments/Week 2.excalidraw.md");
    expect(partnerTarget({ role: "ink", oldPath: "Attachments/Week 1.excalidraw.md", newPath: "Attachments/Week 2.excalidraw.md", partnerPath: "Week 1.md" })).toBe("Week 2.md");
  });
});
