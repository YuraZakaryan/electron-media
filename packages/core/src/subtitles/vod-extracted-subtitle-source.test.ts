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

  it("re-emits already-cached cues synchronously when the same track is re-selected", async () => {
    // The regression this guards: fetchAndMergeCues only notifies when it
    // finds cues it has not seen before, so re-selecting a track whose .vtt
    // was already fully read emitted nothing at all — the track showed as
    // selected while the screen kept whatever the previous selection had
    // rendered. Real path: user picks native, switches to OpenSubtitles,
    // then switches back to native.
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
    source.selectTrack(null);

    const listener = vi.fn();
    source.onCuesChanged(TRACK_ID, listener);
    source.selectTrack(TRACK_ID);

    // Synchronously, before any re-fetch resolves — the renderer must not
    // have to wait on the network to show a track it already has cues for.
    expect(listener).toHaveBeenCalledWith([
      { startSeconds: 1, endSeconds: 2, text: "Hello" },
    ]);
  });

  it("does not emit on re-selection of a track that has no cached cues yet", async () => {
    // The guard above must stay scoped to a genuine cache hit: a track whose
    // .vtt has never yielded a cue has nothing to re-emit, and emitting an
    // empty list here would clear a still-loading track's screen on every
    // re-select instead of leaving the fetch to fill it.
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue(fakeResponse({ text: "WEBVTT\n" }));
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
    source.selectTrack(null);

    const listener = vi.fn();
    source.onCuesChanged(TRACK_ID, listener);
    source.selectTrack(TRACK_ID);

    expect(listener).not.toHaveBeenCalled();
  });

  it("uses the global fetch without making it the instance's own method", async () => {
    // Browsers throw "Illegal invocation" when `fetch` runs with a foreign
    // receiver, which is exactly what storing the global on the instance and
    // calling `this.fetchImpl(...)` did. The throw is synchronous, so it
    // escaped before any handler on the returned promise applied: nothing
    // surfaced anywhere and every track silently produced no cues.
    vi.useFakeTimers();
    const globalFetch = vi.fn(function (this: unknown) {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError("Illegal invocation");
      }
      return Promise.resolve(
        fakeResponse({ text: vttWithCues(["00:01.000", "00:02.000", "Hello"]) })
      );
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = globalFetch;

    try {
      const source = new VodExtractedSubtitleSource({
        sourceId: SOURCE_ID,
        tracks: [
          { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
        ],
        // fetchImpl deliberately omitted — this exercises the default.
      });
      const listener = vi.fn();
      source.onCuesChanged(TRACK_ID, listener);

      source.selectTrack(TRACK_ID);
      await vi.advanceTimersByTimeAsync(0);

      expect(globalFetch).toHaveBeenCalled();
      expect(listener).toHaveBeenCalledWith([
        { startSeconds: 1, endSeconds: 2, text: "Hello" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("a fetchImpl that throws synchronously is contained, not left as an unhandled rejection", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => {
      throw new TypeError("Illegal invocation");
    }) as unknown as typeof fetch;
    const source = new VodExtractedSubtitleSource({
      sourceId: SOURCE_ID,
      tracks: [
        { trackId: TRACK_ID, displayName: "English", kind: TrackKind.Default, vttUrl: "/vod/en.vtt" },
      ],
      fetchImpl,
    });
    const listener = vi.fn();
    source.onCuesChanged(TRACK_ID, listener);

    expect(() => source.selectTrack(TRACK_ID)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(listener).not.toHaveBeenCalled();
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
