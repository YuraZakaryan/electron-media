import { describe, expect, it, vi } from "vitest";

import { asSubtitleSourceId, asSubtitleTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { MockHlsAdapter } from "../testing/mock-hls-adapter.js";
import { HlsNativeSubtitleSource } from "./hls-native-subtitle-source.js";

const SOURCE_ID = asSubtitleSourceId("hls-native");

describe("HlsNativeSubtitleSource", () => {
  it("getTracks() delegates straight to the adapter", () => {
    const adapter = new MockHlsAdapter();
    adapter.subtitleTracks = [
      { trackId: asSubtitleTrackId(0), displayName: "English", kind: TrackKind.Default, sourceId: SOURCE_ID },
    ];
    const source = new HlsNativeSubtitleSource({ sourceId: SOURCE_ID, adapter });

    expect(source.getTracks()).toBe(adapter.subtitleTracks);
  });

  it("selectTrack() delegates to adapter.setSubtitleTrack()", () => {
    const adapter = new MockHlsAdapter();
    const source = new HlsNativeSubtitleSource({ sourceId: SOURCE_ID, adapter });

    source.selectTrack(asSubtitleTrackId(2));
    expect(adapter.selectedSubtitleTrackId).toBe(2);

    source.selectTrack(null);
    expect(adapter.selectedSubtitleTrackId).toBeNull();
  });

  it("onTracksChanged() forwards the adapter's subtitleTracksChanged event", () => {
    const adapter = new MockHlsAdapter();
    const source = new HlsNativeSubtitleSource({ sourceId: SOURCE_ID, adapter });
    const listener = vi.fn();
    source.onTracksChanged(listener);

    const tracks = [
      { trackId: asSubtitleTrackId(0), displayName: "English", kind: TrackKind.Default, sourceId: SOURCE_ID },
    ];
    adapter.emit("subtitleTracksChanged", { tracks });

    expect(listener).toHaveBeenCalledWith(tracks);
  });

  it("onCuesChanged() forwards the adapter's subtitleCuesChanged event for the matching trackId", () => {
    const adapter = new MockHlsAdapter();
    const source = new HlsNativeSubtitleSource({ sourceId: SOURCE_ID, adapter });
    const listener = vi.fn();
    source.onCuesChanged(asSubtitleTrackId(0), listener);

    const cues = [{ startSeconds: 0, endSeconds: 1, text: "hello" }];
    adapter.emit("subtitleCuesChanged", { trackId: asSubtitleTrackId(0), cues });
    expect(listener).toHaveBeenCalledWith(cues);

    // A different track's cues must not leak into this subscription.
    listener.mockClear();
    adapter.emit("subtitleCuesChanged", { trackId: asSubtitleTrackId(1), cues });
    expect(listener).not.toHaveBeenCalled();
  });

  it("onCuesChanged()'s unsubscribe handle stops forwarding further events", () => {
    const adapter = new MockHlsAdapter();
    const source = new HlsNativeSubtitleSource({ sourceId: SOURCE_ID, adapter });
    const listener = vi.fn();
    const unsubscribe = source.onCuesChanged(asSubtitleTrackId(0), listener);

    unsubscribe();
    adapter.emit("subtitleCuesChanged", {
      trackId: asSubtitleTrackId(0),
      cues: [{ startSeconds: 0, endSeconds: 1, text: "hello" }],
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose() turns subtitles off via the adapter", () => {
    const adapter = new MockHlsAdapter();
    const source = new HlsNativeSubtitleSource({ sourceId: SOURCE_ID, adapter });

    source.selectTrack(asSubtitleTrackId(1));
    source.dispose();

    expect(adapter.selectedSubtitleTrackId).toBeNull();
  });
});
