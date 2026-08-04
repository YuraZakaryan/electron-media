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
