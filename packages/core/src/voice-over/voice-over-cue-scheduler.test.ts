import { beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceOverCueScheduler } from "./voice-over-cue-scheduler.js";
import { VoiceOverCuePlaybackState } from "../types/voice-over.js";
import { MockVoiceOverGateway } from "../testing/mock-voiceover-gateway.js";
import { ManualVoiceOverTicker } from "../testing/manual-voice-over-ticker.js";

import type { CanonicalCue } from "../types/cue.js";

function cue(startSeconds: number, endSeconds: number, text = "hello"): CanonicalCue {
  return { startSeconds, endSeconds, text };
}

function fakeVideo(currentTime = 0, paused = false, readyState = 4): HTMLVideoElement {
  return { currentTime, paused, readyState } as unknown as HTMLVideoElement;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("VoiceOverCueScheduler", () => {
  let gateway: MockVoiceOverGateway;
  let ticker: ManualVoiceOverTicker;
  let scheduler: VoiceOverCueScheduler;
  let video: HTMLVideoElement;

  beforeEach(() => {
    gateway = new MockVoiceOverGateway();
    ticker = new ManualVoiceOverTicker();
    scheduler = new VoiceOverCueScheduler({ gateway, ticker, lookaheadSeconds: 6, lateStartGraceSeconds: 4 });
    video = fakeVideo(0, false);
    scheduler.attach(video);
    scheduler.setLanguageCode("en");
  });

  function setCurrentTime(seconds: number) {
    Object.defineProperty(video, "currentTime", { value: seconds, configurable: true });
  }

  function setReadyState(readyState: number) {
    Object.defineProperty(video, "readyState", { value: readyState, configurable: true });
  }

  it("does not call generateLine when there are no cues", () => {
    ticker.tick();
    expect(gateway.generateLineCalls).toHaveLength(0);
  });

  it("transitions Unseen -> Pending and calls generateLine once a cue is due", () => {
    scheduler.setCues([cue(2, 4)]);
    ticker.tick();
    expect(gateway.generateLineCalls).toHaveLength(1);
  });

  it("does not call generateLine twice for a cue already Pending", () => {
    scheduler.setCues([cue(2, 4)]);
    ticker.tick();
    ticker.tick();
    expect(gateway.generateLineCalls).toHaveLength(1);
  });

  it("does not fire onLineReady before the cue's startSeconds even once Ready", async () => {
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
    const ready = vi.fn();
    scheduler.onLineReady(ready);
    scheduler.setCues([cue(5, 7)]);
    setCurrentTime(0);
    ticker.tick();
    await flushMicrotasks();
    expect(ready).not.toHaveBeenCalled();
  });

  it("plays a line that finishes synthesis late but within the grace window", async () => {
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
    const ready = vi.fn();
    scheduler.onLineReady(ready);
    scheduler.setCues([cue(0, 2)]);
    setCurrentTime(0);
    ticker.tick();
    await flushMicrotasks();
    // Advance gradually (each step within the seek-detection epsilon) to
    // reach a time past endSeconds(2) but within grace(4) without the
    // scheduler mistaking this for a seek.
    for (const t of [0.5, 1, 1.5, 2, 2.5, 3]) {
      setCurrentTime(t);
      ticker.tick();
    }
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("skips a line that finishes synthesis beyond the grace window", async () => {
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
    const stateChanges: string[] = [];
    scheduler.onCueStateChanged((_key, status) => stateChanges.push(status));
    scheduler.setCues([cue(0, 2)]);
    setCurrentTime(0);
    ticker.tick();
    setCurrentTime(10); // way past endSeconds(2)+grace(4)
    await flushMicrotasks();
    expect(stateChanges).toContain(VoiceOverCuePlaybackState.Skipped);
    expect(stateChanges).not.toContain(VoiceOverCuePlaybackState.Ready);
  });

  it("never plays a line the gateway reported as failed", async () => {
    gateway.lineResultByKey.set("en:hello", { success: false, error: "tts down" });
    const ready = vi.fn();
    const failed = vi.fn();
    scheduler.onLineReady(ready);
    scheduler.onLineFailed(failed);
    scheduler.setCues([cue(0, 2)]);
    ticker.tick();
    await flushMicrotasks();
    ticker.tick();
    expect(ready).not.toHaveBeenCalled();
    expect(failed).toHaveBeenCalledWith(expect.stringContaining("0:2:hello"), "tts down", false);
  });

  it("does not crash the tick loop when the gateway rejects unexpectedly", async () => {
    gateway.generateLine = () => Promise.reject(new Error("boom"));
    const failed = vi.fn();
    scheduler.onLineFailed(failed);
    scheduler.setCues([cue(0, 2)]);
    ticker.tick();
    await flushMicrotasks();
    expect(failed).toHaveBeenCalledWith(expect.any(String), "boom", true);
    expect(() => ticker.tick()).not.toThrow();
  });

  it("skips non-dialogue cues immediately without calling generateLine", () => {
    scheduler.setCues([cue(0, 2, "[door creaks]")]);
    ticker.tick();
    expect(gateway.generateLineCalls).toHaveLength(0);
  });

  describe("updateCues", () => {
    it("does not replay a cue already Played when the same cue reappears in a later delivery", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);

      scheduler.setCues([cue(0, 2)]);
      setCurrentTime(0);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick(); // line starts playing

      setCurrentTime(3); // past cue(0,2)'s window — settlePlayingCues marks it Played
      ticker.tick();
      expect(ready).toHaveBeenCalledTimes(1);

      // Simulates a source periodically re-emitting its full, grown cue
      // list for the SAME track (VOD-extracted/OpenSubtitles behavior) —
      // the already-played cue reappears verbatim, plus one new one.
      scheduler.updateCues([cue(0, 2), cue(5, 7, "later")]);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      // Still exactly once — updateCues must not have reset cue(0,2) back
      // to Unseen and let it be resynthesized/replayed.
      expect(ready).toHaveBeenCalledTimes(1);
    });

    it("still picks up a genuinely new cue added by a later delivery", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });
      gateway.lineResultByKey.set("en:later", { success: true, audioUrl: "blob:2", durationSeconds: 1 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);

      scheduler.setCues([cue(0, 1)]);
      setCurrentTime(0);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();
      expect(ready).toHaveBeenCalledTimes(1);

      scheduler.updateCues([cue(0, 1), cue(2, 3, "later")]);
      setCurrentTime(2);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      expect(ready).toHaveBeenCalledTimes(2);
      expect(ready).toHaveBeenLastCalledWith(
        expect.objectContaining({ cueKey: expect.stringContaining("later") })
      );
    });

    it("does not reset isGenerating for a cue already Pending when it reappears", async () => {
      let resolveLine!: (value: { success: true; audioUrl: string; durationSeconds: number }) => void;
      gateway.generateLine = () => new Promise((resolve) => { resolveLine = resolve; });

      scheduler.setCues([cue(0, 2)]);
      setCurrentTime(0);
      ticker.tick(); // -> Pending, generateLine in flight
      expect(scheduler.isGenerating).toBe(true);

      scheduler.updateCues([cue(0, 2)]); // same cue reappears mid-synthesis
      expect(scheduler.isGenerating).toBe(true); // still the same in-flight request

      resolveLine({ success: true, audioUrl: "blob:1", durationSeconds: 2 });
      await flushMicrotasks();
      expect(scheduler.isGenerating).toBe(false);
    });
  });

  it("discards a stale result after cancel-then-supersede (epoch race)", async () => {
    let resolveFirst!: (value: { success: true; audioUrl: string; durationSeconds: number }) => void;
    gateway.generateLine = () => new Promise((resolve) => { resolveFirst = resolve; });
    const ready = vi.fn();
    scheduler.onLineReady(ready);
    scheduler.setCues([cue(0, 2)]);
    ticker.tick(); // -> Pending, in-flight promise captured

    scheduler.setLanguageCode("es"); // supersedes: bumps epoch
    resolveFirst({ success: true, audioUrl: "blob:stale", durationSeconds: 2 });
    await flushMicrotasks();
    ticker.tick();

    expect(ready).not.toHaveBeenCalled();
  });

  it("holds the epoch guarantee across 3+ rapid language switches", async () => {
    const resolvers: Array<(v: { success: true; audioUrl: string; durationSeconds: number }) => void> = [];
    gateway.generateLine = () => new Promise((resolve) => resolvers.push(resolve));
    const ready = vi.fn();
    scheduler.onLineReady(ready);
    scheduler.setCues([cue(0, 2)]);
    ticker.tick();

    scheduler.setLanguageCode("es");
    scheduler.setLanguageCode("fr");
    scheduler.setLanguageCode("de");

    resolvers.forEach((resolve) => resolve({ success: true, audioUrl: "blob:stale", durationSeconds: 2 }));
    await flushMicrotasks();
    ticker.tick();

    expect(ready).not.toHaveBeenCalled();
  });

  describe("invalidateStaleCues (discarding an already-Ready line on setLanguageCode)", () => {
    it("does not play a pre-fetched Ready line once its cue becomes due after turning off mid-narration", async () => {
      gateway.lineResultByKey.set("en:first", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
      gateway.lineResultByKey.set("en:second", { success: true, audioUrl: "blob:2", durationSeconds: 2 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      // "second" starts at 3s, well within the 6s lookahead from t=0, so it
      // gets synthesized concurrently with "first" and sits Ready long
      // before its own cue is due — exactly the lookahead pre-fetch that
      // exposes the bug.
      scheduler.setCues([cue(0, 2, "first"), cue(3, 5, "second")]);
      setCurrentTime(0);
      ticker.tick(); // both -> Pending, generateLine called for both
      await flushMicrotasks();
      ticker.tick(); // "first" -> Playing; "second" -> Ready (not yet due)
      expect(ready).toHaveBeenCalledTimes(1);
      expect(ready).toHaveBeenCalledWith(expect.objectContaining({ cueKey: expect.stringContaining("first") }));

      // User turns voice-over off while "first" is still narrating.
      scheduler.setLanguageCode(null);

      // Advance to when "second"'s cue becomes due. Before the fix,
      // startNextDueLine had no language guard and would still hand off
      // this pre-fetched Ready line here — narration audibly resuming a
      // few seconds after being turned off.
      setCurrentTime(3);
      ticker.tick();
      await flushMicrotasks();

      expect(ready).toHaveBeenCalledTimes(1); // still only "first" — never "second"
    });

    it("marks a discarded Ready line Skipped and fires onLineSkipped", async () => {
      gateway.lineResultByKey.set("en:first", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
      gateway.lineResultByKey.set("en:second", { success: true, audioUrl: "blob:2", durationSeconds: 2 });
      const skipped = vi.fn();
      scheduler.onLineSkipped(skipped);
      scheduler.setCues([cue(0, 2, "first"), cue(3, 5, "second")]);
      setCurrentTime(0);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick(); // "second" now Ready, not yet due

      scheduler.setLanguageCode(null);

      expect(skipped).toHaveBeenCalledWith(expect.stringContaining("second"));
    });

    it("does not resurrect a Ready line synthesized under the previous language after switching to a new one", async () => {
      gateway.lineResultByKey.set("en:first", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
      gateway.lineResultByKey.set("en:second", { success: true, audioUrl: "blob:2", durationSeconds: 2 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setCues([cue(0, 2, "first"), cue(3, 5, "second")]);
      setCurrentTime(0);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick(); // "first" Playing (en), "second" Ready (en)

      scheduler.setLanguageCode("es"); // switch language mid-narration

      setCurrentTime(3);
      ticker.tick();
      await flushMicrotasks();

      // "second" was synthesized in "en" and must not play just because its
      // cue became due — even though a language is now selected again.
      expect(ready).toHaveBeenCalledTimes(1);
      expect(ready).not.toHaveBeenCalledWith(
        expect.objectContaining({ cueKey: expect.stringContaining("second") })
      );
    });

    it("best-effort cancels a still-Pending line's synthesis when turning off", async () => {
      gateway.lineResultByKey.set("en:first", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
      scheduler.setCues([cue(0, 2, "first")]);
      setCurrentTime(0);
      ticker.tick(); // -> Pending, generateLine in flight

      scheduler.setLanguageCode(null);

      expect(gateway.cancelLineCalls).toContainEqual({ languageCode: "en", text: "first" });
    });

    it("stops isGenerating from staying stuck true after turning off mid-synthesis", async () => {
      gateway.generateLine = () => new Promise(() => {}); // never resolves
      scheduler.setCues([cue(0, 2, "first")]);
      setCurrentTime(0);
      ticker.tick(); // -> Pending
      expect(scheduler.isGenerating).toBe(true);

      scheduler.setLanguageCode(null);

      expect(scheduler.isGenerating).toBe(false);
    });
  });

  it("plays only the nearest due cue after a forward seek skips past several", async () => {
    gateway.lineResultByKey.set("en:c1", { success: true, audioUrl: "blob:1", durationSeconds: 1 });
    gateway.lineResultByKey.set("en:c2", { success: true, audioUrl: "blob:2", durationSeconds: 1 });
    gateway.lineResultByKey.set("en:c3", { success: true, audioUrl: "blob:3", durationSeconds: 1 });
    const ready = vi.fn();
    scheduler.onLineReady(ready);
    scheduler.setCues([cue(0, 1, "c1"), cue(2, 3, "c2"), cue(4, 5, "c3")]);
    setCurrentTime(0);
    ticker.tick();
    await flushMicrotasks();

    setCurrentTime(4.2); // big forward jump past c1 and c2
    ticker.tick();
    await flushMicrotasks();
    ticker.tick();

    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][0].audioUrl).toBe("blob:3");
  });

  it("skips a large backlog of already-passed cues instantly, without wasting synthesis on them", async () => {
    // Reproduces a source that delivers its ENTIRE cue list up front (e.g.
    // OpenSubtitlesSource downloading the whole movie's transcript) when
    // playback resumed far into the movie (a VOD seek/resume) — most of the
    // list is already in the past on the very first tick, with no seek
    // event to trigger the (already-existing) handleSeek cleanup, since
    // currentTime itself never actually jumped.
    const past = Array.from({ length: 50 }, (_, i) => cue(i, i + 0.5, `past${i}`));
    const current = cue(1000, 1001, "now");
    gateway.lineResultByKey.set("en:now", { success: true, audioUrl: "blob:now", durationSeconds: 1 });

    scheduler.setCues([...past, current]);
    setCurrentTime(1000.2); // within "now"'s window; every "past" cue is long gone
    ticker.tick();
    await flushMicrotasks();
    ticker.tick();

    // None of the 50 backlogged cues should ever have reached the gateway —
    // only "now" should have.
    expect(gateway.generateLineCalls).toHaveLength(1);
    expect(gateway.generateLineCalls[0].text).toBe("now");
  });

  it("interrupts the currently playing cue with no fade on a backward seek", async () => {
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
    const hardStop = vi.fn();
    scheduler.onHardStop(hardStop);
    scheduler.setCues([cue(0, 5)]);
    setCurrentTime(0);
    ticker.tick();
    await flushMicrotasks();
    setCurrentTime(1);
    ticker.tick(); // now Playing

    setCurrentTime(0.5); // backward seek
    ticker.tick();

    expect(hardStop).toHaveBeenCalledTimes(1);
  });

  it("re-enables a played cue after seeking backward into its window again", async () => {
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
    scheduler.setCues([cue(0, 2)]);
    setCurrentTime(0);
    ticker.tick();
    await flushMicrotasks();
    setCurrentTime(1);
    ticker.tick(); // Playing
    setCurrentTime(3);
    ticker.tick(); // Played (window closed)

    gateway.generateLineCalls.length = 0;
    setCurrentTime(0); // seek back into the window
    ticker.tick();
    expect(gateway.generateLineCalls.length).toBeGreaterThan(0);
  });

  it("picks the nearest due cue deterministically regardless of insertion order", async () => {
    gateway.lineResultByKey.set("en:late", { success: true, audioUrl: "blob:late", durationSeconds: 1 });
    gateway.lineResultByKey.set("en:early", { success: true, audioUrl: "blob:early", durationSeconds: 1 });
    const ready = vi.fn();
    scheduler.onLineReady(ready);
    // Inserted in reverse chronological order on purpose.
    scheduler.setCues([cue(1, 2, "late"), cue(0, 1, "early")]);
    setCurrentTime(1.5);
    ticker.tick();
    await flushMicrotasks();
    ticker.tick();

    expect(ready).toHaveBeenCalledTimes(1);
    expect(ready.mock.calls[0][0].audioUrl).toBe("blob:early");
  });

  it("does not start a new cue while paused, even if due", async () => {
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
    const ready = vi.fn();
    scheduler.onLineReady(ready);
    scheduler.setCues([cue(0, 2)]);
    setCurrentTime(0);
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    ticker.tick();
    await flushMicrotasks();
    ticker.tick();

    expect(ready).not.toHaveBeenCalled();
  });

  it("plays a ready-and-due cue once resumed from pause", async () => {
    gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
    const ready = vi.fn();
    scheduler.onLineReady(ready);
    scheduler.setCues([cue(0, 2)]);
    setCurrentTime(0);
    Object.defineProperty(video, "paused", { value: true, configurable: true });
    ticker.tick();
    await flushMicrotasks();

    Object.defineProperty(video, "paused", { value: false, configurable: true });
    ticker.tick();

    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("discards a result that resolves after dispose", async () => {
    let resolveFirst!: (value: { success: true; audioUrl: string; durationSeconds: number }) => void;
    gateway.generateLine = () => new Promise((resolve) => { resolveFirst = resolve; });
    const ready = vi.fn();
    scheduler.onLineReady(ready);
    scheduler.setCues([cue(0, 2)]);
    ticker.tick();

    scheduler.dispose();
    resolveFirst({ success: true, audioUrl: "blob:1", durationSeconds: 2 });
    await flushMicrotasks();

    expect(ready).not.toHaveBeenCalled();
  });

  it("resumes ticking correctly against a newly attached video element", () => {
    scheduler.setCues([cue(0, 2)]);
    scheduler.detach();

    const newVideo = fakeVideo(0, false);
    scheduler.attach(newVideo);
    ticker.tick();
    expect(gateway.generateLineCalls.length).toBeGreaterThan(0);
  });

  it("does not crash and reports isGenerating false for an empty cue list", () => {
    scheduler.setCues([]);
    expect(() => ticker.tick()).not.toThrow();
    expect(scheduler.isGenerating).toBe(false);
  });

  describe("buffering", () => {
    it("blocks a new line from starting while buffering (readyState < HAVE_FUTURE_DATA, not paused), but still lets pending synthesis finish", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setCues([cue(0, 2)]);
      setCurrentTime(0);
      setReadyState(1); // buffering: paused=false, readyState < 3
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      expect(gateway.generateLineCalls).toHaveLength(1); // synthesis still requested
      expect(ready).not.toHaveBeenCalled(); // but not handed off while buffering
    });

    it("lets a ready-and-due line start once buffering clears (readyState back to HAVE_FUTURE_DATA)", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setCues([cue(0, 2)]);
      setCurrentTime(0);
      setReadyState(1);
      ticker.tick();
      await flushMicrotasks();

      setReadyState(4);
      ticker.tick();

      expect(ready).toHaveBeenCalledTimes(1);
    });
  });

  describe("onPlaybackPausedChanged", () => {
    it("fires exactly once per transition, not on every tick that stays effectively paused", () => {
      const pausedChanged = vi.fn();
      scheduler.onPlaybackPausedChanged(pausedChanged);

      Object.defineProperty(video, "paused", { value: true, configurable: true });
      ticker.tick(); // real pause: false -> true
      ticker.tick(); // still paused, no new transition

      Object.defineProperty(video, "paused", { value: false, configurable: true });
      setReadyState(1); // now buffering instead of paused — still "effectively paused"
      ticker.tick();
      ticker.tick();

      Object.defineProperty(video, "paused", { value: false, configurable: true });
      setReadyState(4); // fully resumed
      ticker.tick();

      expect(pausedChanged.mock.calls.map((call) => call[0])).toEqual([true, false]);
    });
  });

  describe("clipped passthrough", () => {
    it("carries the gateway's clipped flag through untouched onto the ready line", async () => {
      gateway.lineResultByKey.set("en:hello", {
        success: true,
        audioUrl: "blob:1",
        durationSeconds: 2,
        clipped: true,
      });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setCues([cue(0, 2)]);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      expect(ready).toHaveBeenCalledWith(expect.objectContaining({ clipped: true }));
    });

    it("leaves clipped undefined when the gateway never sets it", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 2 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setCues([cue(0, 2)]);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      expect(ready.mock.calls[0][0].clipped).toBeUndefined();
    });
  });

  describe("isExtended (WCAG 1.2.7 Extended Audio Description)", () => {
    it("marks a line isExtended=true when synthesized duration exceeds the cue's own window", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setCues([cue(0, 2)]); // 2-second window, but the line is 5 seconds
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      expect(ready).toHaveBeenCalledWith(expect.objectContaining({ isExtended: true }));
    });

    it("marks a line isExtended=false when synthesized duration fits within the cue's window", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1.5 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setCues([cue(0, 2)]);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      expect(ready).toHaveBeenCalledWith(expect.objectContaining({ isExtended: false }));
    });
  });

  describe("setDelaySeconds (live offset, applied fresh each tick — never baked into stored cue times)", () => {
    it("defaults to 0 and getDelaySeconds reflects what was set", () => {
      expect(scheduler.getDelaySeconds()).toBe(0);
      scheduler.setDelaySeconds(1.5);
      expect(scheduler.getDelaySeconds()).toBe(1.5);
    });

    it("a delay set AFTER a cue was already delivered still takes effect on the very next tick — regression test for the reported bug", async () => {
      // Reproduces the real-world sequence: a subtitle track (and therefore
      // voice-over's bind) can fire before an async seek/resume baseline has
      // finished measuring. With a one-shot reprojection at delivery time,
      // that stale (usually zero) offset would be permanently baked in —
      // this is exactly why the delay must be read live, every tick,
      // instead.
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setCues([cue(5, 7)]); // delivered once, while the delay was still 0
      ticker.tick();
      await flushMicrotasks();

      // The real offset settles well after that one delivery.
      scheduler.setDelaySeconds(2);

      for (const t of [0.9, 1.8, 2.7, 3.6, 4.5, 5.4, 6.3]) {
        setCurrentTime(t);
        ticker.tick();
      }
      // Canonical start (5) has long since passed, but with delay=2 the
      // cue isn't actually due until 7 — proving the delay wasn't baked in
      // (and then ignored) at the moment the cue was delivered.
      expect(ready).not.toHaveBeenCalled();

      setCurrentTime(7);
      ticker.tick();
      expect(ready).toHaveBeenCalledTimes(1);
    });

    it("mirrors CueProjector's sign convention: positive delaySeconds makes a cue due LATER, not earlier", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setDelaySeconds(3);
      scheduler.setCues([cue(2, 4)]);
      ticker.tick();
      await flushMicrotasks();

      for (const t of [0.9, 1.8, 2.7, 3.6, 4.5]) {
        setCurrentTime(t);
        ticker.tick();
      }
      expect(ready).not.toHaveBeenCalled(); // canonical start (2) passed, but delayed start is 5

      setCurrentTime(5);
      ticker.tick();
      expect(ready).toHaveBeenCalledTimes(1);
    });

    it("a NEGATIVE delay makes a cue due EARLIER, symmetrically", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });
      const ready = vi.fn();
      scheduler.onLineReady(ready);
      scheduler.setDelaySeconds(-2);
      scheduler.setCues([cue(5, 7)]);
      setCurrentTime(0);
      ticker.tick();
      await flushMicrotasks();

      for (const t of [0.9, 1.8, 2.7]) {
        setCurrentTime(t);
        ticker.tick();
      }
      expect(ready).not.toHaveBeenCalled();

      setCurrentTime(3);
      ticker.tick();
      expect(ready).toHaveBeenCalledTimes(1); // due at 5-2=3, not the canonical 5
    });
  });

  describe("narrationRate", () => {
    it("defaults to requesting the cue's own window unmodified", () => {
      scheduler.setCues([cue(2, 5)]); // 3s window
      ticker.tick();
      expect(gateway.generateLineCalls).toHaveLength(1);
      expect(gateway.generateLineCalls[0].targetDurationSeconds).toBe(3);
    });

    it("a rate above 1 (constructor option) requests a shorter targetDurationSeconds", () => {
      const fastScheduler = new VoiceOverCueScheduler({
        gateway,
        ticker,
        narrationRate: 1.5,
      });
      fastScheduler.attach(video);
      fastScheduler.setLanguageCode("en");
      fastScheduler.setCues([cue(2, 5)]); // 3s window / 1.5 = 2s
      ticker.tick();
      expect(gateway.generateLineCalls).toHaveLength(1);
      expect(gateway.generateLineCalls[0].targetDurationSeconds).toBeCloseTo(2);
    });

    it("setNarrationRate updates the rate applied to the next generateLine call", () => {
      scheduler.setNarrationRate(2);
      scheduler.setCues([cue(2, 6)]); // 4s window / 2 = 2s
      ticker.tick();
      expect(gateway.generateLineCalls).toHaveLength(1);
      expect(gateway.generateLineCalls[0].targetDurationSeconds).toBeCloseTo(2);
    });

    it("a rate below 1 requests a longer targetDurationSeconds", () => {
      scheduler.setNarrationRate(0.5);
      scheduler.setCues([cue(2, 4)]); // 2s window / 0.5 = 4s
      ticker.tick();
      expect(gateway.generateLineCalls).toHaveLength(1);
      expect(gateway.generateLineCalls[0].targetDurationSeconds).toBeCloseTo(4);
    });
  });

  describe("onExtendedPauseDue (Extended Audio Description pause timing)", () => {
    // Jumping currentTime by more than SEEK_FORWARD_EPSILON_SECONDS (1s) in
    // one step reads as a seek and hard-stops the playing cue — advance in
    // small increments to simulate real playback instead, same pattern the
    // grace-window test above this describe block already uses.
    function rampCurrentTimeTo(target: number, step = 0.9) {
      let t = video.currentTime;
      while (t < target) {
        t = Math.min(t + step, target);
        setCurrentTime(t);
        ticker.tick();
      }
    }


    it("never fires for a line that fits its own cue window (not isExtended), even right next to another cue", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 1 });
      const due = vi.fn();
      scheduler.onExtendedPauseDue(due);
      scheduler.setCues([cue(0, 1), cue(1.2, 2, "world")]);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      expect(due).not.toHaveBeenCalled();
    });

    it("does NOT fire the instant an isExtended line becomes due when the next cue is still far away", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });
      const due = vi.fn();
      scheduler.onExtendedPauseDue(due);
      scheduler.setCues([cue(0, 1), cue(10, 11, "world")]); // 9s gap before the next cue
      ticker.tick();
      await flushMicrotasks();
      ticker.tick(); // line starts playing at currentTime=0

      expect(due).not.toHaveBeenCalled();
    });

    it("fires once currentTime closes in on the NEXT cue's own start, not this cue's, for a still-playing isExtended line", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });
      const due = vi.fn();
      scheduler.onExtendedPauseDue(due);
      scheduler.setCues([cue(0, 1), cue(10, 11, "world")]);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();
      expect(due).not.toHaveBeenCalled();

      rampCurrentTimeTo(5); // well before the next cue
      expect(due).not.toHaveBeenCalled();

      rampCurrentTimeTo(9.9); // within the default 0.15s lead of the next cue's start (10)
      expect(due).toHaveBeenCalledTimes(1);
      expect(due).toHaveBeenCalledWith(expect.stringContaining("0:1:hello"));
    });

    it("fires at most once per playing cue, even across many ticks past the threshold", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });
      const due = vi.fn();
      scheduler.onExtendedPauseDue(due);
      scheduler.setCues([cue(0, 1), cue(10, 11, "world")]);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      rampCurrentTimeTo(9.9);
      setCurrentTime(9.95);
      ticker.tick();
      setCurrentTime(9.99);
      ticker.tick();

      expect(due).toHaveBeenCalledTimes(1);
    });

    it("fires immediately when there is no next cue (the last one currently known) — the conservative fallback", async () => {
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });
      const due = vi.fn();
      scheduler.onExtendedPauseDue(due);
      scheduler.setCues([cue(0, 1)]); // only cue in the list
      ticker.tick();
      await flushMicrotasks();
      ticker.tick(); // line starts playing at currentTime=0, no next cue to sync to

      expect(due).toHaveBeenCalledTimes(1);
      expect(due).toHaveBeenCalledWith(expect.stringContaining("0:1:hello"));
    });

    it("respects a custom extendedPauseLeadSeconds", async () => {
      const customScheduler = new VoiceOverCueScheduler({
        gateway,
        ticker,
        lookaheadSeconds: 6,
        lateStartGraceSeconds: 4,
        extendedPauseLeadSeconds: 2,
      });
      customScheduler.attach(video);
      customScheduler.setLanguageCode("en");
      gateway.lineResultByKey.set("en:hello", { success: true, audioUrl: "blob:1", durationSeconds: 5 });
      const due = vi.fn();
      customScheduler.onExtendedPauseDue(due);
      customScheduler.setCues([cue(0, 1), cue(10, 11, "world")]);
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      rampCurrentTimeTo(7.9); // outside a 2s lead (threshold would be 8)
      expect(due).not.toHaveBeenCalled();

      rampCurrentTimeTo(8.1); // now within the custom 2s lead of the next cue's start (10)
      expect(due).toHaveBeenCalledTimes(1);
    });
  });

  describe("onLineSkipped vs onLineFailed mutual exclusivity", () => {
    it("fires onLineSkipped, never onLineFailed, for a non-dialogue cue", () => {
      const skipped = vi.fn();
      const failed = vi.fn();
      scheduler.onLineSkipped(skipped);
      scheduler.onLineFailed(failed);
      scheduler.setCues([cue(0, 2, "[door creaks]")]);

      expect(skipped).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
    });

    it("fires onLineSkipped, never onLineFailed, when a seek drops a cue that's now in the past", () => {
      const skipped = vi.fn();
      const failed = vi.fn();
      scheduler.onLineSkipped(skipped);
      scheduler.onLineFailed(failed);
      scheduler.setCues([cue(0, 1)]);
      setCurrentTime(0);
      ticker.tick();
      setCurrentTime(5); // seek past the cue's window
      ticker.tick();

      expect(skipped).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
    });

    it("fires onLineFailed, never onLineSkipped, for a gateway failure result", async () => {
      gateway.lineResultByKey.set("en:hello", { success: false, error: "tts down" });
      const skipped = vi.fn();
      const failed = vi.fn();
      scheduler.onLineSkipped(skipped);
      scheduler.onLineFailed(failed);
      scheduler.setCues([cue(0, 2)]);
      ticker.tick();
      await flushMicrotasks();

      expect(failed).toHaveBeenCalledTimes(1);
      expect(skipped).not.toHaveBeenCalled();
    });

    it("fires onLineFailed, never onLineSkipped, for an unexpected gateway throw", async () => {
      gateway.generateLine = () => Promise.reject(new Error("boom"));
      const skipped = vi.fn();
      const failed = vi.fn();
      scheduler.onLineSkipped(skipped);
      scheduler.onLineFailed(failed);
      scheduler.setCues([cue(0, 2)]);
      ticker.tick();
      await flushMicrotasks();

      expect(failed).toHaveBeenCalledTimes(1);
      expect(skipped).not.toHaveBeenCalled();
    });
  });

  describe("AbortSignal", () => {
    it("passes an AbortSignal to generateLine and aborts it when superseded by a language switch", async () => {
      let capturedSignal: AbortSignal | undefined;
      gateway.generateLine = (_request, signal) => {
        capturedSignal = signal;
        return new Promise(() => {}); // never resolves
      };
      scheduler.setCues([cue(0, 2)]);
      ticker.tick();

      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal?.aborted).toBe(false);

      scheduler.setLanguageCode("es");
      expect(capturedSignal?.aborted).toBe(true);
    });

    it("aborts the in-flight signal on dispose()", () => {
      let capturedSignal: AbortSignal | undefined;
      gateway.generateLine = (_request, signal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      };
      scheduler.setCues([cue(0, 2)]);
      ticker.tick();

      scheduler.dispose();
      expect(capturedSignal?.aborted).toBe(true);
    });

    it("aborts the in-flight signal when a seek drops the pending cue into the past", () => {
      let capturedSignal: AbortSignal | undefined;
      gateway.generateLine = (_request, signal) => {
        capturedSignal = signal;
        return new Promise(() => {});
      };
      scheduler.setCues([cue(0, 1)]);
      setCurrentTime(0);
      ticker.tick();
      expect(capturedSignal?.aborted).toBe(false);

      setCurrentTime(5);
      ticker.tick();
      expect(capturedSignal?.aborted).toBe(true);
    });

    it("treats an AbortError rejection the same as any other unexpected rejection", async () => {
      const abortError = new DOMException("aborted", "AbortError");
      gateway.generateLine = () => Promise.reject(abortError);
      const failed = vi.fn();
      scheduler.onLineFailed(failed);
      scheduler.setCues([cue(0, 2)]);
      ticker.tick();
      await flushMicrotasks();

      expect(failed).toHaveBeenCalledWith(expect.any(String), "aborted", true);
      expect(() => ticker.tick()).not.toThrow();
    });
  });

  describe("fuzz: randomized tick/seek/pause/track-switch sequences", () => {
    // Hand-rolled seeded PRNG (mulberry32) rather than a property-testing
    // dependency — this repo has no existing fuzz-testing convention to
    // extend, and a seeded generator keeps every run fully deterministic
    // and reproducible on failure, unlike real Math.random().
    function mulberry32(seed: number) {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function runFuzzSeed(seed: number, steps: number) {
      const rng = mulberry32(seed);
      const fuzzGateway = new MockVoiceOverGateway();
      const fuzzTicker = new ManualVoiceOverTicker();
      const fuzzScheduler = new VoiceOverCueScheduler({
        gateway: fuzzGateway,
        ticker: fuzzTicker,
        lookaheadSeconds: 3,
        lateStartGraceSeconds: 2,
      });
      const fuzzVideo = fakeVideo(0, false, 4);
      fuzzScheduler.attach(fuzzVideo);
      fuzzScheduler.setLanguageCode("en");

      const cues = [cue(0, 1, "a"), cue(1.5, 2.5, "b"), cue(3, 4, "c"), cue(4.5, 5.5, "d")];
      for (const c of cues) {
        fuzzGateway.lineResultByKey.set(`en:${c.text}`, {
          success: true,
          audioUrl: `blob:${c.text}`,
          durationSeconds: c.endSeconds - c.startSeconds,
        });
      }
      fuzzScheduler.setCues(cues);

      const statusByKey = new Map<string, string>();
      fuzzScheduler.onCueStateChanged((key, status) => statusByKey.set(key, status));

      let violation: string | null = null;
      fuzzScheduler.onLineReady((line) => {
        const playingCount = [...statusByKey.values()].filter((s) => s === "playing").length;
        if (statusByKey.get(line.cueKey) !== "playing") {
          violation = `onLineReady fired for ${line.cueKey} but its mirrored status is ${statusByKey.get(line.cueKey)}, not "playing"`;
        } else if (playingCount !== 1) {
          violation = `onLineReady fired while ${playingCount} cues are marked "playing" (expected exactly 1)`;
        }
      });

      let currentTime = 0;
      let paused = false;
      for (let step = 0; step < steps && !violation; step++) {
        const action = rng();
        if (action < 0.4) {
          currentTime += rng() * 0.5; // normal small advance
        } else if (action < 0.6) {
          currentTime = rng() * 7; // seek (forward or backward) anywhere in range
        } else if (action < 0.75) {
          paused = !paused;
        } else if (action < 0.9) {
          fuzzScheduler.setLanguageCode(rng() < 0.5 ? "en" : "es"); // "es" has no configured mock results — exercises unresolved/failed synthesis under fuzzing too
        } else {
          fuzzScheduler.setCues(cues); // re-arm everything, as a subtitle-track rebind would
        }

        Object.defineProperty(fuzzVideo, "currentTime", { value: currentTime, configurable: true });
        Object.defineProperty(fuzzVideo, "paused", { value: paused, configurable: true });
        fuzzTicker.tick();

        // Both the mirror and isGenerating are updated synchronously within
        // tick() — the mock gateway's resolution is a microtask that hasn't
        // run yet at this point, so these must agree exactly, every step.
        const pendingCount = [...statusByKey.values()].filter((s) => s === "pending").length;
        if ((pendingCount > 0) !== fuzzScheduler.isGenerating) {
          violation = `isGenerating=${fuzzScheduler.isGenerating} but mirrored pending count is ${pendingCount}`;
        }
      }

      fuzzScheduler.dispose();
      return violation;
    }

    it.each([1, 2, 3, 4, 5])("holds invariants over a randomized sequence (seed %i)", (seed) => {
      const violation = runFuzzSeed(seed, 60);
      expect(violation).toBeNull();
    });
  });

  describe("maxConcurrentSynthesis", () => {
    it("caps in-flight generateLine calls and eventually synthesizes the rest as slots free up", async () => {
      const capped = new VoiceOverCueScheduler({
        gateway,
        ticker,
        lookaheadSeconds: 6,
        lateStartGraceSeconds: 4,
        maxConcurrentSynthesis: 3,
      });
      capped.attach(video);
      capped.setLanguageCode("en");

      const cues = Array.from({ length: 10 }, (_, i) => cue(i * 0.01, i * 0.01 + 1, `c${i}`));
      for (const c of cues) {
        gateway.lineResultByKey.set(`en:${c.text}`, { success: true, audioUrl: `blob:${c.text}`, durationSeconds: 1 });
      }
      capped.setCues(cues);
      setCurrentTime(0);

      ticker.tick();
      expect(gateway.generateLineCalls).toHaveLength(3);

      await flushMicrotasks(); // all 3 in-flight requests resolve
      ticker.tick(); // frees slots, enqueues the next batch
      expect(gateway.generateLineCalls.length).toBeGreaterThan(3);

      await flushMicrotasks();
      ticker.tick();
      await flushMicrotasks();
      ticker.tick();

      expect(gateway.generateLineCalls).toHaveLength(10);
    });
  });
});
