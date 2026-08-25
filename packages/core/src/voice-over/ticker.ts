/**
 * Drives a per-frame callback for {@link VoiceOverCueScheduler}. Exists so
 * the scheduler never touches `requestAnimationFrame` directly — production
 * uses {@link RafVoiceOverTicker}; tests use a manually-stepped double
 * (`ManualVoiceOverTicker` in `../testing/`) to exercise every tick
 * deterministically without real timers.
 * @public
 */
export interface IVoiceOverTicker {
  /**
   * Starts ticking; `callback` is invoked once per frame (or per manual
   * `tick()` call in the test double). Returns a function that stops
   * ticking; calling it more than once is a no-op.
   */
  start(callback: () => void): () => void;
}

/**
 * How often {@link RafVoiceOverTicker} ticks via `setInterval` while the
 * document is hidden. Chromium (and Electron's renderer, which shares its
 * throttling policy) clamps a background page's timers to a 1000ms floor
 * anyway after roughly a minute hidden, so requesting anything shorter
 * than that only wastes ticks before the clamp kicks in.
 */
const BACKGROUND_TICK_MS = 1000;

/**
 * Production {@link IVoiceOverTicker} backed by `requestAnimationFrame`
 * while the page is visible, falling back to `setInterval` while it's
 * hidden (minimized window, switched tab/app).
 *
 * `requestAnimationFrame` callbacks are fully suspended by the browser (and
 * Electron's renderer) whenever the page isn't visible — a deliberate
 * battery/performance optimization, not a bug to work around case-by-case.
 * Without this fallback, every tick-driven decision (starting the next due
 * line, requesting synthesis, settling a finished cue) simply stops while
 * the app is backgrounded: narration audio already playing keeps playing
 * to completion (`Audio.play()`/`ended` aren't tied to rAF), but nothing
 * *new* ever starts — reading as "voice-over turned off" — until the page
 * is foregrounded again, at which point the scheduler catches up on
 * however many cues became due while ticking was paused, reading as
 * narration abruptly resuming. `setInterval` isn't subject to the same
 * full suspension, so ticking (and therefore scheduling decisions) keeps
 * happening throughout, just at a coarser cadence — the standard mitigation
 * for this exact class of problem, per the Page Visibility API's own
 * intended use.
 * @public
 */
export class RafVoiceOverTicker implements IVoiceOverTicker {
  start(callback: () => void): () => void {
    let rafHandle: number | null = null;
    let intervalHandle: ReturnType<typeof setInterval> | null = null;
    let stopped = false;

    const tickRaf = () => {
      if (stopped) return;
      callback();
      rafHandle = requestAnimationFrame(tickRaf);
    };
    const startRaf = () => {
      if (rafHandle === null) rafHandle = requestAnimationFrame(tickRaf);
    };
    const stopRaf = () => {
      if (rafHandle !== null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    };
    const startInterval = () => {
      if (intervalHandle === null) {
        intervalHandle = setInterval(() => {
          if (!stopped) callback();
        }, BACKGROUND_TICK_MS);
      }
    };
    const stopInterval = () => {
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    };

    const isHidden = () =>
      typeof document !== "undefined" && document.hidden;
    const handleVisibilityChange = () => {
      if (isHidden()) {
        stopRaf();
        startInterval();
      } else {
        stopInterval();
        startRaf();
      }
    };

    if (isHidden()) startInterval();
    else startRaf();

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibilityChange);
    }

    return () => {
      stopped = true;
      stopRaf();
      stopInterval();
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    };
  }
}
