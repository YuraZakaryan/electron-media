import { describe, expect, it } from "vitest";

import { parseVttCues } from "./vtt-cue-parser.js";

describe("parseVttCues", () => {
  it("parses a single cue with full HH:MM:SS.mmm timestamps", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello world";
    expect(parseVttCues(vtt)).toEqual([
      { startSeconds: 1, endSeconds: 2.5, text: "Hello world" },
    ]);
  });

  it("parses multiple cues in one document", () => {
    const vtt =
      "WEBVTT\n\n" +
      "00:00:01.000 --> 00:00:02.000\nFirst\n\n" +
      "00:00:03.000 --> 00:00:04.000\nSecond";
    expect(parseVttCues(vtt)).toEqual([
      { startSeconds: 1, endSeconds: 2, text: "First" },
      { startSeconds: 3, endSeconds: 4, text: "Second" },
    ]);
  });

  it("supports the hours-omitted MM:SS.mmm format ffmpeg emits", () => {
    const vtt = "WEBVTT\n\n00:01.959 --> 00:03.200\nShort form";
    expect(parseVttCues(vtt)).toEqual([
      { startSeconds: 1.959, endSeconds: 3.2, text: "Short form" },
    ]);
  });

  it("preserves multi-line cue text", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nLine one\nLine two";
    expect(parseVttCues(vtt)).toEqual([
      { startSeconds: 1, endSeconds: 2, text: "Line one\nLine two" },
    ]);
  });

  it("shifts every cue by offsetSeconds", () => {
    const vtt = "WEBVTT\n\n00:00:10.000 --> 00:00:12.000\nShifted";
    expect(parseVttCues(vtt, -5)).toEqual([
      { startSeconds: 5, endSeconds: 7, text: "Shifted" },
    ]);
  });

  it("drops a block whose end does not come after its start", () => {
    const vtt = "WEBVTT\n\n00:00:05.000 --> 00:00:05.000\nZero-length";
    expect(parseVttCues(vtt)).toEqual([]);
  });

  it("drops a block with no time line", () => {
    const vtt = "WEBVTT\n\nNOTE this is just a comment block";
    expect(parseVttCues(vtt)).toEqual([]);
  });

  it("drops a block with an empty text payload", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n";
    expect(parseVttCues(vtt)).toEqual([]);
  });

  it("returns an empty array for an empty document", () => {
    expect(parseVttCues("WEBVTT\n\n")).toEqual([]);
  });
});
