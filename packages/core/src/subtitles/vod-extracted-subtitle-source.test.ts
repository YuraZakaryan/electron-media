import { afterEach, describe, expect, it, vi } from "vitest";

import { asSubtitleSourceId, asSubtitleTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { VodExtractedSubtitleSource } from "./vod-extracted-subtitle-source.js";

const SOURCE_ID = asSubtitleSourceId("vod-extracted");
const TRACK_ID = asSubtitleTrackId(1);

function fakeResponse(options: {
  ok?: boolean;
  status?: number;
  text?: string;
}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: () => Promise.resolve(options.text ?? ""),
  } as Response;
}

function vttWithCues(...lines: Array<[string, string, string]>): string {
  const body = lines
    .map(([start, end, text]) => `${start} --> ${end}\n${text}`)
    .join("\n\n");
  return `WEBVTT\n\n${body}`;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("VodExtractedSubtitleSource", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reports tracks with this source's own sourceId, regardless of the descriptor's", () => {
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        {
          trackId: TRACK_ID,
          displayName: "English",
          language: "en",
          kind: TrackKind.Default,
          vttUrl: "/vod/en.vtt",
        },
      ],
      fetchImpl: vi.fn(),
    });

    expect(source.getTracks()).toEqual([
      {
        trackId: TRACK_ID,
        displayName: "English",
        language: "en",
        kind: TrackKind.Default,
        sourceId: SOURCE_ID,
      },
    ]);
  });

  it("fetches and emits canonical cues for the selected track", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ text: vttWithCues(["00:01.000", "00:02.000", "Hello"]) })
      );
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
      ],
      fetchImpl,
    });
    const listener = vi.fn();
    source.onCuesChanged(TRACK_ID, listener);

    source.selectTrack(TRACK_ID);
    await flushMicrotasks();

    expect(fetchImpl).toHaveBeenCalledWith("/vod/en.vtt", { cache: "no-store" });
    expect(listener).toHaveBeenCalledWith([
      { startSeconds: 1, endSeconds: 2, text: "Hello" },
    ]);
  });

  it("dedupes cues already seen across repeated polls, only notifying on genuinely new ones", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({ text: vttWithCues(["00:01.000", "00:02.000", "First"]) })
      )
      .mockResolvedValueOnce(
        // Same cue as before, plus one genuinely new one.
        fakeResponse({
          text: vttWithCues(
            ["00:01.000", "00:02.000", "First"],
            ["00:03.000", "00:04.000", "Second"]
          ),
        })
      );
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
      ],
      fetchImpl,
      pollIntervalMs: 1000,
    });
    const listener = vi.fn();
    source.onCuesChanged(TRACK_ID, listener);

    source.selectTrack(TRACK_ID);
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith([
      { startSeconds: 1, endSeconds: 2, text: "First" },
      { startSeconds: 3, endSeconds: 4, text: "Second" },
    ]);
  });

  it("re-projects already-fetched cues against a new baseline offset without re-fetching", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ text: vttWithCues(["00:05.000", "00:06.000", "Hello"]) })
      );
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
      ],
      fetchImpl,
    });
    const listener = vi.fn();
    source.onCuesChanged(TRACK_ID, listener);
    source.selectTrack(TRACK_ID);
    await flushMicrotasks();

    source.setBaselineOffsetSeconds(2);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith([
      { startSeconds: 3, endSeconds: 4, text: "Hello" },
    ]);
  });

  it("drops a cue that ends at or before a baseline offset that moves it entirely before session start", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ text: vttWithCues(["00:01.000", "00:02.000", "Too early"]) })
      );
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
      ],
      fetchImpl,
    });
    const listener = vi.fn();
    source.onCuesChanged(TRACK_ID, listener);
    source.selectTrack(TRACK_ID);
    await flushMicrotasks();

    source.setBaselineOffsetSeconds(5);

    expect(listener).toHaveBeenLastCalledWith([]);
  });

  it("stops polling a track once its .vtt file 404s", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        fakeResponse({ text: vttWithCues(["00:01.000", "00:02.000", "Hello"]) })
      )
      .mockResolvedValue(fakeResponse({ ok: false, status: 404 }));
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
      ],
      fetchImpl,
      pollIntervalMs: 1000,
    });
    source.selectTrack(TRACK_ID);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(1000); // 404 — stops the poll timer
    await vi.advanceTimersByTimeAsync(5000); // would have polled 5 more times otherwise

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("selectTrack(null) stops polling without emitting further cue updates", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ text: vttWithCues(["00:01.000", "00:02.000", "Hello"]) })
      );
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
      ],
      fetchImpl,
      pollIntervalMs: 1000,
    });
    source.selectTrack(TRACK_ID);
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeDeselect = fetchImpl.mock.calls.length;

    source.selectTrack(null);
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchImpl.mock.calls.length).toBe(callsBeforeDeselect);
  });

  it("a fetch that rejects outright is treated the same as a failed response — no crash, no emission", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
      ],
      fetchImpl,
    });
    const listener = vi.fn();
    source.onCuesChanged(TRACK_ID, listener);

    source.selectTrack(TRACK_ID);
    await flushMicrotasks();

    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose() stops polling and clears cue listeners", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        fakeResponse({ text: vttWithCues(["00:01.000", "00:02.000", "Hello"]) })
      );
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
      ],
      fetchImpl,
      pollIntervalMs: 1000,
    });
    source.selectTrack(TRACK_ID);
    await vi.advanceTimersByTimeAsync(0);
    const callsBeforeDispose = fetchImpl.mock.calls.length;

    source.dispose();
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchImpl.mock.calls.length).toBe(callsBeforeDispose);
  });
});
