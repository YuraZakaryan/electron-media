import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TextTrackCueRenderer } from "./text-track-cue-renderer.js";

import type { CanonicalCue } from "../types/cue.js";

/** Minimal stand-in for the `VTTCue` constructor, absent outside a browser. */
class FakeVTTCue {
  snapToLines = true;
  line: number | "auto" = "auto";
  lineAlign = "start";

  constructor(
    readonly startTime: number,
    readonly endTime: number,
    readonly text: string
  ) {}
}

/**
 * Fake `TextTrack` reproducing the single browser behavior this renderer has
 * to work around: per the HTML spec, `cues` reads as `null` while `mode` is
 * `"disabled"`. Anything that enumerates `cues` to remove them therefore sees
 * nothing at all while the track is off — which is how stale cues used to
 * survive a re-render and resurface on the next mode flip.
 */
class FakeTextTrack {
  mode: TextTrackMode = "hidden";
  private readonly cueList: FakeVTTCue[] = [];

  get cues(): FakeVTTCue[] | null {
    return this.mode === "disabled" ? null : this.cueList;
  }

  addCue(cue: FakeVTTCue): void {
    this.cueList.push(cue);
  }

  removeCue(cue: FakeVTTCue): void {
    const index = this.cueList.indexOf(cue);
    if (index >= 0) this.cueList.splice(index, 1);
  }

  /** Test-only: what is actually attached, regardless of `mode`. */
  get attachedTexts(): string[] {
    return this.cueList.map((cue) => cue.text);
  }
}

function setup() {
  const textTrack = new FakeTextTrack();
  const video = {
    addTextTrack: () => textTrack,
  } as unknown as HTMLVideoElement;
  return { textTrack, video };
}

const cue = (startSeconds: number, endSeconds: number, text: string): CanonicalCue => ({
  startSeconds,
  endSeconds,
  text,
});

