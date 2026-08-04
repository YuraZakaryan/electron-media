import type { CanonicalCue } from "../types/cue.js";

// WebVTT allows the hours component to be omitted entirely when it's zero —
// ffmpeg's webvtt muxer does exactly that ("00:01.959", not "00:00:01.959"),
// so the hours group must stay optional rather than fixed-width.
const TIME_LINE_PATTERN =
  /(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})/;

function toSeconds(
  hours: string | undefined,
  minutes: string,
  seconds: string,
  milliseconds: string
): number {
  return (
    Number(hours || 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds) / 1000
  );
}

/**
 * Parses a WebVTT document into canonical cues, shifted by `offsetSeconds`.
 *
 * Used to feed {@link ISubtitleRenderer} via `TextTrack.addCue()` directly
 * instead of a static `<track src>`, which only fetches once and would never
 * see cues appended to a growing file after the browser already parsed it.
 *
 * @public
 */
export function parseVttCues(
  vttText: string,
  offsetSeconds = 0
): CanonicalCue[] {
  const blocks = vttText.replace(/\r\n/g, "\n").trim().split(/\n\n+/);
  const cues: CanonicalCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    const timeLineIndex = lines.findIndex((line) =>
      TIME_LINE_PATTERN.test(line)
    );
    if (timeLineIndex === -1) continue;

    const match = lines[timeLineIndex].match(TIME_LINE_PATTERN);
    if (!match) continue;

    const startSeconds =
      toSeconds(match[1], match[2], match[3], match[4]) + offsetSeconds;
    const endSeconds =
      toSeconds(match[5], match[6], match[7], match[8]) + offsetSeconds;
    const text = lines.slice(timeLineIndex + 1).join("\n");
    if (!text || endSeconds <= startSeconds) continue;

    cues.push({ startSeconds, endSeconds, text });
  }

  return cues;
}
