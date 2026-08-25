import { afterEach, describe, expect, it, vi } from "vitest";

import { asSubtitleSourceId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { MockSubtitleGateway } from "../testing/mock-subtitle-gateway.js";
import { OpenSubtitlesSource } from "./opensubtitles-source.js";
import { SubtitleError } from "../errors/index.js";

const SOURCE_ID = asSubtitleSourceId("opensubtitles");

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OpenSubtitlesSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when the gateway is unavailable", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.isAvailable = false;
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });

    await expect(source.search({ tmdbId: 1 })).rejects.toThrow(SubtitleError);
  });

  it("builds tracks sorted by rating, highest first", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = {
      success: true,
      results: [
        { fileId: 1, language: "en", rating: 5 },
        { fileId: 2, language: "fr", rating: 9 },
        { fileId: 3, language: "de", rating: 7 },
      ],
    };
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });

    const tracks = await source.search({ tmdbId: 1 });

    expect(tracks.map((t) => t.language)).toEqual(["fr", "de", "en"]);
    expect(tracks.every((t) => t.kind === TrackKind.Manual)).toBe(true);
    expect(source.getTracks()).toEqual(tracks);
  });

  it("assigns consecutive trackIds starting at trackIdRangeStart", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = {
      success: true,
      results: [
        { fileId: 1, rating: 1 },
        { fileId: 2, rating: 2 },
      ],
    };
    const source = new OpenSubtitlesSource({
      sourceId: SOURCE_ID,
      gateway,
      trackIdRangeStart: 500,
    });

    const tracks = await source.search({ tmdbId: 1 });

    expect(tracks.map((t) => t.trackId)).toEqual([500, 501]);
  });

  it("clears the track list when the search returns no results", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = { success: true, results: [] };
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });

    const tracks = await source.search({ tmdbId: 1 });

    expect(tracks).toEqual([]);
    expect(source.getTracks()).toEqual([]);
  });

  it("clears the track list when the search fails", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = { success: false, error: "boom" };
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });

    const tracks = await source.search({ tmdbId: 1 });

    expect(tracks).toEqual([]);
  });

  it("notifies onTracksChanged after a search", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = {
      success: true,
      results: [{ fileId: 1, rating: 1 }],
    };
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });
    const listener = vi.fn();
    source.onTracksChanged(listener);

    await source.search({ tmdbId: 1 });

    expect(listener).toHaveBeenCalledWith(source.getTracks());
  });

  it("downloads and emits canonical cues for the selected track", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = {
      success: true,
      results: [{ fileId: 42, rating: 1 }],
    };
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });
    const [track] = await source.search({ tmdbId: 1 });
    const cuesListener = vi.fn();
    source.onCuesChanged(track.trackId, cuesListener);
    gateway.downloadResultByFileId.set(42, {
      success: true,
      content: "1\n00:00:01,000 --> 00:00:02,000\nHello",
    });

    source.selectTrack(track.trackId);
    await flushMicrotasks();

    expect(cuesListener).toHaveBeenCalledWith([
      { startSeconds: 1, endSeconds: 2, text: "Hello" },
    ]);
  });

  it("does not re-download an already-fetched track", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = {
      success: true,
      results: [{ fileId: 42, rating: 1 }],
    };
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });
    const [track] = await source.search({ tmdbId: 1 });
    gateway.downloadResultByFileId.set(42, {
      success: true,
      content: "1\n00:00:01,000 --> 00:00:02,000\nHello",
    });

    source.selectTrack(track.trackId);
    await flushMicrotasks();
    source.selectTrack(null);
    source.selectTrack(track.trackId);
    await flushMicrotasks();

    expect(gateway.downloadCalls).toEqual([42]);
  });

  it("warns and emits nothing when the download fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = {
      success: true,
      results: [{ fileId: 42, rating: 1 }],
    };
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });
    const [track] = await source.search({ tmdbId: 1 });
    const cuesListener = vi.fn();
    source.onCuesChanged(track.trackId, cuesListener);
    gateway.downloadResultByFileId.set(42, {
      success: false,
      error: "quota exceeded",
    });

    source.selectTrack(track.trackId);
    await flushMicrotasks();

    expect(cuesListener).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("ignores a download that resolves after a different track was selected", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = {
      success: true,
      results: [
        { fileId: 1, rating: 2 },
        { fileId: 2, rating: 1 },
      ],
    };
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });
    const [trackA, trackB] = await source.search({ tmdbId: 1 });
    gateway.downloadResultByFileId.set(1, {
      success: true,
      content: "1\n00:00:01,000 --> 00:00:02,000\nStale",
    });
    gateway.downloadResultByFileId.set(2, {
      success: true,
      content: "1\n00:00:05,000 --> 00:00:06,000\nCurrent",
    });
    const staleListener = vi.fn();
    source.onCuesChanged(trackA.trackId, staleListener);

    source.selectTrack(trackA.trackId);
    source.selectTrack(trackB.trackId);
    await flushMicrotasks();

    expect(staleListener).not.toHaveBeenCalled();
  });

  it("dispose() clears track and cue subscriptions", async () => {
    const gateway = new MockSubtitleGateway();
    gateway.searchResult = {
      success: true,
      results: [{ fileId: 1, rating: 1 }],
    };
    const source = new OpenSubtitlesSource({ sourceId: SOURCE_ID, gateway });
    const [track] = await source.search({ tmdbId: 1 });
    const trackListener = vi.fn();
    const cueListener = vi.fn();
    source.onTracksChanged(trackListener);
    source.onCuesChanged(track.trackId, cueListener);

    source.dispose();
    await source.search({ tmdbId: 1 });

    expect(trackListener).not.toHaveBeenCalled();
  });
});
