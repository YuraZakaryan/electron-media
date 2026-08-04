import type { IHlsAdapter } from "./hls-adapter.js";

/** @public Options for {@link HlsController}. */
export interface HlsControllerOptions {
  readonly adapter: IHlsAdapter;
}

/**
 * Owns only the HLS playback lifecycle: attaching to a video element
 * and loading/reloading a source through the given {@link IHlsAdapter}.
 * Holds no audio/subtitle track state (see {@link AudioTrackController}
 * and {@link SubtitleController}) and no partner-specific fallback
 * policy (that remains application-side, layered on top of this class).
 * @public
 */
export class HlsController {
  private readonly adapter: IHlsAdapter;

  constructor(options: HlsControllerOptions) {
    this.adapter = options.adapter;
  }

  /** Attaches to the given video element. Does not take ownership of it. */
  attach(video: HTMLVideoElement): void {
    this.adapter.attach(video);
  }

  /** Loads (or reloads) a source URL, tearing down any previous instance first. */
  loadSource(url: string): void {
    this.adapter.loadSource(url);
  }

  /** Releases all resources. Idempotent; no other method may be called afterwards. */
  destroy(): void {
    this.adapter.destroy();
  }
}
