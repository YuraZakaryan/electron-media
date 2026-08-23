/**
 * Base class for all errors raised by @media-player-core packages.
 * Consumers can catch this to handle any library-originated failure,
 * or catch a specific subclass to handle one failure category.
 * @public
 */
export class PlayerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PlayerError";
  }
}

/**
 * Raised when subtitle parsing, source loading, or rendering fails —
 * e.g. malformed VTT/SRT content, or a subtitle source that could
 * not produce cues.
 * @public
 */
export class SubtitleError extends PlayerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SubtitleError";
  }
}

/**
 * Raised when an {@link IVoiceOverGateway} implementation violates its
 * no-throw contract (`generateLine`/`listVoices` must resolve, never throw
 * or reject unexpectedly). {@link VoiceOverController} catches the
 * violation, wraps it here, and emits it via the `voiceOverLineFailed`
 * event rather than letting it escape as an unhandled rejection.
 * @public
 */
export class VoiceOverError extends PlayerError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VoiceOverError";
  }
}

