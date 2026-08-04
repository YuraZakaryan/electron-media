import type { SubtitleSourceId, SubtitleTrackId } from "../types/branding.js";
import type { SubtitleTrack } from "../types/track.js";
import type { ISubtitleSource } from "./subtitle-source.js";

/** @public */
export interface SubtitleRegistryOptions {
  readonly sources: readonly ISubtitleSource[];
}

/**
 * Holds the set of active {@link ISubtitleSource}s and exposes their merged
 * track list. Does not select, project, or render tracks — see
 * {@link SubtitleSelectionService} and {@link SubtitleController} for those.
 *
 * Ownership: takes ownership of every source passed to the constructor or to
 * {@link registerSource} and will call {@link ISubtitleSource.dispose} on it
 * when unregistered or when this registry is disposed.
 *
 * @public
 */
export class SubtitleRegistry {
  private readonly sourcesById = new Map<SubtitleSourceId, ISubtitleSource>();
  private readonly unsubscribeBySourceId = new Map<SubtitleSourceId, () => void>();
  private readonly listeners = new Set<
    (tracks: readonly SubtitleTrack[]) => void
  >();

  constructor(options: SubtitleRegistryOptions) {
    options.sources.forEach((source) => this.registerSource(source));
  }

  /**
   * Adds a source discovered after construction (e.g. OpenSubtitles search
   * results). This registry takes ownership and will call
   * {@link ISubtitleSource.dispose} when the source is later unregistered.
   */
  registerSource(source: ISubtitleSource): void {
    this.sourcesById.set(source.sourceId, source);
    const unsubscribe = source.onTracksChanged(() => this.notifyTracksChanged());
    this.unsubscribeBySourceId.set(source.sourceId, unsubscribe);
    this.notifyTracksChanged();
  }

  /** Disposes and removes the source identified by `sourceId`. No-op if not registered. */
  unregisterSource(sourceId: SubtitleSourceId): void {
    const source = this.sourcesById.get(sourceId);
    if (!source) return;

    this.unsubscribeBySourceId.get(sourceId)?.();
    this.unsubscribeBySourceId.delete(sourceId);
    this.sourcesById.delete(sourceId);
    source.dispose();
    this.notifyTracksChanged();
  }

  /** Returns every track exposed by every registered source, in registration order. */
  getTracks(): readonly SubtitleTrack[] {
    const tracks: SubtitleTrack[] = [];
    this.sourcesById.forEach((source) => tracks.push(...source.getTracks()));
    return tracks;
  }

  /** Returns the source that owns `trackId`, if any currently registered source does. */
  findSourceForTrack(trackId: SubtitleTrackId): ISubtitleSource | undefined {
    for (const source of this.sourcesById.values()) {
      if (source.getTracks().some((track) => track.trackId === trackId)) {
        return source;
      }
    }
    return undefined;
  }

  /** Returns the source registered under `sourceId`, if any. */
  getSource(sourceId: SubtitleSourceId): ISubtitleSource | undefined {
    return this.sourcesById.get(sourceId);
  }

  /** Notifies `callback` with the merged track list whenever any registered source changes. Returns an unsubscribe function. */
  onTracksChanged(
    callback: (tracks: readonly SubtitleTrack[]) => void
  ): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Unregisters and disposes every source. Idempotent. */
  dispose(): void {
    Array.from(this.sourcesById.keys()).forEach((sourceId) =>
      this.unregisterSource(sourceId)
    );
  }

  private notifyTracksChanged(): void {
    const tracks = this.getTracks();
    this.listeners.forEach((listener) => listener(tracks));
  }
}
