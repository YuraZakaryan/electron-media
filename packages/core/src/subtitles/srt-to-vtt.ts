const TIMESTAMP_PATTERN = /(\d{2}:\d{2}:\d{2}),(\d{3})/g;

/**
 * Converts an SRT subtitle document to WebVTT, the only format
 * {@link parseVttCues} understands. Used for remote sources (e.g.
 * OpenSubtitles) that deliver SRT rather than VTT.
 *
 * @public
 */
export function convertSrtToVtt(srtContent: string): string {
  const normalized = srtContent.replace(/\r\n/g, "\n").trim();

  const body = normalized
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split("\n");
      const withoutIndex = /^\d+$/.test(lines[0]) ? lines.slice(1) : lines;
      return withoutIndex
        .map((line) => line.replace(TIMESTAMP_PATTERN, "$1.$2"))
        .join("\n");
    })
    .join("\n\n");

  return `WEBVTT\n\n${body}\n`;
}
