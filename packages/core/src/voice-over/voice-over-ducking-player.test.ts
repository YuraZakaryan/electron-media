import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceOverDuckingPlayer, easeInOutQuadCurve } from "./voice-over-ducking-player.js";

class FakeAudio {
  static instances: FakeAudio[] = [];
  volume = 1;
  src: string;
  private readonly listeners = new Map<string, Set<() => void>>();
  playCalls = 0;
  playResult: Promise<void> = Promise.resolve();

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    this.playCalls += 1;
    return this.playResult;
  }

  pause(): void {
    // no-op for the fake
  }

  addEventListener(name: string, cb: () => void): void {
    const set = this.listeners.get(name) ?? new Set();
    set.add(cb);
    this.listeners.set(name, set);
  }

  fire(name: string): void {
    this.listeners.get(name)?.forEach((cb) => cb());
  }
}

function fakeVideo(volume = 1): HTMLVideoElement {
  return {
    volume,
    pause: () => {},
    play: () => Promise.resolve(),
  } as unknown as HTMLVideoElement;
}

describe("VoiceOverDuckingPlayer", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    vi.stubGlobal("Audio", FakeAudio);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("fades the video volume down to duckVolume over the configured steps", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({
      video,
      duckVolume: 0,
      duckFadeSteps: 5,
      duckFadeStepMs: 30,
    });

    player.playLine("cue-1", "blob:1");
    const seenVolumes: number[] = [];
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30);
      seenVolumes.push(video.volume);
    }

    seenVolumes.forEach((value, index) => expect(value).toBeCloseTo([0.8, 0.6, 0.4, 0.2, 0][index]));
  });

  it("fades the video volume symmetrically back up when the line ends normally", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({
      video,
      duckVolume: 0,
      duckFadeSteps: 5,
      duckFadeStepMs: 30,
    });

    player.playLine("cue-1", "blob:1");
    vi.advanceTimersByTime(150); // finish duck-in fade
    expect(video.volume).toBe(0);

    FakeAudio.instances[0].fire("ended");
    const seenVolumes: number[] = [];
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(30);
      seenVolumes.push(video.volume);
    }
    seenVolumes.forEach((value, index) => expect(value).toBeCloseTo([0.2, 0.4, 0.6, 0.8, 1][index]));
  });

  it("restores volume instantly with no intermediate fade on a hard stop", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0 });

    player.playLine("cue-1", "blob:1");
    vi.advanceTimersByTime(30); // mid fade-in

    player.stopLine(true);
    expect(video.volume).toBe(1);

    const volumeBefore = video.volume;
    vi.advanceTimersByTime(1000);
    expect(video.volume).toBe(volumeBefore); // no further fade ticks
  });

  it("ignores a stale ended event from a superseded line", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0 });

    player.playLine("cue-1", "blob:1");
    const staleAudio = FakeAudio.instances[0];
    player.playLine("cue-2", "blob:2");

    staleAudio.fire("ended");
    vi.advanceTimersByTime(150);
    expect(video.volume).toBe(0); // still ducked for the active (second) line
  });

  it("re-applies the narration volume immediately when setVoiceOverVolume is called mid-line, independent of duckVolume", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0 });
    player.playLine("cue-1", "blob:1");

    player.setVoiceOverVolume(0.5);
    expect(FakeAudio.instances[0].volume).toBe(0.5);

    player.setVoiceOverVolume(0);
    expect(FakeAudio.instances[0].volume).toBe(0);
  });

  it("defaults voiceOverVolume to 1 (full) and duckVolume to 0.15, independently configurable", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({ video }); // no options — defaults
    player.playLine("cue-1", "blob:1");

    expect(FakeAudio.instances[0].volume).toBe(1); // voiceOverVolume default
    vi.advanceTimersByTime(150);
    expect(video.volume).toBeCloseTo(0.15); // duckVolume default
  });

  it("surfaces autoplay rejection via onPlaybackRejected without throwing", async () => {
    vi.useRealTimers();
    class RejectingAudio extends FakeAudio {
      play(): Promise<void> {
        this.playCalls += 1;
        return Promise.reject(new Error("autoplay blocked"));
      }
    }
    vi.stubGlobal("Audio", RejectingAudio);

    const video = fakeVideo(1);
    const onPlaybackRejected = vi.fn();
    const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, onPlaybackRejected });

    expect(() => player.playLine("cue-1", "blob:1")).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(onPlaybackRejected).toHaveBeenCalledWith("cue-1");
  });

  it("setPaused(true) pauses the current line's Audio without touching volume/fade state", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0 });
    player.playLine("cue-1", "blob:1");
    vi.advanceTimersByTime(150); // fully ducked
    const volumeBefore = video.volume;

    const pauseSpy = vi.spyOn(FakeAudio.instances[0], "pause" as never);
    player.setPaused(true);

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(video.volume).toBe(volumeBefore); // unaffected — this is not a stop
  });

  it("setPaused(false) resumes the current line's Audio", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0 });
    player.playLine("cue-1", "blob:1");
    player.setPaused(true);

    const audio = FakeAudio.instances[0];
    audio.playCalls = 0;
    player.setPaused(false);

    expect(audio.playCalls).toBe(1);
  });

  it("setPaused is a harmless no-op when nothing is playing", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0 });
    expect(() => player.setPaused(true)).not.toThrow();
    expect(() => player.setPaused(false)).not.toThrow();
  });

  describe("fadeCurve", () => {
    it("defaults to linear — unchanged step values from before this option existed", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, duckFadeSteps: 5, duckFadeStepMs: 30 });
      player.playLine("cue-1", "blob:1");

      const seenVolumes: number[] = [];
      for (let i = 0; i < 5; i++) {
        vi.advanceTimersByTime(30);
        seenVolumes.push(video.volume);
      }
      seenVolumes.forEach((value, index) => expect(value).toBeCloseTo([0.8, 0.6, 0.4, 0.2, 0][index]));
    });

    it("an eased curve produces a different, monotonic sequence reaching the same start/end points", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0,
        duckFadeSteps: 10,
        duckFadeStepMs: 10,
        fadeCurve: easeInOutQuadCurve,
      });
      player.playLine("cue-1", "blob:1");

      const seenVolumes: number[] = [];
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(10);
        seenVolumes.push(video.volume);
      }

      for (let i = 1; i < seenVolumes.length; i++) {
        expect(seenVolumes[i]).toBeLessThanOrEqual(seenVolumes[i - 1]); // monotonically decreasing toward duckVolume
      }
      expect(seenVolumes[seenVolumes.length - 1]).toBeCloseTo(0);
      // Ease-in-out starts slower than linear — at t=0.2 (index 1), linear
      // would already be at 0.8; the eased curve should still be higher.
      expect(seenVolumes[1]).toBeGreaterThan(0.8);
    });

    it("clamps an out-of-range curve result instead of overshooting the target volume", () => {
      const video = fakeVideo(1);
      const wildCurve = () => 5; // deliberately invalid: way outside [0, 1]
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0,
        duckFadeSteps: 1,
        duckFadeStepMs: 10,
        fadeCurve: wildCurve,
      });
      player.playLine("cue-1", "blob:1");
      vi.advanceTimersByTime(10);

      expect(video.volume).toBe(0); // clamped to the target, not overshot below/above [0,1]
    });
  });

  describe("Extended Audio Description (allowVideoPause)", () => {
    it("playLine always ducks — never pauses immediately, even for what the caller knows will be an extended line", () => {
      // Regression test for the reported bug: the video used to freeze the
      // instant an extended line started (i.e. at its OWN cue's start),
      // well before the next subtitle — see pauseForExtendedDescription's
      // own tests below for the corrected trigger point.
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, allowVideoPause: true });
      const pauseSpy = vi.fn();
      Object.defineProperty(video, "pause", { value: pauseSpy, configurable: true });

      player.playLine("cue-1", "blob:1");
      vi.advanceTimersByTime(150);

      expect(pauseSpy).not.toHaveBeenCalled();
      expect(video.volume).toBe(0); // normal duck fade ran
      expect(player.isPausedForExtendedDescription).toBe(false);
    });

    it("pauseForExtendedDescription freezes the video (undoing the duck) for the currently-playing cue", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, allowVideoPause: true });
      const pauseSpy = vi.fn();
      Object.defineProperty(video, "pause", { value: pauseSpy, configurable: true });

      player.playLine("cue-1", "blob:1");
      vi.advanceTimersByTime(150); // fully ducked
      expect(video.volume).toBe(0);

      player.pauseForExtendedDescription("cue-1");

      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(player.isPausedForExtendedDescription).toBe(true);
      expect(video.volume).toBe(1); // restored, not left ducked, before pausing
    });

    it("pauseForExtendedDescription is a no-op when allowVideoPause is off (the default)", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0 }); // allowVideoPause defaults to false
      const pauseSpy = vi.fn();
      Object.defineProperty(video, "pause", { value: pauseSpy, configurable: true });

      player.playLine("cue-1", "blob:1");
      player.pauseForExtendedDescription("cue-1");

      expect(pauseSpy).not.toHaveBeenCalled();
      expect(player.isPausedForExtendedDescription).toBe(false);
    });

    it("pauseForExtendedDescription is a no-op for a stale cueKey no longer actually playing", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, allowVideoPause: true });
      const pauseSpy = vi.fn();
      Object.defineProperty(video, "pause", { value: pauseSpy, configurable: true });

      player.playLine("cue-1", "blob:1");
      player.playLine("cue-2", "blob:2"); // supersedes cue-1
      player.pauseForExtendedDescription("cue-1"); // stale signal for the superseded line

      expect(pauseSpy).not.toHaveBeenCalled();
    });

    it("pauseForExtendedDescription is idempotent — a second call while already paused does not re-pause", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, allowVideoPause: true });
      const pauseSpy = vi.fn();
      Object.defineProperty(video, "pause", { value: pauseSpy, configurable: true });

      player.playLine("cue-1", "blob:1");
      player.pauseForExtendedDescription("cue-1");
      player.pauseForExtendedDescription("cue-1");

      expect(pauseSpy).toHaveBeenCalledTimes(1);
    });

    it("resumes the video (not a duck fade-out) on ended, for an extended-paused line", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, allowVideoPause: true });
      const playSpy = vi.fn(() => Promise.resolve());
      Object.defineProperty(video, "play", { value: playSpy, configurable: true });

      player.playLine("cue-1", "blob:1");
      player.pauseForExtendedDescription("cue-1");
      FakeAudio.instances[0].fire("ended");

      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(player.isPausedForExtendedDescription).toBe(false);
    });

    it("surfaces a rejected video-resume via onVideoResumeRejected instead of swallowing it, on ended", async () => {
      const video = fakeVideo(1);
      const onVideoResumeRejected = vi.fn();
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0,
        allowVideoPause: true,
        onVideoResumeRejected,
      });
      Object.defineProperty(video, "play", {
        value: () => Promise.reject(new Error("resume blocked")),
        configurable: true,
      });

      player.playLine("cue-1", "blob:1");
      player.pauseForExtendedDescription("cue-1");
      FakeAudio.instances[0].fire("ended");
      await Promise.resolve();
      await Promise.resolve();

      expect(onVideoResumeRejected).toHaveBeenCalledWith("cue-1");
    });

    it("surfaces a rejected video-resume via onVideoResumeRejected instead of swallowing it, on stopLine() mid-pause", async () => {
      const video = fakeVideo(1);
      const onVideoResumeRejected = vi.fn();
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0,
        allowVideoPause: true,
        onVideoResumeRejected,
      });
      Object.defineProperty(video, "play", {
        value: () => Promise.reject(new Error("resume blocked")),
        configurable: true,
      });

      player.playLine("cue-1", "blob:1");
      player.pauseForExtendedDescription("cue-1");
      expect(() => player.stopLine(true)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      expect(onVideoResumeRejected).toHaveBeenCalledWith("cue-1");
    });

    it("resumes the video when stopLine() is called mid-extended-pause (e.g. a seek interrupt)", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, allowVideoPause: true });
      const playSpy = vi.fn(() => Promise.resolve());
      Object.defineProperty(video, "play", { value: playSpy, configurable: true });

      player.playLine("cue-1", "blob:1");
      player.pauseForExtendedDescription("cue-1");
      player.stopLine(true);

      expect(playSpy).toHaveBeenCalledTimes(1);
      expect(player.isPausedForExtendedDescription).toBe(false);
    });

    it("stopLine() before the freeze point (line still just ducking) is a plain hard-stop — no video.play() call", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, allowVideoPause: true });
      const playSpy = vi.fn(() => Promise.resolve());
      Object.defineProperty(video, "play", { value: playSpy, configurable: true });

      player.playLine("cue-1", "blob:1");
      vi.advanceTimersByTime(30); // mid duck-in, pauseForExtendedDescription never called
      player.stopLine(true);

      expect(playSpy).not.toHaveBeenCalled(); // video was never paused, so nothing to resume
      expect(video.volume).toBe(1); // hard-restored, same as any normal line
    });

    it("setPaused() is a no-op while paused for Extended Audio Description", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0, allowVideoPause: true });
      player.playLine("cue-1", "blob:1");
      player.pauseForExtendedDescription("cue-1");

      const pauseSpy = vi.spyOn(FakeAudio.instances[0], "pause" as never);
      player.setPaused(true); // must NOT pause the narration audio itself

      expect(pauseSpy).not.toHaveBeenCalled();
    });

    it("setAllowVideoPause() live-updates the option for the next pauseForExtendedDescription call", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0 }); // starts off
      const pauseSpy = vi.fn();
      Object.defineProperty(video, "pause", { value: pauseSpy, configurable: true });

      player.playLine("cue-1", "blob:1");
      player.pauseForExtendedDescription("cue-1");
      expect(pauseSpy).not.toHaveBeenCalled(); // still off

      player.setAllowVideoPause(true);
      player.pauseForExtendedDescription("cue-1");

      expect(pauseSpy).toHaveBeenCalledTimes(1);
    });
  });

  it("dispose() mid-line is idempotent and restores volume instantly", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({ video, duckVolume: 0 });
    player.playLine("cue-1", "blob:1");
    vi.advanceTimersByTime(30);

    player.dispose();
    expect(video.volume).toBe(1);
    expect(() => player.dispose()).not.toThrow();
  });
});
