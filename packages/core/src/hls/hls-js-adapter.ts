import Hls, { ErrorTypes, Events } from "hls.js";

import { asSubtitleSourceId } from "../types/branding.js";
import { mapHlsAudioTrack, mapHlsSubtitleTrack } from "./map-hls-track.js";

import type { AudioTrackId, SubtitleTrackId } from "../types/branding.js";
import type { AudioTrack, SubtitleTrack } from "../types/track.js";
import type { HlsAdapterEvents, IHlsAdapter } from "./hls-adapter.js";

const HLS_NATIVE_SUBTITLE_SOURCE_ID = asSubtitleSourceId("hls-native");
const NO_TRACK_INDEX = -1;

/** @public Options for {@link HlsJsAdapter}. */
export interface HlsJsAdapterOptions {
  /** Number of retry attempts for a recoverable (network/media) fatal error before giving up. Defaults to 3. */
  readonly maxRetries?: number;
  /**
   * Called on every fatal network/media error before the adapter's own
   * retry policy runs; return `false` to skip retrying and emit
   * `fatalError` immediately instead. `detail` is hls.js's `ErrorDetails`
   * string (e.g. `"manifestParsingError"`); `errorType` is its `ErrorTypes`
   * string (e.g. `"networkError"`).
   *
   * Exists because "is this error worth retrying" is app/partner-specific
   * policy (e.g. a partner that wants to fall back to a transcoded stream
   * immediately on a broken manifest, without wasting retries on a request
   * that will never succeed) — the adapter itself only knows *how many*
   * times to retry, never *whether* a given failure is worth it. Defaults
   * to always retrying (matching the adapter's behavior before this hook
   * existed).
   */
  readonly shouldRetry?: (detail: string, errorType: string) => boolean;
  /**
   * Milliseconds to wait before retrying a fatal `NETWORK_ERROR`. Media-error
   * recovery (`recoverMediaError()`) is always attempted immediately — a
   * network hiccup benefits from backoff, a decode failure does not.
   * Defaults to 0 (retry immediately, matching the adapter's behavior
   * before this option existed).
   */
  readonly retryDelayMs?: number;
  /**
   * hls.js `ErrorDetails` values that should be recovered from via a full
   * `hls.loadSource(url)` reload instead of the type-based default
   * (`startLoad()`/`recoverMediaError()`). Needed for e.g.
   * `"manifestParsingError"`: `startLoad()` only resumes loading *levels*,
   * so it no-ops when the manifest itself parsed to zero levels — exactly
   * what a manifest file read mid-write produces. Only a fresh
   * `loadSource()` re-reads the file, by then complete. Defaults to none.
   */
  readonly reloadOnDetail?: readonly string[];
}

/**
 * Wraps hls.js as an {@link IHlsAdapter}. This is the only shipped
 * IHlsAdapter implementation; ports the hls.js-specific portions of
 * the app's former `useHls.ts` + `useHlsTracks.ts` + `mapHlsTrack.ts`.
 *
 * Ownership: creates and destroys its own `Hls` instance; never
 * removes the video element passed to {@link attach} from the DOM.
 * @public
 */
export class HlsJsAdapter implements IHlsAdapter {
  private readonly maxRetries: number;
  private readonly shouldRetry: (detail: string, errorType: string) => boolean;
  private readonly retryDelayMs: number;
  private readonly reloadOnDetail: ReadonlySet<string>;
  private readonly emitter = new EventTargetShim<HlsAdapterEvents>();
  private hls: Hls | null = null;
  private video: HTMLVideoElement | null = null;
  private currentUrl: string | null = null;
  private retryCount = 0;
  private audioTracks: readonly AudioTrack[] = [];
  private subtitleTracks: readonly SubtitleTrack[] = [];

  constructor(options: HlsJsAdapterOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3;
    this.shouldRetry = options.shouldRetry ?? (() => true);
    this.retryDelayMs = options.retryDelayMs ?? 0;
    this.reloadOnDetail = new Set(options.reloadOnDetail ?? []);
  }

  attach(video: HTMLVideoElement): void {
    this.video = video;
  }

  detach(): void {
    this.destroyHlsInstance();
    this.video = null;
  }

  loadSource(url: string): void {
    if (!this.video) {
      throw new Error("HlsJsAdapter.loadSource called before attach(video)");
    }
    this.destroyHlsInstance();
    this.retryCount = 0;
    this.currentUrl = url;

    if (!Hls.isSupported()) {
      this.loadNatively(url);
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 60,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 10,
      manifestLoadingMaxRetry: 10,
      levelLoadingMaxRetry: 10,
      fragLoadingMaxRetry: 10,
      enableSoftwareAES: true,
    });
    this.hls = hls;

