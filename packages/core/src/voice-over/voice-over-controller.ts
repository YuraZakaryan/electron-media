import { asVoiceOverTrackId } from "../types/branding.js";
import { TrackKind } from "../types/track.js";
import { VoiceOverError } from "../errors/player-error.js";
import { VoiceOverCueScheduler } from "./voice-over-cue-scheduler.js";
import { VoiceOverDuckingPlayer } from "./voice-over-ducking-player.js";

import type { TypedEventEmitter, PlayerEvents } from "../events.js";
import type { VoiceOverSourceId, VoiceOverTrackId } from "../types/branding.js";
import type { SubtitleTrackId } from "../types/branding.js";
import type { VoiceOverTrack } from "../types/track.js";
import type { IVoiceOverGateway } from "./voice-over-gateway.js";
import type { ISubtitleSource } from "../subtitles/subtitle-source.js";
import type { IVoiceOverTicker } from "./ticker.js";
import type { PlayerPreferenceStore } from "../contracts/preference-store.js";
import type { FadeCurve } from "./voice-over-ducking-player.js";

const DEFAULT_TRACK_SWITCH_DEBOUNCE_MS = 300;
const CONTROLLER_SOURCE_ID = "voice-over-gateway" as VoiceOverSourceId;

/** @public Options for {@link VoiceOverController}. */
export interface VoiceOverControllerOptions {
  readonly gateway: IVoiceOverGateway;
  readonly events: TypedEventEmitter<PlayerEvents>;
  readonly ticker?: IVoiceOverTicker;
  /** How loud the *original* video audio plays while ducked. @defaultValue 0.15 */
  readonly duckVolume?: number;
  /** How loud the narration line itself plays — independent of `duckVolume`. @defaultValue 1 */
  readonly voiceOverVolume?: number;
  readonly duckFadeCurve?: FadeCurve;
  /** Opts into WCAG 1.2.7 Extended Audio Description (pausing the video for a line that doesn't fit its cue window). @defaultValue false */
  readonly allowVideoPause?: boolean;
  /** The host's main/master player volume, `0`–`1`. Live-multiplied into `duckVolume`/`voiceOverVolume` unless {@link ignoreMainVolume} is set. @defaultValue 1 */
  readonly mainVolume?: number;
  /** Opts *out* of {@link mainVolume} scaling `duckVolume`/`voiceOverVolume`. @defaultValue false */
  readonly ignoreMainVolume?: boolean;
  readonly lookaheadSeconds?: number;
  readonly lateStartGraceSeconds?: number;
  readonly maxConcurrentSynthesis?: number;
  /** How far ahead of the *next* cue's own start Extended Audio Description's video-pause fires, for a still-playing line. @defaultValue 0.15 */
  readonly extendedPauseLeadSeconds?: number;
  /** See {@link VoiceOverCueSchedulerOptions.narrationRate}. @defaultValue 1 */
  readonly narrationRate?: number;
  /** Persists/restores the user's chosen narration language. Omit to disable auto-restore. */
  readonly preferenceStore?: PlayerPreferenceStore;
  /** Debounce, in ms, applied to rapid {@link bindSubtitleSource} calls. @defaultValue 300 */
  readonly trackSwitchDebounceMs?: number;
}

/**
 * Public facade for voice-over narration: TTS-synthesizes lines for a bound
 * subtitle track's cues, ducks the video's volume while a line plays, and
 * exposes track listing/selection.
 *
 * Unlike {@link SubtitleController}, this has no registry/selection-service
 * split — voice-over has exactly one kind of source (an
 * {@link IVoiceOverGateway}), not N heterogeneous ones, so that split would
 * be speculative (see `docs/design-principles.md`). It composes
 * {@link VoiceOverCueScheduler} (timing) and {@link VoiceOverDuckingPlayer}
 * (audio/DOM side effects) instead, mirroring {@link AudioTrackController}'s
 * single-controller shape.
 *
 * Ownership: does not own the `video` element passed to {@link attach}.
 *
 * Lifecycle: call {@link destroy} exactly once when done; no other method
 * may be called afterwards.
 *
 * @public
 */
export class VoiceOverController {
  private readonly gateway: IVoiceOverGateway;
  private readonly events: TypedEventEmitter<PlayerEvents>;
  private readonly scheduler: VoiceOverCueScheduler;
  private readonly preferenceStore?: PlayerPreferenceStore;
  private duckVolume?: number;
  private voiceOverVolume?: number;
  private allowVideoPause?: boolean;
  private mainVolume?: number;
  private ignoreMainVolume?: boolean;
  private readonly duckFadeCurve?: FadeCurve;
  private readonly trackSwitchDebounceMs: number;

