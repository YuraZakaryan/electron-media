import type { SubtitleSourceId, SubtitleTrackId } from "../types/branding.js";
import type { SubtitleTrack } from "../types/track.js";
import type { CanonicalCue } from "../types/cue.js";

/**
 * A provider of subtitle tracks — an HLS manifest, a VOD-extracted track set,
 * or a remote provider such as OpenSubtitles.
 *
 * Ownership: the {@link SubtitleRegistry} holding this source is responsible
 * for calling {@link ISubtitleSource.dispose} when the source is unregistered
 * or the player is destroyed; a source must never dispose itself.
 *
 * Mutability: track lists and cues may change after construction (e.g. a
 * VOD transcode appending newly-extracted cues) — subscribe via
 * {@link onTracksChanged}/{@link onCuesChanged} rather than polling.
 *
 * @public
 */
export interface ISubtitleSource {
  /** Stable identifier for this source instance, unique within a {@link SubtitleRegistry}. */
  readonly sourceId: SubtitleSourceId;

  /**
   * `true` when this source draws its own cues directly onto the video
   * element (e.g. hls.js's native `TextTrack` rendering) rather than relying
   * on a host-supplied {@link ISubtitleRenderer}. {@link SubtitleController}
   * uses this to skip re-rendering cues from this source itself — doing so
   * unconditionally would visually duplicate every cue the source is already
   * painting on its own. Omit (or `false`) for the common case of a source
   * whose cue text has no display mechanism of its own.
   */
  readonly rendersNatively?: boolean;

  /**
   * Returns the tracks currently exposed by this source.
   *
   * The returned array is a snapshot and will not update automatically —
   * subscribe via {@link onTracksChanged} for live updates.
   */
  getTracks(): readonly SubtitleTrack[];

  /**
   * Activates cue delivery for `trackId`, or deactivates it when `null`.
   * Only one track per source may be active at a time.
   */
  selectTrack(trackId: SubtitleTrackId | null): void;

  /** Notifies `callback` whenever this source's track list changes. Returns an unsubscribe function. */
  onTracksChanged(
    callback: (tracks: readonly SubtitleTrack[]) => void
  ): () => void;

  /**
   * Notifies `callback` with the full, canonical (delay-unapplied) cue list
   * for `trackId` whenever it changes — including incremental growth for
   * sources that stream in cues over time. Returns an unsubscribe function.
   */
  onCuesChanged(
    trackId: SubtitleTrackId,
    callback: (cues: readonly CanonicalCue[]) => void
  ): () => void;

  /**
   * Releases resources held by this source (stops polling, aborts in-flight
   * requests, disables any TextTracks it created). Called exactly once by
   * the owning {@link SubtitleRegistry}; idempotent.
   */
  dispose(): void;
}
