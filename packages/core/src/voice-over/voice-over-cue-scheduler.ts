import { getSpeakableText } from "./speakable-text.js";
import { RafVoiceOverTicker } from "./ticker.js";
import { VoiceOverCuePlaybackState } from "../types/voice-over.js";

import type { IVoiceOverGateway } from "./voice-over-gateway.js";
import type { IVoiceOverTicker } from "./ticker.js";
import type { CanonicalCue } from "../types/cue.js";

const DEFAULT_LOOKAHEAD_SECONDS = 6;
const DEFAULT_LATE_START_GRACE_SECONDS = 4;
const DEFAULT_MAX_CONCURRENT_SYNTHESIS = 4;
const DEFAULT_NARRATION_RATE = 1;
/** How far ahead of the *next* cue's own start, in seconds, an unfinished Extended Audio Description line signals its video-pause — late enough to look like a natural freeze right before the next subtitle, not a premature one. */
const DEFAULT_EXTENDED_PAUSE_LEAD_SECONDS = 0.15;
/** A forward jump in `video.currentTime` larger than this, between two consecutive ticks, is treated as a seek rather than normal playback advancing. */
const SEEK_FORWARD_EPSILON_SECONDS = 1;
/** `HTMLMediaElement.HAVE_FUTURE_DATA` — below this, a non-paused video is stalled/buffering, not actually advancing. */
const HAVE_FUTURE_DATA = 3;

/** @public One line ready to play, handed to the ducking/playback layer. */
export interface VoiceOverReadyLine {
  readonly cueKey: string;
  readonly audioUrl: string;
  readonly durationSeconds: number;
  /** Mirrored from {@link VoiceOverLineResult}'s `clipped`, if the gateway set it. */
  readonly clipped?: boolean;
  /**
   * `true` when this line's synthesized `durationSeconds` exceeds the
   * cue's own window (`endSeconds - startSeconds`) — the WCAG 1.2.7
   * "Extended Audio Description" case, where the narration script doesn't
   * fit in the video's natural pause. Purely informational at this layer;
   * whether anything acts on it (e.g. pausing the video) is
   * `VoiceOverDuckingPlayer`'s `allowVideoPause` option.
   */
  readonly isExtended: boolean;
}

/** @public Options for {@link VoiceOverCueScheduler}. */
export interface VoiceOverCueSchedulerOptions {
  readonly gateway: IVoiceOverGateway;
  /** @defaultValue `new RafVoiceOverTicker()` */
  readonly ticker?: IVoiceOverTicker;
  /** How far ahead of a cue's start, in seconds, synthesis is requested. @defaultValue 6 */
  readonly lookaheadSeconds?: number;
  /** How long past a cue's end synthesis is still allowed to complete and play. @defaultValue 4 */
  readonly lateStartGraceSeconds?: number;
  /** Maximum number of `generateLine` calls in flight at once; a due cue beyond the cap stays `Unseen` and is retried once a slot frees up. @defaultValue 4 */
  readonly maxConcurrentSynthesis?: number;
  /** How far ahead of the *next* cue's own start, in seconds, {@link onExtendedPauseDue} fires for a still-playing Extended Audio Description line. @defaultValue 0.15 */
  readonly extendedPauseLeadSeconds?: number;
  /**
   * Multiplier applied to each cue's own window
   * (`endSeconds - startSeconds`) before it's requested as
   * `targetDurationSeconds` from the gateway — a rate above 1 asks for a
   * *shorter* window, so a length-fitting gateway implementation speaks
   * faster to fit; below 1 asks for a longer one. Purely a hint to the
   * gateway (this class never touches audio directly) — a gateway that
   * ignores `targetDurationSeconds` entirely is unaffected.
   * @defaultValue 1
   */
  readonly narrationRate?: number;
}

interface CueState {
  readonly cue: CanonicalCue;
  status: VoiceOverCuePlaybackState;
  epoch: number;
  line?: VoiceOverReadyLine;
  /** Set while synthesis for this cue is in flight; aborted (best-effort, alongside `gateway.cancelLine`) when superseded, disabled, or disposed. */
  abortController?: AbortController;
}

