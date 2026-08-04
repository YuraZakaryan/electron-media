import { useEffect, useRef, useState } from "react";

import {
  MediaPlayer,
  type AudioTrack,
  type AudioTrackId,
  type MediaPlayerOptions,
  type PlayerErrorEvent,
  type SubtitleTrack,
  type SubtitleTrackId,
} from "@electron-media/core";

import type { RefObject } from "react";

/** @public Options for {@link useMediaPlayer}; identical to {@link MediaPlayerOptions} minus `video`, which the hook supplies from `videoRef`. */
export type UseMediaPlayerOptions = Omit<MediaPlayerOptions, "video">;

/** @public Return value of {@link useMediaPlayer}. */
export interface UseMediaPlayerResult {
  readonly audioTracks: readonly AudioTrack[];
  readonly selectedAudioTrack: AudioTrack | null;
  readonly subtitleTracks: readonly SubtitleTrack[];
  readonly selectedSubtitle: SubtitleTrack | null;
  selectAudioTrack(trackId: AudioTrackId): void;
  selectSubtitleTrack(trackId: SubtitleTrackId | null): void;
  setSubtitleDelay(offsetSeconds: number): void;
  readonly isLoading: boolean;
  readonly error: PlayerErrorEvent | null;
}

/**
 * React binding for {@link MediaPlayer}. Internal core classes
 * (`MediaPlayer`, `SubtitleController`, `AudioTrackController`, etc.) are
 * never exposed through this hook's return value — only plain data and
 * callbacks, so a host component can never reach past the public API.
 *
 * Ownership: creates one {@link MediaPlayer} per mount of the component
 * calling this hook and destroys it on unmount; assumes `videoRef.current`
 * is non-null by the time this hook's effects run (i.e. the `<video>`
 * element is rendered unconditionally by the caller, not behind a
 * data-dependent conditional).
 *
 * @public
 */
export function useMediaPlayer(
  videoRef: RefObject<HTMLVideoElement | null>,
  sourceUrl: string | null,
  options: UseMediaPlayerOptions
): UseMediaPlayerResult {
  const playerRef = useRef<MediaPlayer | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [audioTracks, setAudioTracks] = useState<readonly AudioTrack[]>([]);
  const [selectedAudioTrackId, setSelectedAudioTrackId] =
    useState<AudioTrackId | null>(null);
  const [subtitleTracks, setSubtitleTracks] = useState<
    readonly SubtitleTrack[]
  >([]);
  const [selectedSubtitle, setSelectedSubtitle] =
    useState<SubtitleTrack | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<PlayerErrorEvent | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const player = new MediaPlayer({ video, ...optionsRef.current });
    playerRef.current = player;

    setAudioTracks(player.audio.getTracks());
    setSelectedAudioTrackId(player.audio.selectedTrackId);
    setSubtitleTracks(player.subtitles.getTracks());
    setSelectedSubtitle(player.subtitles.selectedTrack);
    setError(null);

    const unsubscribeAudioTracks = player.audio.onTracksChanged(setAudioTracks);
    const unsubscribeAudioSelection = player.audio.onSelectionChanged(
      setSelectedAudioTrackId
    );
    const unsubscribeSubtitleTracks =
      player.subtitles.onTracksChanged(setSubtitleTracks);
    const unsubscribeSelection =
      player.subtitles.onSelectionChanged(setSelectedSubtitle);
    const unsubscribeError = player.events.on("error", setError);
    const unsubscribeReady = player.events.on("ready", () =>
      setIsLoading(false)
    );

    return () => {
      unsubscribeAudioTracks();
      unsubscribeAudioSelection();
      unsubscribeSubtitleTracks();
      unsubscribeSelection();
      unsubscribeError();
      unsubscribeReady();
      player.destroy();
      playerRef.current = null;
    };
    // Created exactly once per mount, not keyed on videoRef.current: that
    // value is read at render time, so it's `null` on the very first render
    // and only becomes the real node on the *next* one (refs attach during
    // commit, after render) — using it as a dependency made this effect
    // re-fire on that first re-render, destroying and rebuilding the player
    // right after the sourceUrl effect below had already called
    // loadSource() on the original (now-destroyed) instance, so playback
    // silently never started. Options are read once at construction via
    // optionsRef; changing e.g. preferenceStore mid-session isn't a
    // supported reconfiguration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !sourceUrl) return;

    setIsLoading(true);
    setError(null);
    player.loadSource(sourceUrl);
  }, [sourceUrl]);

  const selectedAudioTrack =
    audioTracks.find((track) => track.trackId === selectedAudioTrackId) ??
    null;

  return {
    audioTracks,
    selectedAudioTrack,
    subtitleTracks,
    selectedSubtitle,
    selectAudioTrack: (trackId) => playerRef.current?.audio.select(trackId),
    selectSubtitleTrack: (trackId) =>
      playerRef.current?.subtitles.selectTrack(trackId),
    setSubtitleDelay: (offsetSeconds) =>
      playerRef.current?.subtitles.setDelaySeconds(offsetSeconds),
    isLoading,
    error,
  };
}
