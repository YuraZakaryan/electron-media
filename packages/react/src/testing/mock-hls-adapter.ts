import type {
  AudioTrackId,
  AudioTrack,
  HlsAdapterEvents,
  IHlsAdapter,
  SubtitleTrack,
  SubtitleTrackId,
} from "@electron-media/core";

/**
 * Local test double for {@link IHlsAdapter} — mirrors core's own
 * (package-internal, unexported) MockHlsAdapter, since this package can
 * only depend on core's public API surface.
 */
export class MockHlsAdapter implements IHlsAdapter {
  audioTracks: readonly AudioTrack[] = [];
  subtitleTracks: readonly SubtitleTrack[] = [];

  attachedVideo: HTMLVideoElement | null = null;
  loadedUrls: string[] = [];
  selectedAudioTrackId: AudioTrackId | null = null;
  selectedSubtitleTrackId: SubtitleTrackId | null = null;
  attachCount = 0;
  destroyCount = 0;

  private readonly listeners = new Map<
    keyof HlsAdapterEvents,
    Set<(payload: never) => void>
  >();

  attach(video: HTMLVideoElement): void {
    this.attachedVideo = video;
    this.attachCount += 1;
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
    this.destroyCount += 1;
  }
}