/**
 * Owns the "when is a line due" timing state machine for voice-over: which
 * cues need synthesis, which are ready, which is currently playing. Does
 * not touch the DOM or an `Audio` element — see `VoiceOverDuckingPlayer`
 * for that; this class only decides *when*, not *how*.
 *
 * Ticks once per {@link IVoiceOverTicker} frame, reading `video.currentTime`
 * / `video.paused` fresh every tick rather than via `pause`/`play`/`seeking`
 * listeners — deliberately preserved from the ported app logic, because a
 * listener bound in {@link attach} would not survive the video element being
 * replaced without a fresh {@link attach} call; polling sidesteps that.
 * Buffering (a non-paused video whose `readyState` is below
 * `HAVE_FUTURE_DATA`) is treated the same as pause for the purpose of
 * starting a new line — it never starves an in-flight synthesis, only
 * postpones handing off newly-ready lines until real playback resumes.
 * {@link onPlaybackPausedChanged} reports this combined "effectively
 * paused" state so a consumer can pause/resume an already-playing line in
 * step with it.
 *
 * @public
 */
export class VoiceOverCueScheduler {
  private readonly gateway: IVoiceOverGateway;
  private readonly ticker: IVoiceOverTicker;
  private lookaheadSeconds: number;
  private lateStartGraceSeconds: number;
  private readonly maxConcurrentSynthesis: number;
  private extendedPauseLeadSeconds: number;
  private narrationRate: number;
  private delaySeconds = 0;

  private readonly cueStateByKey = new Map<string, CueState>();
  private cueOrder: string[] = [];
  private languageCode: string | null = null;
  private epoch = 0;
  private disposed = false;

  private video: HTMLVideoElement | null = null;
  private stopTicking: (() => void) | null = null;
  private lastCurrentTime: number | null = null;
  private lastEffectivePaused: boolean | null = null;
  private playingCueKey: string | null = null;
  private extendedPauseSignaledCueKey: string | null = null;

  private readonly cueStateListeners = new Set<
    (cueKey: string, status: VoiceOverCuePlaybackState) => void
  >();
  private readonly lineReadyListeners = new Set<(line: VoiceOverReadyLine) => void>();
  private readonly lineFailedListeners = new Set<
    (cueKey: string, error: string, wasUnexpectedThrow: boolean) => void
  >();
  private readonly hardStopListeners = new Set<(cueKey: string) => void>();
  private readonly pausedChangedListeners = new Set<(isPaused: boolean) => void>();
  private readonly lineSkippedListeners = new Set<(cueKey: string) => void>();
  private readonly extendedPauseDueListeners = new Set<(cueKey: string) => void>();

  constructor(options: VoiceOverCueSchedulerOptions) {
    this.gateway = options.gateway;
    this.ticker = options.ticker ?? new RafVoiceOverTicker();
    this.lookaheadSeconds = options.lookaheadSeconds ?? DEFAULT_LOOKAHEAD_SECONDS;
    this.lateStartGraceSeconds =
      options.lateStartGraceSeconds ?? DEFAULT_LATE_START_GRACE_SECONDS;
    this.maxConcurrentSynthesis =
      options.maxConcurrentSynthesis ?? DEFAULT_MAX_CONCURRENT_SYNTHESIS;
    this.extendedPauseLeadSeconds =
      options.extendedPauseLeadSeconds ?? DEFAULT_EXTENDED_PAUSE_LEAD_SECONDS;
    this.narrationRate = options.narrationRate ?? DEFAULT_NARRATION_RATE;
  }

  /** Attaches the video whose `currentTime`/`paused` drives scheduling and starts ticking. Safe to call again with a different element. */
  attach(video: HTMLVideoElement): void {
    this.stopTicking?.();
    this.video = video;
    this.lastCurrentTime = null;
    this.lastEffectivePaused = null;
    this.stopTicking = this.ticker.start(() => this.tick());
  }

  /** Stops ticking and detaches the video. Cue state is preserved; {@link attach} again to resume. */
  detach(): void {
    this.stopTicking?.();
    this.stopTicking = null;
    this.video = null;
    this.lastCurrentTime = null;
    this.lastEffectivePaused = null;
  }