  private duckingPlayer: VoiceOverDuckingPlayer | null = null;
  private video: HTMLVideoElement | null = null;

  private tracks: VoiceOverTrack[] = [];
  private tracksPromise: Promise<readonly VoiceOverTrack[]> | null = null;
  private selectedTrackValue: VoiceOverTrack | null = null;
  private hasUserSelected = false;

  private boundSource: ISubtitleSource | null = null;
  private boundSubtitleTrackId: SubtitleTrackId | null = null;
  private unsubscribeFromCues: (() => void) | null = null;
  private rebindTimeoutId: ReturnType<typeof setTimeout> | null = null;

  private readonly unsubscribeFromLineReady: () => void;
  private readonly unsubscribeFromExtendedPauseDue: () => void;
  private readonly unsubscribeFromHardStop: () => void;
  private readonly unsubscribeFromLineFailed: () => void;
  private readonly unsubscribeFromLineSkipped: () => void;
  private readonly unsubscribeFromPausedChanged: () => void;
  private readonly unsubscribeFromCueStateChanged: () => void;
  private readonly selectionListeners = new Set<(track: VoiceOverTrack | null) => void>();
  private readonly generatingListeners = new Set<(isGenerating: boolean) => void>();

  constructor(options: VoiceOverControllerOptions) {
    this.gateway = options.gateway;
    this.events = options.events;
    this.preferenceStore = options.preferenceStore;
    this.duckVolume = options.duckVolume;
    this.voiceOverVolume = options.voiceOverVolume;
    this.allowVideoPause = options.allowVideoPause;
    this.mainVolume = options.mainVolume;
    this.ignoreMainVolume = options.ignoreMainVolume;
    this.duckFadeCurve = options.duckFadeCurve;
    this.trackSwitchDebounceMs =
      options.trackSwitchDebounceMs ?? DEFAULT_TRACK_SWITCH_DEBOUNCE_MS;

    this.scheduler = new VoiceOverCueScheduler({
      gateway: this.gateway,
      ticker: options.ticker,
      lookaheadSeconds: options.lookaheadSeconds,
      lateStartGraceSeconds: options.lateStartGraceSeconds,
      maxConcurrentSynthesis: options.maxConcurrentSynthesis,
      extendedPauseLeadSeconds: options.extendedPauseLeadSeconds,
      narrationRate: options.narrationRate,
    });

    this.unsubscribeFromLineReady = this.scheduler.onLineReady((line) => {
      this.duckingPlayer?.playLine(line.cueKey, line.audioUrl);
      const trackId = this.selectedTrackValue?.trackId ?? asVoiceOverTrackId("");
      this.events.emit("voiceOverLinePlayed", {
        trackId,
        cueKey: line.cueKey,
        clipped: line.clipped,
        isExtended: line.isExtended,
      });
    });
    this.unsubscribeFromExtendedPauseDue = this.scheduler.onExtendedPauseDue((cueKey) => {
      this.duckingPlayer?.pauseForExtendedDescription(cueKey);
    });
    this.unsubscribeFromHardStop = this.scheduler.onHardStop(() => {
      this.duckingPlayer?.stopLine(true);
    });
    this.unsubscribeFromPausedChanged = this.scheduler.onPlaybackPausedChanged((isPaused) => {
      // A paused-for-Extended-Description video is a pause this class
      // itself caused; mirroring it back onto the narration audio would
      // freeze the one thing that must keep playing through it.
      if (this.duckingPlayer?.isPausedForExtendedDescription) return;
      this.duckingPlayer?.setPaused(isPaused);
    });
    this.unsubscribeFromLineFailed = this.scheduler.onLineFailed(
      (_cueKey, error, wasUnexpectedThrow) => {
        const trackId = this.selectedTrackValue?.trackId ?? asVoiceOverTrackId("");
        this.events.emit("voiceOverLineFailed", {
          trackId,
          error: wasUnexpectedThrow ? new VoiceOverError(error) : error,
        });
      }
    );
    this.unsubscribeFromLineSkipped = this.scheduler.onLineSkipped((cueKey) => {
      const trackId = this.selectedTrackValue?.trackId ?? asVoiceOverTrackId("");
      this.events.emit("voiceOverLineSkipped", { trackId, cueKey });
    });

    let wasGenerating = false;
    const pollGenerating = () => {
      if (this.scheduler.isGenerating !== wasGenerating) {
        wasGenerating = this.scheduler.isGenerating;
        this.generatingListeners.forEach((listener) => listener(wasGenerating));
      }
    };
    this.unsubscribeFromCueStateChanged = this.scheduler.onCueStateChanged(pollGenerating);
  }

