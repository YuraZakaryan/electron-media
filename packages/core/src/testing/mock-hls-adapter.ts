import type { AudioTrackId, SubtitleTrackId } from "../types/branding.js";
import type { AudioTrack, SubtitleTrack } from "../types/track.js";
import type { HlsAdapterEvents, IHlsAdapter } from "../hls/hls-adapter.js";

/** Test double for {@link IHlsAdapter}. Not exported from the package's public API. */
export class MockHlsAdapter implements IHlsAdapter {
  audioTracks: readonly AudioTrack[] = [];
  subtitleTracks: readonly SubtitleTrack[] = [];

  attachedVideo: HTMLVideoElement | null = null;
  loadedUrls: string[] = [];
  selectedAudioTrackId: AudioTrackId | null = null;
  selectedSubtitleTrackId: SubtitleTrackId | null = null;
  destroyed = false;

  private readonly listeners = new Map<
    keyof HlsAdapterEvents,
    Set<(payload: never) => void>
  >();

  attach(video: HTMLVideoElement): void {
    this.attachedVideo = video;
  }

  detach(): void {
    this.attachedVideo = null;
  }

  loadSource(url: string): void {
    this.loadedUrls.push(url);
  }

  getAudioTracks(): readonly AudioTrack[] {
    return this.audioTracks;
  }

  getSubtitleTracks(): readonly SubtitleTrack[] {
    return this.subtitleTracks;
  }

  setAudioTrack(trackId: AudioTrackId): void {
    this.selectedAudioTrackId = trackId;
  }

  setSubtitleTrack(trackId: SubtitleTrackId | null): void {
    this.selectedSubtitleTrackId = trackId;
  }

  on<TEventName extends keyof HlsAdapterEvents>(
    eventName: TEventName,
    callback: (payload: HlsAdapterEvents[TEventName]) => void
  ): () => void {
    const set = this.listeners.get(eventName) ?? new Set();
    set.add(callback as (payload: never) => void);
    this.listeners.set(eventName, set);
    return () => set.delete(callback as (payload: never) => void);
  }

  /** Test-only helper to simulate the adapter emitting an event. */
  emit<TEventName extends keyof HlsAdapterEvents>(
    eventName: TEventName,
    payload: HlsAdapterEvents[TEventName]
  ): void {
    this.listeners
      .get(eventName)
      ?.forEach((listener) => (listener as (payload: never) => void)(payload as never));
  }

  destroy(): void {
    this.destroyed = true;
    // Deliberately does NOT clear `listeners` — tests that verify a
    // consumer's OWN cleanup (e.g. MediaPlayer no longer forwarding events
    // after its destroy()) need this mock to keep emitting so that behavior
    // isn't accidentally masked by the adapter also going silent.
  }
}