  /**
   * Replaces the full cue list (e.g. on subtitle-track switch), resetting
   * all per-cue state. Non-dialogue cues (per {@link getSpeakableText}) are
   * marked {@link VoiceOverCuePlaybackState.Skipped} immediately and never
   * sent for synthesis. Invalidates any in-flight synthesis from before this
   * call via the epoch counter.
   */
  setCues(cues: readonly CanonicalCue[]): void {
    this.bumpEpoch();
    this.cueStateByKey.clear();
    this.cueOrder = [];

    for (const cue of cues) {
      const key = cueKeyOf(cue);
      this.cueOrder.push(key);
      const speakable = getSpeakableText(cue.text) !== null;
      this.cueStateByKey.set(key, {
        cue,
        status: speakable
          ? VoiceOverCuePlaybackState.Unseen
          : VoiceOverCuePlaybackState.Skipped,
        epoch: this.epoch,
      });
      if (!speakable) this.lineSkippedListeners.forEach((listener) => listener(key));
    }
    this.playingCueKey = null;
  }

  /**
   * Merges newly-seen cues into the existing list WITHOUT resetting any
   * cue's already-tracked playback state — unlike {@link setCues}, a cue
   * this call already knows about (by its start/end/text key) is left
   * exactly as it was, whether Played, Playing, Pending, or Ready. Only
   * cues not seen before are initialized (Unseen/Skipped, same rule as
   * `setCues`). No epoch bump, no `playingCueKey` reset — nothing currently
   * in flight or playing is disturbed.
   *
   * For a source that periodically re-emits its *entire*, ever-growing cue
   * list for the same track (VOD-extracted subtitles as more of the file
   * is read; OpenSubtitles re-emitting its cached transcript) — as opposed
   * to `setCues`, reserved for an actual track/source rebind. Calling
   * `setCues` on every such periodic re-emission would wipe a cue just
   * spoken back to Unseen and let it be resynthesized and replayed the
   * next time it's still within the lookahead/grace window — most visibly
   * during an Extended Audio Description pause, which gives a periodic
   * re-emission more real time to land while the just-played line is
   * still "fresh".
   */
  updateCues(cues: readonly CanonicalCue[]): void {
    const newOrder: string[] = [];
    for (const cue of cues) {
      const key = cueKeyOf(cue);
      newOrder.push(key);
      if (this.cueStateByKey.has(key)) continue;

      const speakable = getSpeakableText(cue.text) !== null;
      this.cueStateByKey.set(key, {
        cue,
        status: speakable
          ? VoiceOverCuePlaybackState.Unseen
          : VoiceOverCuePlaybackState.Skipped,
        epoch: this.epoch,
      });
      if (!speakable) this.lineSkippedListeners.forEach((listener) => listener(key));
    }
    this.cueOrder = newOrder;
  }

  /** Sets which language to synthesize in, or disables voice-over entirely when `null`. Invalidates in-flight synthesis and any already-synthesized-but-not-yet-playing line from the previous language. */
  setLanguageCode(languageCode: string | null): void {
    this.invalidateStaleCues();
    this.bumpEpoch();
    this.languageCode = languageCode;
    if (languageCode === null) this.hardStopPlayingCue();
  }

  /** `true` while at least one cue's synthesis is in flight. */
  get isGenerating(): boolean {
    return this.countPending() > 0;
  }

  /** Updates how far ahead of a cue's start synthesis is requested. Takes effect on the next tick. */
  setLookaheadSeconds(seconds: number): void {
    this.lookaheadSeconds = seconds;
  }

  /** Updates how long past a cue's end synthesis is still allowed to complete and play. Takes effect on the next tick. */
  setLateStartGraceSeconds(seconds: number): void {
    this.lateStartGraceSeconds = seconds;
  }

  /** Updates the Extended Audio Description pause lead. Takes effect on the next tick. */
  setExtendedPauseLeadSeconds(seconds: number): void {
    this.extendedPauseLeadSeconds = seconds;
  }

