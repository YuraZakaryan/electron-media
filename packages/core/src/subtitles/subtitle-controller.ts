import type { SubtitleSourceId, SubtitleTrackId } from "../types/branding.js";
import type { CanonicalCue } from "../types/cue.js";
import type { SubtitleTrack } from "../types/track.js";
import type { SubtitleDelayProcessor } from "./subtitle-delay-processor.js";
import type { SubtitleRegistry } from "./subtitle-registry.js";
import type { SubtitleSelectionService } from "./subtitle-selection-service.js";
import type { ISubtitleRenderer } from "./subtitle-renderer.js";
import type { ISubtitleSource } from "./subtitle-source.js";

/** @public */
export interface SubtitleControllerOptions {
  readonly registry: SubtitleRegistry;
  readonly selection: SubtitleSelectionService;
  readonly delay: SubtitleDelayProcessor;
  readonly renderer: ISubtitleRenderer;
}

// Media events that can land after a host-owned engine (e.g. hls.js, on
// MEDIA_ATTACHING/MANIFEST_LOADING) wipes the video's text tracks — a repair
// check on each is cheaper than the interval alone and reacts sooner.
const REPAIR_EVENT_NAMES = [
  "loadedmetadata",
  "canplay",
  "progress",
  "timeupdate",
] as const;

// Belt-and-suspenders alongside the events above: some wipes (e.g. one that
// happens before MANIFEST_PARSED) can land before any of those events fire.
const REPAIR_INTERVAL_MS = 500;

/**
 * Facade exposed to the host application and the React adapter. Wires
 * {@link SubtitleRegistry} (available tracks), {@link SubtitleSelectionService}
 * (active track), {@link SubtitleDelayProcessor} (timing nudge), and
 * {@link ISubtitleRenderer} (DOM output) together: whenever the selected
 * track's cues or the delay change, it projects the canonical cues and
 * re-renders.
 *
 * Ownership: does not own the `video` element passed to {@link attach}; only
 * ever hands it to the configured renderer.
 *
 * Lifecycle: call {@link destroy} exactly once when done; no other method
 * may be called afterwards.
 *
 * @public
 */
export class SubtitleController {
  private readonly registry: SubtitleRegistry;
  private readonly selection: SubtitleSelectionService;
  private readonly delay: SubtitleDelayProcessor;
  private readonly renderer: ISubtitleRenderer;

  private video: HTMLVideoElement | null = null;
  private canonicalCues: readonly CanonicalCue[] = [];
  private unsubscribeFromCues: (() => void) | null = null;
  private previouslySelectedTrack: SubtitleTrack | null = null;
  private readonly unsubscribeFromSelection: () => void;
  private readonly unsubscribeFromDelay: () => void;
  private repairIntervalId: ReturnType<typeof setInterval> | null = null;
  private repairEventTarget: HTMLVideoElement | null = null;
  private readonly handleRepairTick = () => this.repairIfWiped();

  constructor(options: SubtitleControllerOptions) {
    this.registry = options.registry;
    this.selection = options.selection;
    this.delay = options.delay;
    this.renderer = options.renderer;

    this.unsubscribeFromSelection = this.selection.onSelectionChanged(
      (track) => this.handleSelectionChanged(track)
    );
    this.unsubscribeFromDelay = this.delay.onDelayChanged(() =>
      this.rerender()
    );
  }

  /** Attaches the video element cues will be rendered onto. Safe to call again with a new element (e.g. on source change). */
  attach(video: HTMLVideoElement): void {
    this.video = video;
    this.rerender();
    this.syncRepairLoop();
  }

  /** Detaches the current video element and clears any rendered cues. */
  detach(): void {
    this.stopRepairLoop();
    this.renderer.clear();
    this.video = null;
  }

  /** Returns every track exposed by every registered source. */
  getTracks(): readonly SubtitleTrack[] {
    return this.registry.getTracks();
  }

  /** Selects `trackId` for rendering, or turns subtitles off when `null`. */
  selectTrack(trackId: SubtitleTrackId | null): void {
    this.selection.select(trackId);
  }

  /** The currently selected subtitle track, or `null` if none is active. */
  get selectedTrack(): SubtitleTrack | null {
    return this.selection.selected;
  }

  /** Notifies `callback` whenever the selected track changes. Returns an unsubscribe function. */
  onSelectionChanged(
    callback: (track: SubtitleTrack | null) => void
  ): () => void {
    return this.selection.onSelectionChanged(callback);
  }

  /** Sets the user-facing subtitle delay, in seconds (positive = later). */
  setDelaySeconds(offsetSeconds: number): void {
    this.delay.setDelaySeconds(offsetSeconds);
  }

