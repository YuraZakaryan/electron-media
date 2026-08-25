# Public API Reference

All public exports are re-exported from `@electron-media/core`'s
`src/index.ts`. This document is a map, not a duplicate of the JSDoc on each
member — read the source for exact contracts; every public export there
carries `@public`/`@internal`/`@experimental`/`@deprecated` and full JSDoc.

## Entry point

```ts
import { MediaPlayer, HlsJsAdapter } from "@electron-media/core";

const player = new MediaPlayer({
  video: videoElement,
  hlsAdapter: new HlsJsAdapter(),
  preferenceStore: myPreferenceStore, // optional
  subtitleSources: [mySubtitleSource], // optional, more can be added later
});

player.loadSource("https://example.com/master.m3u8");

player.audio.getTracks();
player.audio.select(trackId);

player.subtitles.getTracks();
player.subtitles.selectTrack(trackId);
player.subtitles.setDelaySeconds(0.5);

player.events.on("error", (e) => console.error(e.code, e.fatal));
player.events.on("ready", (e) => console.log(e.durationSeconds));

// Optional — player.voiceOver is null unless voiceOverGateway is supplied.
player.voiceOver?.getTracks().then((tracks) => { /* ... */ });
player.voiceOver?.selectTrack(trackId);
player.voiceOver?.bindSubtitleSource(mySubtitleSource, subtitleTrackId);
player.voiceOver?.setDuckVolume(0.15); // "original sound" while ducked
player.voiceOver?.setVoiceOverVolume(1); // "voice-over sound" — independent of the above
player.events.on("voiceOverLineFailed", (e) => console.warn(e.trackId, e.error));
player.events.on("voiceOverLinePlayed", (e) => console.log(e.cueKey, e.clipped));
player.events.on("voiceOverLineSkipped", (e) => console.log(e.cueKey));
player.events.on("voiceOverPlaybackRejected", (e) => console.warn(e.trackId));
player.events.on("voiceOverVideoResumeRejected", (e) => console.warn(e.trackId));

player.destroy();
```

## React

```tsx
import { useMediaPlayer } from "@electron-media/react";
import { HlsJsAdapter } from "@electron-media/core";

function Player({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { audio, subtitles, voiceOver, isLoading, error } =
    useMediaPlayer(videoRef, src, { hlsAdapter: new HlsJsAdapter() });

  // audio/subtitles/voiceOver are each exactly the { state, actions } shape
  // returned by useAudioTrackController/useSubtitleController/
  // useVoiceOverController — e.g. subtitles.state.tracks,
  // subtitles.actions.selectTrack(trackId), voiceOver.actions.setDuckVolume(0.15).

  return <video ref={videoRef} />;
}
```

`useMediaPlayer` never returns a `MediaPlayer`, `SubtitleController`, or any
other core class — only plain data and callbacks. This is intentional: a
component cannot reach past the public surface even if it tries.

## Types

| Type | Purpose |
|---|---|
| `AudioTrackId`, `SubtitleTrackId`, `SubtitleSourceId`, `VoiceOverTrackId`, `VoiceOverSourceId` | Branded ids — a `SubtitleTrackId` cannot be passed where an `AudioTrackId` is expected without an explicit cast. `VoiceOverTrackId` is keyed by language code, not a positional index. |
| `TrackKind` | `Default \| Forced \| Commentary \| Dub \| Manual` |
| `AudioTrack`, `SubtitleTrack`, `VoiceOverTrack` | Normalized track shape, identical across all sources. |
| `CanonicalCue` | `{ startSeconds, endSeconds, text }` — delay-unapplied. |
| `VoiceOverLineRequest`, `VoiceOverLineResult` (incl. optional `clipped`), `VoiceOverVoiceDescriptor` | `IVoiceOverGateway`'s request/response shapes. |
| `PlayerErrorEvent`, `PlayerReadyEvent`, `VoiceOverLineFailedEvent`, `VoiceOverPlaybackRejectedEvent`, `VoiceOverVideoResumeRejectedEvent`, `VoiceOverLinePlayedEvent`, `VoiceOverLineSkippedEvent` | `MediaPlayer.events` payloads. `LineSkipped` is scheduling-only (non-dialogue, late-grace miss, seek-past) — a gateway failure is exclusively `LineFailed`, never both. `VideoResumeRejected` mirrors `PlaybackRejected` but for resuming the video after an Extended Audio Description pause. |
| `PlayerError`, `SubtitleError`, `VoiceOverError` | Typed exception hierarchy — `catch (e) { if (e instanceof SubtitleError) ... }`. |
| `FadeCurve`, `linearFadeCurve` (default), `easeInOutQuadCurve` | Shapes `VoiceOverDuckingPlayerOptions.fadeCurve`'s interpolation. |

## Contracts a host application implements

| Interface | Implemented by (in the reference app) |
|---|---|
| `PlayerPreferenceStore` | A wrapper over `localStorage`/`electron-store` — audio-language required; `getVoiceOverLanguage`/`setVoiceOverLanguage` optional, for narration-language restore. |
| `ISubtitleGateway` | A wrapper over `opensubtitles-client.js`. |
| `IVoiceOverGateway` | A wrapper over an Electron-IPC-backed on-device TTS engine — the library never synthesizes speech itself. `generateLine`'s second `signal?: AbortSignal` parameter is optional to honor. |
| `IHlsAdapter` | `HlsJsAdapter` (owns the `Hls` instance end-to-end) and `AttachedHlsAdapter` (wraps a host-owned instance — a host that manages its own `Hls` retry/seek/transcode session), both shipped. Override only for tests or a different HLS engine. |
| `ISubtitleRenderer` | `TextTrackCueRenderer`, shipped — override for e.g. a future ASS/SSA renderer. |

## Extended Audio Description (WCAG 1.2.7)

Opt in via `voiceOverOptions.allowVideoPause` (or live, `VoiceOverController
.setAllowVideoPause`/the hook's `voiceOver.actions.setAllowVideoPause`) — off by
default. When on, a line whose synthesized duration exceeds its cue's own
window pauses the video entirely for the line's duration instead of merely
ducking it, then resumes it once the line ends. `voiceOverLinePlayed`'s
`isExtended` flag reports which lines needed this, whether or not
`allowVideoPause` is actually on, so a host can gauge how often extended
descriptions would trigger before opting in.

## Voice-over live tuning

`VoiceOverController.setDuckVolume`/`setVoiceOverVolume`/
`setLookaheadSeconds`/`setLateStartGraceSeconds` (and the React hook's
`voiceOver.actions.setDuckVolume`/`setVoiceOverVolume`/`setLookaheadSeconds`)
update tuning live, without recreating the player. `setDuckVolume` and
`setVoiceOverVolume` are independent of each other — a settings popover can
expose them as two separate sliders, "original sound" (default 15%, how
loud the video itself plays while a line is narrating) and "voice-over
sound" (default 100%, the narration line's own volume); neither derives
from or scales the other. `maxConcurrentSynthesis` (constructor-only,
default 4) caps how many `generateLine` calls run at once.

Both sliders are, by default, live-multiplied by `setMainVolume` (the
host's own top-level player volume, `0`–`1`) — the standard "master
volume" pattern: at main volume 50%, either slider at 100% still only
plays at 50%. Opt out via `setIgnoreMainVolume` (default off) for
narration that should ignore the host's main volume entirely. Defaults to
`mainVolume: 1`, so a host that never calls `setMainVolume` sees no
behavior change.
