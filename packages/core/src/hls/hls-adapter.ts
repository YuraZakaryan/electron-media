import type { AudioTrackId, SubtitleTrackId } from "../types/branding.js";
import type { AudioTrack, SubtitleTrack } from "../types/track.js";

/** @public Events emitted by an {@link IHlsAdapter}. */
export interface HlsAdapterEvents extends Record<string, unknown> {
  audioTracksChanged: { readonly tracks: readonly AudioTrack[] };
  subtitleTracksChanged: { readonly tracks: readonly SubtitleTrack[] };
  fatalError: { readonly code: string; readonly cause?: unknown };
  /** Fired once the manifest has been parsed and playback can begin. */
  manifestParsed: { readonly durationSeconds: number };
  /**
   * Fired for every hls.js error, fatal or not, before any retry/fallback
   * policy runs. Non-fatal errors never affect playback on their own, but
   * are often the only trace of *why* a stream degrades (e.g. a 404 on one
   * rendition, a fragment append failure) — this exists purely so a host
   * application can log them; the adapter itself takes no action here.
   */
  errorObserved: {
    readonly fatal: boolean;
    readonly type: string;
    readonly detail: string;
    readonly cause: unknown;
  };
}

/**
 * Abstraction over the underlying HLS engine that exposes multi-audio
 * and native-subtitle track selection. The only shipped implementation
 * is {@link HlsJsAdapter}; consumers may substitute their own (e.g. a
 * mock for unit tests, or a future non-hls.js backend) without
 * changing {@link HlsController} or {@link AudioTrackController}.
 *
 * Ownership: the adapter does not own the video element; it only
 * attaches/detaches its own media pipeline to it.
 * @public
 */
export interface IHlsAdapter {
  attach(video: HTMLVideoElement): void;
  detach(): void;
  loadSource(url: string): void;
  getAudioTracks(): readonly AudioTrack[];
  getSubtitleTracks(): readonly SubtitleTrack[];
  setAudioTrack(trackId: AudioTrackId): void;
  setSubtitleTrack(trackId: SubtitleTrackId | null): void;
  on<TEventName extends keyof HlsAdapterEvents>(
    eventName: TEventName,
    callback: (payload: HlsAdapterEvents[TEventName]) => void,
  ): () => void;
  /** Releases the underlying HLS instance and all its listeners. Idempotent. */
  destroy(): void;
}
