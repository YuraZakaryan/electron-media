import type { SubtitleSourceId, SubtitleTrackId } from "../types/branding.js";
import type { CanonicalCue } from "../types/cue.js";
import type { SubtitleTrack } from "../types/track.js";
import type { ISubtitleSource } from "../subtitles/subtitle-source.js";

/** Test double for {@link ISubtitleSource}. Not exported from the package's public API. */
export class MockSubtitleSource implements ISubtitleSource {
  selectedTrackId: SubtitleTrackId | null = null;
  disposed = false;

  private tracks: SubtitleTrack[];
  private readonly trackListeners = new Set<
    (tracks: readonly SubtitleTrack[]) => void
  >();
  private readonly cueListenersByTrackId = new Map<
    SubtitleTrackId,
    Set<(cues: readonly CanonicalCue[]) => void>
  >();

  constructor(
    readonly sourceId: SubtitleSourceId,
    tracks: readonly SubtitleTrack[] = []
  ) {
    this.tracks = [...tracks];
  }

  getTracks(): readonly SubtitleTrack[] {
    return this.tracks;
  }

  selectTrack(trackId: SubtitleTrackId | null): void {
    this.selectedTrackId = trackId;
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
    const set = this.cueListenersByTrackId.get(trackId) ?? new Set();
    set.add(callback);
    this.cueListenersByTrackId.set(trackId, set);
    return () => set.delete(callback);
  }

  dispose(): void {
    this.disposed = true;
  }

  /** Test-only helper to simulate this source's track list changing. */
  setTracks(tracks: readonly SubtitleTrack[]): void {
    this.tracks = [...tracks];
    this.trackListeners.forEach((listener) => listener(this.tracks));
  }

  /** Test-only helper to simulate new cues arriving for `trackId`. */
  emitCues(trackId: SubtitleTrackId, cues: readonly CanonicalCue[]): void {
    this.cueListenersByTrackId.get(trackId)?.forEach((listener) => listener(cues));
  }
}
