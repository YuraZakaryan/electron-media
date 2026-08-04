import { asAudioTrackId, asSubtitleTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";

import type { MediaPlaylist } from "hls.js";
import type { AudioTrackId, SubtitleTrackId, SubtitleSourceId } from "../types/branding.js";
import type { AudioTrack, SubtitleTrack } from "../types/track.js";

function trackKindFrom(playlist: MediaPlaylist): TrackKind {
  return playlist.default ? TrackKind.Default : TrackKind.Manual;
}

function displayNameFrom(playlist: MediaPlaylist, index: number): string {
  return playlist.name || playlist.lang || `Track ${index + 1}`;
}

/**
 * Normalizes an hls.js `MediaPlaylist` entry into a library {@link AudioTrack}.
 * Not exported publicly: hls.js's own types (`MediaPlaylist` and its
 * transitive fields) use private class members, so re-exporting a function
 * typed against them creates a dual-package hazard for any consumer whose
 * own `hls.js` install resolves to a different physical copy than this
 * library's — TypeScript then treats the two as structurally incompatible.
 * Host apps wrapping their own `Hls` instance in a custom `IHlsAdapter`
 * should inline the equivalent few lines themselves instead.
 * @internal
 */
export function mapHlsAudioTrack(playlist: MediaPlaylist, index: number): AudioTrack {
  return {
    trackId: asAudioTrackId(index) as AudioTrackId,
    displayName: displayNameFrom(playlist, index),
    language: playlist.lang,
    kind: trackKindFrom(playlist),
  };
}

/**
 * Normalizes an hls.js `MediaPlaylist` entry into a library {@link SubtitleTrack}.
 * See {@link mapHlsAudioTrack} for why this is not exported publicly.
 * @internal
 */
export function mapHlsSubtitleTrack(
  playlist: MediaPlaylist,
  index: number,
  sourceId: SubtitleSourceId,
): SubtitleTrack {
  return {
    trackId: asSubtitleTrackId(index) as SubtitleTrackId,
    displayName: displayNameFrom(playlist, index),
    language: playlist.lang,
    kind: trackKindFrom(playlist),
    sourceId,
  };
}
