import { useCallback, useMemo, useSyncExternalStore } from "react";

import type { AudioTrack, AudioTrackController, AudioTrackId } from "@electron-media/core";

const EMPTY_TRACKS: readonly AudioTrack[] = [];

/** @public State half of {@link useAudioTrackController}'s return value. */
export interface AudioTrackControllerState {
  readonly tracks: readonly AudioTrack[];
  readonly selectedTrack: AudioTrack | null;
}

/** @public Actions half of {@link useAudioTrackController}'s return value. */
export interface AudioTrackControllerActions {
  select(trackId: AudioTrackId): void;
}

/** @public Return value of {@link useAudioTrackController}. */
export interface UseAudioTrackControllerResult {
  readonly state: AudioTrackControllerState;
  readonly actions: AudioTrackControllerActions;
}

/**
 * React binding for a single already-constructed {@link AudioTrackController}
 * — unlike {@link useMediaPlayer}, this hook does not construct or own the
 * controller, so it also works for hosts that build their own `MediaPlayer`
 * pieces directly (e.g. because they must keep external ownership of the
 * underlying `Hls` instance for their own seek/transcode lifecycle) and only
 * need the state-subscription boilerplate for a controller they already
 * have.
 *
 * Returns `{ state, actions }` — data kept separate from behaviour, the same
 * shape every hook in this package returns (see
 * {@link useSubtitleController}, {@link useVoiceOverController}) — so a
 * consumer destructuring one never has to guess whether a given property is
 * a value or a callback. `actions` is referentially stable across renders
 * as long as `audio` itself doesn't change, so it's safe to omit from a
 * consuming effect's dependency array.
 *
 * @public
 */
export function useAudioTrackController(
  audio: AudioTrackController | null | undefined
): UseAudioTrackControllerResult {
  // useSyncExternalStore, not useState+useEffect: this hook mirrors an
  // external, non-React-owned store, and a manual subscription is prone to
  // tearing under concurrent rendering (React pausing mid-render while the
  // controller emits a change could let two components reading the same
  // controller see different values within one render pass).
  const subscribeTracks = useCallback(
    (onStoreChange: () => void) =>
      audio ? audio.onTracksChanged(() => onStoreChange()) : () => {},
    [audio]
  );
  const getTracksSnapshot = useCallback(
    () => (audio ? audio.getTracks() : EMPTY_TRACKS),
    [audio]
  );
  const tracks = useSyncExternalStore(subscribeTracks, getTracksSnapshot);

  const subscribeSelection = useCallback(
    (onStoreChange: () => void) =>
      audio ? audio.onSelectionChanged(() => onStoreChange()) : () => {},
    [audio]
  );
  const getSelectionSnapshot = useCallback(
    () => (audio ? audio.selectedTrackId : null),
    [audio]
  );
  const selectedTrackId = useSyncExternalStore(subscribeSelection, getSelectionSnapshot);

  const selectedTrack =
    tracks.find((track) => track.trackId === selectedTrackId) ?? null;

  const select = useCallback(
    (trackId: AudioTrackId) => audio?.select(trackId),
    [audio]
  );

  const state = useMemo<AudioTrackControllerState>(
    () => ({ tracks, selectedTrack }),
    [tracks, selectedTrack]
  );
  const actions = useMemo<AudioTrackControllerActions>(
    () => ({ select }),
    [select]
  );

  return { state, actions };
}
