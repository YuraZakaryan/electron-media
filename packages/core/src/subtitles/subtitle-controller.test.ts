import { describe, expect, it, vi } from "vitest";

import { asSubtitleSourceId, asSubtitleTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { MockSubtitleSource } from "../testing/mock-subtitle-source.js";
import { SubtitleController } from "./subtitle-controller.js";
import { SubtitleDelayProcessor } from "./subtitle-delay-processor.js";
import { SubtitleRegistry } from "./subtitle-registry.js";
import { SubtitleSelectionService } from "./subtitle-selection-service.js";

import type { CanonicalCue } from "../types/cue.js";
import type { SubtitleTrack } from "../types/track.js";
import type { ISubtitleSource } from "./subtitle-source.js";

/**
 * Reproduces OpenSubtitlesSource's cache-hit behavior: selectTrack() emits
 * cues SYNCHRONOUSLY, from within the call itself (not on a later
 * microtask), simulating a track whose cues were already downloaded.
 */
class SyncEmittingSubtitleSource implements ISubtitleSource {
  private cueListeners = new Set<(cues: readonly CanonicalCue[]) => void>();

  constructor(
    readonly sourceId: ReturnType<typeof asSubtitleSourceId>,
    private readonly tracks: SubtitleTrack[],
    private readonly cachedCues: readonly CanonicalCue[]
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

const track = (id: number, sourceId: string): SubtitleTrack => ({
  trackId: asSubtitleTrackId(id),
  displayName: `Track ${id}`,
  kind: TrackKind.Manual,
  sourceId: asSubtitleSourceId(sourceId),
});

function stubRenderer() {
  return { render: vi.fn(), clear: vi.fn(), isIntact: vi.fn(() => true) };
}

function fakeVideoWithListenerCapture() {
  const listenersByEvent = new Map<string, Set<() => void>>();
  const video = {
    addEventListener: vi.fn((event: string, callback: () => void) => {
      const listeners = listenersByEvent.get(event) ?? new Set();
      listeners.add(callback);
      listenersByEvent.set(event, listeners);
    }),
    removeEventListener: vi.fn((event: string, callback: () => void) => {
      listenersByEvent.get(event)?.delete(callback);
    }),
  } as unknown as HTMLVideoElement;
  return { video, listenersByEvent };
}

function setup(sources: MockSubtitleSource[]) {
  const registry = new SubtitleRegistry({ sources });
  const selection = new SubtitleSelectionService({ registry });
  const delay = new SubtitleDelayProcessor();
  const renderer = stubRenderer();
  const controller = new SubtitleController({
    registry,
    selection,
    delay,
    renderer,
  });
  return { controller, renderer };
}

describe("SubtitleController", () => {
  it("selects the track on its owning source", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
    ]);
    const { controller } = setup([sourceA]);

    controller.selectTrack(asSubtitleTrackId(1));

    expect(sourceA.selectedTrackId).toBe(1);
  });

  it("deselects the previously active source when switching to a track on a different source", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
    ]);
    const sourceB = new MockSubtitleSource(asSubtitleSourceId("b"), [
      track(2, "b"),
    ]);
    const { controller } = setup([sourceA, sourceB]);

    controller.selectTrack(asSubtitleTrackId(1));
    controller.selectTrack(asSubtitleTrackId(2));

    expect(sourceA.selectedTrackId).toBeNull();
    expect(sourceB.selectedTrackId).toBe(2);
  });

  it("deselects the previously active source when turning subtitles off", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
    ]);
    const { controller } = setup([sourceA]);

    controller.selectTrack(asSubtitleTrackId(1));
    controller.selectTrack(null);

    expect(sourceA.selectedTrackId).toBeNull();
  });

  it("does not re-deselect the same source when switching between its own tracks", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
      track(2, "a"),
    ]);
    const { controller } = setup([sourceA]);

    controller.selectTrack(asSubtitleTrackId(1));
    controller.selectTrack(asSubtitleTrackId(2));

    // The source's own selectTrack(2) call already transitioned it away
    // from track 1 — selectedTrackId reflects the latest call, not a
    // spurious extra null in between.
    expect(sourceA.selectedTrackId).toBe(2);
  });

  it("exposes the currently selected track and notifies subscribers", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
    ]);
    const { controller } = setup([sourceA]);
    const listener = vi.fn();
    controller.onSelectionChanged(listener);

    controller.selectTrack(asSubtitleTrackId(1));

    expect(controller.selectedTrack).toEqual(track(1, "a"));
    expect(listener).toHaveBeenCalledWith(track(1, "a"));
  });

  it("delivers cues emitted synchronously from within selectTrack (cache-hit case)", () => {
    const cues: CanonicalCue[] = [
      { startSeconds: 1, endSeconds: 2, text: "cached" },
    ];
    const source = new SyncEmittingSubtitleSource(
      asSubtitleSourceId("sync"),
      [track(1, "sync")],
      cues
    );
    const { controller, renderer } = setup([
      source as unknown as MockSubtitleSource,
    ]);
    const fakeVideo = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    controller.attach(fakeVideo);

    controller.selectTrack(asSubtitleTrackId(1));

    expect(renderer.render).toHaveBeenCalledWith(fakeVideo, cues);
  });

  it("clears the previous source's cues when switching to a source that emits nothing synchronously", () => {
    // The regression this guards: switching from a cache-hit source
    // (OpenSubtitles-like, emits from inside selectTrack) to one that emits
    // later or never — a still-fetching VodExtractedSubtitleSource, or
    // HlsNativeSubtitleSource which never emits at all — used to leave the
    // FIRST source's cues rendered indefinitely. The new track read as
    // selected in the UI while the old subtitles kept showing on screen.
    const cues: CanonicalCue[] = [
      { startSeconds: 1, endSeconds: 2, text: "external" },
    ];
    const emitting = new SyncEmittingSubtitleSource(
      asSubtitleSourceId("external"),
      [track(1, "external")],
      cues
    );
    const silent = new MockSubtitleSource(asSubtitleSourceId("native"), [
      track(2, "native"),
    ]);
    const { controller, renderer } = setup([
      emitting as unknown as MockSubtitleSource,
      silent,
    ]);
    const fakeVideo = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    controller.attach(fakeVideo);

    controller.selectTrack(asSubtitleTrackId(1));
    expect(renderer.render).toHaveBeenLastCalledWith(fakeVideo, cues);

    controller.selectTrack(asSubtitleTrackId(2));

    expect(renderer.render).toHaveBeenLastCalledWith(fakeVideo, []);
  });

  describe("rendersNatively", () => {
    it("never calls renderer.render for a rendersNatively source, even once it has cues", () => {
      const native = new MockSubtitleSource(
        asSubtitleSourceId("native"),
        [track(1, "native")],
        true
      );
      const { controller, renderer } = setup([native]);
      const fakeVideo = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLVideoElement;
      controller.attach(fakeVideo);

      controller.selectTrack(asSubtitleTrackId(1));
      native.emitCues(asSubtitleTrackId(1), [
        { startSeconds: 0, endSeconds: 1, text: "hello" },
      ]);

      // The source paints this cue onto its OWN native TextTrack directly
      // (that's the whole point of rendersNatively) — render() must never
      // see it, or the browser would show it twice.
      expect(renderer.render).not.toHaveBeenCalled();
    });

    it("clears the renderer when switching from a normal source to a rendersNatively one", () => {
      const cues: CanonicalCue[] = [
        { startSeconds: 1, endSeconds: 2, text: "external" },
      ];
      const normal = new SyncEmittingSubtitleSource(
        asSubtitleSourceId("normal"),
        [track(1, "normal")],
        cues
      );
      const native = new MockSubtitleSource(
        asSubtitleSourceId("native"),
        [track(2, "native")],
        true
      );
      const { controller, renderer } = setup([
        normal as unknown as MockSubtitleSource,
        native,
      ]);
      const fakeVideo = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLVideoElement;
      controller.attach(fakeVideo);

      controller.selectTrack(asSubtitleTrackId(1));
      expect(renderer.render).toHaveBeenLastCalledWith(fakeVideo, cues);

      controller.selectTrack(asSubtitleTrackId(2));
      native.emitCues(asSubtitleTrackId(2), [
        { startSeconds: 0, endSeconds: 1, text: "should never render" },
      ]);

      expect(renderer.clear).toHaveBeenCalled();
      // render() was called exactly once — for the FIRST (normal) source —
      // and never again after switching to the native one.
      expect(renderer.render).toHaveBeenCalledTimes(1);
    });

    it("resumes normal rendering when switching from a rendersNatively source back to a normal one", () => {
      const native = new MockSubtitleSource(
        asSubtitleSourceId("native"),
        [track(1, "native")],
        true
      );
      const cues: CanonicalCue[] = [
        { startSeconds: 1, endSeconds: 2, text: "external" },
      ];
      const normal = new SyncEmittingSubtitleSource(
        asSubtitleSourceId("normal"),
        [track(2, "normal")],
        cues
      );
      const { controller, renderer } = setup([
        native,
        normal as unknown as MockSubtitleSource,
      ]);
      const fakeVideo = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as HTMLVideoElement;
      controller.attach(fakeVideo);

      controller.selectTrack(asSubtitleTrackId(1));
      controller.selectTrack(asSubtitleTrackId(2));

      expect(renderer.render).toHaveBeenLastCalledWith(fakeVideo, cues);
    });
  });

  it("renders exactly once when the newly selected source emits synchronously", () => {
    // Guards the other half of the fix above: re-rendering cues the
    // source's own synchronous emission already rendered would remove and
    // re-add every VTTCue, visibly flickering whichever cue is on screen.
    const cues: CanonicalCue[] = [
      { startSeconds: 1, endSeconds: 2, text: "first" },
    ];
    const other: CanonicalCue[] = [
      { startSeconds: 3, endSeconds: 4, text: "second" },
    ];
    const sourceA = new SyncEmittingSubtitleSource(
      asSubtitleSourceId("a"),
      [track(1, "a")],
      cues
    );
    const sourceB = new SyncEmittingSubtitleSource(
      asSubtitleSourceId("b"),
      [track(2, "b")],
      other
    );
    const { controller, renderer } = setup([
      sourceA as unknown as MockSubtitleSource,
      sourceB as unknown as MockSubtitleSource,
    ]);
    const fakeVideo = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    controller.attach(fakeVideo);

    controller.selectTrack(asSubtitleTrackId(1));
    const rendersAfterFirstSelect = renderer.render.mock.calls.length;

    controller.selectTrack(asSubtitleTrackId(2));

    expect(renderer.render.mock.calls.length).toBe(rendersAfterFirstSelect + 1);
    expect(renderer.render).toHaveBeenLastCalledWith(fakeVideo, other);
  });

  it("rebinds the active selection onto a replacement source registered under the same sourceId", () => {
    // The regression this guards: a host starting a new session (a seek that
    // re-runs the transcode) unregisters its VOD-extracted source and
    // registers a fresh instance under the same sourceId. The selection never
    // changes, so the selection service stays silent — the controller used to
    // keep its cue subscription on the disposed instance while the replacement
    // was never told anything was selected. The track read as selected and
    // rendered nothing until the user picked it again, on every seek.
    const registry = new SubtitleRegistry({ sources: [] });
    const selection = new SubtitleSelectionService({ registry });
    const delay = new SubtitleDelayProcessor();
    const renderer = stubRenderer();
    const controller = new SubtitleController({
      registry,
      selection,
      delay,
      renderer,
    });
    const fakeVideo = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    controller.attach(fakeVideo);

    const first = new MockSubtitleSource(asSubtitleSourceId("vod"), [
      track(1, "vod"),
    ]);
    registry.registerSource(first);
    controller.selectTrack(asSubtitleTrackId(1));
    expect(first.selectedTrackId).toBe(1);

    // The session swap.
    registry.unregisterSource(asSubtitleSourceId("vod"));
    const replacement = new MockSubtitleSource(asSubtitleSourceId("vod"), [
      track(1, "vod"),
    ]);
    registry.registerSource(replacement);

    // The replacement must have been told about the still-active selection…
    expect(replacement.selectedTrackId).toBe(1);
    // …and its cues must now reach the renderer.
    const cues: CanonicalCue[] = [
      { startSeconds: 1, endSeconds: 2, text: "after seek" },
    ];
    replacement.emitCues(asSubtitleTrackId(1), cues);
    expect(renderer.render).toHaveBeenLastCalledWith(fakeVideo, cues);
  });

  it("stops rendering cues emitted by a source that has been replaced", () => {
    const registry = new SubtitleRegistry({ sources: [] });
    const selection = new SubtitleSelectionService({ registry });
    const delay = new SubtitleDelayProcessor();
    const renderer = stubRenderer();
    const controller = new SubtitleController({
      registry,
      selection,
      delay,
      renderer,
    });
    const fakeVideo = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLVideoElement;
    controller.attach(fakeVideo);

    const first = new MockSubtitleSource(asSubtitleSourceId("vod"), [
      track(1, "vod"),
    ]);
    registry.registerSource(first);
    controller.selectTrack(asSubtitleTrackId(1));

    registry.unregisterSource(asSubtitleSourceId("vod"));
    const replacement = new MockSubtitleSource(asSubtitleSourceId("vod"), [
      track(1, "vod"),
    ]);
    registry.registerSource(replacement);
    renderer.render.mockClear();

    // A late emission from the disposed instance must not paint over what the
    // replacement is responsible for.
    first.emitCues(asSubtitleTrackId(1), [
      { startSeconds: 9, endSeconds: 10, text: "stale session" },
    ]);

    expect(renderer.render).not.toHaveBeenCalled();
  });

  it("leaves the selection alone when the replacement source no longer offers the selected track", () => {
    const registry = new SubtitleRegistry({ sources: [] });
    const selection = new SubtitleSelectionService({ registry });
    const delay = new SubtitleDelayProcessor();
    const renderer = stubRenderer();
    const controller = new SubtitleController({
      registry,
      selection,
      delay,
      renderer,
    });
    const first = new MockSubtitleSource(asSubtitleSourceId("vod"), [
      track(1, "vod"),
    ]);
    registry.registerSource(first);
    controller.selectTrack(asSubtitleTrackId(1));

    registry.unregisterSource(asSubtitleSourceId("vod"));
    const replacement = new MockSubtitleSource(asSubtitleSourceId("vod"), [
      track(2, "vod"),
    ]);
    registry.registerSource(replacement);

    expect(replacement.selectedTrackId).toBeNull();
  });

  it("self-heals when the renderer reports its cues were wiped from outside (e.g. by hls.js)", () => {
    vi.useFakeTimers();
    try {
      const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
        track(1, "a"),
      ]);
      const registry = new SubtitleRegistry({ sources: [sourceA] });
      const selection = new SubtitleSelectionService({ registry });
      const delay = new SubtitleDelayProcessor();
      const renderer = stubRenderer();
      const controller = new SubtitleController({
        registry,
        selection,
        delay,
        renderer,
      });
      const { video } = fakeVideoWithListenerCapture();

      controller.attach(video);
      controller.selectTrack(asSubtitleTrackId(1));
      renderer.render.mockClear();

      // Nothing wiped yet — the periodic tick must not re-render (that would
      // flicker the native TextTrack on every interval for no reason).
      renderer.isIntact.mockReturnValue(true);
      vi.advanceTimersByTime(500);
      expect(renderer.render).not.toHaveBeenCalled();

      // hls.js wiped the video's text tracks — the next tick must repair it.
      renderer.isIntact.mockReturnValue(false);
      vi.advanceTimersByTime(500);
      expect(renderer.render).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getTracks() returns the merged track list from the registry", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
    ]);
    const sourceB = new MockSubtitleSource(asSubtitleSourceId("b"), [
      track(2, "b"),
    ]);
    const { controller } = setup([sourceA, sourceB]);

    expect(controller.getTracks().map((t) => t.trackId)).toEqual([1, 2]);
  });
});