    hls.on(Events.AUDIO_TRACKS_UPDATED, (_event, data) => {
      this.audioTracks = data.audioTracks.map(mapHlsAudioTrack);
      this.emitter.emit("audioTracksChanged", { tracks: this.audioTracks });
    });

    hls.on(Events.SUBTITLE_TRACKS_UPDATED, (_event, data) => {
      this.subtitleTracks = data.subtitleTracks.map((track, index) =>
        mapHlsSubtitleTrack(track, index, HLS_NATIVE_SUBTITLE_SOURCE_ID),
      );
      this.emitter.emit("subtitleTracksChanged", { tracks: this.subtitleTracks });
    });

    hls.on(Events.MANIFEST_PARSED, () => {
      this.emitter.emit("manifestParsed", {
        durationSeconds: this.video?.duration || 0,
      });
    });

    hls.on(Events.ERROR, (_event, data) => {
      this.emitter.emit("errorObserved", {
        fatal: data.fatal,
        type: data.type,
        detail: data.details,
        cause: data,
      });

      if (!data.fatal) return;

      const canRetry =
        this.retryCount < this.maxRetries &&
        this.shouldRetry(data.details, data.type);

      const recover = () => {
        // The delayed path can fire after this exact hls.js instance has
        // already been torn down (a new loadSource()/destroy() call in the
        // meantime) — recovering against a dead instance would throw.
        if (this.hls !== hls) return;
        if (this.reloadOnDetail.has(data.details)) {
          hls.loadSource(this.currentUrl as string);
        } else if (data.type === ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else {
          hls.recoverMediaError();
        }
      };

      switch (data.type) {
        case ErrorTypes.NETWORK_ERROR:
          if (canRetry) {
            this.retryCount += 1;
            if (this.retryDelayMs > 0) {
              setTimeout(recover, this.retryDelayMs);
            } else {
              recover();
            }
            return;
          }
          break;
        case ErrorTypes.MEDIA_ERROR:
          if (canRetry) {
            this.retryCount += 1;
            recover();
            return;
          }
          break;
        default:
          break;
      }

      this.emitter.emit("fatalError", { code: data.details, cause: data });
      this.destroyHlsInstance();
    });

    hls.loadSource(url);
    hls.attachMedia(this.video);
  }

  getAudioTracks(): readonly AudioTrack[] {
    return this.audioTracks;
  }

  getSubtitleTracks(): readonly SubtitleTrack[] {
    return this.subtitleTracks;
  }

  setAudioTrack(trackId: AudioTrackId): void {
    if (!this.hls) return;
    this.hls.audioTrack = trackId;
  }

  setSubtitleTrack(trackId: SubtitleTrackId | null): void {
    if (!this.hls) return;
    this.hls.subtitleTrack = trackId === null ? NO_TRACK_INDEX : (trackId);
  }

  on<TEventName extends keyof HlsAdapterEvents>(
    eventName: TEventName,
    callback: (payload: HlsAdapterEvents[TEventName]) => void,
  ): () => void {
    return this.emitter.on(eventName, callback);
  }

  destroy(): void {
    this.destroyHlsInstance();
    this.emitter.removeAllListeners();
    this.video = null;
  }

  private destroyHlsInstance(): void {
    this.hls?.destroy();
    this.hls = null;
    this.audioTracks = [];
    this.subtitleTracks = [];
  }

  private loadNatively(url: string): void {
    if (!this.video) return;
    if (!this.video.canPlayType("application/vnd.apple.mpegurl")) {
      this.emitter.emit("fatalError", { code: "hlsUnsupported" });
      return;
    }
    this.video.src = url;
  }
}

/** @internal Minimal typed emitter reused inside the adapter; not exported publicly. */
class EventTargetShim<TEvents extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof TEvents, Set<(payload: never) => void>>();

  on<K extends keyof TEvents>(eventName: K, callback: (payload: TEvents[K]) => void): () => void {
    const set = this.listeners.get(eventName) ?? new Set();
    set.add(callback);
    this.listeners.set(eventName, set);
    return () => set.delete(callback);
  }

  emit<K extends keyof TEvents>(eventName: K, payload: TEvents[K]): void {
    const set = this.listeners.get(eventName);
    if (!set) return;
    for (const listener of set) (listener as (payload: TEvents[K]) => void)(payload);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }
}