  /** Updates the narration rate — see {@link VoiceOverCueSchedulerOptions.narrationRate}. Applies to the next `generateLine` call onward; already-synthesized/in-flight lines are unaffected. */
  setNarrationRate(rate: number): void {
    this.narrationRate = rate;
  }

  /**
   * Updates the user-facing timing nudge applied when comparing a cue's own
   * `startSeconds`/`endSeconds` against `video.currentTime` — mirrors
   * {@link SubtitleDelayProcessor}/`CueProjector`'s exact contract (positive
   * = a cue is due later). Applied fresh on every tick, never baked into a
   * cue's own stored times: unlike a wrapper that reprojects cue times once
   * at delivery time, changing this can never go stale relative to a cue
   * that was delivered before the correct value was known (e.g. a still-
   * settling seek/resume baseline) — the very next tick already uses the
   * new value, with no dependency on the source ever redelivering.
   */
  setDelaySeconds(delaySeconds: number): void {
    this.delaySeconds = delaySeconds;
  }

  /** Returns the currently configured delay offset, in seconds. */
  getDelaySeconds(): number {
    return this.delaySeconds;
  }

  /** Notifies `callback` whenever a cue's {@link VoiceOverCuePlaybackState} changes. */
  onCueStateChanged(
    callback: (cueKey: string, status: VoiceOverCuePlaybackState) => void
  ): () => void {
    this.cueStateListeners.add(callback);
    return () => this.cueStateListeners.delete(callback);
  }

  /** Notifies `callback` when a line becomes due and should start playing. */
  onLineReady(callback: (line: VoiceOverReadyLine) => void): () => void {
    this.lineReadyListeners.add(callback);
    return () => this.lineReadyListeners.delete(callback);
  }

  /** Notifies `callback` when a cue's synthesis fails. `wasUnexpectedThrow` is `true` when the gateway violated its no-throw contract, `false` for a normal `{ success: false }` result. */
  onLineFailed(
    callback: (cueKey: string, error: string, wasUnexpectedThrow: boolean) => void
  ): () => void {
    this.lineFailedListeners.add(callback);
    return () => this.lineFailedListeners.delete(callback);
  }

  /** Notifies `callback` when a currently-playing line must stop immediately, with no fade (seek, language disable, or dispose). */
  onHardStop(callback: (cueKey: string) => void): () => void {
    this.hardStopListeners.add(callback);
    return () => this.hardStopListeners.delete(callback);
  }

  /**
   * Notifies `callback` whenever the "effectively paused" state (real pause
   * OR buffering) changes. Intended for pausing/resuming an already-playing
   * line in step with the video, without stopping or restarting it — see
   * `VoiceOverDuckingPlayer.setPaused`.
   */
  onPlaybackPausedChanged(callback: (isPaused: boolean) => void): () => void {
    this.pausedChangedListeners.add(callback);
    return () => this.pausedChangedListeners.delete(callback);
  }

  /**
   * Notifies `callback` when the currently-playing line is flagged
   * {@link VoiceOverReadyLine.isExtended} and, per its own most up-to-date
   * cue list, is now within {@link VoiceOverCueSchedulerOptions.extendedPauseLeadSeconds}
   * of the *next* cue's own start while still narrating — the "how" (whether
   * to actually pause the video) is left entirely to the caller, mirroring
   * how {@link VoiceOverReadyLine.isExtended} itself is purely informational
   * at this layer. Fires at most once per playing cue. If there is no next
   * cue yet (the last cue in the currently-known list, or the next one
   * hasn't been delivered yet by an incrementally-loading source), fires
   * immediately once the line starts — the same conservative fallback this
   * class used unconditionally before this event existed.
   */
  onExtendedPauseDue(callback: (cueKey: string) => void): () => void {
    this.extendedPauseDueListeners.add(callback);
    return () => this.extendedPauseDueListeners.delete(callback);
  }

  /**
   * Notifies `callback` when a cue is skipped for a **scheduling** reason —
   * non-dialogue, missed its late-start grace window, or dropped by a seek
   * jumping past it. Deliberately separate from {@link onLineFailed}: a
   * gateway failure or unexpected throw also ends in
   * {@link VoiceOverCuePlaybackState.Skipped}, but is reported exclusively
   * via {@link onLineFailed}, never here — the two are mutually exclusive
   * by construction (this method's call sites are disjoint from
   * {@link onLineFailed}'s), not by inference from the resulting status.
   */
  onLineSkipped(callback: (cueKey: string) => void): () => void {
    this.lineSkippedListeners.add(callback);
    return () => this.lineSkippedListeners.delete(callback);
  }

