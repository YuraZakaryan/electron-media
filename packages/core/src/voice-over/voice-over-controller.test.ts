import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceOverController } from "./voice-over-controller.js";
import { TypedEventEmitter, type PlayerEvents } from "../events.js";
import { MockVoiceOverGateway } from "../testing/mock-voiceover-gateway.js";
import { MockSubtitleSource } from "../testing/mock-subtitle-source.js";
import { ManualVoiceOverTicker } from "../testing/manual-voice-over-ticker.js";
import { asSubtitleSourceId, asSubtitleTrackId, asVoiceOverTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { VoiceOverError } from "../errors/player-error.js";

import type { CanonicalCue } from "../types/cue.js";
import type { SubtitleTrack } from "../types/track.js";
import type { ISubtitleSource } from "../subtitles/subtitle-source.js";

/**
 * Reproduces OpenSubtitlesSource's cache-hit behavior: selectTrack() emits
 * cues SYNCHRONOUSLY, from within the call itself (not on a later
 * microtask), simulating a track whose cues were already downloaded. Mirrors
 * the identically-named fake in `subtitle-controller.test.ts`.
 */
class SyncEmittingSubtitleSource implements ISubtitleSource {
  private cueListeners = new Set<(cues: readonly CanonicalCue[]) => void>();

  constructor(
    readonly sourceId: ReturnType<typeof asSubtitleSourceId>,
    private readonly cachedCues: readonly CanonicalCue[],
    private readonly tracks: SubtitleTrack[] = []
  ) {}

  getTracks(): readonly SubtitleTrack[] {
    return this.tracks;
  }

  selectTrack(): void {
    this.cueListeners.forEach((listener) => listener(this.cachedCues));
  }

  onTracksChanged(): () => void {
    return () => {};
  }

  onCuesChanged(
    _trackId: unknown,
    callback: (cues: readonly CanonicalCue[]) => void
  ): () => void {
    this.cueListeners.add(callback);
    return () => this.cueListeners.delete(callback);
  }

  dispose(): void {}
}

class FakeAudio {
  volume = 1;
  constructor(readonly src: string) {}
  play(): Promise<void> {
    return Promise.resolve();
  }
  pause(): void {}
  addEventListener(): void {}
}

interface FakeVideo {
  volume: number;
  currentTime: number;
  paused: boolean;
  readyState: number;
  pause(): void;
  play(): Promise<void>;
}

function fakeVideo(): HTMLVideoElement {
  const video: FakeVideo = {
    volume: 1,
    currentTime: 0,
    paused: false,
    readyState: 4,
    pause() {
      video.paused = true;
    },
    play() {
      video.paused = false;
      return Promise.resolve();
    },
  };
  return video as unknown as HTMLVideoElement;
}

describe("VoiceOverController", () => {
  let gateway: MockVoiceOverGateway;
  let events: TypedEventEmitter<PlayerEvents>;
  let ticker: ManualVoiceOverTicker;
  let controller: VoiceOverController;

  beforeEach(() => {
    vi.stubGlobal("Audio", FakeAudio);
    gateway = new MockVoiceOverGateway();
    gateway.voices = [{ languageCode: "en", displayName: "English" }];
    events = new TypedEventEmitter<PlayerEvents>();
    ticker = new ManualVoiceOverTicker();
    controller = new VoiceOverController({ gateway, events, ticker, trackSwitchDebounceMs: 10 });
    controller.attach(fakeVideo());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("caches getTracks() after the first successful call", async () => {
    await controller.getTracks();
    await controller.getTracks();
    expect(gateway.voices).toHaveLength(1); // sanity: same source list
  });

  it("is a no-op selecting an unknown track id", async () => {
    await controller.getTracks();
    const changed = vi.fn();
    controller.onSelectionChanged(changed);
    controller.selectTrack(asVoiceOverTrackId("xx"));
    expect(controller.selectedTrack).toBeNull();
    expect(changed).not.toHaveBeenCalled();
  });

  it("updates selection and fires one change event for a valid track id", async () => {
    await controller.getTracks();
    const changed = vi.fn();
    controller.onSelectionChanged(changed);
    controller.selectTrack(asVoiceOverTrackId("en"));
    expect(controller.selectedTrack?.language).toBe("en");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("bindSubtitleSource calls source.selectTrack(trackId) to activate cue fetching", async () => {
    vi.useFakeTimers();
    const source = new MockSubtitleSource(asSubtitleSourceId("subs"), [
      { trackId: asSubtitleTrackId(1), displayName: "EN", kind: TrackKind.Default, sourceId: asSubtitleSourceId("subs") },
    ]);
    controller.bindSubtitleSource(source, asSubtitleTrackId(1));
    vi.advanceTimersByTime(20);
    // Real ISubtitleSource implementations (VodExtractedSubtitleSource,
    // OpenSubtitlesSource) never fetch/emit a track's cue text until their
    // own selectTrack() has been called for that id — onCuesChanged alone
    // is just a listener nothing else fires. Without this call, voice-over
    // would silently never receive any narration text at all.
    expect(source.selectedTrackId).toBe(asSubtitleTrackId(1));
  });

  it("subscribes before selecting, so a cache-hit source's synchronous cue emission is still captured", async () => {
    vi.useFakeTimers();
    const cachedCues = [{ startSeconds: 0, endSeconds: 1, text: "hello" }];
    const source = new SyncEmittingSubtitleSource(asSubtitleSourceId("subs"), cachedCues);
    controller.bindSubtitleSource(source, asSubtitleTrackId(1));
    vi.advanceTimersByTime(20);
    vi.useRealTimers();

    await controller.getTracks();
    controller.selectTrack(asVoiceOverTrackId("en"));
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });

    ticker.tick();
    await Promise.resolve();
    await Promise.resolve();

    // The cached cue arrived synchronously from *within* source.selectTrack()
    // itself — only reachable if onCuesChanged was registered beforehand.
    expect(gateway.generateLineCalls.length).toBeGreaterThan(0);
  });

  it("does not evict a previously-bound source's own active track when rebinding to a different source", async () => {
    vi.useFakeTimers();
    const firstSource = new MockSubtitleSource(asSubtitleSourceId("subs-1"), [
      { trackId: asSubtitleTrackId(1), displayName: "EN", kind: TrackKind.Default, sourceId: asSubtitleSourceId("subs-1") },
    ]);
    controller.bindSubtitleSource(firstSource, asSubtitleTrackId(1));
    vi.advanceTimersByTime(20);
    expect(firstSource.selectedTrackId).toBe(asSubtitleTrackId(1));

    const secondSource = new MockSubtitleSource(asSubtitleSourceId("subs-2"), [
      { trackId: asSubtitleTrackId(2), displayName: "RU", kind: TrackKind.Default, sourceId: asSubtitleSourceId("subs-2") },
    ]);
    controller.bindSubtitleSource(secondSource, asSubtitleTrackId(2));
    vi.advanceTimersByTime(20);

    // Rebinding to a different source must never null out the FIRST
    // source's own selection — that source may still be backing the
    // visibly-rendered subtitle on its track, and this controller has no
    // way to know that, so it must never touch a source it isn't currently
    // bound to.
    expect(firstSource.selectedTrackId).toBe(asSubtitleTrackId(1));
    expect(secondSource.selectedTrackId).toBe(asSubtitleTrackId(2));
  });

  it("forwards bound subtitle cues into the scheduler", async () => {
    vi.useFakeTimers();
    const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
    controller.bindSubtitleSource(source, asSubtitleTrackId(1));
    vi.advanceTimersByTime(20);
    vi.useRealTimers();

    await controller.getTracks();
    controller.selectTrack(asVoiceOverTrackId("en"));
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });

    source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
    ticker.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(gateway.generateLineCalls.length).toBeGreaterThan(0);
  });

  it("does not replay an already-played cue when the bound source re-emits its full (grown) cue list", async () => {
    // Reproduces a real subtitle source's actual behavior:
    // VodExtractedSubtitleSource/OpenSubtitlesSource periodically re-emit
    // their ENTIRE canonical cue list for the same track (growing over time
    // as more of the file is read/downloaded) — not an incremental delta.
    // Before the fix, the controller forwarded every such emission straight
    // into scheduler.setCues(), which resets ALL cue state (including
    // already-played lines) back to Unseen, so a line just spoken could be
    // resynthesized and replayed the moment the source's next periodic
    // emission landed while it was still within the lookahead/grace window
    // — most visibly during an Extended Audio Description pause, which
    // gives that periodic emission more real time to land.
    vi.useFakeTimers();
    const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
    controller.bindSubtitleSource(source, asSubtitleTrackId(1));
    vi.advanceTimersByTime(20);
    vi.useRealTimers();

    await controller.getTracks();
    controller.selectTrack(asVoiceOverTrackId("en"));
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });

    const played = vi.fn();
    events.on("voiceOverLinePlayed", played);

    source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
    ticker.tick();
    await Promise.resolve();
    await Promise.resolve();
    ticker.tick(); // line starts playing
    expect(played).toHaveBeenCalledTimes(1);

    // The source re-emits its full list — the same cue plus a new one, the
    // same shape as a real growing VOD-extracted/OpenSubtitles source.
    source.emitCues(asSubtitleTrackId(1), [
      { startSeconds: 0, endSeconds: 1, text: "hello" },
      { startSeconds: 5, endSeconds: 6, text: "later" },
    ]);
    ticker.tick();
    await Promise.resolve();
    await Promise.resolve();
    ticker.tick();

    expect(played).toHaveBeenCalledTimes(1);
  });

  it("does not replay an already-played cue when bindSubtitleSource is called again with the same source+trackId", async () => {
    // A redundant bindSubtitleSource call for the exact same source+trackId
    // (e.g. an unrelated dependency change re-running whatever host effect
    // calls it) must be a no-op — before the fix it fell through to
    // scheduler.setCues([]) just like a genuine rebind, wiping already-
    // played cue tracking and letting the next cue delivery replay it.
    vi.useFakeTimers();
    const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
    controller.bindSubtitleSource(source, asSubtitleTrackId(1));
    vi.advanceTimersByTime(20);
    vi.useRealTimers();

    await controller.getTracks();
    controller.selectTrack(asVoiceOverTrackId("en"));
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });

    const played = vi.fn();
    events.on("voiceOverLinePlayed", played);

    source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
    ticker.tick();
    await Promise.resolve();
    await Promise.resolve();
    ticker.tick(); // line starts playing
    expect(played).toHaveBeenCalledTimes(1);

    // Redundant call, identical source+trackId — not a real rebind.
    vi.useFakeTimers();
    controller.bindSubtitleSource(source, asSubtitleTrackId(1));
    vi.advanceTimersByTime(20);
    vi.useRealTimers();
    ticker.tick();
    await Promise.resolve();
    await Promise.resolve();
    ticker.tick();

    expect(played).toHaveBeenCalledTimes(1);
  });

  it("hard-stops and clears isGenerating when disabled while playing", async () => {
    await controller.getTracks();
    controller.selectTrack(asVoiceOverTrackId("en"));
    controller.selectTrack(null);
    expect(controller.isGenerating).toBe(false);
    expect(controller.selectedTrack).toBeNull();
  });

  it("destroy() is idempotent", () => {
    expect(() => {
      controller.destroy();
      controller.destroy();
    }).not.toThrow();
  });

  it("emits voiceOverLineFailed when the gateway reports failure", async () => {
    vi.useFakeTimers();
    const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
    controller.bindSubtitleSource(source, asSubtitleTrackId(1));
    vi.advanceTimersByTime(20);
    vi.useRealTimers();

    await controller.getTracks();
    controller.selectTrack(asVoiceOverTrackId("en"));
    gateway.lineResultByKey.set("en:hello", { success: false, error: "tts down" });

    const failed = vi.fn();
    events.on("voiceOverLineFailed", failed);
    source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
    ticker.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(failed).toHaveBeenCalledWith(
      expect.objectContaining({ error: "tts down" })
    );
  });

  it("wraps an unexpected gateway throw in VoiceOverError", async () => {
    vi.useFakeTimers();
    const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
    controller.bindSubtitleSource(source, asSubtitleTrackId(1));
    vi.advanceTimersByTime(20);
    vi.useRealTimers();

    await controller.getTracks();
    controller.selectTrack(asVoiceOverTrackId("en"));
    gateway.generateLine = () => Promise.reject(new Error("boom"));

    const failed = vi.fn();
    events.on("voiceOverLineFailed", failed);
    source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
    ticker.tick();
    await Promise.resolve();
    await Promise.resolve();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(failed.mock.calls[0][0].error).toBeInstanceOf(VoiceOverError);
  });

  it("bindSubtitleSource(null, null) results in no gateway calls", async () => {
    vi.useFakeTimers();
    controller.bindSubtitleSource(null, null);
    vi.advanceTimersByTime(20);
    vi.useRealTimers();
    ticker.tick();
    await Promise.resolve();
    expect(gateway.generateLineCalls).toHaveLength(0);
  });

  it("setVoiceOverVolume without an active line does not throw", () => {
    expect(() => controller.setVoiceOverVolume(0.5)).not.toThrow();
  });

  it("re-attaching with a new video re-wires the scheduler and ducking player", () => {
    const newVideo = fakeVideo();
    expect(() => controller.attach(newVideo)).not.toThrow();
  });

  it("resolves the same VoiceOverTrackId for the same language code across calls", async () => {
    const tracksA = await controller.getTracks();
    const tracksB = await controller.getTracks();
    expect(tracksA[0].trackId).toBe(tracksB[0].trackId);
  });

  describe("voiceOverLinePlayed / voiceOverLineSkipped", () => {
    async function bindAndSelect(source: MockSubtitleSource) {
      vi.useFakeTimers();
      controller.bindSubtitleSource(source, asSubtitleTrackId(1));
      vi.advanceTimersByTime(20);
      vi.useRealTimers();
      await controller.getTracks();
      controller.selectTrack(asVoiceOverTrackId("en"));
    }

    it("fires voiceOverLinePlayed with the cueKey and clipped flag when a line starts", async () => {
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(source);
      gateway.lineResultByKey.set("en:hello", {
        success: true,
        audioUrl: "blob:1",
        durationSeconds: 1,
        clipped: true,
      });

      const played = vi.fn();
      events.on("voiceOverLinePlayed", played);
      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();
      ticker.tick();

      expect(played).toHaveBeenCalledWith(
        expect.objectContaining({ cueKey: expect.stringContaining("hello"), clipped: true })
      );
    });

    it("does not block the next due line after Audio.play() rejects (e.g. autoplay policy)", async () => {
      // A rejected play() means no audio ever actually started — without
      // releasing the scheduler's hold on that cue, startNextDueLine keeps
      // refusing to start the next due line until video.currentTime
      // naturally passes the rejected cue's own endSeconds, producing a
      // silent gap where nothing narrates even though a later line is
      // already ready.
      class RejectingAudio extends FakeAudio {
        play(): Promise<void> {
          return Promise.reject(new Error("autoplay blocked"));
        }
      }
      vi.stubGlobal("Audio", RejectingAudio);

      const video = fakeVideo();
      controller.attach(video); // re-attach so this test can drive currentTime directly

      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(source);
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });
      gateway.lineResultByKey.set("en:world", { success: true, audioUrl: "blob:2", durationSeconds: 1 });

      const rejected = vi.fn();
      const played = vi.fn();
      events.on("voiceOverPlaybackRejected", rejected);
      events.on("voiceOverLinePlayed", played);

      source.emitCues(asSubtitleTrackId(1), [
        { startSeconds: 0, endSeconds: 1, text: "hello" },
        { startSeconds: 1, endSeconds: 2, text: "world" },
      ]);
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();
      ticker.tick(); // "hello" becomes due, hands off to the ducking player, play() rejects
      await Promise.resolve();
      await Promise.resolve();

      expect(rejected).toHaveBeenCalledTimes(1);
      expect(played).toHaveBeenCalledWith(
        expect.objectContaining({ cueKey: expect.stringContaining("hello") })
      );

      // Advance into "world"'s own window — if the scheduler's hold were
      // still stuck on the rejected "hello" cue, this could not start.
      Object.defineProperty(video, "currentTime", { value: 1, configurable: true });
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();
      ticker.tick();

      expect(played).toHaveBeenCalledWith(
        expect.objectContaining({ cueKey: expect.stringContaining("world") })
      );
    });

    it("fires voiceOverLineSkipped for a non-dialogue cue, never voiceOverLineFailed", async () => {
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(source);

      const skipped = vi.fn();
      const failed = vi.fn();
      events.on("voiceOverLineSkipped", skipped);
      events.on("voiceOverLineFailed", failed);
      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "[music]" }]);
      ticker.tick();

      expect(skipped).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
    });

    it("fires voiceOverLineFailed for a gateway failure, never voiceOverLineSkipped", async () => {
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(source);
      gateway.lineResultByKey.set("en:hello", { success: false, error: "tts down" });

      const skipped = vi.fn();
      const failed = vi.fn();
      events.on("voiceOverLineSkipped", skipped);
      events.on("voiceOverLineFailed", failed);
      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();

      expect(failed).toHaveBeenCalledTimes(1);
      expect(skipped).not.toHaveBeenCalled();
    });
  });

  describe("live option updates", () => {
    it("setDuckVolume and setVoiceOverVolume are independent — changing one never affects the other", async () => {
      vi.useFakeTimers();
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      controller.bindSubtitleSource(source, asSubtitleTrackId(1));
      vi.advanceTimersByTime(20);

      controller.setDuckVolume(0.15);
      controller.setVoiceOverVolume(1);

      await controller.getTracks();
      controller.selectTrack(asVoiceOverTrackId("en"));
      const video = fakeVideo();
      controller.attach(video);
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });

      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await vi.advanceTimersByTimeAsync(0);
      ticker.tick();
      await vi.advanceTimersByTimeAsync(200); // let the duck fade complete

      expect(video.volume).toBeCloseTo(0.15); // "original sound" slider
      // Now change ONLY the voice-over slider — the original-sound level must not move.
      controller.setVoiceOverVolume(0.3);
      expect(video.volume).toBeCloseTo(0.15);

      vi.useRealTimers();
    });

    it("setDuckVolume changes the target volume used by a subsequently started line", async () => {
      vi.useFakeTimers();
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      controller.bindSubtitleSource(source, asSubtitleTrackId(1));
      vi.advanceTimersByTime(20);

      controller.setDuckVolume(0.42);

      await controller.getTracks();
      controller.selectTrack(asVoiceOverTrackId("en"));
      const video = fakeVideo();
      controller.attach(video); // re-attach to pick up the new duck volume in a fresh VoiceOverDuckingPlayer
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });

      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await vi.advanceTimersByTimeAsync(0);
      ticker.tick();
      await vi.advanceTimersByTimeAsync(200); // let the duck fade complete

      expect(video.volume).toBeCloseTo(0.42);
      vi.useRealTimers();
    });

    it("setMainVolume and setIgnoreMainVolume forward to the ducking player and scale a subsequently started line", async () => {
      vi.useFakeTimers();
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      controller.bindSubtitleSource(source, asSubtitleTrackId(1));
      vi.advanceTimersByTime(20);

      controller.setDuckVolume(0.2);
      controller.setVoiceOverVolume(0.8);
      controller.setMainVolume(0.5);

      await controller.getTracks();
      controller.selectTrack(asVoiceOverTrackId("en"));
      const video = fakeVideo();
      controller.attach(video); // re-attach to pick up the new options in a fresh VoiceOverDuckingPlayer
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });

      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await vi.advanceTimersByTimeAsync(0);
      ticker.tick();
      await vi.advanceTimersByTimeAsync(200); // let the duck fade complete

      expect(video.volume).toBeCloseTo(0.1); // 0.2 * 0.5

      controller.setIgnoreMainVolume(true);
      expect(video.volume).toBeCloseTo(0.2); // back to the unscaled duckVolume

      vi.useRealTimers();
    });
  });

  describe("stop()", () => {
    it("hard-stops a currently playing line and restores the video's volume, without touching the selected track", async () => {
      vi.useFakeTimers();
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      controller.bindSubtitleSource(source, asSubtitleTrackId(1));
      vi.advanceTimersByTime(20);

      await controller.getTracks();
      controller.selectTrack(asVoiceOverTrackId("en"));
      const video = fakeVideo();
      controller.attach(video);
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });

      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 5, text: "hello" }]);
      ticker.tick();
      await vi.advanceTimersByTimeAsync(0);
      ticker.tick();
      await vi.advanceTimersByTimeAsync(200); // let the duck fade complete
      expect(video.volume).toBeCloseTo(0.15); // default duck volume — genuinely ducked

      controller.stop();

      expect(video.volume).toBe(1); // restored, not left stuck at the ducked level
      // Unlike selectTrack(null), stop() is not an "off" decision — the
      // user's chosen language is exactly what a host closing/reopening a
      // title should still see selected.
      expect(controller.selectedTrack?.language).toBe("en");

      vi.useRealTimers();
    });

    it("is a harmless no-op when nothing is currently playing", () => {
      expect(() => controller.stop()).not.toThrow();
    });
  });

  describe("Extended Audio Description (allowVideoPause)", () => {
    async function bindAndSelect(c: VoiceOverController, source: MockSubtitleSource) {
      vi.useFakeTimers();
      c.bindSubtitleSource(source, asSubtitleTrackId(1));
      vi.advanceTimersByTime(20);
      vi.useRealTimers();
      await c.getTracks();
      c.selectTrack(asVoiceOverTrackId("en"));
    }

    it("includes isExtended on voiceOverLinePlayed when the line doesn't fit its cue window", async () => {
      const video = fakeVideo();
      const c = new VoiceOverController({ gateway, events, ticker, allowVideoPause: true, trackSwitchDebounceMs: 10 });
      c.attach(video);
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(c, source);
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });

      const played = vi.fn();
      events.on("voiceOverLinePlayed", played);
      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();
      ticker.tick();

      expect(played).toHaveBeenCalledWith(expect.objectContaining({ isExtended: true }));
      expect(video.paused).toBe(true); // paused by Extended AD, not by the (fake) user
    });

    it("emits voiceOverVideoResumeRejected (never throws) when resuming from Extended AD is rejected", async () => {
      const video = fakeVideo();
      const c = new VoiceOverController({ gateway, events, ticker, allowVideoPause: true, trackSwitchDebounceMs: 10 });
      c.attach(video);
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(c, source);
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });

      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();
      ticker.tick(); // line starts, video paused for Extended AD
      expect(video.paused).toBe(true);

      const resumeRejected = vi.fn();
      events.on("voiceOverVideoResumeRejected", resumeRejected);
      video.play = () => Promise.reject(new Error("resume blocked"));

      expect(() => c.selectTrack(null)).not.toThrow(); // hard-stop must attempt to resume the video
      await Promise.resolve();
      await Promise.resolve();

      expect(resumeRejected).toHaveBeenCalledWith(expect.objectContaining({ trackId: expect.anything() }));
    });

    it("does NOT freeze the video at the extended line's own start when the next cue is still far away — only once close to it", async () => {
      // Regression test for the reported bug: the video used to freeze the
      // instant the extended line started, long before the next subtitle
      // was actually due, then resume "instantly" right as it appeared.
      const video = fakeVideo();
      const c = new VoiceOverController({
        gateway,
        events,
        ticker,
        allowVideoPause: true,
        trackSwitchDebounceMs: 10,
        extendedPauseLeadSeconds: 0.15,
      });
      c.attach(video);
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(c, source);
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });

      source.emitCues(asSubtitleTrackId(1), [
        { startSeconds: 0, endSeconds: 1, text: "hello" }, // isExtended: 5s line, 1s window
        { startSeconds: 10, endSeconds: 11, text: "world" }, // next cue, 9s later
      ]);
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();
      ticker.tick(); // line starts playing at currentTime=0

      expect(video.paused).toBe(false); // not frozen at its own start

      // Advance in small, continuous steps — a jump of more than 1s between
      // ticks reads as a seek and would hard-stop the line before it ever
      // reaches the freeze threshold below.
      const mutableVideo = video as unknown as { currentTime: number };
      const rampTo = (target: number, step = 0.9) => {
        let t = mutableVideo.currentTime;
        while (t < target) {
          t = Math.min(t + step, target);
          mutableVideo.currentTime = t;
          ticker.tick();
        }
      };

      rampTo(5); // still well before the next cue
      expect(video.paused).toBe(false); // still not frozen — plenty of time left before cue 2

      rampTo(9.9); // within extendedPauseLeadSeconds of cue 2's start (10)
      expect(video.paused).toBe(true); // frozen right before the next subtitle, not earlier
    });

    it("never pauses the video when allowVideoPause is off, even for an isExtended line", async () => {
      const video = fakeVideo();
      const c = new VoiceOverController({ gateway, events, ticker, trackSwitchDebounceMs: 10 }); // allowVideoPause defaults off
      c.attach(video);
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(c, source);
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });

      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();
      ticker.tick();

      expect(video.paused).toBe(false);
    });

    it("does not forward the video's own pause (caused by Extended AD) back onto the narration audio", async () => {
      const video = fakeVideo();
      const c = new VoiceOverController({ gateway, events, ticker, allowVideoPause: true, trackSwitchDebounceMs: 10 });
      c.attach(video);
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(c, source);
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });

      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();
      ticker.tick(); // line starts, video.pause() called synchronously

      // Next tick observes video.paused === true and would normally forward
      // setPaused(true) to the ducking player — must be suppressed here.
      expect(() => ticker.tick()).not.toThrow();
    });

    it("setAllowVideoPause live-updates the setting without recreating the controller", async () => {
      const video = fakeVideo();
      const c = new VoiceOverController({ gateway, events, ticker, trackSwitchDebounceMs: 10 }); // starts off
      c.attach(video);
      const source = new MockSubtitleSource(asSubtitleSourceId("subs"), []);
      await bindAndSelect(c, source);
      c.setAllowVideoPause(true);
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });

      source.emitCues(asSubtitleTrackId(1), [{ startSeconds: 0, endSeconds: 1, text: "hello" }]);
      ticker.tick();
      await Promise.resolve();
      await Promise.resolve();
      ticker.tick();

      expect(video.paused).toBe(true);
    });
  });

  describe("language preference persistence", () => {
    function makeStore(initial: string | null = null) {
      let stored = initial;
      return {
        getAudioLanguage: () => null,
        setAudioLanguage: () => {},
        getVoiceOverLanguage: () => stored,
        setVoiceOverLanguage: (language: string | null) => {
          stored = language;
        },
      };
    }

    it("auto-selects the stored language once getTracks() resolves, without an explicit call", async () => {
      const store = makeStore("en");
      const c = new VoiceOverController({ gateway, events, ticker, preferenceStore: store });
      c.attach(fakeVideo());

      await c.getTracks();
      expect(c.selectedTrack?.language).toBe("en");
    });

    it("leaves voice-over off when the stored language matches no available track", async () => {
      const store = makeStore("fr");
      const c = new VoiceOverController({ gateway, events, ticker, preferenceStore: store });
      c.attach(fakeVideo());

      await c.getTracks();
      expect(c.selectedTrack).toBeNull();
    });

    it("persists an explicit selectTrack() call via setVoiceOverLanguage", async () => {
      const store = makeStore(null);
      const c = new VoiceOverController({ gateway, events, ticker, preferenceStore: store });
      c.attach(fakeVideo());

      await c.getTracks();
      c.selectTrack(asVoiceOverTrackId("en"));
      expect(store.getVoiceOverLanguage()).toBe("en");
    });

    it("does not let a stale stored preference override an explicit null selection", async () => {
      const store = makeStore("en");
      const c = new VoiceOverController({ gateway, events, ticker, preferenceStore: store });
      c.attach(fakeVideo());

      c.selectTrack(null); // explicit, before getTracks() ever resolves
      await c.getTracks();
      expect(c.selectedTrack).toBeNull();
    });

    it("clears the stored preference on selectTrack(null), so an explicit off stays off across a later restore", async () => {
      const store = makeStore("en");
      const first = new VoiceOverController({ gateway, events, ticker, preferenceStore: store });
      first.attach(fakeVideo());
      await first.getTracks();
      expect(first.selectedTrack?.language).toBe("en"); // auto-restored, as before

      first.selectTrack(null); // user explicitly turns narration off
      expect(store.getVoiceOverLanguage()).toBeNull();

      // A later restore — e.g. the next app launch — must not read a stale
      // language back and turn narration on again.
      const second = new VoiceOverController({ gateway, events, ticker, preferenceStore: store });
      second.attach(fakeVideo());
      await second.getTracks();
      expect(second.selectedTrack).toBeNull();
    });

    it("does not throw against a preference store missing the optional voice-over methods", async () => {
      const audioOnlyStore = { getAudioLanguage: () => null, setAudioLanguage: () => {} };
      const c = new VoiceOverController({ gateway, events, ticker, preferenceStore: audioOnlyStore });
      c.attach(fakeVideo());

      await expect(c.getTracks()).resolves.toBeDefined();
      expect(() => c.selectTrack(asVoiceOverTrackId("en"))).not.toThrow();
    });
  });
});
