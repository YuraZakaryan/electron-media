import { Events } from "hls.js";
import { describe, expect, it, vi } from "vitest";

import { AttachedHlsAdapter } from "./attached-hls-adapter.js";

import type Hls from "hls.js";
import type { MediaPlaylist } from "hls.js";

/**
 * Minimal fake of the slice of `Hls` this adapter actually touches:
 * `.on(event, cb)` recording per-event listeners, and settable
 * `audioTrack`/`subtitleTrack` properties. Each instance is independent,
 * so tests simulating a seek/transcode session swap use two separate
 * `FakeHls` instances rather than one shared mock.
 */
class FakeHls {
  audioTrack = -1;
  subtitleTrack = -1;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  on(event: string, callback: (...args: unknown[]) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(callback);
    this.listeners.set(event, set);
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((callback) => callback(...args));
  }

  asHls(): Hls {
    return this as unknown as Hls;
  }
}

function playlist(overrides: Partial<MediaPlaylist> = {}): MediaPlaylist {
  return { default: false, name: undefined, lang: undefined, ...overrides } as MediaPlaylist;
}

describe("AttachedHlsAdapter — good cases", () => {
  it("populates audio tracks from AUDIO_TRACKS_UPDATED after attachHls", () => {
    const adapter = new AttachedHlsAdapter();
    const hls = new FakeHls();
    adapter.attachHls(hls.asHls());

    hls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist({ lang: "en" }), playlist({ lang: "es" })] });

    expect(adapter.getAudioTracks().map((t) => t.language)).toEqual(["en", "es"]);
  });

  it("populates subtitle tracks from SUBTITLE_TRACKS_UPDATED after attachHls", () => {
    const adapter = new AttachedHlsAdapter();
    const hls = new FakeHls();
    adapter.attachHls(hls.asHls());

    hls.emit(Events.SUBTITLE_TRACKS_UPDATED, {}, { subtitleTracks: [playlist({ lang: "en" })] });

    expect(adapter.getSubtitleTracks().map((t) => t.language)).toEqual(["en"]);
  });

  it("emits audioTracksChanged/subtitleTracksChanged to on() subscribers", () => {
    const adapter = new AttachedHlsAdapter();
    const hls = new FakeHls();
    adapter.attachHls(hls.asHls());
    const audioListener = vi.fn();
    const subtitleListener = vi.fn();
    adapter.on("audioTracksChanged", audioListener);
    adapter.on("subtitleTracksChanged", subtitleListener);

    hls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist({ lang: "en" })] });
    hls.emit(Events.SUBTITLE_TRACKS_UPDATED, {}, { subtitleTracks: [playlist({ lang: "fr" })] });

    expect(audioListener).toHaveBeenCalledWith({ tracks: expect.arrayContaining([expect.objectContaining({ language: "en" })]) });
    expect(subtitleListener).toHaveBeenCalledWith({ tracks: expect.arrayContaining([expect.objectContaining({ language: "fr" })]) });
  });

  it("setAudioTrack/setSubtitleTrack forward to the attached hls instance", () => {
    const adapter = new AttachedHlsAdapter();
    const hls = new FakeHls();
    adapter.attachHls(hls.asHls());

    adapter.setAudioTrack(2 as never);
    adapter.setSubtitleTrack(3 as never);

    expect(hls.audioTrack).toBe(2);
    expect(hls.subtitleTrack).toBe(3);
  });

  it("setSubtitleTrack(null) sets subtitleTrack to -1 (off)", () => {
    const adapter = new AttachedHlsAdapter();
    const hls = new FakeHls();
    adapter.attachHls(hls.asHls());
    adapter.setSubtitleTrack(4 as never);

    adapter.setSubtitleTrack(null);

    expect(hls.subtitleTrack).toBe(-1);
  });

  it("detachHls clears track lists and emits empty lists", () => {
    const adapter = new AttachedHlsAdapter();
    const hls = new FakeHls();
    adapter.attachHls(hls.asHls());
    hls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist({ lang: "en" })] });
    const audioListener = vi.fn();
    adapter.on("audioTracksChanged", audioListener);

    adapter.detachHls();

    expect(adapter.getAudioTracks()).toEqual([]);
    expect(adapter.getSubtitleTracks()).toEqual([]);
    expect(audioListener).toHaveBeenCalledWith({ tracks: [] });
  });

  it("re-attaching a fresh Hls instance after detachHls repopulates tracks from the new instance only", () => {
    const adapter = new AttachedHlsAdapter();
    const firstHls = new FakeHls();
    adapter.attachHls(firstHls.asHls());
    firstHls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist({ lang: "en" })] });
    adapter.detachHls();

    const secondHls = new FakeHls();
    adapter.attachHls(secondHls.asHls());
    secondHls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist({ lang: "es" }), playlist({ lang: "de" })] });

    expect(adapter.getAudioTracks().map((t) => t.language)).toEqual(["es", "de"]);
  });

  it("on() returns an unsubscribe function that stops further callbacks", () => {
    const adapter = new AttachedHlsAdapter();
    const hls = new FakeHls();
    adapter.attachHls(hls.asHls());
    const listener = vi.fn();
    const unsubscribe = adapter.on("audioTracksChanged", listener);

    unsubscribe();
    hls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist()] });

    expect(listener).not.toHaveBeenCalled();
  });
});