  /** Stops ticking, invalidates all in-flight synthesis, and clears cue state. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidateStaleCues();
    this.detach();
    this.bumpEpoch();
    this.cueStateByKey.clear();
    this.cueOrder = [];
    this.playingCueKey = null;
  }

  /** `cue.startSeconds` shifted by the current live {@link delaySeconds} — the only form a cue's start should ever be compared against `video.currentTime` in. */
  private adjustedStart(cue: CanonicalCue): number {
    return cue.startSeconds + this.delaySeconds;
  }

  /** `cue.endSeconds` shifted by the current live {@link delaySeconds} — the only form a cue's end should ever be compared against `video.currentTime` in. */
  private adjustedEnd(cue: CanonicalCue): number {
    return cue.endSeconds + this.delaySeconds;
  }

  private tick(): void {
    if (this.disposed || !this.video) return;
    const currentTime = this.video.currentTime;
    const paused = this.video.paused;
    const isBuffering = !paused && this.video.readyState < HAVE_FUTURE_DATA;
    const effectivePaused = paused || isBuffering;
    const previous = this.lastCurrentTime;
    this.lastCurrentTime = currentTime;

    if (previous !== null) {
      const delta = currentTime - previous;
      if (delta < 0) {
        this.handleSeek(currentTime, "backward");
      } else if (delta > SEEK_FORWARD_EPSILON_SECONDS) {
        this.handleSeek(currentTime, "forward");
      }
    }

    if (effectivePaused !== this.lastEffectivePaused) {
      this.lastEffectivePaused = effectivePaused;
      this.pausedChangedListeners.forEach((listener) => listener(effectivePaused));
    }

    this.settlePlayingCues(currentTime);
    if (this.languageCode !== null) this.requestDueSynthesis(currentTime);
    if (!effectivePaused) this.startNextDueLine(currentTime);
    this.checkExtendedPauseDue(currentTime);
  }

  private handleSeek(currentTime: number, direction: "forward" | "backward"): void {
    this.hardStopPlayingCue();

    for (const key of this.cueOrder) {
      const state = this.cueStateByKey.get(key);
      if (!state) continue;

      const isActive =
        state.status === VoiceOverCuePlaybackState.Unseen ||
        state.status === VoiceOverCuePlaybackState.Pending ||
        state.status === VoiceOverCuePlaybackState.Ready;
      if (isActive && this.adjustedEnd(state.cue) < currentTime) {
        if (state.status === VoiceOverCuePlaybackState.Pending) state.abortController?.abort();
        this.setStatus(key, state, VoiceOverCuePlaybackState.Skipped);
        this.lineSkippedListeners.forEach((listener) => listener(key));
      }

      if (
        direction === "backward" &&
        (state.status === VoiceOverCuePlaybackState.Played ||
          state.status === VoiceOverCuePlaybackState.Skipped) &&
        this.adjustedEnd(state.cue) > currentTime
      ) {
        const speakable = getSpeakableText(state.cue.text) !== null;
        this.setStatus(
          key,
          state,
          speakable ? VoiceOverCuePlaybackState.Unseen : VoiceOverCuePlaybackState.Skipped
        );
      }
    }
  }

  /**
   * Settles a playing cue purely from `currentTime` crossing its own
   * `endSeconds` — correct ONLY for a normal (non-`isExtended`) line: since
   * its synthesized audio fits within that same window and the video never
   * freezes for it, `currentTime` reaching `endSeconds` reliably means the
   * audio has also finished by then. An `isExtended` line breaks that
   * assumption on purpose (it's *meant* to keep narrating past its own
   * window while the video keeps playing normally) — skipped here, and
   * settled only via the real end-of-audio signal, {@link notifyLineEnded}.
   */
  private settlePlayingCues(currentTime: number): void {
    if (!this.playingCueKey) return;
    const state = this.cueStateByKey.get(this.playingCueKey);
    if (!state) {
      this.playingCueKey = null;
      return;
    }
    if (state.line?.isExtended) return;
    if (currentTime > this.adjustedEnd(state.cue)) {
      this.setStatus(this.playingCueKey, state, VoiceOverCuePlaybackState.Played);
      this.playingCueKey = null;
    }
  }

