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

  describe("videoOriginalVolume drift across fast-following lines (isDucked)", () => {
    it("restores to the true original after a second line starts before the first line's restore-up fade finishes", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });

      player.playLine("cue-1", "blob:1");
      vi.advanceTimersByTime(150); // duck-in fully settled at 0
      FakeAudio.instances[0].fire("ended");
      vi.advanceTimersByTime(60); // restore-up only 2/5 steps in (video.volume = 0.4)

      // "cue-2" (e.g. the next subtitle, close behind the first) starts
      // before cue-1's restore finished. Before the fix, this captured the
      // interrupted 0.4 as the new "original".
      player.playLine("cue-2", "blob:2");
      FakeAudio.instances[1].fire("ended");
      vi.advanceTimersByTime(150); // cue-2's own restore-up fully settles

      expect(video.volume).toBe(1); // back to the TRUE original, not 0.4
    });

    it("restores to the true original after a second line supersedes the first mid duck-in fade", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });

      player.playLine("cue-1", "blob:1");
      vi.advanceTimersByTime(60); // duck-in only 2/5 steps in (video.volume = 0.6)

      player.playLine("cue-2", "blob:2"); // supersedes before cue-1 ever fully ducked
      FakeAudio.instances[1].fire("ended");
      vi.advanceTimersByTime(150); // cue-2's restore-up fully settles

      expect(video.volume).toBe(1); // back to the TRUE original, not 0.6
    });

    it("does not drift across many rapid, close-together lines (dense dialogue)", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });

      for (let i = 0; i < 6; i++) {
        player.playLine(`cue-${i}`, `blob:${i}`);
        vi.advanceTimersByTime(45); // supersede mid fade, whichever direction, every time
        FakeAudio.instances[i].fire("ended");
      }
      vi.advanceTimersByTime(150); // let the final line's restore fully settle

      expect(video.volume).toBe(1); // never ratcheted down toward duckVolume
    });

    it("a hard stop mid-restore-fade still leaves the next line free to recapture a fresh original", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });

      player.playLine("cue-1", "blob:1");
      vi.advanceTimersByTime(150);
      FakeAudio.instances[0].fire("ended");
      vi.advanceTimersByTime(60); // restore-up partway (0.4)

      player.stopLine(true); // e.g. a seek — hard-restores and clears isDucked
      expect(video.volume).toBe(1);

      // The user then changes the video's own volume via the native
      // controls before the next line starts.
      video.volume = 0.5;
      player.playLine("cue-2", "blob:2");
      FakeAudio.instances[1].fire("ended");
      vi.advanceTimersByTime(150);

      expect(video.volume).toBe(0.5); // recaptured the new original, not stuck at 1
    });
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

  it("re-applies the duck volume immediately when setDuckVolume is called mid-line, once the duck-in fade has settled", () => {
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

    player.setDuckVolume(0.3);
    expect(video.volume).toBeCloseTo(0.3);

    player.setDuckVolume(0);
    expect(video.volume).toBe(0);
  });

  it("does not retarget an in-flight duck fade when setDuckVolume changes mid-fade", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({
      video,
      duckVolume: 0,
      duckFadeSteps: 5,
      duckFadeStepMs: 30,
    });
    player.playLine("cue-1", "blob:1"); // fade-in toward 0 starts

    player.setDuckVolume(0.5);
    expect(video.volume).toBe(1); // unchanged synchronously — fade still animating

    vi.advanceTimersByTime(150); // let the original fade finish
    expect(video.volume).toBe(0); // the in-flight fade's own target wins, as documented
  });

  it("does not re-apply setDuckVolume while paused for Extended Audio Description", () => {
    const video = fakeVideo(1);
    const player = new VoiceOverDuckingPlayer({
      video,
      duckVolume: 0,
      allowVideoPause: true,
      duckFadeSteps: 5,
      duckFadeStepMs: 30,
    });
    player.playLine("cue-1", "blob:1");
    vi.advanceTimersByTime(150);
    player.pauseForExtendedDescription("cue-1");
    expect(video.volume).toBe(1); // restored to original for the pause

    player.setDuckVolume(0.4);
    expect(video.volume).toBe(1); // untouched while paused for Extended Audio Description
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

  describe("main volume scaling (mainVolume / ignoreMainVolume)", () => {
    it("defaults mainVolume to 1 — no behavior change for a host that never calls setMainVolume", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0.2,
        voiceOverVolume: 0.7,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });
      player.playLine("cue-1", "blob:1");
      expect(FakeAudio.instances[0].volume).toBeCloseTo(0.7);

      vi.advanceTimersByTime(150);
      expect(video.volume).toBeCloseTo(0.2);
    });

    it("scales both duckVolume and voiceOverVolume multiplicatively by mainVolume", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0.2,
        voiceOverVolume: 0.8,
        mainVolume: 0.5,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });
      player.playLine("cue-1", "blob:1");
      expect(FakeAudio.instances[0].volume).toBeCloseTo(0.4); // 0.8 * 0.5

      vi.advanceTimersByTime(150);
      expect(video.volume).toBeCloseTo(0.1); // 0.2 * 0.5
    });

    it("even at 100% on their own sliders, duckVolume/voiceOverVolume never exceed mainVolume", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 1,
        voiceOverVolume: 1,
        mainVolume: 0.5,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });
      player.playLine("cue-1", "blob:1");
      expect(FakeAudio.instances[0].volume).toBeCloseTo(0.5);

      vi.advanceTimersByTime(150);
      expect(video.volume).toBeCloseTo(0.5);
    });

    it("ignoreMainVolume bypasses scaling entirely, even with mainVolume < 1", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0.2,
        voiceOverVolume: 0.8,
        mainVolume: 0.5,
        ignoreMainVolume: true,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });
      player.playLine("cue-1", "blob:1");
      expect(FakeAudio.instances[0].volume).toBeCloseTo(0.8);

      vi.advanceTimersByTime(150);
      expect(video.volume).toBeCloseTo(0.2);
    });

    it("setMainVolume re-applies live to the current line's narration volume and, once settled, the duck target", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0.2,
        voiceOverVolume: 0.8,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });
      player.playLine("cue-1", "blob:1");
      vi.advanceTimersByTime(150); // duck-in settled

      player.setMainVolume(0.5);
      expect(FakeAudio.instances[0].volume).toBeCloseTo(0.4);
      expect(video.volume).toBeCloseTo(0.1);
    });

    it("setMainVolume does not retarget an in-flight duck fade", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0.2,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });
      player.playLine("cue-1", "blob:1"); // fade-in toward 0.2 starts

      player.setMainVolume(0.5);
      expect(video.volume).toBe(1); // unchanged synchronously — fade still animating

      vi.advanceTimersByTime(150); // let the original (unscaled) fade finish
      expect(video.volume).toBeCloseTo(0.2); // the in-flight fade's own target wins
    });

    it("setIgnoreMainVolume toggling live re-applies to the current line", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0.2,
        voiceOverVolume: 0.8,
        mainVolume: 0.5,
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });
      player.playLine("cue-1", "blob:1");
      vi.advanceTimersByTime(150);
      expect(video.volume).toBeCloseTo(0.1);

      player.setIgnoreMainVolume(true);
      expect(FakeAudio.instances[0].volume).toBeCloseTo(0.8);
      expect(video.volume).toBeCloseTo(0.2);

      player.setIgnoreMainVolume(false);
      expect(FakeAudio.instances[0].volume).toBeCloseTo(0.4);
      expect(video.volume).toBeCloseTo(0.1);
    });

    it("clamps an out-of-range mainVolume instead of distorting the product", () => {
      const video = fakeVideo(1);
      const player = new VoiceOverDuckingPlayer({
        video,
        duckVolume: 0.5,
        voiceOverVolume: 0.5,
        mainVolume: 2, // out of range
        duckFadeSteps: 5,
        duckFadeStepMs: 30,
      });
      player.playLine("cue-1", "blob:1");
      expect(FakeAudio.instances[0].volume).toBeCloseTo(0.5); // clamped to 1, not 1.0*2

      vi.advanceTimersByTime(150);
      expect(video.volume).toBeCloseTo(0.5);
    });
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
