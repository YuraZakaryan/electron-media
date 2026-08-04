import { CueProjector } from "./cue-projector.js";

import type { CanonicalCue } from "../types/cue.js";

/**
 * Owns the user-facing subtitle timing nudge, in seconds (positive = subtitles
 * appear later). Holds no DOM/video reference — pure timing state plus
 * cue-shift arithmetic delegated to {@link CueProjector}.
 *
 * Exists because no automatic baseline can guarantee sync for externally
 * sourced subtitles (a different release/cut, or a differing frame rate) —
 * this is the user's manual remedy for whatever mismatch remains after any
 * source-specific baseline correction (e.g. a VOD transcode's own start offset).
 *
 * @public
 */
export class SubtitleDelayProcessor {
  private readonly cueProjector = new CueProjector();
  private delaySeconds = 0;
  private readonly listeners = new Set<(delaySeconds: number) => void>();

  /** Sets the delay offset in seconds. Notifies subscribers only when the value actually changes. */
  setDelaySeconds(delaySeconds: number): void {
    if (delaySeconds === this.delaySeconds) return;
    this.delaySeconds = delaySeconds;
    this.listeners.forEach((listener) => listener(delaySeconds));
  }

  /** Returns the currently configured delay offset, in seconds. */
  getDelaySeconds(): number {
    return this.delaySeconds;
  }

  /** Applies the current delay offset to `cue`, returning a new shifted cue. */
  apply(cue: CanonicalCue): CanonicalCue {
    return this.cueProjector.project(cue, this.delaySeconds);
  }

  /** Notifies `callback` whenever {@link setDelaySeconds} changes the value. Returns an unsubscribe function. */
  onDelayChanged(callback: (delaySeconds: number) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }
}