  /**
   * Marks the currently-playing cue Played once its narration audio has
   * genuinely finished — the only way an {@link VoiceOverReadyLine.isExtended}
   * cue's hold on `playingCueKey` ever clears, since {@link settlePlayingCues}
   * deliberately skips its own `currentTime`-based proxy for exactly this
   * case. Call from the playback layer's own `ended` event. No-op if
   * `cueKey` isn't the one currently playing (a stale or already-settled
   * call).
   */
  notifyLineEnded(cueKey: string): void {
    if (this.playingCueKey !== cueKey) return;
    const state = this.cueStateByKey.get(cueKey);
    this.playingCueKey = null;
    if (state) this.setStatus(cueKey, state, VoiceOverCuePlaybackState.Played);
  }

  private requestDueSynthesis(currentTime: number): void {
    let pendingCount = this.countPending();

    for (const key of this.cueOrder) {
      if (pendingCount >= this.maxConcurrentSynthesis) return;

      const state = this.cueStateByKey.get(key);
      if (!state || state.status !== VoiceOverCuePlaybackState.Unseen) continue;

      // Already entirely in the past — spending a synthesis round-trip
      // just to discover that once it resolves would be wasted. Matters a
      // lot for a source that delivers its ENTIRE cue list up front (e.g.
      // OpenSubtitlesSource downloading the whole movie's transcript) as
      // opposed to only what's currently reachable (e.g. a native HLS
      // TextTrack, which only ever has cues for segments it actually
      // loaded): without this, a large backlog of already-passed cues
      // consumes every maxConcurrentSynthesis slot one wasted round-trip
      // at a time — each batch has to fully resolve before the next 4 are
      // even looked at — before ever reaching a cue actually near
      // currentTime, reading as "voice-over doesn't speak at all" for
      // however long that backlog takes to churn through.
      if (currentTime > this.adjustedEnd(state.cue) + this.lateStartGraceSeconds) {
        this.setStatus(key, state, VoiceOverCuePlaybackState.Skipped);
        this.lineSkippedListeners.forEach((listener) => listener(key));
        continue;
      }

      if (this.adjustedStart(state.cue) - currentTime > this.lookaheadSeconds) continue;

      this.setStatus(key, state, VoiceOverCuePlaybackState.Pending);
      this.synthesize(key, state);
      pendingCount += 1;
    }
  }

  private countPending(): number {
    let count = 0;
    for (const state of this.cueStateByKey.values()) {
      if (state.status === VoiceOverCuePlaybackState.Pending) count += 1;
    }
    return count;
  }

  private synthesize(key: string, state: CueState): void {
    const languageCode = this.languageCode;
    if (languageCode === null) return;
    const requestEpoch = this.epoch;
    const text = getSpeakableText(state.cue.text) ?? state.cue.text;
    const abortController = new AbortController();
    state.abortController = abortController;

    void this.gateway
      .generateLine(
        {
          text,
          languageCode,
          targetDurationSeconds:
            (state.cue.endSeconds - state.cue.startSeconds) /
            this.narrationRate,
        },
        abortController.signal
      )
      .then(
        (result) => this.handleSynthesisResult(key, requestEpoch, result),
        (error) => this.handleSynthesisThrow(key, requestEpoch, error)
      );
  }

