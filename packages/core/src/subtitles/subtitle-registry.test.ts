import { describe, expect, it, vi } from "vitest";

import { asSubtitleSourceId, asSubtitleTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { MockSubtitleSource } from "../testing/mock-subtitle-source.js";
import { SubtitleRegistry } from "./subtitle-registry.js";

import type { SubtitleTrack } from "../types/track.js";

const track = (id: number, sourceId: string): SubtitleTrack => ({
  trackId: asSubtitleTrackId(id),
  displayName: `Track ${id}`,
  kind: TrackKind.Manual,
  sourceId: asSubtitleSourceId(sourceId),
});

describe("SubtitleRegistry", () => {
  it("merges tracks from every source passed to the constructor", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
    ]);
    const sourceB = new MockSubtitleSource(asSubtitleSourceId("b"), [
      track(2, "b"),
      track(3, "b"),
    ]);

    const registry = new SubtitleRegistry({ sources: [sourceA, sourceB] });

    expect(registry.getTracks().map((t) => t.trackId)).toEqual([1, 2, 3]);
  });

  it("notifies subscribers when a registered source's own track list changes", () => {
    const source = new MockSubtitleSource(asSubtitleSourceId("a"), []);
    const registry = new SubtitleRegistry({ sources: [source] });
    const listener = vi.fn();
    registry.onTracksChanged(listener);

    source.setTracks([track(1, "a")]);

    expect(listener).toHaveBeenCalledWith([track(1, "a")]);
  });

  it("merges in a source registered after construction", () => {
    const registry = new SubtitleRegistry({ sources: [] });
    const source = new MockSubtitleSource(asSubtitleSourceId("late"), [
      track(9, "late"),
    ]);

    registry.registerSource(source);

    expect(registry.getTracks()).toEqual([track(9, "late")]);
  });

  it("notifies subscribers immediately when a source is registered", () => {
    const registry = new SubtitleRegistry({ sources: [] });
    const listener = vi.fn();
    registry.onTracksChanged(listener);

    registry.registerSource(
      new MockSubtitleSource(asSubtitleSourceId("late"), [track(1, "late")])
    );

    expect(listener).toHaveBeenCalledWith([track(1, "late")]);
  });

  it("disposes and removes a source on unregisterSource", () => {
    const source = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
    ]);
    const registry = new SubtitleRegistry({ sources: [source] });

    registry.unregisterSource(asSubtitleSourceId("a"));

    expect(source.disposed).toBe(true);
    expect(registry.getTracks()).toEqual([]);
  });

  it("no-ops when unregistering a sourceId that was never registered", () => {
    const registry = new SubtitleRegistry({ sources: [] });
    expect(() =>
      registry.unregisterSource(asSubtitleSourceId("missing"))
    ).not.toThrow();
  });

  it("findSourceForTrack returns the owning source", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
    ]);
    const registry = new SubtitleRegistry({ sources: [sourceA] });

    expect(registry.findSourceForTrack(asSubtitleTrackId(1))).toBe(sourceA);
    expect(registry.findSourceForTrack(asSubtitleTrackId(999))).toBeUndefined();
  });

  it("getSource returns the source registered under a sourceId", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), []);
    const registry = new SubtitleRegistry({ sources: [sourceA] });

    expect(registry.getSource(asSubtitleSourceId("a"))).toBe(sourceA);
    expect(registry.getSource(asSubtitleSourceId("missing"))).toBeUndefined();
  });

  it("dispose() disposes every registered source and clears the track list", () => {
    const sourceA = new MockSubtitleSource(asSubtitleSourceId("a"), [
      track(1, "a"),
    ]);
    const sourceB = new MockSubtitleSource(asSubtitleSourceId("b"), [
      track(2, "b"),
    ]);
    const registry = new SubtitleRegistry({ sources: [sourceA, sourceB] });

    registry.dispose();

    expect(sourceA.disposed).toBe(true);
    expect(sourceB.disposed).toBe(true);
    expect(registry.getTracks()).toEqual([]);
  });
});
