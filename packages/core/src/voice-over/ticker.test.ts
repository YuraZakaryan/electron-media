import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RafVoiceOverTicker } from "./ticker.js";

class FakeDocument {
  hidden = false;
  private readonly listeners = new Set<() => void>();

  addEventListener(name: string, cb: () => void): void {
    if (name === "visibilitychange") this.listeners.add(cb);
  }

  removeEventListener(name: string, cb: () => void): void {
    if (name === "visibilitychange") this.listeners.delete(cb);
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.listeners.forEach((listener) => listener());
  }
}

describe("RafVoiceOverTicker", () => {
  let fakeDocument: FakeDocument;
  let rafCallbacks: Map<number, () => void>;
  let intervalCallbacks: Map<number, () => void>;
  let nextHandle: number;

  beforeEach(() => {
    fakeDocument = new FakeDocument();
    rafCallbacks = new Map();
    intervalCallbacks = new Map();
    nextHandle = 1;

    vi.stubGlobal("document", fakeDocument);
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      const handle = nextHandle++;
      rafCallbacks.set(handle, cb);
      return handle;
    });
    vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
      rafCallbacks.delete(handle);
    });
    // A "manual" setInterval double, mirroring this file's rAF double:
    // registers the callback once and leaves it registered (matching real
    // setInterval's repeat-until-cleared contract) — tests fire it as many
    // times as they want to simulate repeated ticks, deterministically,
    // without real or vitest-mocked wall-clock time.
    vi.stubGlobal("setInterval", (cb: () => void) => {
      const handle = nextHandle++;
      intervalCallbacks.set(handle, cb);
      return handle;
    });
    vi.stubGlobal("clearInterval", (handle: number) => {
      intervalCallbacks.delete(handle);
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fireRaf(): void {
    const entry = [...rafCallbacks.entries()][0];
    if (!entry) return;
    rafCallbacks.delete(entry[0]);
    entry[1]();
  }

  function fireInterval(times = 1): void {
    for (let i = 0; i < times; i++) {
      const entry = [...intervalCallbacks.entries()][0];
      if (!entry) return;
      entry[1]();
    }
  }

  it("ticks via requestAnimationFrame while the document is visible", () => {
    const callback = vi.fn();
    new RafVoiceOverTicker().start(callback);

    fireRaf();
    fireRaf();

    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("does not register a setInterval while visible", () => {
    new RafVoiceOverTicker().start(() => {});
    expect(intervalCallbacks.size).toBe(0);
  });

  it("switches to setInterval and cancels rAF once the document becomes hidden", () => {
    const callback = vi.fn();
    new RafVoiceOverTicker().start(callback);
    expect(rafCallbacks.size).toBe(1);

    fakeDocument.setHidden(true);

    expect(rafCallbacks.size).toBe(0);
    expect(intervalCallbacks.size).toBe(1);

    fireInterval(3);
    expect(callback).toHaveBeenCalledTimes(3);
  });

  it("switches back to requestAnimationFrame and clears the interval once visible again", () => {
    const callback = vi.fn();
    new RafVoiceOverTicker().start(callback);

    fakeDocument.setHidden(true);
    fireInterval();
    expect(callback).toHaveBeenCalledTimes(1);

    fakeDocument.setHidden(false);

    expect(intervalCallbacks.size).toBe(0);
    expect(rafCallbacks.size).toBe(1);

    fireRaf();
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("starts directly on setInterval if the document is already hidden at start()", () => {
    fakeDocument.hidden = true;
    const callback = vi.fn();
    new RafVoiceOverTicker().start(callback);

    expect(rafCallbacks.size).toBe(0);
    expect(intervalCallbacks.size).toBe(1);

    fireInterval();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels both rAF and interval ticking, and further visibility changes cannot resurrect it", () => {
    const callback = vi.fn();
    const stop = new RafVoiceOverTicker().start(callback);

    fakeDocument.setHidden(true);
    stop();

    expect(rafCallbacks.size).toBe(0);
    expect(intervalCallbacks.size).toBe(0);

    fakeDocument.setHidden(false);
    expect(rafCallbacks.size).toBe(0);
    expect(intervalCallbacks.size).toBe(0);
  });

  it("stop() is idempotent", () => {
    const stop = new RafVoiceOverTicker().start(() => {});
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });

  it("falls back to plain requestAnimationFrame ticking when document is unavailable (non-browser context)", () => {
    vi.stubGlobal("document", undefined);
    const callback = vi.fn();
    new RafVoiceOverTicker().start(callback);

    expect(rafCallbacks.size).toBe(1);
    fireRaf();
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