  private handleSynthesisResult(
    key: string,
    requestEpoch: number,
    result: Awaited<ReturnType<IVoiceOverGateway["generateLine"]>>
  ): void {
    if (requestEpoch !== this.epoch) return;
    const state = this.cueStateByKey.get(key);
    if (!state || state.status !== VoiceOverCuePlaybackState.Pending) return;

    if (!result.success) {
      this.setStatus(key, state, VoiceOverCuePlaybackState.Skipped);
      this.lineFailedListeners.forEach((listener) => listener(key, result.error, false));
      return;
    }

    const currentTime = this.video?.currentTime ?? 0;
    if (currentTime > this.adjustedEnd(state.cue) + this.lateStartGraceSeconds) {
      this.setStatus(key, state, VoiceOverCuePlaybackState.Skipped);
      this.lineSkippedListeners.forEach((listener) => listener(key));
      return;
    }

    const cueWindowSeconds = state.cue.endSeconds - state.cue.startSeconds;
    state.line = {
      cueKey: key,
      audioUrl: result.audioUrl,
      durationSeconds: result.durationSeconds,
      clipped: result.clipped,
      isExtended: result.durationSeconds > cueWindowSeconds,
    };
    this.setStatus(key, state, VoiceOverCuePlaybackState.Ready);
  }

  private handleSynthesisThrow(key: string, requestEpoch: number, error: unknown): void {
    if (requestEpoch !== this.epoch) return;
    const state = this.cueStateByKey.get(key);
    if (!state || state.status !== VoiceOverCuePlaybackState.Pending) return;

    this.setStatus(key, state, VoiceOverCuePlaybackState.Skipped);
    const message = error instanceof Error ? error.message : String(error);
    this.lineFailedListeners.forEach((listener) => listener(key, message, true));
  }

  private startNextDueLine(currentTime: number): void {
    if (this.playingCueKey) return;

    let bestKey: string | null = null;
    let bestState: CueState | null = null;
    for (const key of this.cueOrder) {
      const state = this.cueStateByKey.get(key);
      if (!state || state.status !== VoiceOverCuePlaybackState.Ready || !state.line) continue;
      if (currentTime < this.adjustedStart(state.cue)) continue;
      if (currentTime > this.adjustedEnd(state.cue) + this.lateStartGraceSeconds) continue;
      if (!bestState || state.cue.startSeconds < bestState.cue.startSeconds) {
        bestKey = key;
        bestState = state;
      }
    }

    if (!bestKey || !bestState?.line) return;
    this.playingCueKey = bestKey;
    this.setStatus(bestKey, bestState, VoiceOverCuePlaybackState.Playing);
    const line = bestState.line;
    this.lineReadyListeners.forEach((listener) => listener(line));
  }

  /**
   * The chronologically-next cue's own `startSeconds` among everything
   * currently known, or `null` if `afterCue` is the last one (or the next
   * one hasn't been delivered yet by an incrementally-loading source).
   * Compares by time rather than `cueOrder` position so this stays correct
   * even for a source that delivers cues out of chronological order.
   */
  private findNextCueStartSeconds(afterCue: CanonicalCue): number | null {
    let best: number | null = null;
    for (const key of this.cueOrder) {
      const state = this.cueStateByKey.get(key);
      if (!state) continue;
      if (state.cue.startSeconds <= afterCue.startSeconds) continue;
      if (best === null || state.cue.startSeconds < best) best = state.cue.startSeconds;
    }
    return best === null ? null : best + this.delaySeconds;
  }

  /**
   * Fires {@link onExtendedPauseDue} at most once per playing cue, right as
   * `currentTime` closes in on the *next* cue's own start while an
   * {@link VoiceOverReadyLine.isExtended} line is still playing — not at
   * this cue's own start, which is when the line began. Recomputing the
   * next cue's start on every tick (rather than freezing it at the moment
   * the line started) keeps this correct against a source that keeps
   * delivering more cues while this one plays (e.g. VOD-extracted
   * subtitles filling in as more of the file is transcoded).
   */
  private checkExtendedPauseDue(currentTime: number): void {
    if (!this.playingCueKey) return;
    if (this.extendedPauseSignaledCueKey === this.playingCueKey) return;

    const state = this.cueStateByKey.get(this.playingCueKey);
    if (!state?.line?.isExtended) return;

    const nextCueStartSeconds = this.findNextCueStartSeconds(state.cue);
    const threshold =
      nextCueStartSeconds !== null
        ? nextCueStartSeconds - this.extendedPauseLeadSeconds
        : this.adjustedStart(state.cue);
    if (currentTime < threshold) return;

    this.extendedPauseSignaledCueKey = this.playingCueKey;
    const cueKey = this.playingCueKey;
    this.extendedPauseDueListeners.forEach((listener) => listener(cueKey));
  }

