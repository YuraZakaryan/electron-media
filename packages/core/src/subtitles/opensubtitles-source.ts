import { asSubtitleTrackId, type SubtitleSourceId, type SubtitleTrackId } from "../types/branding.js";
import { SubtitleError } from "../errors/index.js";
import { TrackKind, type SubtitleTrack } from "../types/track.js";
import type { CanonicalCue } from "../types/cue.js";
import { convertSrtToVtt } from "./srt-to-vtt.js";
import { parseVttCues } from "./vtt-cue-parser.js";

import type {
  ISubtitleGateway,
  SubtitleSearchParams,
} from "../contracts/subtitle-gateway.js";
import type { ISubtitleSource } from "./subtitle-source.js";

/** @public */
export interface OpenSubtitlesSourceOptions {
  readonly sourceId: SubtitleSourceId;
  readonly gateway: ISubtitleGateway;
  /**
   * First numeric id assigned to a search result; subsequent results get
   * consecutive ids. Callers combining this source with others (e.g.
   * {@link VodExtractedSubtitleSource}) must pick non-overlapping ranges.
   * Defaults to 100000.
   */
  readonly trackIdRangeStart?: number;
}

const DEFAULT_TRACK_ID_RANGE_START = 100000;

/**
 * Subtitle source backed by a remote provider (OpenSubtitles or compatible)
 * via {@link ISubtitleGateway}. Unlike {@link VodExtractedSubtitleSource},
 * its track list is not known at construction time — call {@link search} once
 * content metadata (TMDB id or title) is available, which populates
 * {@link getTracks} and fires {@link onTracksChanged}.
 *
 * Ownership: downloads the full transcript for a track up front on
 * {@link selectTrack} (no polling) — the whole file is available immediately,
 * unlike a growing VOD-extracted `.vtt`.
 *
 * @public
 */
export class OpenSubtitlesSource implements ISubtitleSource {
  readonly sourceId: SubtitleSourceId;

  private readonly gateway: ISubtitleGateway;
  private readonly trackIdRangeStart: number;

  private tracks: SubtitleTrack[] = [];
  private fileIdByTrackId = new Map<SubtitleTrackId, number>();
  private canonicalCuesByTrackId = new Map<SubtitleTrackId, CanonicalCue[]>();
  private activeTrackId: SubtitleTrackId | null = null;
  private activatedForReadingTrackIds = new Set<SubtitleTrackId>();

  private readonly trackListeners = new Set<
    (tracks: readonly SubtitleTrack[]) => void
  >();
  private readonly cueListeners = new Map<
    SubtitleTrackId,
    Set<(cues: readonly CanonicalCue[]) => void>
  >();

  constructor(options: OpenSubtitlesSourceOptions) {
    this.sourceId = options.sourceId;
    this.gateway = options.gateway;
    this.trackIdRangeStart =
      options.trackIdRangeStart ?? DEFAULT_TRACK_ID_RANGE_START;
  }

  /**
   * Searches the gateway for candidate subtitles, ranks them by rating, and
   * replaces this source's track list. Safe to call again (e.g. when TMDB
   * metadata becomes available after an initial title-only search).
   */
  async search(params: SubtitleSearchParams): Promise<readonly SubtitleTrack[]> {
    if (!this.gateway.isAvailable) {
      throw new SubtitleError("OpenSubtitles gateway is not available");
    }

    const response = await this.gateway.search(params);
    if (!response.success || !response.results?.length) {
      this.tracks = [];
      this.fileIdByTrackId = new Map();
      this.notifyTracksChanged();
      return this.tracks;
    }

    const sorted = [...response.results].sort(
      (a, b) => (b.rating ?? 0) - (a.rating ?? 0)
    );

    const fileIdByTrackId = new Map<SubtitleTrackId, number>();
    this.tracks = sorted.map((result, index) => {
      const trackId = asSubtitleTrackId(this.trackIdRangeStart + index);
      fileIdByTrackId.set(trackId, result.fileId);
      return {
        trackId,
        displayName: result.release || result.language || "Subtitle",
        language: result.language,
        kind: TrackKind.Manual,
        sourceId: this.sourceId,
      };
    });
    this.fileIdByTrackId = fileIdByTrackId;
    this.notifyTracksChanged();
    return this.tracks;
  }

