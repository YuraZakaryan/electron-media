import { TypedEventEmitter, type PlayerEvents } from "../events.js";
import { HlsController } from "../hls/hls-controller.js";
import { AudioTrackController } from "../hls/audio-track-controller.js";
import { SubtitleController } from "../subtitles/subtitle-controller.js";
import { SubtitleRegistry } from "../subtitles/subtitle-registry.js";
import { SubtitleSelectionService } from "../subtitles/subtitle-selection-service.js";
import { SubtitleDelayProcessor } from "../subtitles/subtitle-delay-processor.js";
import { TextTrackCueRenderer } from "../subtitles/text-track-cue-renderer.js";

import type { IHlsAdapter } from "../hls/hls-adapter.js";
import type { PlayerPreferenceStore } from "../contracts/preference-store.js";
import type { ISubtitleRenderer } from "../subtitles/subtitle-renderer.js";
import type { ISubtitleSource } from "../subtitles/subtitle-source.js";

/** @public */
export interface MediaPlayerOptions {
  /** Video element playback attaches to. Never inserted into or removed from the DOM by {@link MediaPlayer}. */
  readonly video: HTMLVideoElement;
  /** HLS engine abstraction; the only shipped implementation is `HlsJsAdapter`. */
  readonly hlsAdapter: IHlsAdapter;
  /** Persists the user's audio/subtitle language choices across sessions. Omit to disable auto-restore. */
  readonly preferenceStore?: PlayerPreferenceStore;
  /** Subtitle sources active from construction (e.g. an `HlsNativeSubtitleSource`); more can be added later via `subtitles`'s underlying registry. */
  readonly subtitleSources?: readonly ISubtitleSource[];
  /** Renders projected subtitle cues onto the video. Defaults to {@link TextTrackCueRenderer}. */
  readonly subtitleRenderer?: ISubtitleRenderer;
}

/**
 * Composition root for the player. Wires together HLS playback, audio track
 * selection, and subtitle handling behind one narrow surface — consumers
 * should not need to reach into `audio`/`subtitles`' constituent classes.
 *
 * Ownership: does not own the `video` element supplied in
 * {@link MediaPlayerOptions} and will never insert/remove it from the DOM —
 * the host application controls its lifecycle.
 *
 * Lifecycle: call {@link destroy} exactly once when done; no other method
 * may be called afterwards.
 *
 * @public
 */
export class MediaPlayer {
  /** Typed pub/sub for player-level lifecycle events (`error`, `loading`, `ready`). */
  readonly events = new TypedEventEmitter<PlayerEvents>();
  /** Audio track listing/selection. */
  readonly audio: AudioTrackController;
  /** Subtitle track listing/selection/delay/rendering. */
  readonly subtitles: SubtitleController;

  private readonly video: HTMLVideoElement;
  private readonly hlsController: HlsController;

  constructor(options: MediaPlayerOptions) {
    this.video = options.video;
    this.hlsController = new HlsController({ adapter: options.hlsAdapter });

    this.audio = new AudioTrackController({
      adapter: options.hlsAdapter,
      preferenceStore: options.preferenceStore,
    });

    const registry = new SubtitleRegistry({
      sources: options.subtitleSources ?? [],
    });
    const selection = new SubtitleSelectionService({ registry });
    const delay = new SubtitleDelayProcessor();

    this.subtitles = new SubtitleController({
      registry,
      selection,
      delay,
      renderer: options.subtitleRenderer ?? new TextTrackCueRenderer(),
    });

    options.hlsAdapter.on("fatalError", ({ code, cause }) => {
      this.events.emit("error", { code, fatal: true, cause });
    });
    options.hlsAdapter.on("manifestParsed", ({ durationSeconds }) => {
      this.events.emit("ready", { durationSeconds });
    });

    this.hlsController.attach(this.video);
    this.subtitles.attach(this.video);
  }

  /** Loads (or reloads) a source URL, tearing down any previous HLS instance first. */
  loadSource(url: string): void {
    this.hlsController.loadSource(url);
  }

  /** Releases all resources (HLS instance, event listeners, subtitle renderer). Idempotent. */
  destroy(): void {
    this.hlsController.destroy();
    this.subtitles.destroy();
    this.events.removeAllListeners();
  }
}
