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
 * Production {@link IVoiceOverTicker} backed by `requestAnimationFrame`.
 * @public
 */
export class RafVoiceOverTicker implements IVoiceOverTicker {
  start(callback: () => void): () => void {
    let handle: number | null = null;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      callback();
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      if (handle !== null) cancelAnimationFrame(handle);
    };
  }
}
