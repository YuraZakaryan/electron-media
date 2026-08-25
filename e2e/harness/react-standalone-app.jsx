import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import Hls from "hls.js";
import {
  useAudioTrackController,
  useSubtitleController,
  useVoiceOverController,
} from "@electron-media/react";
import {
  AttachedHlsAdapter,
  AudioTrackController,
  SubtitleController,
  SubtitleDelayProcessor,
  SubtitleRegistry,
  SubtitleSelectionService,
  TextTrackCueRenderer,
  TrackKind,
  TypedEventEmitter,
  VodExtractedSubtitleSource,
  VoiceOverController,
  asSubtitleSourceId,
  asSubtitleTrackId,
} from "@electron-media/core";

const params = new URLSearchParams(window.location.search);
const sourceUrl = params.get("src") ?? "/fixtures/master.m3u8";

const VOD_SOURCE_ID = asSubtitleSourceId("vod-extracted");
const VOD_TRACK_ID = asSubtitleTrackId(200000);

// A fixed, pre-baked silent WAV data URI is enough to exercise real
// Audio playback through VoiceOverDuckingPlayer without needing Web Audio
// synthesis — the fixture's own 1s/2s cue windows are generous enough that
// this fixed duration never triggers Extended Audio Description (already
// covered end-to-end by e2e/tests/voice-over.spec.ts against core.html).
const SILENT_WAV_DATA_URL =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

/**
 * Records every generateLine call so a test can assert the real scheduler
 * (ticking off the real <video>'s currentTime, driven by real hls.js
 * playback) actually reached a cue and requested synthesis for it — not
 * just that state/track wiring looks right.
 */
class FakeVoiceOverGateway {
  isAvailable = true;
  generateLineCalls = [];

  async listVoices() {
    return [{ languageCode: "en", displayName: "English" }];
  }

  async generateLine(request) {
    this.generateLineCalls.push(request);
    return { success: true, audioUrl: SILENT_WAV_DATA_URL, durationSeconds: 1 };
  }

  async cancelLine() {}
}

/**
 * Mirrors useVodSubtitleAndAudioTracks.ts's own composition exactly: a
 * host-owned `Hls` instance handed to `AttachedHlsAdapter` (not
 * `HlsJsAdapter`, which owns the `Hls` lifecycle itself), audio/subtitle/
 * voice-over controllers constructed directly from `@electron-media/core`,
 * and bound through the standalone `useAudioTrackController`/
 * `useSubtitleController`/`useVoiceOverController` hooks rather than the
 * all-in-one `useMediaPlayer` — the one construction pattern none of the
 * other e2e harnesses (`core.html`, `react-app.jsx`) exercises.
 */
