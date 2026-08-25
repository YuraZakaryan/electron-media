import type { VoiceOverTrackId } from "./types/branding.js";
import type { VoiceOverError } from "./errors/player-error.js";

/**
 * Minimal typed pub/sub used throughout @electron-media/core in
 * place of string-keyed `on(event, cb)` APIs with `unknown` payloads.
 * @public
 */
export class TypedEventEmitter<TEvents extends Record<string, unknown>> {
  private readonly listenersByEvent = new Map<keyof TEvents, Set<(payload: never) => void>>();

  /**
   * Subscribes to an event.
   * @returns An unsubscribe function; calling it more than once is a no-op.
   */
  on<TEventName extends keyof TEvents>(
    eventName: TEventName,
    callback: (payload: TEvents[TEventName]) => void,
  ): () => void {
    const listeners = this.listenersByEvent.get(eventName) ?? new Set();
    listeners.add(callback);
    this.listenersByEvent.set(eventName, listeners);
    return () => {
      listeners.delete(callback);
    };
  }

  /** @internal Emits an event to all current subscribers. Used only by core classes, not by consumers. */
  emit<TEventName extends keyof TEvents>(eventName: TEventName, payload: TEvents[TEventName]): void {
    const listeners = this.listenersByEvent.get(eventName);
    if (!listeners) return;
    for (const listener of listeners) {
      (listener as (payload: TEvents[TEventName]) => void)(payload);
    }
  }

  /** @internal Removes all listeners for all events. Called from destroy() paths. */
  removeAllListeners(): void {
    this.listenersByEvent.clear();
  }
}

/**
 * Payload for the `error` event — a fatal condition the player could
 * not recover from on its own.
 * @public
 */
export interface PlayerErrorEvent {
  readonly code: string;
  readonly fatal: boolean;
  readonly cause?: unknown;
}

/** @public Payload for the `ready` event, emitted once the media duration is known. */
export interface PlayerReadyEvent {
  readonly durationSeconds: number;
}

/**
 * Payload for the `voiceOverLineFailed` event — a voice-over line could not
 * be synthesized, either because the gateway reported failure or because it
 * violated its no-throw contract (in which case `error` is a
 * {@link VoiceOverError}).
 * @public
 */
export interface VoiceOverLineFailedEvent {
  readonly trackId: VoiceOverTrackId;
  readonly error: string | VoiceOverError;
}

/**
 * Payload for the `voiceOverPlaybackRejected` event — the browser's
 * autoplay policy rejected playing a synthesized voice-over line. Surfaced
 * explicitly rather than swallowed, so a host application can react (e.g.
 * prompt the user to interact) instead of voice-over silently doing nothing.
 * @public
 */
export interface VoiceOverPlaybackRejectedEvent {
  readonly trackId: VoiceOverTrackId;
}

/**
 * Payload for the `voiceOverVideoResumeRejected` event — resuming the
 * video after an Extended Audio Description pause (WCAG 1.2.7) was
 * rejected. Surfaced explicitly rather than swallowed, consistent with
 * `voiceOverPlaybackRejected` — a host can react (e.g. show a "tap to
 * resume" prompt) instead of the video silently staying paused.
 * @public
 */
export interface VoiceOverVideoResumeRejectedEvent {
  readonly trackId: VoiceOverTrackId;
}

/**
 * Payload for the `voiceOverLinePlayed` event — a synthesized line started
 * playing. `clipped` mirrors {@link VoiceOverLineResult}'s `clipped`, when
 * the gateway set it.
 * @public
 */
export interface VoiceOverLinePlayedEvent {
  readonly trackId: VoiceOverTrackId;
  readonly cueKey: string;
  readonly clipped?: boolean;
  /** `true` when this line didn't fit its cue's window (WCAG 1.2.7 Extended Audio Description case) — whether the video was actually paused for it depends on the host's `allowVideoPause` setting. */
  readonly isExtended?: boolean;
}

/**
 * Payload for the `voiceOverLineSkipped` event — a cue was skipped for a
 * scheduling reason (non-dialogue, missed its late-start grace window, or
 * dropped by a seek). Never fired for a gateway failure or unexpected
 * throw — those are exclusively `voiceOverLineFailed`.
 * @public
 */
export interface VoiceOverLineSkippedEvent {
  readonly trackId: VoiceOverTrackId;
  readonly cueKey: string;
}

/**
 * Events emitted by {@link MediaPlayer}.
 * @public
 */
export interface PlayerEvents extends Record<string, unknown> {
  error: PlayerErrorEvent;
  ready: PlayerReadyEvent;
  voiceOverLineFailed: VoiceOverLineFailedEvent;
  voiceOverPlaybackRejected: VoiceOverPlaybackRejectedEvent;
  voiceOverVideoResumeRejected: VoiceOverVideoResumeRejectedEvent;
  voiceOverLinePlayed: VoiceOverLinePlayedEvent;
  voiceOverLineSkipped: VoiceOverLineSkippedEvent;
}
