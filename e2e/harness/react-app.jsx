import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useMediaPlayer } from "@electron-media/react";
import { HlsJsAdapter, HlsNativeSubtitleSource, asSubtitleSourceId } from "@electron-media/core";

const params = new URLSearchParams(window.location.search);
const initialSourceUrl = params.get("src");

function App({ onSetSourceUrl }) {
  const videoRef = useRef(null);
  const [sourceUrl, setSourceUrl] = useState(initialSourceUrl);
  onSetSourceUrl(setSourceUrl);
  const adapterRef = useRef(null);
  // See core.html's harness for why reloadOnDetail is needed here: without
  // it, a manifest that 404s never actually retries (startLoad() no-ops on
  // a manifest with zero levels) and the player hangs forever instead of
  // reaching maxRetries and surfacing a fatal error.
  if (!adapterRef.current) {
    adapterRef.current = new HlsJsAdapter({
      reloadOnDetail: ["manifestLoadError", "manifestParsingError"],
    });
  }

  const subtitleSourcesRef = useRef(null);
  if (!subtitleSourcesRef.current) {
    subtitleSourcesRef.current = [
      new HlsNativeSubtitleSource({
        sourceId: asSubtitleSourceId("hls-native"),
        adapter: adapterRef.current,
      }),
    ];
  }

  const {
    audioTracks,
    selectedAudioTrack,
    subtitleTracks,
    selectedSubtitle,
    selectAudioTrack,
    selectSubtitleTrack,
    isLoading,
    error,
  } = useMediaPlayer(videoRef, sourceUrl, {
    hlsAdapter: adapterRef.current,
    subtitleSources: subtitleSourcesRef.current,
  });

  return (
    <div>
      <video ref={videoRef} id="video" muted playsInline width={320} height={180} />
      <div id="loading-state">{String(isLoading)}</div>
      <div id="error-message">{error ? `${error.code}|fatal:${error.fatal}` : ""}</div>
      <div id="selected-audio-track-id">
        {selectedAudioTrack ? String(selectedAudioTrack.trackId) : ""}
      </div>
      <ul id="audio-track-list">
        {audioTracks.map((track) => (
          <li key={track.trackId}>
            <button
              data-track-id={track.trackId}
              data-language={track.language ?? ""}
              className={selectedAudioTrack?.trackId === track.trackId ? "selected" : ""}
              onClick={() => selectAudioTrack(track.trackId)}
            >
              {track.language ?? track.displayName} ({track.trackId})
            </button>
          </li>
        ))}
      </ul>
      <div id="selected-subtitle-track-id">
        {selectedSubtitle ? String(selectedSubtitle.trackId) : ""}
      </div>
      <ul id="subtitle-track-list">
        {subtitleTracks.map((track) => (
          <li key={track.trackId}>
            <button
              data-track-id={track.trackId}
              data-language={track.language ?? ""}
              className={selectedSubtitle?.trackId === track.trackId ? "selected" : ""}
              onClick={() => selectSubtitleTrack(track.trackId)}
            >
              {track.language ?? track.displayName} ({track.trackId})
            </button>
          </li>
        ))}
      </ul>
      <button id="subtitle-off-button" onClick={() => selectSubtitleTrack(null)}>
        subtitles off
      </button>
      <div id="subtitle-cue-text" />
    </div>
  );
}

const root = createRoot(document.getElementById("root"));
let setSourceUrlRef = null;
root.render(<App onSetSourceUrl={(setter) => (setSourceUrlRef = setter)} />);

window.__setSourceUrl = (url) => setSourceUrlRef?.(url);
window.__unmount = () => {
  root.unmount();
  document.getElementById("mounted-state").textContent = "false";
};

// HlsNativeSubtitleSource never emits cues through the library's own
// selection/rendering pipeline — hls.js paints them onto its own hidden
// TextTrack directly (see core's HlsNativeSubtitleSource docs). Polling
// video.textTracks here is the only way the DOM ever reflects the actual
// rendered cue text, independent of whatever useMediaPlayer's own state
// reports.
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
