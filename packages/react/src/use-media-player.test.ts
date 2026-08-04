import React, { useRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  asAudioTrackId,
  asSubtitleSourceId,
  asSubtitleTrackId,
  HlsNativeSubtitleSource,
  TrackKind,
} from "@electron-media/core";

import { useMediaPlayer } from "./use-media-player.js";
import { MockHlsAdapter } from "./testing/mock-hls-adapter.js";

import type { UseMediaPlayerOptions, UseMediaPlayerResult } from "./use-media-player.js";

// JSX isn't configured for this package's build (a hook library ships no
// components), so the test harness component is built via createElement
// directly rather than adding a JSX toolchain just for this one file.
function TestComponent(props: {
  sourceUrl: string | null;
  options: UseMediaPlayerOptions;
  onResult: (result: UseMediaPlayerResult) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const result = useMediaPlayer(videoRef, props.sourceUrl, props.options);
  props.onResult(result);
  return React.createElement("video", { ref: videoRef, "data-testid": "video" });
}

function setup(initialSourceUrl: string | null, options: UseMediaPlayerOptions) {
  let latest!: UseMediaPlayerResult;
  const onResult = (result: UseMediaPlayerResult) => {
    latest = result;
  };

  const utils = render(
    React.createElement(TestComponent, { sourceUrl: initialSourceUrl, options, onResult })
  );

  return {
    get result() {
      return latest;
    },
    rerenderWith: (sourceUrl: string | null) =>
      utils.rerender(React.createElement(TestComponent, { sourceUrl, options, onResult })),
    unmount: utils.unmount,
  };
}

describe("useMediaPlayer", () => {
  afterEach(() => {
    cleanup();
  });

  it("attaches the adapter and calls loadSource exactly once on mount — regression test for the [videoRef.current] effect-dependency bug", () => {
    // Previously the player-construction effect depended on
    // [videoRef.current], which reads `null` on the first render and only
    // becomes the real node on the next one — causing a spurious second
    // effect run that destroyed and rebuilt the player right after the
    // sourceUrl effect had already called loadSource() on the first (now
    // dead) instance. Both counts below must be exactly 1, not 2.
    const adapter = new MockHlsAdapter();
    setup("https://example.com/master.m3u8", { hlsAdapter: adapter });

    expect(adapter.attachCount).toBe(1);
    expect(adapter.loadedUrls).toEqual(["https://example.com/master.m3u8"]);
  });

  it("re-rendering the host component without prop changes does not recreate the player", () => {
    const adapter = new MockHlsAdapter();
    const harness = setup("https://example.com/master.m3u8", { hlsAdapter: adapter });

    harness.rerenderWith("https://example.com/master.m3u8");
    harness.rerenderWith("https://example.com/master.m3u8");

    expect(adapter.attachCount).toBe(1);
    expect(adapter.loadedUrls).toEqual(["https://example.com/master.m3u8"]);
  });

  it("calling loadSource again when sourceUrl changes after mount", () => {
    const adapter = new MockHlsAdapter();
    const harness = setup("https://example.com/a.m3u8", { hlsAdapter: adapter });

    harness.rerenderWith("https://example.com/b.m3u8");

    expect(adapter.loadedUrls).toEqual([
      "https://example.com/a.m3u8",
      "https://example.com/b.m3u8",
    ]);
    // The player itself is not torn down for a source change — only one
    // MediaPlayer should ever have been constructed.
    expect(adapter.attachCount).toBe(1);
  });

  it("does not call loadSource when mounted with a null sourceUrl", () => {
    const adapter = new MockHlsAdapter();
    setup(null, { hlsAdapter: adapter });

    expect(adapter.loadedUrls).toEqual([]);
  });

  it("destroys the adapter exactly once on unmount", () => {
    const adapter = new MockHlsAdapter();
    const harness = setup("https://example.com/master.m3u8", { hlsAdapter: adapter });

    harness.unmount();

    expect(adapter.destroyCount).toBe(1);
  });

  it("reflects audio tracks reported by the adapter, and selectAudioTrack proxies to it", () => {
    const adapter = new MockHlsAdapter();
    const harness = setup("https://example.com/master.m3u8", { hlsAdapter: adapter });

    const tracks = [
      { trackId: asAudioTrackId(0), displayName: "English", language: "en", kind: TrackKind.Default },
      { trackId: asAudioTrackId(1), displayName: "Spanish", language: "es", kind: TrackKind.Manual },
    ];
    act(() => {
      adapter.audioTracks = tracks;
      adapter.emit("audioTracksChanged", { tracks });
    });

    expect(harness.result.audioTracks).toEqual(tracks);
    // AudioTrackController auto-selects the "default" track on first list update.
    expect(harness.result.selectedAudioTrack).toEqual(tracks[0]);

    act(() => harness.result.selectAudioTrack(asAudioTrackId(1)));

    expect(adapter.selectedAudioTrackId).toBe(1);
    expect(harness.result.selectedAudioTrack).toEqual(tracks[1]);
  });

  it("reflects subtitle tracks and proxies selectSubtitleTrack/setSubtitleDelay", () => {
    const adapter = new MockHlsAdapter();
    const sourceId = asSubtitleSourceId("hls-native");
    // Subtitle tracks flow through the registered ISubtitleSource(s), not
    // directly from the adapter's own event — HlsNativeSubtitleSource is
    // the one shipped source that just forwards the adapter's tracks.
    // subtitleRenderer is stubbed because jsdom doesn't implement
    // HTMLMediaElement.addTextTrack(), which the default renderer needs —
    // the same workaround core's own subtitle-controller.test.ts uses.
    const harness = setup("https://example.com/master.m3u8", {
      hlsAdapter: adapter,
      subtitleSources: [new HlsNativeSubtitleSource({ sourceId, adapter })],
      subtitleRenderer: { render: () => {}, clear: () => {} },
    });

    const tracks = [
      { trackId: asSubtitleTrackId(0), displayName: "English", language: "en", kind: TrackKind.Default, sourceId },
    ];
    act(() => {
      adapter.subtitleTracks = tracks;
      adapter.emit("subtitleTracksChanged", { tracks });
    });

    expect(harness.result.subtitleTracks).toEqual(tracks);
    expect(harness.result.selectedSubtitle).toBeNull();

    act(() => harness.result.selectSubtitleTrack(asSubtitleTrackId(0)));
    expect(adapter.selectedSubtitleTrackId).toBe(0);

    // setSubtitleDelay must not throw even with no track selected on a
    // fresh SubtitleController — proxying is a plain passthrough call.
    expect(() => act(() => harness.result.setSubtitleDelay(2))).not.toThrow();
  });

  it("isLoading is true immediately after loadSource and false once the adapter reports the manifest parsed", () => {
    const adapter = new MockHlsAdapter();
    const harness = setup("https://example.com/master.m3u8", { hlsAdapter: adapter });

    expect(harness.result.isLoading).toBe(true);

    act(() => adapter.emit("manifestParsed", { durationSeconds: 42 }));

    expect(harness.result.isLoading).toBe(false);
  });

  it("surfaces a fatal adapter error and clears it again on the next loadSource", () => {
    const adapter = new MockHlsAdapter();
    const harness = setup("https://example.com/a.m3u8", { hlsAdapter: adapter });

    act(() => adapter.emit("fatalError", { code: "networkError", cause: undefined }));

    expect(harness.result.error).toEqual({ code: "networkError", fatal: true, cause: undefined });

    harness.rerenderWith("https://example.com/b.m3u8");

    expect(harness.result.error).toBeNull();
  });
});
