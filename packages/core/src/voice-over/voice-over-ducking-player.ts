const DEFAULT_DUCK_VOLUME = 0.15;
const DEFAULT_VOICE_OVER_VOLUME = 1;
const DEFAULT_FADE_STEPS = 5;
const DEFAULT_FADE_STEP_MS = 30;

/**
 * Maps a fade's linear time progress (`0` at the start, `1` at the end) to
 * the interpolation weight actually applied between the from/to volumes.
 * Must return a value in `[0, 1]`; an out-of-range result is clamped rather
 * than allowed to overshoot the target volume.
 * @public
 */
export type FadeCurve = (progress: number) => number;

/** @public The default fade curve — linear, unchanged from this class's original behavior. */
export const linearFadeCurve: FadeCurve = (progress) => progress;

/** @public An eased alternative to {@link linearFadeCurve}, easing in and out of the fade rather than moving at a constant rate. */
export const easeInOutQuadCurve: FadeCurve = (progress) =>
  progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;

/** @public Options for {@link VoiceOverDuckingPlayer}. */
export interface VoiceOverDuckingPlayerOptions {
  readonly video: HTMLVideoElement;
  /** Volume the main video (the "original sound") is faded down to while a line plays. @defaultValue 0.15 */
  readonly duckVolume?: number;
  /** The narration line's own playback volume — independent of `duckVolume`, e.g. two separate sliders in a settings UI ("original sound" / "voice-over sound"). @defaultValue 1 */
  readonly voiceOverVolume?: number;
  /** Number of steps in the linear fade. @defaultValue 5 */
  readonly duckFadeSteps?: number;
  /** Duration of each fade step, in milliseconds. @defaultValue 30 */
  readonly duckFadeStepMs?: number;
  /** Called when a synthesized line's `Audio.play()` promise rejects (autoplay policy). Never silently swallowed. */
  readonly onPlaybackRejected?: (cueKey: string) => void;
  /** Called when resuming the video after an Extended Audio Description pause rejects. Never silently swallowed. */
  readonly onVideoResumeRejected?: (cueKey: string) => void;
  /** Called when a line's narration audio actually finishes (the `ended` event) — the scheduler's only reliable signal that an `isExtended` cue is truly done, since it cannot infer that from `video.currentTime` alone. Not called for a superseded/stopped line. */
  readonly onLineEnded?: (cueKey: string) => void;
  /** Shapes the duck fade's interpolation. @defaultValue {@link linearFadeCurve} */
  readonly fadeCurve?: FadeCurve;
  /**
   * Opts into WCAG 1.2.7 "Extended Audio Description": when a line's
   * `isExtended` flag is set (its synthesized duration exceeds the cue's
   * own window), the video is paused for the line's full duration instead
   * of merely ducked, then resumed once it finishes. Off by default — an
   * unexpected video pause is a real behavior change a host must opt into
   * deliberately, not something this library does unasked.
   * @defaultValue false
   */
  readonly allowVideoPause?: boolean;
}

/**
 * Owns the `Audio` element used to play one voice-over line at a time, the
 * video-ducking volume fade around the main video's own ("original sound")
 * volume, and the narration line's own independent volume. Contains no
 * scheduling/timing logic — see {@link VoiceOverCueScheduler} for "when";
 * this class only handles "how".
 *
 * Two independent volume levers, e.g. for a settings popover exposing both
 * as separate sliders: {@link VoiceOverDuckingPlayerOptions.duckVolume} —
 * how loud the *original* video audio plays while ducked (default 15%) —
 * and {@link VoiceOverDuckingPlayerOptions.voiceOverVolume} — how loud the
 * *narration* line itself plays (default 100%). Neither derives from or
 * scales the other.
 *
 * Fade behavior: fading in (duck) and fading back out (restore after a line
 * finishes normally) are symmetric — a deliberate fix versus the ported app
 * logic, which faded in but snapped the restore instantly. A **hard** stop
 * (seek, disable, dispose) still snaps instantly with no fade, preserving
 * the app's explicit "a fade during a seek reads as lag" UX decision.
 *
 * @public
 */
export class VoiceOverDuckingPlayer {
  private readonly video: HTMLVideoElement;
  private duckVolume: number;
  private voiceOverVolume: number;
  private readonly duckFadeSteps: number;
  private readonly duckFadeStepMs: number;
  private readonly onPlaybackRejected?: (cueKey: string) => void;
  private readonly onVideoResumeRejected?: (cueKey: string) => void;
  private readonly onLineEnded?: (cueKey: string) => void;
  private readonly fadeCurve: FadeCurve;
  private allowVideoPause: boolean;

  private videoOriginalVolume = 1;
  private currentAudio: HTMLAudioElement | null = null;
  private currentCueKey: string | null = null;
  private fadeIntervalId: ReturnType<typeof setInterval> | null = null;
  private pausedForExtendedDescription = false;

  constructor(options: VoiceOverDuckingPlayerOptions) {
    this.video = options.video;
    this.duckVolume = options.duckVolume ?? DEFAULT_DUCK_VOLUME;
    this.voiceOverVolume = options.voiceOverVolume ?? DEFAULT_VOICE_OVER_VOLUME;
    this.duckFadeSteps = options.duckFadeSteps ?? DEFAULT_FADE_STEPS;
    this.duckFadeStepMs = options.duckFadeStepMs ?? DEFAULT_FADE_STEP_MS;
    this.onPlaybackRejected = options.onPlaybackRejected;
    this.onVideoResumeRejected = options.onVideoResumeRejected;
    this.onLineEnded = options.onLineEnded;
    this.fadeCurve = options.fadeCurve ?? linearFadeCurve;
    this.allowVideoPause = options.allowVideoPause ?? false;
  }

