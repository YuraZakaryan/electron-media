import type { CanonicalCue } from "../types/cue.js";

/**
 * Renders projected cues onto a video element. The only interface permitted
 * to touch `HTMLVideoElement.addTextTrack`/`TextTrack.addCue` (or, for a
 * future implementation, a custom overlay for ASS/SSA-style positioning).
 *
 * Ownership: does not own the `video` element; only ever adds/removes
 * TextTracks and cues on it.
 *
 * @public
 */
export interface ISubtitleRenderer {
  /**
   * Replaces the currently displayed cues with `cues`. Called every time the
   * active track's cue list or the delay offset changes — implementations
   * should diff/clear-and-rebuild internally rather than assume incremental input.
   */
  render(video: HTMLVideoElement, cues: readonly CanonicalCue[]): void;

  /** Hides/clears any cues this renderer previously added. Idempotent. */
  clear(): void;

  /**
   * Reports whether the cues from the last {@link render} call are still
   * actually present on the video element. Optional — implementations that
   * cannot be wiped from outside (e.g. a canvas overlay) may omit it.
   *
   * Exists because a host-owned media engine (e.g. hls.js's
   * `TimelineController`) can clear every `TextTrack` on the video element
   * out from under a renderer that uses native `TextTrack`/`addCue`, with no
   * event or error of its own — {@link SubtitleController} polls this to
   * detect and self-heal from that silently.
   */
  isIntact?(): boolean;
}