  /** Attaches the video voice-over lines play alongside/duck. Safe to call again with a new element. */
  attach(video: HTMLVideoElement): void {
    this.video = video;
    this.duckingPlayer?.dispose();
    this.duckingPlayer = new VoiceOverDuckingPlayer({
      video,
      duckVolume: this.duckVolume,
      voiceOverVolume: this.voiceOverVolume,
      allowVideoPause: this.allowVideoPause,
      mainVolume: this.mainVolume,
      ignoreMainVolume: this.ignoreMainVolume,
      fadeCurve: this.duckFadeCurve,
      onPlaybackRejected: (cueKey) => {
        // No audio ever actually started — without releasing the hold
        // here, the scheduler keeps refusing to start the next due line
        // until video.currentTime naturally passes this cue's own
        // endSeconds, producing a silent gap in narration.
        this.scheduler.releasePlayingCue(cueKey);
        const trackId = this.selectedTrackValue?.trackId ?? asVoiceOverTrackId("");
        this.events.emit("voiceOverPlaybackRejected", { trackId });
      },
      onVideoResumeRejected: () => {
        const trackId = this.selectedTrackValue?.trackId ?? asVoiceOverTrackId("");
        this.events.emit("voiceOverVideoResumeRejected", { trackId });
      },
      onLineEnded: (cueKey) => {
        this.scheduler.notifyLineEnded(cueKey);
      },
    });
    this.scheduler.attach(video);
  }

  /** Detaches the current video. */
  detach(): void {
    this.scheduler.detach();
    this.duckingPlayer?.dispose();
    this.duckingPlayer = null;
    this.video = null;
  }

  /**
   * Returns the available voice-over tracks, fetched from the gateway once
   * and cached thereafter. On the first successful resolution, if no
   * explicit {@link selectTrack} call has happened yet, auto-restores the
   * language last persisted via `preferenceStore.setVoiceOverLanguage` —
   * mirroring {@link AudioTrackController}'s restore latch — but only when
   * a stored language actually matches an available track; unlike audio,
   * there is no "always select something" fallback, since voice-over's
   * default is off.
   */
  async getTracks(): Promise<readonly VoiceOverTrack[]> {
    if (this.tracksPromise) return this.tracksPromise;

    this.tracksPromise = this.gateway.listVoices().then((voices) => {
      this.tracks = voices.map((voice) => ({
        trackId: asVoiceOverTrackId(voice.languageCode),
        displayName: voice.displayName,
        language: voice.languageCode,
        kind: TrackKind.Dub,
        sourceId: CONTROLLER_SOURCE_ID,
      }));
      this.autoRestorePreferredTrack();
      return this.tracks;
    });
    return this.tracksPromise;
  }

  /** Selects `trackId` (enabling narration in that language), or disables voice-over when `null`. No-op if `trackId` is not currently known. Persists the choice via `preferenceStore.setVoiceOverLanguage`, if provided. */
  selectTrack(trackId: VoiceOverTrackId | null): void {
    this.hasUserSelected = true;

    if (trackId === null) {
      this.setSelected(null);
      this.scheduler.setLanguageCode(null);
      // Without this, a stale stored language from an earlier explicit pick
      // would silently turn narration back on the next time getTracks()
      // resolves (a new controller instance, e.g. after an app restart) —
      // an explicit "off" must stick exactly as durably as an explicit pick.
      this.preferenceStore?.setVoiceOverLanguage?.(null);
      return;
    }

    const track = this.tracks.find((candidate) => candidate.trackId === trackId);
    if (!track) return;

    this.setSelected(track);
    this.scheduler.setLanguageCode(track.language);
    this.preferenceStore?.setVoiceOverLanguage?.(track.language);
  }

  /**
   * Immediately stops any currently playing narration line, restoring the
   * video's volume — without changing the selected track or persisted
   * language preference. Unlike calling {@link selectTrack}`(null)`, this
   * is not an "off" decision: use it for host-side cleanup (e.g. closing
   * the current title while a line is mid-narration) where the user's
   * choice should still apply, unchanged, the next time narration starts.
   */
  stop(): void {
    this.scheduler.stop();
  }

  /**
   * Updates how loud the *original* video audio plays while ducked, live,
   * without recreating the controller. Applies to the next line started;
   * does not re-fade a line already playing. Pair with
   * {@link setVoiceOverVolume} for a settings UI exposing both as
   * independent sliders.
   */
  setDuckVolume(volume: number): void {
    this.duckVolume = volume;
    this.duckingPlayer?.setDuckVolume(volume);
  }

