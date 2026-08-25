import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type {
  ISubtitleSource,
  SubtitleTrackId,
  VoiceOverController,
  VoiceOverTrack,
  VoiceOverTrackId,
} from "@electron-media/core";

/** @public State half of {@link useVoiceOverController}'s return value. */
export interface VoiceOverControllerState {
  readonly tracks: readonly VoiceOverTrack[];
  readonly selectedTrack: VoiceOverTrack | null;
  readonly isGenerating: boolean;
}

/** @public Actions half of {@link useVoiceOverController}'s return value. */
export interface VoiceOverControllerActions {
  selectTrack(trackId: VoiceOverTrackId | null): void;
  /** Shorthand for `selectTrack(null)`. */
  disableVoiceOver(): void;
  /** Feeds `source`'s cues for `trackId` into voice-over narration, without turning that subtitle track on. Auto-pick policy (which track to narrate) stays app-level. */
  bindSubtitleSource(source: ISubtitleSource | null, trackId: SubtitleTrackId | null): void;
  setDuckVolume(volume: number): void;
  setVoiceOverVolume(volume: number): void;
  setLookaheadSeconds(seconds: number): void;
  setNarrationRate(rate: number): void;
  setAllowVideoPause(allow: boolean): void;
  /** The host's main/master player volume — live-multiplied into `duckVolume`/`voiceOverVolume` unless {@link setIgnoreMainVolume} is on. */
  setMainVolume(volume: number): void;
  /** Opts in/out of {@link setMainVolume} scaling `duckVolume`/`voiceOverVolume`. */
  setIgnoreMainVolume(ignore: boolean): void;
}

/** @public Return value of {@link useVoiceOverController}. */
export interface UseVoiceOverControllerResult {
  readonly state: VoiceOverControllerState;
  readonly actions: VoiceOverControllerActions;
}

/**
 * React binding for a single already-constructed {@link VoiceOverController}.
 * See {@link useAudioTrackController} for why this exists alongside the
 * all-in-one {@link useMediaPlayer} — a host that must build its own
 * `SubtitleController`/`AudioTrackController`/`VoiceOverController` directly
 * (rather than via `MediaPlayer`) still gets the same subscription
 * boilerplate for whichever controller it already owns — and for the
 * `{ state, actions }` shape shared across this package's hooks.
 *
 * @public
 */
export function useVoiceOverController(
  voiceOver: VoiceOverController | null | undefined
): UseVoiceOverControllerResult {
  // tracks stays on useState+effect: getTracks() is an async fetch
  // (gateway.listVoices()) — VoiceOverController exposes no synchronous
  // getter + change-event for its resolved value, unlike selectedTrack/
  // isGenerating below, so there is no synchronous external store here for
  // useSyncExternalStore to wrap.
  const [tracks, setTracks] = useState<readonly VoiceOverTrack[]>([]);

  useEffect(() => {
    if (!voiceOver) {
      setTracks([]);
      return;
    }
    void voiceOver.getTracks().then(setTracks);
  }, [voiceOver]);

  // useSyncExternalStore, not useState+useEffect: these two mirror an
  // external, non-React-owned store, and a manual subscription is prone to
  // tearing under concurrent rendering (React pausing mid-render while the
  // controller emits a change could let two components reading the same
  // controller see different values within one render pass).
  const subscribeSelection = useCallback(
    (onStoreChange: () => void) =>
      voiceOver ? voiceOver.onSelectionChanged(() => onStoreChange()) : () => {},
    [voiceOver]
  );
  const getSelectionSnapshot = useCallback(
    () => (voiceOver ? voiceOver.selectedTrack : null),
    [voiceOver]
  );
  const selectedTrack = useSyncExternalStore(subscribeSelection, getSelectionSnapshot);

  const subscribeGenerating = useCallback(
    (onStoreChange: () => void) =>
      voiceOver ? voiceOver.onGeneratingChanged(() => onStoreChange()) : () => {},
    [voiceOver]
  );
  const getGeneratingSnapshot = useCallback(
    () => (voiceOver ? voiceOver.isGenerating : false),
    [voiceOver]
  );
  const isGenerating = useSyncExternalStore(subscribeGenerating, getGeneratingSnapshot);

  const selectTrack = useCallback(
    (trackId: VoiceOverTrackId | null) => voiceOver?.selectTrack(trackId),
    [voiceOver]
  );
  const disableVoiceOver = useCallback(
    () => voiceOver?.selectTrack(null),
    [voiceOver]
  );
  const bindSubtitleSource = useCallback(
    (source: ISubtitleSource | null, trackId: SubtitleTrackId | null) =>
      voiceOver?.bindSubtitleSource(source, trackId),
    [voiceOver]
  );
  const setDuckVolume = useCallback(
    (volume: number) => voiceOver?.setDuckVolume(volume),
    [voiceOver]
  );
  const setVoiceOverVolume = useCallback(
    (volume: number) => voiceOver?.setVoiceOverVolume(volume),
    [voiceOver]
  );
  const setLookaheadSeconds = useCallback(
    (seconds: number) => voiceOver?.setLookaheadSeconds(seconds),
    [voiceOver]
  );
  const setNarrationRate = useCallback(
    (rate: number) => voiceOver?.setNarrationRate(rate),
    [voiceOver]
  );
  const setAllowVideoPause = useCallback(
    (allow: boolean) => voiceOver?.setAllowVideoPause(allow),
    [voiceOver]
  );
  const setMainVolume = useCallback(
    (volume: number) => voiceOver?.setMainVolume(volume),
    [voiceOver]
  );
  const setIgnoreMainVolume = useCallback(
    (ignore: boolean) => voiceOver?.setIgnoreMainVolume(ignore),
    [voiceOver]
  );

  const state = useMemo<VoiceOverControllerState>(
    () => ({ tracks, selectedTrack, isGenerating }),
    [tracks, selectedTrack, isGenerating]
  );
  const actions = useMemo<VoiceOverControllerActions>(
    () => ({
      selectTrack,
      disableVoiceOver,
      bindSubtitleSource,
      setDuckVolume,
      setVoiceOverVolume,
      setLookaheadSeconds,
      setNarrationRate,
      setAllowVideoPause,
      setMainVolume,
      setIgnoreMainVolume,
    }),
    [
      selectTrack,
      disableVoiceOver,
      bindSubtitleSource,
      setDuckVolume,
      setVoiceOverVolume,
      setLookaheadSeconds,
      setNarrationRate,
      setAllowVideoPause,
      setMainVolume,
      setIgnoreMainVolume,
    ]
  );

  return { state, actions };
}
