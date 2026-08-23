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
 * Subtitle source for tracks embedded in the HLS manifest itself. hls.js
 * renders WebVTT/IMSC1 subtitle tracks onto its own native `TextTrack`
 * automatically once `hls.subtitleTrack` is set — {@link onCuesChanged}
 * forwards whatever the adapter reads back off that same native TextTrack
 * (see {@link IHlsAdapter}'s `subtitleCuesChanged` event), if the adapter
 * implements it; an adapter that doesn't simply means nothing is ever
 * forwarded, the previous behavior of this class entirely. Track selection
 * is delegated straight to the {@link IHlsAdapter}.
 *
 * @public
 */
export class HlsNativeSubtitleSource implements ISubtitleSource {
  readonly sourceId: SubtitleSourceId;
  /** hls.js paints this track's cues onto its own native TextTrack directly — see {@link ISubtitleSource.rendersNatively}. */
  readonly rendersNatively = true;
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

  onCuesChanged(
    trackId: SubtitleTrackId,
    callback: (cues: readonly CanonicalCue[]) => void
  ): () => void {
    return this.adapter.on("subtitleCuesChanged", (payload) => {
      if (payload.trackId === trackId) callback(payload.cues);
    });
  }

  dispose(): void {
    this.adapter.setSubtitleTrack(null);
  }
}
