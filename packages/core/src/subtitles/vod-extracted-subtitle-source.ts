import type { SubtitleSourceId, SubtitleTrackId } from "../types/branding.js";
import type { CanonicalCue } from "../types/cue.js";
import type { SubtitleTrack, TrackKind } from "../types/track.js";
import { parseVttCues } from "./vtt-cue-parser.js";

import type { ISubtitleSource } from "./subtitle-source.js";

const DEFAULT_POLL_INTERVAL_MS = 8000;

/**
 * One VOD-extracted subtitle track as reported by the host application's VOD
 * transcode pipeline — its `.vtt` file already exists by the time this
 * descriptor is constructed and keeps growing as the transcode progresses.
 * @public
 */
export interface VodExtractedSubtitleTrackDescriptor {
  readonly trackId: SubtitleTrackId;
  readonly displayName: string;
  readonly language?: string;
  readonly kind: TrackKind;
  /** URL of the (possibly still-growing) WebVTT file for this track. */
  readonly vttUrl: string;
}

/** @public */
export interface VodExtractedSubtitleSourceOptions {
  readonly sourceId: SubtitleSourceId;
  readonly tracks: readonly VodExtractedSubtitleTrackDescriptor[];
  /**
   * Absolute source-time seconds to subtract from every parsed cue, correcting
   * for the transcode session's own start offset (e.g. a `-copyts` seek
   * session). This is a source-specific technical baseline, distinct from the
   * user-facing nudge owned by {@link SubtitleDelayProcessor}.
   */
  readonly baselineOffsetSeconds?: number;
  /** How often to re-fetch the active track's `.vtt` file while it may still be growing. Defaults to 8000ms. */
  readonly pollIntervalMs?: number;
  /** Fetch implementation to use; defaults to the global `fetch`. Override in non-browser test environments. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Subtitle source for tracks extracted as a side effect of a VOD transcode.
 * Ports the polling/dedup/baseline-reprojection behavior of the app's
 * original `useVodExtractedSubtitles` hook: fetches each active track's
 * `.vtt` file, accumulates newly-seen cues (deduped by start/end/text) into a
 * canonical, offset-agnostic cache, and re-emits the full canonical cue list
 * via {@link onCuesChanged} whenever it grows or the baseline changes.
 *
 * Ownership: does not touch the DOM directly — cue projection and rendering
 * are the {@link SubtitleController}'s and {@link ISubtitleRenderer}'s job.
 *
 * @public
 */
export class VodExtractedSubtitleSource implements ISubtitleSource {
  readonly sourceId: SubtitleSourceId;

  private readonly tracksById = new Map<
    SubtitleTrackId,
    VodExtractedSubtitleTrackDescriptor
  >();
  private readonly fetchImpl: typeof fetch;
  private readonly pollIntervalMs: number;
  private baselineOffsetSeconds: number;

  private activeTrackId: SubtitleTrackId | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly seenCueKeysByTrackId = new Map<
    SubtitleTrackId,
    Set<string>
  >();
  private readonly canonicalCuesByTrackId = new Map<
    SubtitleTrackId,
    CanonicalCue[]
  >();
  private readonly cueListeners = new Map<
    SubtitleTrackId,
    Set<(cues: readonly CanonicalCue[]) => void>
  >();

  constructor(options: VodExtractedSubtitleSourceOptions) {
    this.sourceId = options.sourceId;
    options.tracks.forEach((track) => this.tracksById.set(track.trackId, track));
    this.baselineOffsetSeconds = options.baselineOffsetSeconds ?? 0;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    // Wrapped rather than stored bare: `this.fetchImpl(...)` would invoke the
    // global `fetch` with this instance as its receiver, which browsers reject
    // outright ("Illegal invocation"). That throw is synchronous, so it escapes
    // before the `.catch()` on the returned promise can apply — the rejection
    // surfaced nowhere and every track silently produced no cues at all.
    this.fetchImpl =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  }

  /**
   * Updates the technical baseline (see constructor docs) and re-emits
   * already-fetched cues re-projected against it — no network call, so this
   * is safe to call on every tick of a position-offset UI control.
   */
  setBaselineOffsetSeconds(baselineOffsetSeconds: number): void {
    if (baselineOffsetSeconds === this.baselineOffsetSeconds) return;
    this.baselineOffsetSeconds = baselineOffsetSeconds;
    if (this.activeTrackId !== null) {
      this.notifyCuesChanged(this.activeTrackId);
    }
  }