  getTracks(): readonly SubtitleTrack[] {
    return this.tracks;
  }

  selectTrack(trackId: SubtitleTrackId | null): void {
    this.activeTrackId = trackId;
    if (trackId === null) return;

    const fileId = this.fileIdByTrackId.get(trackId);
    if (fileId === undefined) return;

    void this.downloadAndEmitCues(trackId, fileId);
  }

  /**
   * See {@link ISubtitleSource.activateForReading}. Doesn't touch
   * `activeTrackId` — unlike VodExtractedSubtitleSource this source has no
   * polling to stop/start per track (fetch-once, cached by trackId), so this
   * is really just `selectTrack` without the exclusive-slot side effect;
   * kept as a separate method for interface symmetry and because the two
   * having independent behavior is exactly what the shared subtitle-source
   * contract calls for.
   *
   * Tracked in `activatedForReadingTrackIds` so `downloadAndEmitCues`'s
   * stale-download guard (written for `selectTrack`'s single exclusive slot)
   * doesn't discard this fetch just because some *other* track is the
   * visibly-selected one — the bug this fixed: a narration language that
   * differed from the on-screen subtitle's language downloaded its transcript
   * successfully but the result was silently dropped every time, since
   * `activeTrackId` was never this track's id.
   */
  activateForReading(trackId: SubtitleTrackId): () => void {
    this.activatedForReadingTrackIds.add(trackId);
    const fileId = this.fileIdByTrackId.get(trackId);
    if (fileId !== undefined) void this.downloadAndEmitCues(trackId, fileId);
    return () => this.activatedForReadingTrackIds.delete(trackId);
  }

  onTracksChanged(
    callback: (tracks: readonly SubtitleTrack[]) => void
  ): () => void {
    this.trackListeners.add(callback);
    return () => this.trackListeners.delete(callback);
  }

  onCuesChanged(
    trackId: SubtitleTrackId,
    callback: (cues: readonly CanonicalCue[]) => void
  ): () => void {
    const listeners = this.cueListeners.get(trackId) ?? new Set();
    listeners.add(callback);
    this.cueListeners.set(trackId, listeners);
    return () => listeners.delete(callback);
  }

  dispose(): void {
    this.trackListeners.clear();
    this.cueListeners.clear();
    this.activatedForReadingTrackIds.clear();
  }

  private async downloadAndEmitCues(
    trackId: SubtitleTrackId,
    fileId: number
  ): Promise<void> {
    const cached = this.canonicalCuesByTrackId.get(trackId);
    if (cached) {
      this.emitCues(trackId, cached);
      return;
    }

    const result = await this.gateway.download(fileId);
    // A later selectTrack() call may have superseded this one while the
    // download was in flight — don't resurrect a track the caller already
    // moved away from. Doesn't apply to a track activateForReading()
    // independently activated: that's a non-exclusive slot by design (see
    // its own doc comment), so it's never "superseded" by a different
    // track becoming the visible selection.
    if (
      this.activeTrackId !== trackId &&
      !this.activatedForReadingTrackIds.has(trackId)
    ) {
      return;
    }
    if (!result.success || !result.content) {
      // selectTrack() is synchronous and fire-and-forget (ISubtitleSource has
      // no error channel of its own) — throwing here would only surface as
      // an unhandled promise rejection, never as something a caller could
      // catch. Warn instead, matching the app's former behavior for this
      // exact failure.
      console.warn(
        "[OpenSubtitlesSource] download failed:",
        result.error ?? "unknown error"
      );
      return;
    }

    const vtt = convertSrtToVtt(result.content);
    const cues = parseVttCues(vtt);
    this.canonicalCuesByTrackId.set(trackId, cues);
    this.emitCues(trackId, cues);
  }

  private emitCues(
    trackId: SubtitleTrackId,
    cues: readonly CanonicalCue[]
  ): void {
    this.cueListeners.get(trackId)?.forEach((listener) => listener(cues));
  }

  private notifyTracksChanged(): void {
    this.trackListeners.forEach((listener) => listener(this.tracks));
  }
}
