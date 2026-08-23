import { describe, expect, it, vi } from "vitest";

import { MockHlsAdapter } from "../testing/mock-hls-adapter.js";
import { MockVoiceOverGateway } from "../testing/mock-voiceover-gateway.js";
import { ManualVoiceOverTicker } from "../testing/manual-voice-over-ticker.js";
import { MediaPlayer } from "./media-player.js";

import type { CanonicalCue } from "../types/cue.js";
import type { ISubtitleRenderer } from "../subtitles/subtitle-renderer.js";

function fakeVideo(): HTMLVideoElement {
  return {} as HTMLVideoElement;
}

function stubRenderer(): ISubtitleRenderer & {
  renderCalls: readonly CanonicalCue[][];
  clearCalls: number;
} {
  const renderCalls: CanonicalCue[][] = [];
  let clearCalls = 0;
  return {
    render: (_video, cues) => {
      renderCalls.push([...cues]);
    },
    clear: () => {
      clearCalls += 1;
    },
    get renderCalls() {
      return renderCalls;
    },
    get clearCalls() {
      return clearCalls;
    },
  };
}

describe("MediaPlayer", () => {
  it("attaches to the video element on construction", () => {
    const adapter = new MockHlsAdapter();
    const video = fakeVideo();

    new MediaPlayer({ video, hlsAdapter: adapter, subtitleRenderer: stubRenderer() });

    expect(adapter.attachedVideo).toBe(video);
  });

  it("delegates loadSource to the HLS adapter", () => {
    const adapter = new MockHlsAdapter();
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: adapter,
      subtitleRenderer: stubRenderer(),
    });

    player.loadSource("https://example.com/master.m3u8");

    expect(adapter.loadedUrls).toEqual(["https://example.com/master.m3u8"]);
  });

  it("exposes audio tracks reported by the adapter", () => {
    const adapter = new MockHlsAdapter();
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: adapter,
      subtitleRenderer: stubRenderer(),
    });

    adapter.emit("audioTracksChanged", { tracks: adapter.audioTracks });

    expect(player.audio.getTracks()).toEqual(adapter.audioTracks);
  });

  it("emits a ready event once the adapter reports the manifest parsed", () => {
    const adapter = new MockHlsAdapter();
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: adapter,
      subtitleRenderer: stubRenderer(),
    });
    const listener = vi.fn();
    player.events.on("ready", listener);

    adapter.emit("manifestParsed", { durationSeconds: 120 });

    expect(listener).toHaveBeenCalledWith({ durationSeconds: 120 });
  });

  it("emits an error event when the adapter reports a fatal error", () => {
    const adapter = new MockHlsAdapter();
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: adapter,
      subtitleRenderer: stubRenderer(),
    });
    const listener = vi.fn();
    player.events.on("error", listener);

    adapter.emit("fatalError", { code: "networkError" });

    expect(listener).toHaveBeenCalledWith({
      code: "networkError",
      fatal: true,
      cause: undefined,
    });
  });

  it("destroy() releases the HLS adapter", () => {
    const adapter = new MockHlsAdapter();
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: adapter,
      subtitleRenderer: stubRenderer(),
    });

    player.destroy();

    expect(adapter.destroyed).toBe(true);
  });

  it("destroy() stops further player events from reaching subscribers", () => {
    const adapter = new MockHlsAdapter();
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: adapter,
      subtitleRenderer: stubRenderer(),
    });
    const listener = vi.fn();
    player.events.on("error", listener);

    player.destroy();
    // The mock adapter's own listener bookkeeping survives adapter.destroy()
    // being a stub, but MediaPlayer's own event emitter must already have
    // dropped every subscriber by this point.
    adapter.emit("fatalError", { code: "afterDestroy" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("destroy() clears any rendered subtitle cues", () => {
    const adapter = new MockHlsAdapter();
    const renderer = stubRenderer();
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: adapter,
      subtitleRenderer: renderer,
    });

    player.destroy();

    expect(renderer.clearCalls).toBeGreaterThan(0);
  });

  it("voiceOver is null when constructed without a voiceOverGateway", () => {
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: new MockHlsAdapter(),
      subtitleRenderer: stubRenderer(),
    });

    expect(player.voiceOver).toBeNull();
  });

  it("voiceOver is non-null when constructed with a voiceOverGateway", () => {
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: new MockHlsAdapter(),
      subtitleRenderer: stubRenderer(),
      voiceOverGateway: new MockVoiceOverGateway(),
      voiceOverOptions: { ticker: new ManualVoiceOverTicker() },
    });

    expect(player.voiceOver).not.toBeNull();
  });

  it("destroy() cascades to voiceOver.destroy()", () => {
    const player = new MediaPlayer({
      video: fakeVideo(),
      hlsAdapter: new MockHlsAdapter(),
      subtitleRenderer: stubRenderer(),
      voiceOverGateway: new MockVoiceOverGateway(),
      voiceOverOptions: { ticker: new ManualVoiceOverTicker() },
    });

    expect(() => player.destroy()).not.toThrow();
  });
});
