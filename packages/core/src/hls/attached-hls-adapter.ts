import { Events } from "hls.js";

import { TypedEventEmitter } from "../events.js";
import { asAudioTrackId, asSubtitleSourceId, asSubtitleTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";

import type { AudioTrackId, SubtitleTrackId } from "../types/branding.js";
import type { CanonicalCue } from "../types/cue.js";
import type { AudioTrack, SubtitleTrack } from "../types/track.js";
import type { HlsAdapterEvents, IHlsAdapter } from "./hls-adapter.js";
import type Hls from "hls.js";
import type { MediaPlaylist } from "hls.js";

const HLS_NATIVE_SUBTITLE_SOURCE_ID = asSubtitleSourceId("hls-native");
const NO_TRACK_INDEX = -1;

// Deliberately duplicated from map-hls-track.ts rather than imported: this
// adapter's `Hls` instance is created by the *host application*, which may
// resolve its own `hls.js` install to a different physical copy than this
// library's — re-exporting a function typed against hls.js's `MediaPlaylist`
// (which uses private class members) across that boundary creates a
// dual-package hazard. See map-hls-track.ts for the full rationale; this is
// exactly the case it says a host-owned adapter must inline instead.
function trackKindFrom(playlist: MediaPlaylist): TrackKind {
  return playlist.default ? TrackKind.Default : TrackKind.Manual;
}

function displayNameFrom(playlist: MediaPlaylist, index: number): string {
  return playlist.name || playlist.lang || `Track ${index + 1}`;
}

function mapAudioTrack(playlist: MediaPlaylist, index: number): AudioTrack {
  return {
    trackId: asAudioTrackId(index),
    displayName: displayNameFrom(playlist, index),
    language: playlist.lang,
    kind: trackKindFrom(playlist),
  };
}

function mapSubtitleTrack(playlist: MediaPlaylist, index: number): SubtitleTrack {
  return {
    trackId: asSubtitleTrackId(index),
    displayName: displayNameFrom(playlist, index),
    language: playlist.lang,
    kind: trackKindFrom(playlist),
    sourceId: HLS_NATIVE_SUBTITLE_SOURCE_ID,
  };
}

/**
 * `IHlsAdapter` that wraps an `Hls` instance the *host application* creates
 * and destroys itself, rather than owning that lifecycle the way
 * {@link HlsJsAdapter} does.
 *
 * Exists for host applications whose HLS lifecycle (retry policy, stall
 * diagnostics, or an app-specific seek/transcode session) is managed
 * outside this library — this library covers multi-audio and native/
 * external-subtitle track selection only, never the underlying `Hls`
 * instance's create/destroy lifecycle. Call {@link attachHls} whenever the
 * host (re)creates its own `Hls` instance and {@link detachHls} whenever it
 * tears one down — both are safe to call redundantly (calling `detachHls`
 * with nothing attached, or twice in a row, is a no-op) and safe to call
 * repeatedly across many attach/detach cycles (e.g. a VOD seek that
 * destroys and recreates the stream mid-session).
 *
 * `attach`/`detach`/`loadSource`/`destroy` below satisfy {@link IHlsAdapter}
 * but do not touch the `Hls` instance itself — the host app owns creating
 * and destroying it; `detach()`/`destroy()` here only stop *reporting* on
 * whatever instance was last attached, mirroring {@link detachHls}.
 * @public
 */
export class AttachedHlsAdapter implements IHlsAdapter {
  private readonly emitter = new TypedEventEmitter<HlsAdapterEvents>();
  private audioTracks: readonly AudioTrack[] = [];
  private subtitleTracks: readonly SubtitleTrack[] = [];
  private hls: Hls | null = null;
  private subtitleCueUnsubscribers: Array<() => void> = [];

  /**
   * Starts reporting tracks from `hls`. Safe to call again with a new
   * instance without an intervening {@link detachHls} — the previous
   * instance's listeners are only ever bound to that instance and stop
   * firing once the host destroys it, but calling {@link detachHls} first
   * is still the correct usage since it clears state deterministically
   * instead of waiting for the old instance to go quiet.
   */
  attachHls(hls: Hls): void {
    this.hls = hls;

    hls.on(Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
      if (this.hls !== hls) return;
      this.audioTracks = data.audioTracks.map(mapAudioTrack);
      this.emitter.emit("audioTracksChanged", { tracks: this.audioTracks });
    });

    hls.on(Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
      if (this.hls !== hls) return;
      this.subtitleTracks = data.subtitleTracks.map(mapSubtitleTrack);
      this.emitter.emit("subtitleTracksChanged", { tracks: this.subtitleTracks });
      this.wireSubtitleCueListeners(hls, data.subtitleTracks);
    });
  }

  /**
   * Stops reporting tracks and clears the current list. Does not touch the
   * `Hls` instance itself — the host app owns destroying it. Idempotent:
   * safe to call with nothing attached, and safe to call more than once.
   */
  detachHls(): void {
    if (!this.hls && this.audioTracks.length === 0 && this.subtitleTracks.length === 0) {
      return;
    }
    this.clearSubtitleCueListeners();
    this.hls = null;
    this.audioTracks = [];
    this.subtitleTracks = [];
    this.emitter.emit("audioTracksChanged", { tracks: [] });
    this.emitter.emit("subtitleTracksChanged", { tracks: [] });
  }

  /**
   * hls.js renders each subtitle rendition onto its own real, native
   * `TextTrack` (when `renderTextTracksNatively` is on, this app's config)
   * — cues only ever populate on whichever ONE is currently active
   * (`hls.subtitleTrack`); an inactive track's `.cues` is `null` per the
   * TextTrack spec while its mode is `"disabled"`. This is what finally
   * lets {@link HlsNativeSubtitleSource.onCuesChanged} forward real cue
   * text — previously it never fired at all, since nothing read the native
   * TextTrack API. One listener is attached per rendition (harmless for
   * the disabled ones — cuechange simply never fires while disabled), so
   * no rewiring is needed when the *active* one changes, only when the
   * rendition list itself changes.
   */
  private wireSubtitleCueListeners(hls: Hls, playlists: readonly MediaPlaylist[]): void {
    this.clearSubtitleCueListeners();

    const media = hls.media;
    if (!media) return;

    const candidates: TextTrack[] = [];
    for (let i = 0; i < media.textTracks.length; i++) {
      const track = media.textTracks[i];
      if (track.kind === "subtitles" || track.kind === "captions") {
        candidates.push(track);
      }
    }

    playlists.forEach((playlist, index) => {
      // Matched by label+language — exactly what hls.js itself passed to
      // `media.addTextTrack(kind, track.name, track.lang)` when creating
      // this rendition's native track — falling back to positional index
      // among subtitle-kind tracks when that match is ambiguous/absent.
      const label = playlist.name ?? "";
      const lang = playlist.lang ?? "";
      const textTrack =
        candidates.find((track) => track.label === label && track.language === lang) ??
        candidates[index] ??
        null;
      if (!textTrack) return;

      const trackId = asSubtitleTrackId(index);
      const emitCues = () => {
        const cueList = textTrack.cues;
        if (!cueList) return;
        const cues: CanonicalCue[] = [];
        for (let i = 0; i < cueList.length; i++) {
          const cue = cueList[i] as VTTCue;
          cues.push({ startSeconds: cue.startTime, endSeconds: cue.endTime, text: cue.text });
        }
        this.emitter.emit("subtitleCuesChanged", { trackId, cues });
      };

      textTrack.addEventListener("cuechange", emitCues);
      this.subtitleCueUnsubscribers.push(() =>
        textTrack.removeEventListener("cuechange", emitCues)
      );
      // Covers a track that's already active with cues loaded by the time
      // this wiring runs — cuechange only fires on the NEXT change.
      emitCues();
    });
  }

  private clearSubtitleCueListeners(): void {
    this.subtitleCueUnsubscribers.forEach((unsubscribe) => unsubscribe());
    this.subtitleCueUnsubscribers = [];
  }

  getAudioTracks(): readonly AudioTrack[] {
    return this.audioTracks;
  }

  getSubtitleTracks(): readonly SubtitleTrack[] {
    return this.subtitleTracks;
  }

  setAudioTrack(trackId: AudioTrackId): void {
    if (!this.hls) return;
    this.hls.audioTrack = trackId as unknown as number;
  }

  setSubtitleTrack(trackId: SubtitleTrackId | null): void {
    if (!this.hls) return;
    this.hls.subtitleTrack = trackId === null ? NO_TRACK_INDEX : (trackId as unknown as number);
  }

  on<TEventName extends keyof HlsAdapterEvents>(
    eventName: TEventName,
    callback: (payload: HlsAdapterEvents[TEventName]) => void,
  ): () => void {
    return this.emitter.on(eventName, callback);
  }

  attach(): void {}

  detach(): void {
    this.detachHls();
  }

  loadSource(): void {}

  destroy(): void {
    this.detachHls();
    this.emitter.removeAllListeners();
  }
}
