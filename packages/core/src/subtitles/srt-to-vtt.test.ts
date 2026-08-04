import { describe, expect, it } from "vitest";

import { convertSrtToVtt } from "./srt-to-vtt.js";
import { parseVttCues } from "./vtt-cue-parser.js";

describe("convertSrtToVtt", () => {
  it("prepends a WEBVTT header", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello";
    expect(convertSrtToVtt(srt).startsWith("WEBVTT\n\n")).toBe(true);
  });

  it("converts comma millisecond separators to dots", () => {
    const srt = "1\n00:00:01,250 --> 00:00:02,750\nHello";
    const vtt = convertSrtToVtt(srt);
    expect(vtt).toContain("00:00:01.250 --> 00:00:02.750");
  });

  it("strips the numeric index line from each block", () => {
    const srt = "1\n00:00:01,000 --> 00:00:02,000\nHello";
    const vtt = convertSrtToVtt(srt);
    expect(vtt).not.toMatch(/^\d+$/m);
  });

  it("round-trips through parseVttCues for multiple blocks", () => {
    const srt =
      "1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n" +
      "2\n00:00:03,500 --> 00:00:04,500\nSecond";
    const cues = parseVttCues(convertSrtToVtt(srt));
    expect(cues).toEqual([
      { startSeconds: 1, endSeconds: 2, text: "First" },
      { startSeconds: 3.5, endSeconds: 4.5, text: "Second" },
    ]);
  });

  it("normalizes CRLF line endings", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n";
    expect(convertSrtToVtt(srt)).not.toContain("\r");
  });
});
