import { describe, expect, it } from "vitest";
import { getSpeakableText } from "./speakable-text.js";

describe("getSpeakableText", () => {
  it("passes plain dialogue through unchanged", () => {
    expect(getSpeakableText("Hello, how are you?")).toBe("Hello, how are you?");
  });

  it("strips a bracketed SDH sound-effect cue to null", () => {
    expect(getSpeakableText("[door creaks]")).toBeNull();
  });

  it("strips a music-note-marked cue to null", () => {
    expect(getSpeakableText("♪ some lyrics ♪")).toBeNull();
  });

  it("returns null for whitespace-only text", () => {
    expect(getSpeakableText("   \n\t  ")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(getSpeakableText("")).toBeNull();
  });

  it("strips only the bracketed portion of a mixed dialogue+SFX cue", () => {
    expect(getSpeakableText("Get down! [gunshot]")).toBe("Get down!");
  });

  it("strips a parenthesized speaker label, keeping dialogue", () => {
    expect(getSpeakableText("(John) I'll be right there.")).toBe("I'll be right there.");
  });
});