describe("AttachedHlsAdapter — bad cases", () => {
  it("detachHls without a prior attachHls is a no-op, not a throw", () => {
    const adapter = new AttachedHlsAdapter();

    expect(() => adapter.detachHls()).not.toThrow();
    expect(adapter.getAudioTracks()).toEqual([]);
  });

  it("calling detachHls twice in a row does not double-emit empty track lists", () => {
    const adapter = new AttachedHlsAdapter();
    const hls = new FakeHls();
    adapter.attachHls(hls.asHls());
    hls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist({ lang: "en" })] });
    adapter.detachHls();
    const audioListener = vi.fn();
    adapter.on("audioTracksChanged", audioListener);

    adapter.detachHls();

    expect(audioListener).not.toHaveBeenCalled();
  });

  it("setAudioTrack/setSubtitleTrack before any attachHls do not throw and are no-ops", () => {
    const adapter = new AttachedHlsAdapter();

    expect(() => {
      adapter.setAudioTrack(1 as never);
      adapter.setSubtitleTrack(1 as never);
    }).not.toThrow();
  });

  it("getAudioTracks/getSubtitleTracks before any attachHls return empty arrays, not throw", () => {
    const adapter = new AttachedHlsAdapter();

    expect(adapter.getAudioTracks()).toEqual([]);
    expect(adapter.getSubtitleTracks()).toEqual([]);
  });

  it("attachHls called again without an intervening detachHls does not leak the old instance's events into current state", () => {
    const adapter = new AttachedHlsAdapter();
    const firstHls = new FakeHls();
    adapter.attachHls(firstHls.asHls());

    const secondHls = new FakeHls();
    adapter.attachHls(secondHls.asHls());

    // A stale/queued event from the instance that was silently replaced
    // (the exact class of app-side bug this adapter guards against) must
    // not resurrect state for an instance that is no longer attached.
    firstHls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist({ lang: "stale" })] });
    expect(adapter.getAudioTracks()).toEqual([]);

    secondHls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist({ lang: "fresh" })] });
    expect(adapter.getAudioTracks().map((t) => t.language)).toEqual(["fresh"]);
  });

  it("an event from an already-detached instance does not update state", () => {
    const adapter = new AttachedHlsAdapter();
    const hls = new FakeHls();
    adapter.attachHls(hls.asHls());
    adapter.detachHls();

    hls.emit(Events.AUDIO_TRACKS_UPDATED, {}, { audioTracks: [playlist({ lang: "too-late" })] });

    expect(adapter.getAudioTracks()).toEqual([]);
  });

  it("destroy() is safe to call without a prior attachHls", () => {
    const adapter = new AttachedHlsAdapter();

    expect(() => adapter.destroy()).not.toThrow();
  });

  it("detach()/attach()/loadSource() (the IHlsAdapter no-op surface) never throw", () => {
    const adapter = new AttachedHlsAdapter();

    expect(() => {
      adapter.attach(undefined as never);
      adapter.loadSource("unused");
      adapter.detach();
    }).not.toThrow();
  });
});