  getTracks(): readonly SubtitleTrack[] {
    return Array.from(this.tracksById.values()).map((track) => ({
      trackId: track.trackId,
      displayName: track.displayName,
      language: track.language,
      kind: track.kind,
      sourceId: this.sourceId,
    }));
  }

  selectTrack(trackId: SubtitleTrackId | null): void {
    this.stopPolling();
    this.activeTrackId = trackId;
    if (trackId === null) return;

    const track = this.tracksById.get(trackId);
    if (!track) return;

    // Re-emit what is already cached, synchronously, before re-fetching.
    // fetchAndMergeCues only notifies when it finds cues it has not seen
    // before, so re-selecting a track whose .vtt was already fully read
    // would otherwise never reach the renderer again — the track would show
    // as selected while the screen kept whatever the previous selection put
    // there. Mirrors OpenSubtitlesSource, which re-emits its cached
    // transcript on every selectTrack.
    if ((this.canonicalCuesByTrackId.get(trackId)?.length ?? 0) > 0) {
      this.notifyCuesChanged(trackId);
    }

    void this.fetchAndMergeCues(trackId, track.vttUrl);
    this.pollTimer = setInterval(() => {
      void this.fetchAndMergeCues(trackId, track.vttUrl);
    }, this.pollIntervalMs);
  }

  onTracksChanged(): () => void {
    // This source's track list is fixed at construction time; nothing to subscribe to.
    return () => {};
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
    this.stopPolling();
    this.cueListeners.clear();
  }

  private stopPolling(): void {
    if (this.pollTimer === null) return;
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async fetchAndMergeCues(
    trackId: SubtitleTrackId,
    vttUrl: string
  ): Promise<void> {
    // try/catch rather than `.catch()` on the returned promise: a `fetchImpl`
    // that throws synchronously never returns a promise to attach a handler
    // to, so the failure used to escape this method entirely and land as an
    // unhandled rejection in the caller, which does not await it.
    let response: Response | null;
    try {
      response = await this.fetchImpl(vttUrl, { cache: "no-store" });
    } catch {
      response = null;
    }
    if (!response || !response.ok) {
      // A 404 means this session's directory is gone (e.g. a seek replaced
      // it) — stop polling a dead URL rather than hammering it every tick.
      if (response?.status === 404 && this.activeTrackId === trackId) {
        this.stopPolling();
      }
      return;
    }

    const text = await response.text();
    const parsed = parseVttCues(text);

    const seen = this.seenCueKeysByTrackId.get(trackId) ?? new Set<string>();
    const canonical = this.canonicalCuesByTrackId.get(trackId) ?? [];

    let addedNew = false;
    for (const cue of parsed) {
      // Keyed on unshifted (canonical) time plus text — a shifted key would
      // change whenever the baseline does and let a single cue back in as a
      // duplicate.
      const key = `${cue.startSeconds.toFixed(3)}-${cue.endSeconds.toFixed(3)}-${cue.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      canonical.push(cue);
      addedNew = true;
    }
    this.seenCueKeysByTrackId.set(trackId, seen);
    this.canonicalCuesByTrackId.set(trackId, canonical);

    if (addedNew) this.notifyCuesChanged(trackId);
  }

  private notifyCuesChanged(trackId: SubtitleTrackId): void {
    const canonical = this.canonicalCuesByTrackId.get(trackId) ?? [];
    const offset = this.baselineOffsetSeconds;
    const projected: CanonicalCue[] = [];

    for (const cue of canonical) {
      const endSeconds = cue.endSeconds - offset;
      // Entirely before this session starts — unplayable, skip.
      if (endSeconds <= 0) continue;
      const startSeconds = Math.max(0, cue.startSeconds - offset);
      if (endSeconds <= startSeconds) continue;
      projected.push({ startSeconds, endSeconds, text: cue.text });
    }

    const listeners = this.cueListeners.get(trackId);
    listeners?.forEach((listener) => listener(projected));
  }
}
