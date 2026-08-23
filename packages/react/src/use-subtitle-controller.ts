import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import type { SubtitleController, SubtitleTrack, SubtitleTrackId } from "@electron-media/core";

const EMPTY_TRACKS: readonly SubtitleTrack[] = [];

/** @public State half of {@link useSubtitleController}'s return value. */
export interface SubtitleControllerState {
  readonly tracks: readonly SubtitleTrack[];
  readonly selectedTrack: SubtitleTrack | null;
}

/** @public Actions half of {@link useSubtitleController}'s return value. */
export interface SubtitleControllerActions {
  selectTrack(trackId: SubtitleTrackId | null): void;
  setDelaySeconds(offsetSeconds: number): void;
}

/** @public Return value of {@link useSubtitleController}. */
export interface UseSubtitleControllerResult {
  readonly state: SubtitleControllerState;
  readonly actions: SubtitleControllerActions;
}

/**
 * React binding for a single already-constructed {@link SubtitleController}.
 * See {@link useAudioTrackController} for why this exists alongside the
 * all-in-one {@link useMediaPlayer}, and for the `{ state, actions }` shape
 * shared across this package's hooks.
 *
 * @public
 */
export function useSubtitleController(
  subtitles: SubtitleController | null | undefined
): UseSubtitleControllerResult {
  // useSyncExternalStore, not useState+useEffect: this hook mirrors an
  // external, non-React-owned store, and a manual subscription is prone to
  // tearing under concurrent rendering (React pausing mid-render while the
  // controller emits a change could let two components reading the same
  // controller see different values within one render pass).
  const subscribeTracks = useCallback(
    (onStoreChange: () => void) =>
      subtitles ? subtitles.onTracksChanged(() => onStoreChange()) : () => {},
    [subtitles]
  );
  // SubtitleController.getTracks() rebuilds a fresh array from its registry
  // on every call, even when nothing changed — cached here by content (same
  // trackIds in the same order) so the snapshot stays referentially stable
  // across renders that don't actually change the track list.
  const tracksCacheRef = useRef<readonly SubtitleTrack[]>(EMPTY_TRACKS);
  const getTracksSnapshot = useCallback(() => {
    const next = subtitles ? subtitles.getTracks() : EMPTY_TRACKS;
    const prev = tracksCacheRef.current;
    const sameContent =
      prev.length === next.length &&
      prev.every((track, index) => track.trackId === next[index].trackId);
    if (!sameContent) tracksCacheRef.current = next;
    return tracksCacheRef.current;
  }, [subtitles]);
  const tracks = useSyncExternalStore(subscribeTracks, getTracksSnapshot);

  const subscribeSelection = useCallback(
    (onStoreChange: () => void) =>
      subtitles ? subtitles.onSelectionChanged(() => onStoreChange()) : () => {},
    [subtitles]
  );
  const getSelectionSnapshot = useCallback(
    () => (subtitles ? subtitles.selectedTrack : null),
    [subtitles]
  );
  const selectedTrack = useSyncExternalStore(subscribeSelection, getSelectionSnapshot);

  const selectTrack = useCallback(
    (trackId: SubtitleTrackId | null) => subtitles?.selectTrack(trackId),
    [subtitles]
  );
  const setDelaySeconds = useCallback(
    (offsetSeconds: number) => subtitles?.setDelaySeconds(offsetSeconds),
    [subtitles]
  );

  const state = useMemo<SubtitleControllerState>(
    () => ({ tracks, selectedTrack }),
    [tracks, selectedTrack]
  );
  const actions = useMemo<SubtitleControllerActions>(
    () => ({ selectTrack, setDelaySeconds }),
    [selectTrack, setDelaySeconds]
  );

  return { state, actions };
}
