import { describe, expect, it, vi } from "vitest";

import { asSubtitleSourceId, asSubtitleTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { MockSubtitleSource } from "../testing/mock-subtitle-source.js";
import { SubtitleRegistry } from "./subtitle-registry.js";
import { SubtitleSelectionService } from "./subtitle-selection-service.js";

import type { SubtitleTrack } from "../types/track.js";

const track = (id: number): SubtitleTrack => ({
  trackId: asSubtitleTrackId(id),
  displayName: `Track ${id}`,
  kind: TrackKind.Manual,
  sourceId: asSubtitleSourceId("a"),
});

function setup(tracks: SubtitleTrack[]) {
  const source = new MockSubtitleSource(asSubtitleSourceId("a"), tracks);
  const registry = new SubtitleRegistry({ sources: [source] });
  const selection = new SubtitleSelectionService({ registry });
  return { source, registry, selection };
}

describe("SubtitleSelectionService", () => {
  it("starts with no selection", () => {
    const { selection } = setup([track(1)]);
    expect(selection.selected).toBeNull();
  });

  it("selects a track present in the registry", () => {
    const { selection } = setup([track(1), track(2)]);
    selection.select(asSubtitleTrackId(2));
    expect(selection.selected).toEqual(track(2));
  });

  it("ignores selecting a trackId the registry doesn't have", () => {
    const { selection } = setup([track(1)]);
    selection.select(asSubtitleTrackId(999));
    expect(selection.selected).toBeNull();
  });

  it("clears the selection when selecting null", () => {
    const { selection } = setup([track(1)]);
    selection.select(asSubtitleTrackId(1));
    selection.select(null);
    expect(selection.selected).toBeNull();
  });

  it("notifies subscribers when the selection changes", () => {
    const { selection } = setup([track(1)]);
    const listener = vi.fn();
    selection.onSelectionChanged(listener);

    selection.select(asSubtitleTrackId(1));

    expect(listener).toHaveBeenCalledWith(track(1));
  });

  it("does not notify subscribers when re-selecting the already-active track", () => {
    const { selection } = setup([track(1)]);
    selection.select(asSubtitleTrackId(1));
    const listener = vi.fn();
    selection.onSelectionChanged(listener);

    selection.select(asSubtitleTrackId(1));

    expect(listener).not.toHaveBeenCalled();
  });

  it("stops notifying once unsubscribed", () => {
    const { selection } = setup([track(1)]);
    const listener = vi.fn();
    const unsubscribe = selection.onSelectionChanged(listener);

    unsubscribe();
    selection.select(asSubtitleTrackId(1));

    expect(listener).not.toHaveBeenCalled();
  });
});