  /**
   * Updates how loud the *narration* line itself plays, live — independent
   * of {@link setDuckVolume}. Re-applies immediately to a currently
   * playing line, if any.
   */
  setVoiceOverVolume(volume: number): void {
    this.voiceOverVolume = volume;
    this.duckingPlayer?.setVoiceOverVolume(volume);
  }

  /**
   * Updates whether Extended Audio Description (WCAG 1.2.7 — pausing the
   * video for a line that doesn't fit its cue window) is allowed, live.
   * Takes effect on the next line started.
   */
  setAllowVideoPause(allow: boolean): void {
    this.allowVideoPause = allow;
    this.duckingPlayer?.setAllowVideoPause(allow);
  }

  /**
   * Updates the host's main/master player volume, live — multiplied into
   * both `duckVolume` and `voiceOverVolume` unless {@link setIgnoreMainVolume}
   * is on. Re-applies immediately to whatever's currently playing, mirroring
   * {@link setDuckVolume}/{@link setVoiceOverVolume}'s live re-apply.
   */
  setMainVolume(volume: number): void {
    this.mainVolume = volume;
    this.duckingPlayer?.setMainVolume(volume);
  }

  /**
   * Opts in/out of {@link setMainVolume} scaling `duckVolume`/
   * `voiceOverVolume`, live. Off by default — narration respects the
   * main volume unless a host explicitly opts out.
   */
  setIgnoreMainVolume(ignore: boolean): void {
    this.ignoreMainVolume = ignore;
    this.duckingPlayer?.setIgnoreMainVolume(ignore);
  }

  /**
   * Updates the user-facing timing nudge applied to every bound cue's own
   * `startSeconds`/`endSeconds` before comparing against `video.currentTime`
   * — mirrors `SubtitleController.setDelaySeconds`'s exact contract
   * (positive = a cue is due later), so a host reprojecting both subtitles
   * and voice-over by the same offset can call both with the same sign.
   * Applied live on every tick, never baked into a cue's own stored
   * time — see {@link VoiceOverCueScheduler.setDelaySeconds}'s own doc
   * comment for why that matters.
   */
  setDelaySeconds(delaySeconds: number): void {
    this.scheduler.setDelaySeconds(delaySeconds);
  }

  /** Updates the synthesis lookahead window live. Takes effect on the next tick. */
  setLookaheadSeconds(seconds: number): void {
    this.scheduler.setLookaheadSeconds(seconds);
  }

  /** Updates the late-start grace window live. Takes effect on the next tick. */
  setLateStartGraceSeconds(seconds: number): void {
    this.scheduler.setLateStartGraceSeconds(seconds);
  }

  /** Updates the Extended Audio Description pause lead live. Takes effect on the next tick. */
  setExtendedPauseLeadSeconds(seconds: number): void {
    this.scheduler.setExtendedPauseLeadSeconds(seconds);
  }

  /** Updates the narration rate live — see {@link VoiceOverControllerOptions.narrationRate}. */
  setNarrationRate(rate: number): void {
    this.scheduler.setNarrationRate(rate);
  }

  /** The currently selected voice-over track, or `null` if disabled. */
  get selectedTrack(): VoiceOverTrack | null {
    return this.selectedTrackValue;
  }

  /** Notifies `callback` whenever the selected track changes. */
  onSelectionChanged(callback: (track: VoiceOverTrack | null) => void): () => void {
    this.selectionListeners.add(callback);
    return () => this.selectionListeners.delete(callback);
  }

  /** `true` while at least one line's synthesis is in flight. */
  get isGenerating(): boolean {
    return this.scheduler.isGenerating;
  }

  /** Notifies `callback` whenever {@link isGenerating} changes. */
  onGeneratingChanged(callback: (isGenerating: boolean) => void): () => void {
    this.generatingListeners.add(callback);
    return () => this.generatingListeners.delete(callback);
  }

