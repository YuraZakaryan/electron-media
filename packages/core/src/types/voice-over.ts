/**
 * Input to {@link IVoiceOverGateway.generateLine} — the text to synthesize,
 * which language/voice to use, and the duration the resulting line should
 * be time-fit to (the subtitle cue's own duration).
 * @public
 */
export interface VoiceOverLineRequest {
  readonly text: string;
  readonly languageCode: string;
  readonly targetDurationSeconds: number;
}

/** @public One voice/language a gateway can synthesize lines for. */
export interface VoiceOverVoiceDescriptor {
  readonly languageCode: string;
  readonly displayName: string;
}

/**
 * Result of {@link IVoiceOverGateway.generateLine} — a discriminated union
 * so failure is a normal return value, never a thrown/rejected promise.
 * @public
 */
export type VoiceOverLineResult =
  | {
      readonly success: true;
      readonly audioUrl: string;
      readonly durationSeconds: number;
      /** Set by a gateway that time-fits speech to the cue's duration, when that fit had to clamp beyond a comfortable range. Purely informational; the library never changes behavior based on it. */
      readonly clipped?: boolean;
    }
  | {
      readonly success: false;
      readonly error: string;
    };

/**
 * Lifecycle state of one subtitle cue as voice-over narration for it is
 * scheduled, synthesized, and played. Modeled as an explicit enum (rather
 * than implicit bookkeeping across several parallel collections) so tests
 * can assert on a concrete value at every transition.
 * @public
 */
export enum VoiceOverCuePlaybackState {
  /** Not yet within the lookahead window; no synthesis requested. */
  Unseen = "unseen",
  /** Synthesis requested; gateway response not yet received. */
  Pending = "pending",
  /** Synthesis succeeded; audio is available but not yet due to play. */
  Ready = "ready",
  /** Currently audible. */
  Playing = "playing",
  /** Finished playing, or its window passed without playing. Terminal. */
  Played = "played",
  /** Never sent for synthesis (non-dialogue) or dropped by a seek. Terminal. */
  Skipped = "skipped",
}