  /** Notifies `callback` whenever the merged track list changes. Returns an unsubscribe function. */
  onTracksChanged(
    callback: (tracks: readonly SubtitleTrack[]) => void
  ): () => void {
    return this.registry.onTracksChanged(callback);
  }

  /** Releases all subscriptions and clears rendered cues. Idempotent. */
  destroy(): void {
    this.stopRepairLoop();
    this.unsubscribeFromCues?.();
    this.unsubscribeFromCues = null;
    this.unsubscribeFromSelection();
    this.unsubscribeFromDelay();
    this.renderer.clear();
    this.video = null;
  }

  private handleSelectionChanged(track: SubtitleTrack | null): void {
    this.unsubscribeFromCues?.();
    this.unsubscribeFromCues = null;
    this.canonicalCues = [];

    const previousTrack = this.previouslySelectedTrack;
    this.previouslySelectedTrack = track;

    // A source switch (or turning subtitles off) must tell the PREVIOUSLY
    // active source to deselect — otherwise a source like
    // VodExtractedSubtitleSource keeps polling a track nothing displays
    // anymore. Switching between two tracks on the SAME source doesn't need
    // this: that source's own selectTrack(newId) already transitions its
    // internal state away from the old id.
    if (previousTrack && previousTrack.sourceId !== track?.sourceId) {
      this.findSource(previousTrack.sourceId)?.selectTrack(null);
    }

    if (!track) {
      this.rerender();
      return;
    }

    const source = this.findSource(track.sourceId);
    // Subscribe BEFORE calling selectTrack — a source that already has this
    // track's cues cached (e.g. OpenSubtitlesSource re-selecting a
    // previously-downloaded track) emits them synchronously from within
    // selectTrack() itself. Subscribing afterwards would miss that
    // synchronous emission entirely: the track would show as selected but
    // never actually render.
    let emittedDuringSelect = false;
    this.unsubscribeFromCues =
      source?.onCuesChanged(track.trackId, (cues) => {
        emittedDuringSelect = true;
        this.canonicalCues = cues;
        this.rerender();
      }) ?? null;
    source?.selectTrack(track.trackId);
    // A source that emits nothing synchronously must still take the screen:
    // canonicalCues was cleared above, so without this the PREVIOUS track's
    // cues stay rendered until (or forever, if) the new source emits. Hit by
    // every switch to a still-fetching source, and permanently by one that
    // never emits at all (HlsNativeSubtitleSource, where hls.js paints its
    // own TextTrack instead). Skipped when the source already emitted, since
    // re-rendering identical cues visibly flickers the on-screen cue.
    if (!emittedDuringSelect) this.rerender();
    this.syncRepairLoop();
  }

  private findSource(sourceId: SubtitleSourceId): ISubtitleSource | undefined {
    return this.registry.getSource(sourceId);
  }

  private rerender(): void {
    if (!this.video || !this.selection.selected) {
      this.renderer.clear();
      return;
    }

    const projected = this.canonicalCues.map((cue) => this.delay.apply(cue));
    this.renderer.render(this.video, projected);
  }

  /** Starts or stops the wipe-repair loop to match "is a track selected and attached right now". */
  private syncRepairLoop(): void {
    if (this.video && this.selection.selected) {
      this.startRepairLoop();
    } else {
      this.stopRepairLoop();
    }
  }

  private startRepairLoop(): void {
    if (!this.video) return;
    if (this.repairEventTarget === this.video && this.repairIntervalId !== null) {
      return; // already running for this exact video
    }
    this.stopRepairLoop();
    this.repairEventTarget = this.video;
    for (const eventName of REPAIR_EVENT_NAMES) {
      this.repairEventTarget.addEventListener(eventName, this.handleRepairTick);
    }
    this.repairIntervalId = setInterval(this.handleRepairTick, REPAIR_INTERVAL_MS);
  }

  private stopRepairLoop(): void {
    if (this.repairIntervalId !== null) {
      clearInterval(this.repairIntervalId);
      this.repairIntervalId = null;
    }
    if (this.repairEventTarget) {
      for (const eventName of REPAIR_EVENT_NAMES) {
        this.repairEventTarget.removeEventListener(eventName, this.handleRepairTick);
      }
      this.repairEventTarget = null;
    }
  }

  /**
   * Re-renders only if the renderer reports its cues were actually wiped —
   * an unconditional re-render on every tick would flicker (native
   * `TextTrack.addCue` briefly clears before repopulating).
   */
  private repairIfWiped(): void {
    if (this.renderer.isIntact?.() === false) {
      this.rerender();
    }
  }
}