  private hardStopPlayingCue(): void {
    if (!this.playingCueKey) return;
    const key = this.playingCueKey;
    const state = this.cueStateByKey.get(key);
    this.playingCueKey = null;
    if (state) this.setStatus(key, state, VoiceOverCuePlaybackState.Played);
    this.hardStopListeners.forEach((listener) => listener(key));
  }

  /**
   * Releases the hold on `cueKey` if it's still the one marked Playing —
   * for when the playback layer's own `Audio.play()` promise rejects (e.g.
   * a browser autoplay-policy block) after the line was already handed off
   * via {@link onLineReady}. No audio ever actually started, so unlike
   * {@link hardStopPlayingCue} this does NOT fire `hardStopListeners` (there
   * is nothing playing to stop). Without this, `playingCueKey` stays set
   * and {@link startNextDueLine} keeps refusing to start the next due
   * line — silently, with nothing narrating — until `video.currentTime`
   * eventually passes this cue's own `endSeconds` on its own.
   */
  releasePlayingCue(cueKey: string): void {
    if (this.playingCueKey !== cueKey) return;
    const state = this.cueStateByKey.get(cueKey);
    this.playingCueKey = null;
    if (state) this.setStatus(cueKey, state, VoiceOverCuePlaybackState.Played);
  }

  /**
   * Immediately stops whatever line is currently playing (fires
   * {@link onHardStop}, which the controller wires to restoring the
   * video's volume), without changing {@link setLanguageCode}'s own
   * state — unlike passing `null` there, this is not an "off" decision.
   * For a host that needs to silence in-progress narration without it
   * being the user's explicit choice — e.g. closing the current title
   * while a line is mid-narration, where the next title should still
   * auto-restore the same language.
   */
  stop(): void {
    this.hardStopPlayingCue();
  }

  /**
   * Invalidates every non-playing cue left over from the previous language:
   * an in-flight ({@link VoiceOverCuePlaybackState.Pending}) synthesis is
   * best-effort cancelled, and an already-resolved
   * ({@link VoiceOverCuePlaybackState.Ready}) line is discarded — both
   * transition straight to {@link VoiceOverCuePlaybackState.Skipped} rather
   * than being left to resolve (or sit) under a language that's no longer
   * selected. Without the `Ready` half of this, a line pre-synthesized
   * during the previous selection's lookahead window kept sitting in
   * `Ready` and was still handed to {@link startNextDueLine} once its own
   * cue became due — even after the user turned narration off (or switched
   * languages) — reading as narration briefly resuming a few seconds after
   * being turned off, right as that pre-fetched line's cue arrived.
   */
  private invalidateStaleCues(): void {
    const previousLanguageCode = this.languageCode;
    for (const [key, state] of this.cueStateByKey) {
      if (state.status === VoiceOverCuePlaybackState.Pending) {
        if (previousLanguageCode !== null) {
          const text = getSpeakableText(state.cue.text) ?? state.cue.text;
          void this.gateway.cancelLine({ languageCode: previousLanguageCode, text });
        }
        state.abortController?.abort();
        this.setStatus(key, state, VoiceOverCuePlaybackState.Skipped);
        this.lineSkippedListeners.forEach((listener) => listener(key));
      } else if (state.status === VoiceOverCuePlaybackState.Ready) {
        state.line = undefined;
        this.setStatus(key, state, VoiceOverCuePlaybackState.Skipped);
        this.lineSkippedListeners.forEach((listener) => listener(key));
      }
    }
  }

  private bumpEpoch(): void {
    this.epoch += 1;
  }

  private setStatus(
    key: string,
    state: CueState,
    status: VoiceOverCuePlaybackState
  ): void {
    if (state.status === status) return;
    state.status = status;
    this.cueStateListeners.forEach((listener) => listener(key, status));
  }
}

function cueKeyOf(cue: CanonicalCue): string {
  return `${cue.startSeconds}:${cue.endSeconds}:${cue.text}`;
}