  /**
   * Subscribes to `trackId`'s cues on `source` and feeds them to the
   * scheduler as narration material, calling `source.selectTrack(trackId)`
   * to activate that source's own fetch/emit pipeline — required for real
   * {@link ISubtitleSource} implementations (`VodExtractedSubtitleSource`,
   * `OpenSubtitlesSource`), which never fetch or emit a track's cue text
   * until their own `selectTrack()` has been called for that id;
   * `onCuesChanged` alone only registers a listener nothing else fires.
   * This is safe to do invisibly: on-screen rendering is owned entirely by
   * `SubtitleController`'s own selection state and renderer, which never
   * inspects a source's internal active-track id, so binding a subtitle
   * track for narration still never has the side effect of visibly turning
   * that subtitle track on. Debounced against rapid repeated calls (e.g.
   * arrow-key track cycling).
   */
  bindSubtitleSource(source: ISubtitleSource | null, trackId: SubtitleTrackId | null): void {
    if (this.rebindTimeoutId !== null) clearTimeout(this.rebindTimeoutId);
    this.rebindTimeoutId = setTimeout(() => {
      this.rebindTimeoutId = null;
      this.applySubtitleBinding(source, trackId);
    }, this.trackSwitchDebounceMs);
  }

  /** Releases all resources. Idempotent. */
  destroy(): void {
    if (this.rebindTimeoutId !== null) {
      clearTimeout(this.rebindTimeoutId);
      this.rebindTimeoutId = null;
    }
    this.unsubscribeFromCues?.();
    this.unsubscribeFromCues = null;
    this.boundSource = null;

    this.unsubscribeFromLineReady();
    this.unsubscribeFromExtendedPauseDue();
    this.unsubscribeFromHardStop();
    this.unsubscribeFromLineFailed();
    this.unsubscribeFromLineSkipped();
    this.unsubscribeFromPausedChanged();
    this.unsubscribeFromCueStateChanged();

    this.duckingPlayer?.dispose();
    this.duckingPlayer = null;
    this.scheduler.dispose();
  }

  private applySubtitleBinding(
    source: ISubtitleSource | null,
    trackId: SubtitleTrackId | null
  ): void {
    // A redundant call with the same source+trackId as already bound is a
    // no-op, not "just a cheap re-selection" — falling through would still
    // call scheduler.setCues([]) below, wiping every cue's already-narrated
    // tracking (Played/Skipped/Ready) and letting an already-played line
    // look brand new to the next updateCues() delivery, replaying it. This
    // can be triggered by an unrelated dependency change re-running whatever
    // effect calls bindSubtitleSource — not just an actual track switch.
    if (source === this.boundSource && trackId === this.boundSubtitleTrackId) {
      return;
    }

    this.unsubscribeFromCues?.();
    this.unsubscribeFromCues = null;
    this.boundSource = source;
    this.boundSubtitleTrackId = trackId;

    if (!source || trackId === null) {
      this.scheduler.setCues([]);
      return;
    }

    // A genuine rebind (this method only runs for a new/changed source or
    // trackId — see bindSubtitleSource's debounce) starts from a clean
    // slate; every cue delivery AFTER this one, for this same subscription,
    // is treated as incremental growth of the same track (updateCues,
    // below) rather than another rebind — see updateCues's own doc comment
    // for why that distinction matters.
    this.scheduler.setCues([]);

    // Subscribe BEFORE selecting — a source with this track's cues already
    // cached (e.g. OpenSubtitlesSource re-selecting a previously-downloaded
    // track) emits them synchronously from within selectTrack() itself;
    // subscribing afterwards would miss that emission.
    this.unsubscribeFromCues = source.onCuesChanged(trackId, (cues) => {
      this.scheduler.updateCues(cues);
    });
    // Required for cue text to ever actually arrive — see this method's
    // doc comment. Deliberately never pairs this with a
    // `previousSource.selectTrack(null)` on rebind/unbind: this source
    // instance may also be backing the visibly-selected subtitle on a
    // different track, and nulling its active id would stop that track's
    // own fetching/polling as a side effect. Whichever caller (this one or
    // SubtitleController) calls selectTrack next simply supersedes; a
    // source's own selectTrack implementation already stops its previous
    // polling before starting the new one.
    source.selectTrack(trackId);
  }

  private autoRestorePreferredTrack(): void {
    if (this.hasUserSelected) return;

    const storedLanguage = this.preferenceStore?.getVoiceOverLanguage?.();
    if (!storedLanguage) return;

    const track = this.tracks.find((candidate) => candidate.language === storedLanguage);
    if (!track) return;

    // Auto-restore, not a user action — deliberately does not set
    // hasUserSelected or re-persist, mirroring AudioTrackController's latch.
    this.setSelected(track);
    this.scheduler.setLanguageCode(track.language);
  }

  private setSelected(track: VoiceOverTrack | null): void {
    if (track?.trackId === this.selectedTrackValue?.trackId) return;
    this.selectedTrackValue = track;
    this.selectionListeners.forEach((listener) => listener(track));
  }
}
