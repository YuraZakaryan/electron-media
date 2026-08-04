import type { SubtitleSourceId, SubtitleTrackId } from "../types/branding.js";
import type { CanonicalCue } from "../types/cue.js";
import type { SubtitleTrack } from "../types/track.js";
import type { IHlsAdapter } from "../hls/hls-adapter.js";
import type { ISubtitleSource } from "./subtitle-source.js";

/** @public */
export interface HlsNativeSubtitleSourceOptions {
  readonly sourceId: SubtitleSourceId;
  readonly adapter: IHlsAdapter;
}

/**
 * Subtitle source for tracks embedded in the HLS manifest itself. Unlike
 * {@link VodExtractedSubtitleSource} and {@link OpenSubtitlesSource}, this
 * source never emits cues — hls.js renders WebVTT/IMSC1 subtitle tracks onto
 * its own hidden TextTrack automatically once `hls.subtitleTrack` is set, so
 * {@link onCuesChanged} intentionally has no subscribers to notify.
 * Track selection is delegated straight to the {@link IHlsAdapter}.
 *
 * @public
 */
export class HlsNativeSubtitleSource implements ISubtitleSource {
  readonly sourceId: SubtitleSourceId;
  private readonly adapter: IHlsAdapter;

  constructor(options: HlsNativeSubtitleSourceOptions) {
    this.sourceId = options.sourceId;
    this.adapter = options.adapter;
  }

  getTracks(): readonly SubtitleTrack[] {
    return this.adapter.getSubtitleTracks();
  }

  selectTrack(trackId: SubtitleTrackId | null): void {
    this.adapter.setSubtitleTrack(trackId);
  }

  onTracksChanged(
    callback: (tracks: readonly SubtitleTrack[]) => void
  ): () => void {
    return this.adapter.on("subtitleTracksChanged", ({ tracks }) =>
      callback(tracks)
    );
  }

  /** Never fires — hls.js renders its own subtitle tracks; see class docs. */
  onCuesChanged(
    _trackId: SubtitleTrackId,
    _callback: (cues: readonly CanonicalCue[]) => void
  ): () => void {
    return () => {};
  }

  dispose(): void {
    this.adapter.setSubtitleTrack(null);
  }
}
