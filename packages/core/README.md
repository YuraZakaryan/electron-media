# @electron-media/core

Framework-agnostic multi-audio-track selection, and native/VOD-extracted/remote subtitle composition for HLS playback in Electron media apps, built on [hls.js](https://github.com/video-dev/hls.js).

Not a full player — it composes track selection and subtitle rendering behind a small facade (`MediaPlayer`) and a set of narrow, independently testable classes. HLS lifecycle, transcoding, and DRM stay outside its scope; bring your own via the adapter/gateway interfaces below.

## Install

```bash
npm install @electron-media/core hls.js
```

`hls.js` is a peer dependency — install it yourself so there's exactly one copy in your dependency tree (avoids the "two different `Hls` types" class of TypeScript error you get from duplicate installs).

## What it does

- **Multi-audio**: `AudioTrackController` — lists tracks, selects one, restores the last-used language via an app-supplied `PlayerPreferenceStore`.
- **Native subtitles**: `HlsNativeSubtitleSource` — subtitle tracks embedded in the HLS manifest.
- **VOD-extracted subtitles**: `VodExtractedSubtitleSource` — polls a growing `.vtt` file (e.g. one your backend extracts via ffmpeg during transcode).
- **Remote subtitles**: `OpenSubtitlesSource` — search/download/parse SRT from OpenSubtitles or any compatible provider, via an app-supplied `ISubtitleGateway`.
- **Composition**: `SubtitleRegistry` (merges track lists across sources) + `SubtitleSelectionService` (active track) + `SubtitleDelayProcessor` (user timing nudge) + `TextTrackCueRenderer` (renders via `HTMLVideoElement.addTextTrack`/`addCue`, working around the Chromium/WebKit "flip to showing before cues exist" bug) — wired together by `SubtitleController`, which also self-heals if a host-owned media engine (e.g. hls.js's own `TimelineController`) wipes the video's text tracks out from under it.

## Quick start

```ts
import { MediaPlayer, HlsJsAdapter } from "@electron-media/core";

const video = document.querySelector("video")!;
const player = new MediaPlayer({
  video,
  hlsAdapter: new HlsJsAdapter(),
});

player.loadSource("https://example.com/master.m3u8");

player.audio.onTracksChanged((tracks) => console.log(tracks));
player.audio.select(tracks[0].trackId);

player.subtitles.onTracksChanged((tracks) => console.log(tracks));
player.subtitles.selectTrack(tracks[0].trackId);

// later
player.destroy();
```

## Extension points

- `IHlsAdapter` — swap in your own HLS engine, or an `Hls` instance your app already owns and manages (see `docs/extension-points.md`).
- `ISubtitleSource` — add a new subtitle provider beyond native/VOD-extracted/OpenSubtitles.
- `ISubtitleRenderer` — replace the default `TextTrackCueRenderer` (e.g. a canvas overlay for ASS/SSA positioning).
- `PlayerPreferenceStore` / `ISubtitleGateway` — adapt to your app's own storage and OpenSubtitles-compatible backend.

## Docs

See `docs/` in the repository: `architecture.md`, `public-api.md`, `lifecycle.md`, `extension-points.md`, `naming-conventions.md`, `design-principles.md`.

## Scope

Deliberately does **not** include: ffmpeg/transcoding, DRM, ASS/SSA rendering, or ownership of an `Hls` instance whose lifecycle your app manages itself (retry policy, stall diagnostics, seek sessions) — see `design-principles.md`'s "Post-launch scope correction" for why those were cut rather than kept as speculative extension points.

## License

MIT
