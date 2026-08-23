import type {
  AudioTrackId,
  SubtitleSourceId,
  SubtitleTrackId,
  VoiceOverSourceId,
  VoiceOverTrackId,
} from "./branding.js";

/**
 * Classifies the intent of a track. Modeled as an enum rather than a
 * boolean `isDefault` flag because a track can be default, forced,
 * a commentary/dub track, or manually selected by the user — a
 * boolean cannot express this without a breaking change later.
 * @public
 */
export enum TrackKind {
  Default = "default",
  Forced = "forced",
  Commentary = "commentary",
  Dub = "dub",
  Manual = "manual",
}

/**
 * A single selectable audio track, normalized from the underlying
 * HLS manifest.
 * @public
 */
export interface AudioTrack {
  readonly trackId: AudioTrackId;
  readonly displayName: string;
  readonly language?: string;
  readonly kind: TrackKind;
}

/**
 * A single selectable subtitle track, normalized across all
 * registered {@link ISubtitleSource}s (HLS manifest, VOD-extracted,
 * OpenSubtitles, or a custom source).
 * @public
 */
export interface SubtitleTrack {
  readonly trackId: SubtitleTrackId;
  readonly displayName: string;
  readonly language?: string;
  readonly kind: TrackKind;
  readonly sourceId: SubtitleSourceId;
}

/**
 * A single selectable voice-over (narration/audio-description) track,
 * exposed by an {@link IVoiceOverGateway}. Unlike {@link SubtitleTrack},
 * `language` is required — a voice-over track's identity is the language
 * itself, not an incidental attribute.
 * @public
 */
export interface VoiceOverTrack {
  readonly trackId: VoiceOverTrackId;
  readonly displayName: string;
  readonly language: string;
  readonly kind: TrackKind;
  readonly sourceId: VoiceOverSourceId;
}
