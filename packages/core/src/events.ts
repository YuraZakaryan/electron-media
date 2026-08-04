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
    listeners.add(callback as (payload: never) => void);
    this.listenersByEvent.set(eventName, listeners);
    return () => {
      listeners.delete(callback as (payload: never) => void);
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
 * Events emitted by {@link MediaPlayer}.
 * @public
 */
export interface PlayerEvents extends Record<string, unknown> {
  error: PlayerErrorEvent;
  ready: PlayerReadyEvent;
}