  /** `true` while the video is paused by this class for an Extended Audio Description line. */
  get isPausedForExtendedDescription(): boolean {
    return this.pausedForExtendedDescription;
  }

  /**
   * Starts playing `audioUrl` for `cueKey`. Supersedes any currently
   * playing line. Always ducks the video's volume down and (on `ended`)
   * fades it back up — even for a line the scheduler flagged
   * `isExtended`, which keeps playing over a moving, ducked video for as
   * long as it can. A still-unfinished extended line only ever freezes the
   * video via a later, separate {@link pauseForExtendedDescription} call
   * (WCAG 1.2.7 Extended Audio Description) — never as a side effect of
   * starting the line itself. See that method's doc comment for why.
   */
  playLine(cueKey: string, audioUrl: string): void {
    this.stopLine(false);

    this.currentCueKey = cueKey;
    const audio = new Audio(audioUrl);
    this.currentAudio = audio;
    audio.volume = this.effectiveLineVolume();

    this.videoOriginalVolume = this.video.volume;
    this.fadeVideoVolume(this.videoOriginalVolume, this.duckVolume);

    audio.addEventListener("ended", () => {
      if (this.currentAudio !== audio) return; // superseded; not this line's restore to run
      this.currentAudio = null;
      this.currentCueKey = null;
      this.onLineEnded?.(cueKey);
      if (this.pausedForExtendedDescription) {
        this.pausedForExtendedDescription = false;
        this.video.volume = this.videoOriginalVolume;
        this.video.play().catch(() => {
          this.onVideoResumeRejected?.(cueKey);
        });
      } else {
        this.fadeVideoVolume(this.video.volume, this.videoOriginalVolume);
      }
    });

    audio.play().catch(() => {
      this.onPlaybackRejected?.(cueKey);
    });
  }

  /**
   * Freezes the video in place for WCAG 1.2.7 Extended Audio Description —
   * called by the scheduler once `video.currentTime` is within its
   * configured lead of the *next* cue's own start and this line still
   * hasn't finished narrating (never at this line's own cue's start, which
   * is when it merely began). No-op if `allowVideoPause` is off, if
   * `cueKey` no longer matches the line actually playing (a stale signal
   * for a line already superseded or stopped), or if already paused for
   * this reason.
   */
  pauseForExtendedDescription(cueKey: string): void {
    if (!this.allowVideoPause) return;
    if (this.currentCueKey !== cueKey) return;
    if (this.pausedForExtendedDescription) return;

    this.clearFadeInterval();
    this.video.volume = this.videoOriginalVolume;
    this.pausedForExtendedDescription = true;
    this.video.pause();
  }

  /** Stops the currently playing line, if any. `hard=true` (seek/disable/dispose) restores volume instantly with no fade. Resumes the video first if it was paused for Extended Audio Description. */
  stopLine(hard: boolean): void {
    this.clearFadeInterval();
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.src = "";
    }
    this.currentAudio = null;
    const cueKey = this.currentCueKey;
    this.currentCueKey = null;

    if (this.pausedForExtendedDescription) {
      this.pausedForExtendedDescription = false;
      this.video.play().catch(() => {
        if (cueKey) this.onVideoResumeRejected?.(cueKey);
      });
      return;
    }

    if (hard) {
      this.video.volume = this.videoOriginalVolume;
    }
  }

  /** Updates the narration line's own volume — independent of `duckVolume`. Re-applies immediately to a currently playing line, if any. */
  setVoiceOverVolume(volume: number): void {
    this.voiceOverVolume = volume;
    if (this.currentAudio) this.currentAudio.volume = this.effectiveLineVolume();
  }

  /**
   * Pauses or resumes the currently playing line in place, mirroring the
   * video's own paused/buffering state — does not stop the line, does not
   * touch ducking/volume state. No-op if nothing is playing, and no-op
   * while {@link isPausedForExtendedDescription} — the video's paused
   * state in that case was caused by this class itself, and mirroring it
   * back onto the narration audio would freeze the one thing that must
   * keep playing through it.
   */
  setPaused(isPaused: boolean): void {
    if (!this.currentAudio || this.pausedForExtendedDescription) return;
    if (isPaused) {
      this.currentAudio.pause();
    } else {
      this.currentAudio.play().catch(() => {
        if (this.currentCueKey) this.onPlaybackRejected?.(this.currentCueKey);
      });
    }
  }

  /** Releases resources. Idempotent. */
  dispose(): void {
    this.stopLine(true);
  }

  /** Updates the duck target volume. Takes effect on the next line started; does not re-fade a line already playing. */
  setDuckVolume(volume: number): void {
    this.duckVolume = volume;
  }

  /** Updates whether Extended Audio Description (video pause) is allowed. Takes effect on the next line started; does not retroactively pause or resume a line already playing. */
  setAllowVideoPause(allow: boolean): void {
    this.allowVideoPause = allow;
  }

  private effectiveLineVolume(): number {
    return clamp01(this.voiceOverVolume);
  }

  private fadeVideoVolume(from: number, to: number): void {
    this.clearFadeInterval();
    let step = 0;
    const steps = this.duckFadeSteps;
    this.video.volume = from;
    this.fadeIntervalId = setInterval(() => {
      step += 1;
      const timeProgress = Math.min(step / steps, 1);
      const weight = clamp01(this.fadeCurve(timeProgress));
      this.video.volume = from + (to - from) * weight;
      if (step >= steps) this.clearFadeInterval();
    }, this.duckFadeStepMs);
  }

  private clearFadeInterval(): void {
    if (this.fadeIntervalId !== null) {
      clearInterval(this.fadeIntervalId);
      this.fadeIntervalId = null;
    }
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
