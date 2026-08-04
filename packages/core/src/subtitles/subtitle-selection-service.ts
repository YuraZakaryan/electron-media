import type { SubtitleTrackId } from "../types/branding.js";
import type { SubtitleTrack } from "../types/track.js";
import type { SubtitleRegistry } from "./subtitle-registry.js";

/** @public */
export interface SubtitleSelectionServiceOptions {
  readonly registry: SubtitleRegistry;
}

/**
 * Tracks which subtitle track (if any) is currently active. Stateless with
 * respect to rendering — selecting a track here does not by itself change
 * what's on screen; {@link SubtitleController} is what wires selection to
 * cue delivery and rendering.
 *
 * @public
 */
export class SubtitleSelectionService {
  private readonly registry: SubtitleRegistry;
  private selectedTrack: SubtitleTrack | null = null;
  private readonly listeners = new Set<
    (track: SubtitleTrack | null) => void
  >();

  constructor(options: SubtitleSelectionServiceOptions) {
    this.registry = options.registry;
  }

  /** Selects `trackId`, or clears the selection when `null`. No-op if `trackId` is not currently registered. */
  select(trackId: SubtitleTrackId | null): void {
    if (trackId === null) {
      this.setSelected(null);
      return;
    }

    const track = this.registry
      .getTracks()
      .find((candidate) => candidate.trackId === trackId);
    if (!track) return;

    this.setSelected(track);
  }

  /** The currently selected track, or `null` if none is active. */
  get selected(): SubtitleTrack | null {
    return this.selectedTrack;
  }

  /** Notifies `callback` whenever the selection changes. Returns an unsubscribe function. */
  onSelectionChanged(
    callback: (track: SubtitleTrack | null) => void
  ): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private setSelected(track: SubtitleTrack | null): void {
    if (track?.trackId === this.selectedTrack?.trackId) return;
    this.selectedTrack = track;
    this.listeners.forEach((listener) => listener(track));
  }
}
