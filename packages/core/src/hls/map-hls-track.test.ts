import { describe, expect, it } from "vitest";

import { asSubtitleSourceId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { mapHlsAudioTrack, mapHlsSubtitleTrack } from "./map-hls-track.js";

import type { MediaPlaylist } from "hls.js";

function playlist(overrides: Partial<MediaPlaylist> = {}): MediaPlaylist {
  return { default: false, name: undefined, lang: undefined, ...overrides } as MediaPlaylist;
}

describe("mapHlsAudioTrack", () => {
  it("brands the track id from the given index", () => {
    expect(mapHlsAudioTrack(playlist(), 3).trackId).toBe(3);
  });

  it("maps default: true to TrackKind.Default and false to TrackKind.Manual", () => {
    expect(mapHlsAudioTrack(playlist({ default: true }), 0).kind).toBe(TrackKind.Default);
    expect(mapHlsAudioTrack(playlist({ default: false }), 0).kind).toBe(TrackKind.Manual);
  });

  it("passes the playlist's language through unchanged", () => {
    expect(mapHlsAudioTrack(playlist({ lang: "es" }), 0).language).toBe("es");
  });

  it("prefers name over lang for displayName", () => {
    expect(mapHlsAudioTrack(playlist({ name: "Director's Commentary", lang: "en" }), 0).displayName).toBe(
      "Director's Commentary",
    );
  });

  it("falls back to lang when name is absent", () => {
    expect(mapHlsAudioTrack(playlist({ lang: "fr" }), 0).displayName).toBe("fr");
  });

  it("falls back to a 1-indexed placeholder when neither name nor lang is present", () => {
    expect(mapHlsAudioTrack(playlist(), 2).displayName).toBe("Track 3");
  });
});

describe("mapHlsSubtitleTrack", () => {
  const sourceId = asSubtitleSourceId("hls-native");

  it("brands the track id and attaches the given sourceId", () => {
    const track = mapHlsSubtitleTrack(playlist(), 1, sourceId);
    expect(track.trackId).toBe(1);
    expect(track.sourceId).toBe(sourceId);
  });

  it("maps default/kind and displayName the same way mapHlsAudioTrack does", () => {
    const track = mapHlsSubtitleTrack(playlist({ default: true, name: "English" }), 0, sourceId);
    expect(track.kind).toBe(TrackKind.Default);
    expect(track.displayName).toBe("English");
  });
});
