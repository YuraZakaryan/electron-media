import { useEffect, useRef, useState } from "react";

import {
  MediaPlayer,
  type MediaPlayerOptions,
  type PlayerErrorEvent,
} from "@electron-media/core";

import type { RefObject } from "react";

import { useAudioTrackController } from "./use-audio-track-controller.js";
import { useSubtitleController } from "./use-subtitle-controller.js";
import { useVoiceOverController } from "./use-voice-over-controller.js";

import type { UseAudioTrackControllerResult } from "./use-audio-track-controller.js";
import type { UseSubtitleControllerResult } from "./use-subtitle-controller.js";
import type { UseVoiceOverControllerResult } from "./use-voice-over-controller.js";

/** @public Options for {@link useMediaPlayer}; identical to {@link MediaPlayerOptions} minus `video`, which the hook supplies from `videoRef`. */
export type UseMediaPlayerOptions = Omit<MediaPlayerOptions, "video">;

/** @public Return value of {@link useMediaPlayer}. */
export interface UseMediaPlayerResult {
  readonly audio: UseAudioTrackControllerResult;
  readonly subtitles: UseSubtitleControllerResult;
  /** `voiceOver.state.tracks` is empty, and every `voiceOver.actions` call a harmless no-op, when the player was constructed without a `voiceOverGateway`. */
  readonly voiceOver: UseVoiceOverControllerResult;
  readonly isLoading: boolean;
  readonly error: PlayerErrorEvent | null;
}

/**
 * React binding for {@link MediaPlayer}. Internal core classes
 * (`MediaPlayer`, `SubtitleController`, `AudioTrackController`, etc.) are
 * never exposed through this hook's return value — only plain data and
 * callbacks, so a host component can never reach past the public API.
 * `audio`/`subtitles`/`voiceOver` are exactly the `{ state, actions }`
 * results of {@link useAudioTrackController}, {@link useSubtitleController}
 * and {@link useVoiceOverController} — this hook composes them rather than
 * re-deriving the same state, so a host that needs just one of the three
 * (e.g. because it must own its own `Hls` instance and can't use this
 * all-in-one hook) can call that hook directly and get an identical shape.
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

  // Mirrors playerRef once the mount effect below has constructed the
  // player — the per-controller hooks need the instance itself to
  // subscribe to, and a ref mutation alone doesn't trigger the re-render
  // that lets them pick it up.
  const [player, setPlayer] = useState<MediaPlayer | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<PlayerErrorEvent | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const newPlayer = new MediaPlayer({ video, ...optionsRef.current });
    playerRef.current = newPlayer;
    setError(null);
    setPlayer(newPlayer);

    const unsubscribeError = newPlayer.events.on("error", setError);
    const unsubscribeReady = newPlayer.events.on("ready", () =>
      setIsLoading(false)
    );

    return () => {
      unsubscribeError();
      unsubscribeReady();
      newPlayer.destroy();
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
    const currentPlayer = playerRef.current;
    if (!currentPlayer || !sourceUrl) return;

    setIsLoading(true);
    setError(null);
    currentPlayer.loadSource(sourceUrl);
  }, [sourceUrl]);

  const audio = useAudioTrackController(player?.audio);
  const subtitles = useSubtitleController(player?.subtitles);
  const voiceOver = useVoiceOverController(player?.voiceOver);

  return {
    audio,
    subtitles,
    voiceOver,
    isLoading,
    error,
  };
}
