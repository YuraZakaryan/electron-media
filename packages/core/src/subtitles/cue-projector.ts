import type { CanonicalCue } from "../types/cue.js";

/**
 * Projects a canonical (source-provided) cue into a renderer-ready cue by
 * applying the user-facing delay offset. Holds no state of its own — the
 * delay value is owned by {@link SubtitleDelayProcessor}.
 *
 * Extension point: a future ASS/SSA renderer can subclass or wrap this to
 * additionally apply positioning/RTL/vertical-text rules without touching
 * {@link SubtitleRegistry} or {@link SubtitleSelectionService}.
 *
 * @public
 */
export class CueProjector {
  /**
   * Returns a new cue shifted by `delaySeconds` (positive = appears later).
   * Does not mutate `cue`.
   */
  project(cue: CanonicalCue, delaySeconds: number): CanonicalCue {
    return {
      startSeconds: cue.startSeconds + delaySeconds,
      endSeconds: cue.endSeconds + delaySeconds,
      text: cue.text,
    };
  }
}
