/**
 * A subtitle cue in canonical (source-provided, undelayed) form —
 * the shared shape all {@link ISubtitleSource} implementations
 * normalize into before it reaches the {@link CueProjector}.
 * @public
 */
export interface CanonicalCue {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
}
