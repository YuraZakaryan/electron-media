import type { AudioTrackId } from "../types/branding.js";
import type { AudioTrack } from "../types/track.js";
import type { IHlsAdapter } from "./hls-adapter.js";
import type { PlayerPreferenceStore } from "../contracts/preference-store.js";

/** @public Options for {@link AudioTrackController}. */
export interface AudioTrackControllerOptions {
  readonly adapter: IHlsAdapter;
  readonly preferenceStore?: PlayerPreferenceStore;
}

/**
 * Exposes and selects audio tracks reported by the underlying
 * {@link IHlsAdapter}. On first track-list update, auto-selects the
 * user's previously stored language preference (if any), falling
 * back to the manifest's default track. Once the user calls
 * {@link select} explicitly, auto-selection no longer applies.
 * @public
 */
export class AudioTrackController {
  private readonly adapter: IHlsAdapter;
  private readonly preferenceStore?: PlayerPreferenceStore;
  private hasUserSelected = false;
  private currentTrackId: AudioTrackId | null = null;
  private readonly selectionListeners = new Set<
    (trackId: AudioTrackId | null) => void
  >();

  constructor(options: AudioTrackControllerOptions) {
    this.adapter = options.adapter;
    this.preferenceStore = options.preferenceStore;

    this.adapter.on("audioTracksChanged", ({ tracks }) => {
      // An empty list means the adapter detached from its engine — a stream
      // teardown, e.g. a seek that rebuilds the underlying `Hls` instance.
      // The replacement instance starts with no selection of its own, so the
      // "user already chose" latch has to clear here: left set, it makes the
      // handler below bail out on the new track list and the user's choice is
      // silently dropped back to the manifest default. Clearing it instead
      // re-runs the stored-language restore that `select` persisted, so the
      // same language carries across into the new stream.
      //
      // `currentTrackId` is deliberately kept: setSelected still forwards to
      // the adapter before comparing ids, so the new engine instance gets the
      // track applied even when the resolved id is unchanged, without emitting
      // a redundant selection change.
      if (tracks.length === 0) {
        this.hasUserSelected = false;
        return;
      }
      if (this.hasUserSelected) return;
      const preferred = this.resolvePreferredTrack(tracks);
      if (preferred) this.setSelected(preferred.trackId);
    });
  }

  /** Selects a track by id and persists the choice via the preference store, if provided. */
  select(trackId: AudioTrackId): void {
    this.hasUserSelected = true;
    this.setSelected(trackId);
    const track = this.getTracks().find((candidate) => candidate.trackId === trackId);
    if (track?.language) this.preferenceStore?.setAudioLanguage(track.language);
  }

  /** The currently selected audio track's id, or `null` before any track has been selected (auto or manual). */
  get selectedTrackId(): AudioTrackId | null {
    return this.currentTrackId;
  }

  /** Notifies `callback` whenever the selected track changes (auto-restore or manual {@link select}). Returns an unsubscribe function. */
  onSelectionChanged(
    callback: (trackId: AudioTrackId | null) => void
  ): () => void {
    this.selectionListeners.add(callback);
    return () => this.selectionListeners.delete(callback);
  }

  /** Returns a snapshot of currently known audio tracks. Does not update automatically — subscribe via {@link onTracksChanged}. */
  getTracks(): readonly AudioTrack[] {
    return this.adapter.getAudioTracks();
  }

  /** Subscribes to audio track list changes (e.g. when the HLS manifest reports new renditions). */
  onTracksChanged(callback: (tracks: readonly AudioTrack[]) => void): () => void {
    return this.adapter.on("audioTracksChanged", ({ tracks }) => callback(tracks));
  }

  private setSelected(trackId: AudioTrackId): void {
    this.adapter.setAudioTrack(trackId);
    if (trackId === this.currentTrackId) return;
    this.currentTrackId = trackId;
    this.selectionListeners.forEach((listener) => listener(trackId));
  }

  private resolvePreferredTrack(tracks: readonly AudioTrack[]): AudioTrack | undefined {
    const storedLanguage = this.preferenceStore?.getAudioLanguage();
    return (
      (storedLanguage && tracks.find((track) => track.language === storedLanguage)) ||
      tracks.find((track) => track.kind === "default") ||
      tracks[0]
    );
  }
}