describe("TextTrackCueRenderer", () => {
  let originalVttCue: unknown;

  beforeEach(() => {
    originalVttCue = (globalThis as { VTTCue?: unknown }).VTTCue;
    (globalThis as { VTTCue?: unknown }).VTTCue = FakeVTTCue;
  });

  afterEach(() => {
    (globalThis as { VTTCue?: unknown }).VTTCue = originalVttCue;
  });

  it("renders cues onto the track and shows it", () => {
    const { textTrack, video } = setup();
    const renderer = new TextTrackCueRenderer();

    renderer.render(video, [cue(1, 2, "first")]);

    expect(textTrack.attachedTexts).toEqual(["first"]);
    expect(textTrack.mode).toBe("showing");
  });

  it("replaces the previous cues on a subsequent render", () => {
    const { textTrack, video } = setup();
    const renderer = new TextTrackCueRenderer();

    renderer.render(video, [cue(1, 2, "first")]);
    renderer.render(video, [cue(3, 4, "second")]);

    expect(textTrack.attachedTexts).toEqual(["second"]);
  });

  it("removes stale cues even when an outside engine disabled the track first", () => {
    // The regression this guards: hls.js disables every text track it does
    // not own whenever its own `subtitleTrack` is set. `TextTrack.cues` is
    // null in that state, so the removal loop used to enumerate nothing —
    // leaving the previous selection's cues attached, which the mode flip at
    // the end of render() then put straight back on screen. Observed as
    // "switching subtitle source neither clears the old subtitles nor shows
    // the new ones".
    const { textTrack, video } = setup();
    const renderer = new TextTrackCueRenderer();
    renderer.render(video, [cue(1, 2, "stale")]);

    textTrack.mode = "disabled";
    renderer.render(video, []);

    expect(textTrack.attachedTexts).toEqual([]);
  });

  it("replaces — not appends — cues when the track was disabled between renders", () => {
    const { textTrack, video } = setup();
    const renderer = new TextTrackCueRenderer();
    renderer.render(video, [cue(1, 2, "old")]);

    textTrack.mode = "disabled";
    renderer.render(video, [cue(3, 4, "new")]);

    expect(textTrack.attachedTexts).toEqual(["new"]);
  });

  it("clear() detaches cues from an already-disabled track", () => {
    // Same null-cues trap: clear() left the cues attached, so re-showing the
    // track later resurrected subtitles the user had turned off.
    const { textTrack, video } = setup();
    const renderer = new TextTrackCueRenderer();
    renderer.render(video, [cue(1, 2, "off-but-attached")]);

    textTrack.mode = "disabled";
    renderer.clear();

    expect(textTrack.attachedTexts).toEqual([]);
    expect(textTrack.mode).toBe("disabled");
  });

  it("creates a track on a replacement <video> instead of reusing the previous element's", () => {
    // The regression this guards: a TextTrack belongs to the element it was
    // created on and cannot be moved. Caching it without checking the owner
    // meant a host that remounts its <video> — closing and reopening a player —
    // kept writing every later cue into the detached element's track. Nothing
    // appeared on screen, no error was raised, and the element actually being
    // played carried no text track at all.
    const first = setup();
    const renderer = new TextTrackCueRenderer();
    renderer.render(first.video, [cue(1, 2, "before remount")]);
    expect(first.textTrack.attachedTexts).toEqual(["before remount"]);

    const second = setup();
    renderer.render(second.video, [cue(3, 4, "after remount")]);

    expect(second.textTrack.attachedTexts).toEqual(["after remount"]);
    expect(second.textTrack.mode).toBe("showing");
    // The old element keeps whatever it had — it is being discarded, and a
    // track added via addTextTrack cannot be removed anyway.
    expect(first.textTrack.attachedTexts).toEqual(["before remount"]);
  });

  it("reports intact right after switching to a replacement <video>", () => {
    // The new track starts empty; carrying the previous element's cue count
    // over would make the repair loop see a wipe that never happened and
    // re-render on every tick.
    const first = setup();
    const renderer = new TextTrackCueRenderer();
    renderer.render(first.video, [cue(1, 2, "before remount")]);

    const second = setup();
    renderer.render(second.video, []);

    expect(renderer.isIntact()).toBe(true);
  });

  it("clear() before anything was rendered does not throw", () => {
    const renderer = new TextTrackCueRenderer();

    expect(() => renderer.clear()).not.toThrow();
  });

  it("skips cues whose end is at or before their start", () => {
    const { textTrack, video } = setup();
    const renderer = new TextTrackCueRenderer();

    renderer.render(video, [cue(5, 5, "zero-length"), cue(6, 5, "inverted"), cue(1, 2, "valid")]);

    expect(textTrack.attachedTexts).toEqual(["valid"]);
  });

  it("skips a cue left entirely in negative time by an offset, and keeps one that straddles zero", () => {
    const { textTrack, video } = setup();
    const renderer = new TextTrackCueRenderer();

    renderer.render(video, [cue(-9, -4, "before-session"), cue(-1, 3, "straddles")]);

    expect(textTrack.attachedTexts).toEqual(["straddles"]);
  });

  it("applies a cueLine getter freshly on every render", () => {
    const { textTrack, video } = setup();
    let line = 80;
    const renderer = new TextTrackCueRenderer({ cueLine: () => line });

    renderer.render(video, [cue(1, 2, "first")]);
    expect((textTrack.cues as FakeVTTCue[])[0].line).toBe(80);
    expect((textTrack.cues as FakeVTTCue[])[0].snapToLines).toBe(false);
    expect((textTrack.cues as FakeVTTCue[])[0].lineAlign).toBe("end");

    line = 60;
    renderer.render(video, [cue(3, 4, "second")]);
    expect((textTrack.cues as FakeVTTCue[])[0].line).toBe(60);
  });

  it("reports not-intact once a track it populated has been disabled from outside", () => {
    const { textTrack, video } = setup();
    const renderer = new TextTrackCueRenderer();
    renderer.render(video, [cue(1, 2, "rendered")]);
    expect(renderer.isIntact()).toBe(true);

    textTrack.mode = "disabled";

    expect(renderer.isIntact()).toBe(false);
  });

  it("reports intact when the last render legitimately had zero cues", () => {
    const { video } = setup();
    const renderer = new TextTrackCueRenderer();

    renderer.render(video, []);

    expect(renderer.isIntact()).toBe(true);
  });
});
