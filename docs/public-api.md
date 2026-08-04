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

player.destroy();
```

## React

```tsx
import { useMediaPlayer } from "@electron-media/react";
import { HlsJsAdapter } from "@electron-media/core";

function Player({ src }: { src: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const { audioTracks, subtitleTracks, selectedSubtitle, selectAudioTrack,
          selectSubtitleTrack, setSubtitleDelay, isLoading, error } =
    useMediaPlayer(videoRef, src, { hlsAdapter: new HlsJsAdapter() });

  return <video ref={videoRef} />;
}
```

`useMediaPlayer` never returns a `MediaPlayer`, `SubtitleController`, or any
other core class — only plain data and callbacks. This is intentional: a
component cannot reach past the public surface even if it tries.

## Types

| Type | Purpose |
|---|---|
| `AudioTrackId`, `SubtitleTrackId`, `SubtitleSourceId` | Branded ids — a `SubtitleTrackId` cannot be passed where an `AudioTrackId` is expected without an explicit cast. |
| `TrackKind` | `Default \| Forced \| Commentary \| Dub \| Manual` |
| `AudioTrack`, `SubtitleTrack` | Normalized track shape, identical across all sources. |
| `CanonicalCue` | `{ startSeconds, endSeconds, text }` — delay-unapplied. |
| `PlayerErrorEvent`, `PlayerReadyEvent` | `MediaPlayer.events` payloads (`error`, `ready`). |
| `PlayerError`, `SubtitleError` | Typed exception hierarchy — `catch (e) { if (e instanceof SubtitleError) ... }`. |

## Contracts a host application implements

| Interface | Implemented by (in the reference app) |
|---|---|
| `PlayerPreferenceStore` | A wrapper over `localStorage`/`electron-store` — audio-language restore only. |
| `ISubtitleGateway` | A wrapper over `opensubtitles-client.js`. |
| `IHlsAdapter` | `HlsJsAdapter`, shipped — only override for tests or a different HLS engine. |
| `ISubtitleRenderer` | `TextTrackCueRenderer`, shipped — override for e.g. a future ASS/SSA renderer. |
