import { describe, expect, it, vi } from "vitest";

import { TypedEventEmitter } from "./events.js";

interface TestEvents extends Record<string, unknown> {
  ping: { readonly value: number };
  pong: { readonly label: string };
}

describe("TypedEventEmitter", () => {
  it("calls a subscribed listener with the emitted payload", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener = vi.fn();

    emitter.on("ping", listener);
    emitter.emit("ping", { value: 42 });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ value: 42 });
  });

  it("supports multiple listeners on the same event", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const first = vi.fn();
    const second = vi.fn();

    emitter.on("ping", first);
    emitter.on("ping", second);
    emitter.emit("ping", { value: 1 });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps event channels independent", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const pingListener = vi.fn();
    const pongListener = vi.fn();

    emitter.on("ping", pingListener);
    emitter.on("pong", pongListener);
    emitter.emit("pong", { label: "hello" });

    expect(pingListener).not.toHaveBeenCalled();
    expect(pongListener).toHaveBeenCalledTimes(1);
    expect(pongListener).toHaveBeenCalledWith({ label: "hello" });
  });

  it("stops notifying a listener once unsubscribed", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const listener = vi.fn();

    const unsubscribe = emitter.on("ping", listener);
    unsubscribe();
    emitter.emit("ping", { value: 1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not throw when unsubscribe is called more than once", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const unsubscribe = emitter.on("ping", vi.fn());

    expect(() => {
      unsubscribe();
      unsubscribe();
    }).not.toThrow();
  });

  it("is a no-op to emit an event with no subscribers", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    expect(() => emitter.emit("ping", { value: 1 })).not.toThrow();
  });

  it("removeAllListeners clears every event channel", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const pingListener = vi.fn();
    const pongListener = vi.fn();
    emitter.on("ping", pingListener);
    emitter.on("pong", pongListener);

    emitter.removeAllListeners();
    emitter.emit("ping", { value: 1 });
    emitter.emit("pong", { label: "x" });

    expect(pingListener).not.toHaveBeenCalled();
    expect(pongListener).not.toHaveBeenCalled();
  });
});
