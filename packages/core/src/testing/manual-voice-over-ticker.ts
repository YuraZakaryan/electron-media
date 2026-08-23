import type { IVoiceOverTicker } from "../voice-over/ticker.js";

/**
 * Test double for {@link IVoiceOverTicker} — advances only when `tick()` is
 * called, so scheduler tests are deterministic and need no real timers or
 * fake-timer gymnastics. Not exported from the package's public API.
 */
export class ManualVoiceOverTicker implements IVoiceOverTicker {
  private callback: (() => void) | null = null;
  private stopped = false;

  start(callback: () => void): () => void {
    this.callback = callback;
    this.stopped = false;
    return () => {
      this.stopped = true;
      this.callback = null;
    };
  }

  /** Test-only helper: invokes the current callback once, as if one frame elapsed. */
  tick(): void {
    if (this.stopped) return;
    this.callback?.();
  }
}
