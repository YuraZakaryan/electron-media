import { SubtitleError } from "../errors/index.js";

import type { CanonicalCue } from "../types/cue.js";
import type { ISubtitleRenderer } from "./subtitle-renderer.js";

/** @public */
export interface TextTrackCueRendererOptions {
  /**
   * Vertical line position applied to every cue via `VTTCue.line`
   * (with `snapToLines = false`, `lineAlign = "end"`). Left undefined to use
   * the browser default.
   *
   * Accepts either a fixed number or a getter function, invoked fresh for
   * every {@link render} call — a getter is what host apps whose layout
   * changes at runtime (e.g. controls bar show/hide shifting where cues
   * should sit) should use: cues must be positioned correctly the instant
   * they're added, not just eventually corrected by some later re-scan.
   */
  cueLine?: number | (() => number);
  /** Label passed to `HTMLVideoElement.addTextTrack` when no track-specific label is available. Defaults to `"Subtitle"`. */
  defaultLabel?: string;
}

/**
 * Default {@link ISubtitleRenderer}. Renders cues via
 * `HTMLVideoElement.addTextTrack`/`TextTrack.addCue` rather than a static
 * `<track src>`, working around a documented Chromium/WebKit bug where a
 * TextTrack flipped straight to `"showing"` before it has cues doesn't
 * reliably run the "update text track rendering" steps afterward — cues
 * added later can stay invisible until something else nudges the renderer.
 * This renderer avoids the bug by adding cues before flipping the mode.
 *
 * Ownership: does not own the `video` element; creates at most one TextTrack
 * on it and only ever mutates that track's cues. A TextTrack added via
 * `addTextTrack` cannot be removed, only disabled — {@link clear} disables it.
 *
 * @public
 */
export class TextTrackCueRenderer implements ISubtitleRenderer {
  private readonly cueLine?: number | (() => number);
  private readonly defaultLabel: string;
  private textTrack: TextTrack | null = null;
  private lastCueCount = 0;

  constructor(options: TextTrackCueRendererOptions = {}) {
    this.cueLine = options.cueLine;
    this.defaultLabel = options.defaultLabel ?? "Subtitle";
  }

  render(video: HTMLVideoElement, cues: readonly CanonicalCue[]): void {
    const textTrack = this.ensureTextTrack(video);

    const existing = textTrack.cues ? Array.from(textTrack.cues) : [];
    existing.forEach((cue) => textTrack.removeCue(cue));

    const cueLine =
      typeof this.cueLine === "function" ? this.cueLine() : this.cueLine;

    for (const cue of cues) {
      if (cue.endSeconds <= cue.startSeconds) continue;
      const start = Math.max(0, cue.startSeconds);
      if (cue.endSeconds <= start) continue;

      try {
        const vttCue = new VTTCue(start, cue.endSeconds, cue.text);
        if (cueLine !== undefined) {
          vttCue.snapToLines = false;
          vttCue.line = cueLine;
          vttCue.lineAlign = "end";
        }
        textTrack.addCue(vttCue);
      } catch (cause) {
        throw new SubtitleError("Failed to add subtitle cue", { cause });
      }
    }

    textTrack.mode = "showing";
    this.lastCueCount = cues.length;
  }

  clear(): void {
    this.lastCueCount = 0;
    if (!this.textTrack) return;
    const existing = this.textTrack.cues
      ? Array.from(this.textTrack.cues)
      : [];
    existing.forEach((cue) => this.textTrack?.removeCue(cue));
    this.textTrack.mode = "disabled";
  }

  /**
   * `false` once a track this renderer previously populated with cues no
   * longer has any — the fingerprint left by hls.js's `TimelineController`
   * wiping every `TextTrack` on the video element (its own cleanup runs on
   * `MEDIA_ATTACHING`/`MANIFEST_LOADING` and clears tracks it didn't create,
   * not just its own). Always `true` when nothing was ever rendered or the
   * last render legitimately had zero cues.
   */
  isIntact(): boolean {
    if (this.lastCueCount === 0) return true;
    if (!this.textTrack) return false;
    return this.textTrack.mode === "showing" && this.textTrack.cues !== null && this.textTrack.cues.length > 0;
  }

  private ensureTextTrack(video: HTMLVideoElement): TextTrack {
    if (this.textTrack) return this.textTrack;
    this.textTrack = video.addTextTrack("subtitles", this.defaultLabel);
    return this.textTrack;
  }
}