function App() {
  const videoRef = useRef(null);
  const vodSourceRef = useRef(null);
  const gatewayRef = useRef(null);

  const [audioController, setAudioController] = useState(null);
  const [subtitleController, setSubtitleController] = useState(null);
  const [voiceOverController, setVoiceOverController] = useState(null);

  useEffect(() => {
    const adapter = new AttachedHlsAdapter();

    // Deliberately not registering an HlsNativeSubtitleSource here — this
    // harness only needs one subtitle track, and HlsNativeSubtitleSource
    // never emits onCuesChanged anyway (hls.js paints its own hidden
    // TextTrack directly instead), which is already covered end-to-end by
    // e2e/tests/react.spec.ts against react-app.jsx.
    const vodSource = new VodExtractedSubtitleSource({
      sourceId: VOD_SOURCE_ID,
      tracks: [
        {
          trackId: VOD_TRACK_ID,
          displayName: "VOD extracted",
          language: "en",
          kind: TrackKind.Manual,
          vttUrl: "/fixtures/cues.vtt",
        },
      ],
    });
    vodSourceRef.current = vodSource;

    const registry = new SubtitleRegistry({ sources: [vodSource] });
    const selection = new SubtitleSelectionService({ registry });
    const delay = new SubtitleDelayProcessor();
    const renderer = new TextTrackCueRenderer({ cueLine: () => 90 });
    const subtitles = new SubtitleController({ registry, selection, delay, renderer });

    const audio = new AudioTrackController({ adapter });

    const gateway = new FakeVoiceOverGateway();
    gatewayRef.current = gateway;
    const events = new TypedEventEmitter();
    const voiceOver = new VoiceOverController({ gateway, events });

    const hls = new Hls();
    adapter.attachHls(hls);
    hls.loadSource(sourceUrl);
    hls.attachMedia(videoRef.current);

    setAudioController(audio);
    setSubtitleController(subtitles);
    setVoiceOverController(voiceOver);

    return () => {
      subtitles.destroy();
      voiceOver.destroy();
      adapter.detachHls();
      hls.destroy();
    };
  }, []);

  useEffect(() => {
    if (!videoRef.current) return;
    subtitleController?.attach(videoRef.current);
    voiceOverController?.attach(videoRef.current);
  }, [subtitleController, voiceOverController]);

  const audioHook = useAudioTrackController(audioController);
  const subtitleHook = useSubtitleController(subtitleController);
  const voiceOverHook = useVoiceOverController(voiceOverController);

  useEffect(() => {
    window.__voiceOverGenerateLineCallCount = () =>
      gatewayRef.current?.generateLineCalls.length ?? 0;
    window.__bindVoiceOverToVodTrack = () =>
      voiceOverHook.actions.bindSubtitleSource(vodSourceRef.current, VOD_TRACK_ID);
  }, [voiceOverHook.actions]);

  return (
    <div>
      <video ref={videoRef} id="video" muted playsInline width={320} height={180} />

      <div id="selected-audio-track-id">
        {audioHook.state.selectedTrack ? String(audioHook.state.selectedTrack.trackId) : ""}
      </div>
      <ul id="audio-track-list">
        {audioHook.state.tracks.map((track) => (
          <li key={track.trackId}>
            <button
              data-track-id={track.trackId}
              data-language={track.language ?? ""}
              className={audioHook.state.selectedTrack?.trackId === track.trackId ? "selected" : ""}
              onClick={() => audioHook.actions.select(track.trackId)}
            >
              {track.language ?? track.displayName} ({track.trackId})
            </button>
          </li>
        ))}
      </ul>

      <div id="selected-subtitle-track-id">
        {subtitleHook.state.selectedTrack ? String(subtitleHook.state.selectedTrack.trackId) : ""}
      </div>
      <ul id="subtitle-track-list">
        {subtitleHook.state.tracks.map((track) => (
          <li key={track.trackId}>
            <button
              data-track-id={track.trackId}
              data-language={track.language ?? ""}
              className={subtitleHook.state.selectedTrack?.trackId === track.trackId ? "selected" : ""}
              onClick={() => subtitleHook.actions.selectTrack(track.trackId)}
            >
              {track.language ?? track.displayName} ({track.trackId})
            </button>
          </li>
        ))}
      </ul>
      <div id="subtitle-cue-text" />

      <div id="selected-voiceover-track-id">
        {voiceOverHook.state.selectedTrack ? String(voiceOverHook.state.selectedTrack.trackId) : ""}
      </div>
      <ul id="voiceover-track-list">
        {voiceOverHook.state.tracks.map((track) => (
          <li key={track.trackId}>
            <button
              data-track-id={track.trackId}
              className={voiceOverHook.state.selectedTrack?.trackId === track.trackId ? "selected" : ""}
              onClick={() => voiceOverHook.actions.selectTrack(track.trackId)}
            >
              {track.language} ({track.trackId})
            </button>
          </li>
        ))}
      </ul>
      <button id="voiceover-bind-vod-track-button" onClick={() => window.__bindVoiceOverToVodTrack()}>
        bind voice-over to VOD track
      </button>
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
root.render(<App />);

// HlsNativeSubtitleSource paints its own hidden TextTrack directly (never
// emits onCuesChanged — see its own class docs), so it's excluded here;
// this harness only ever needs to observe the VOD-extracted track's cues,
// which SubtitleController's own TextTrackCueRenderer adds as real VTTCues
// on the video, same as the app's real renderer does.
setInterval(() => {
  const video = document.getElementById("video");
  const target = document.getElementById("subtitle-cue-text");
  if (!video || !target) return;
  let activeCueText = "";
  for (const track of video.textTracks) {
    if (!track.activeCues || track.activeCues.length === 0) continue;
    for (const cue of track.activeCues) {
      if (cue.text) activeCueText = cue.text;
    }
  }
  target.textContent = activeCueText;
}, 100);
