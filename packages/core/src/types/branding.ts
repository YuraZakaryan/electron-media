/**
 * Branded numeric identifier for an audio track, unique within one
 * {@link MediaPlayer} instance. Prevents accidentally passing a
 * {@link SubtitleTrackId} where an audio track id is expected.
 * @public
 */
export type AudioTrackId = number & { readonly __brand: "AudioTrackId" };

/**
 * Branded numeric identifier for a subtitle track, unique within one
 * {@link MediaPlayer} instance (merged across all registered sources).
 * @public
 */
export type SubtitleTrackId = number & { readonly __brand: "SubtitleTrackId" };

/**
 * Branded string identifier for a subtitle source ("hls-native",
 * "vod-extracted", "opensubtitles", or a consumer-defined id for a
 * custom {@link ISubtitleSource}).
 * @public
 */
export type SubtitleSourceId = string & { readonly __brand: "SubtitleSourceId" };

/**
 * Branded string identifier for a voice-over track, keyed by language code
 * (e.g. "en", "es") rather than a positional index — a track's identity must
 * stay stable across repeated {@link IVoiceOverGateway.listVoices} calls.
 * @public
 */
export type VoiceOverTrackId = string & { readonly __brand: "VoiceOverTrackId" };

/**
 * Branded string identifier for a voice-over source, mirroring
 * {@link SubtitleSourceId} for symmetry with {@link VoiceOverTrack}.
 * @public
 */
export type VoiceOverSourceId = string & { readonly __brand: "VoiceOverSourceId" };

/** @public Constructs an {@link AudioTrackId} from a raw number. */
export function asAudioTrackId(value: number): AudioTrackId {
  return value as AudioTrackId;
}

/** @public Constructs a {@link SubtitleTrackId} from a raw number. */
export function asSubtitleTrackId(value: number): SubtitleTrackId {
  return value as SubtitleTrackId;
}

/** @public Constructs a {@link SubtitleSourceId} from a raw string. */
export function asSubtitleSourceId(value: string): SubtitleSourceId {
  return value as SubtitleSourceId;
}

/** @public Constructs a {@link VoiceOverTrackId} from a raw language code. */
export function asVoiceOverTrackId(value: string): VoiceOverTrackId {
  return value as VoiceOverTrackId;
}

/** @public Constructs a {@link VoiceOverSourceId} from a raw string. */
export function asVoiceOverSourceId(value: string): VoiceOverSourceId {
  return value as VoiceOverSourceId;
}
