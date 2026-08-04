import { describe, expect, it, vi } from "vitest";

import { asAudioTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { MockHlsAdapter } from "../testing/mock-hls-adapter.js";
import { AudioTrackController } from "./audio-track-controller.js";

import type { AudioTrack } from "../types/track.js";
import type { PlayerPreferenceStore } from "../contracts/preference-store.js";

const track = (
  id: number,
  language: string,
  kind: TrackKind = TrackKind.Manual
): AudioTrack => ({
  trackId: asAudioTrackId(id),
  displayName: language,
  language,
  kind,
});

function makePreferenceStore(
  storedAudioLanguage: string | null = null
): PlayerPreferenceStore {
  return {
    getAudioLanguage: vi.fn(() => storedAudioLanguage),
    setAudioLanguage: vi.fn(),
    getSubtitleLanguage: vi.fn(() => null),
    setSubtitleLanguage: vi.fn(),
  };
}

describe("AudioTrackController", () => {
  it("auto-selects the track matching the stored language preference", () => {
    const adapter = new MockHlsAdapter();
    const preferenceStore = makePreferenceStore("fr");
    new AudioTrackController({ adapter, preferenceStore });

    adapter.emit("audioTracksChanged", {
      tracks: [track(1, "en", TrackKind.Default), track(2, "fr")],
    });

    expect(adapter.selectedAudioTrackId).toBe(2);
  });

  it("falls back to the default-kind track when no stored language matches", () => {
    const adapter = new MockHlsAdapter();
    const preferenceStore = makePreferenceStore("de");
    new AudioTrackController({ adapter, preferenceStore });

    adapter.emit("audioTracksChanged", {
      tracks: [track(1, "en", TrackKind.Default), track(2, "fr")],
    });

    expect(adapter.selectedAudioTrackId).toBe(1);
  });

  it("falls back to the first track when there is no stored language and no default-kind track", () => {
    const adapter = new MockHlsAdapter();
    new AudioTrackController({ adapter });

    adapter.emit("audioTracksChanged", {
      tracks: [track(1, "en"), track(2, "fr")],
    });

    expect(adapter.selectedAudioTrackId).toBe(1);
  });

  it("stops auto-selecting once the user has explicitly selected a track", () => {
    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });

    adapter.emit("audioTracksChanged", {
      tracks: [track(1, "en", TrackKind.Default), track(2, "fr")],
    });
    controller.select(asAudioTrackId(2));

    adapter.emit("audioTracksChanged", {
      tracks: [track(1, "en", TrackKind.Default), track(2, "fr")],
    });

    expect(adapter.selectedAudioTrackId).toBe(2);
  });

  it("re-applies the stored language to a new stream's tracks after a detach, despite an earlier explicit select", () => {
    // The regression this guards: a seek that rebuilds the underlying engine
    // makes the adapter report an empty list and then the new instance's
    // tracks. The `hasUserSelected` latch used to survive that and short-
    // circuit the restore, so the replacement instance — which carries no
    // selection of its own — fell back to the manifest default and the user's
    // audio choice was lost on every seek.
    const adapter = new MockHlsAdapter();
    const preferenceStore = makePreferenceStore("fr");
    const controller = new AudioTrackController({ adapter, preferenceStore });
    const tracks = [track(1, "en", TrackKind.Default), track(2, "fr")];

    // A real adapter's getAudioTracks() reflects whatever it last reported, so
    // the mock's snapshot is kept in step with each emission.
    adapter.audioTracks = tracks;
    adapter.emit("audioTracksChanged", { tracks });
    controller.select(asAudioTrackId(2));
    expect(preferenceStore.setAudioLanguage).toHaveBeenCalledWith("fr");

    // Seek: adapter detaches from the old instance, then the fresh one reports
    // the same renditions with nothing selected yet.
    adapter.audioTracks = [];
    adapter.emit("audioTracksChanged", { tracks: [] });
    adapter.selectedAudioTrackId = null;
    adapter.audioTracks = tracks;
    adapter.emit("audioTracksChanged", { tracks });

    expect(adapter.selectedAudioTrackId).toBe(2);
  });

  it("keeps reporting the current selection when the adapter reports an empty list", () => {
    // The latch reset above must not double as a selection reset: the UI would
    // flash "no audio track" on every seek.
    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });
    adapter.emit("audioTracksChanged", { tracks: [track(1, "en", TrackKind.Default)] });
    const listener = vi.fn();
    controller.onSelectionChanged(listener);

    adapter.emit("audioTracksChanged", { tracks: [] });

    expect(listener).not.toHaveBeenCalled();
    expect(controller.selectedTrackId).toBe(1);
  });

  it("select() sets the adapter's audio track", () => {
    const adapter = new MockHlsAdapter();
    adapter.audioTracks = [track(1, "en"), track(2, "fr")];
    const controller = new AudioTrackController({ adapter });

    controller.select(asAudioTrackId(2));

    expect(adapter.selectedAudioTrackId).toBe(2);
  });

  it("select() persists the chosen track's language to the preference store", () => {
    const adapter = new MockHlsAdapter();
    adapter.audioTracks = [track(1, "en"), track(2, "fr")];
    const preferenceStore = makePreferenceStore();
    const controller = new AudioTrackController({ adapter, preferenceStore });

    controller.select(asAudioTrackId(2));

    expect(preferenceStore.setAudioLanguage).toHaveBeenCalledWith("fr");
  });

  it("select() does not touch the preference store for an unknown trackId", () => {
    const adapter = new MockHlsAdapter();
    const preferenceStore = makePreferenceStore();
    const controller = new AudioTrackController({ adapter, preferenceStore });

    controller.select(asAudioTrackId(999));

    expect(preferenceStore.setAudioLanguage).not.toHaveBeenCalled();
  });

  it("starts with no selected track", () => {
    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });
    expect(controller.selectedTrackId).toBeNull();
  });

  it("tracks the selected trackId after an explicit select()", () => {
    const adapter = new MockHlsAdapter();
    adapter.audioTracks = [track(1, "en"), track(2, "fr")];
    const controller = new AudioTrackController({ adapter });

    controller.select(asAudioTrackId(2));

    expect(controller.selectedTrackId).toBe(2);
  });

  it("tracks the selected trackId after auto-selection", () => {
    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });

    adapter.emit("audioTracksChanged", {
      tracks: [track(1, "en", TrackKind.Default), track(2, "fr")],
    });

    expect(controller.selectedTrackId).toBe(1);
  });

  it("notifies onSelectionChanged when the selection changes", () => {
    const adapter = new MockHlsAdapter();
    adapter.audioTracks = [track(1, "en"), track(2, "fr")];
    const controller = new AudioTrackController({ adapter });
    const listener = vi.fn();
    controller.onSelectionChanged(listener);

    controller.select(asAudioTrackId(2));

    expect(listener).toHaveBeenCalledWith(2);
  });

  it("does not notify onSelectionChanged for re-selecting the same track", () => {
    const adapter = new MockHlsAdapter();
    adapter.audioTracks = [track(1, "en")];
    const controller = new AudioTrackController({ adapter });
    controller.select(asAudioTrackId(1));
    const listener = vi.fn();
    controller.onSelectionChanged(listener);

    controller.select(asAudioTrackId(1));

    expect(listener).not.toHaveBeenCalled();
  });

  it("getTracks() delegates to the adapter", () => {
    const adapter = new MockHlsAdapter();
    adapter.audioTracks = [track(1, "en")];
    const controller = new AudioTrackController({ adapter });

    expect(controller.getTracks()).toEqual([track(1, "en")]);
  });

  it("onTracksChanged() fires when the adapter reports new tracks", () => {
    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });
    const listener = vi.fn();
    controller.onTracksChanged(listener);

    adapter.emit("audioTracksChanged", { tracks: [track(1, "en")] });

    expect(listener).toHaveBeenCalledWith([track(1, "en")]);
  });

  it("works with no preference store at all", () => {
    const adapter = new MockHlsAdapter();
    const controller = new AudioTrackController({ adapter });

    expect(() => {
      adapter.emit("audioTracksChanged", { tracks: [track(1, "en")] });
      controller.select(asAudioTrackId(1));
    }).not.toThrow();
  });
});
