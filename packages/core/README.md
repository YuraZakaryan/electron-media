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

## API

### `MediaPlayer`

The main entry point. Create one instance per `<video>` element — it wires up playback, audio tracks, and subtitles for you.

| Member | Description |
| --- | --- |
| `constructor(options)` | Creates the player and immediately starts it. Requires `video` (your `<video>` element) and `hlsAdapter` (the HLS engine to use — normally `new HlsJsAdapter()`). Optional: `preferenceStore` (remembers the user's language across sessions), `subtitleSources` (which subtitle providers to use), `subtitleRenderer` (how subtitles get drawn on screen). |
| `.audio` | Gives you an `AudioTrackController` for listing/selecting audio tracks. |
| `.subtitles` | Gives you a `SubtitleController` for listing/selecting/rendering subtitles. |
| `.events` | Where you listen for player-level events: `"error"` (something failed) and `"ready"` (duration is known, playback can start). |
| `loadSource(url)` | Starts playing an HLS stream at `url`. Call again with a new URL to switch streams — it automatically tears down the old stream first. |
| `destroy()` | Shuts everything down and frees resources. Call this once when you're done with the player (e.g. when your component unmounts). Safe to call more than once. |

### `AudioTrackController` (available as `player.audio`)

Lets the user pick which audio language/track plays.

| Member | Description |
| --- | --- |
| `getTracks()` | Returns the list of audio tracks currently available (e.g. English, Spanish). This is a one-time snapshot — use `onTracksChanged` below to stay up to date. |
| `select(trackId)` | Switches playback to the given track and remembers the choice for next time (if you gave the player a `preferenceStore`). |
| `.selectedTrackId` | The id of the track currently playing, or `null` if none has been chosen yet. |
| `onSelectionChanged(callback)` | Runs `callback` every time the selected track changes — whether the user picked it or the player auto-restored a saved language. Call the returned function to stop listening. |
| `onTracksChanged(callback)` | Runs `callback` whenever the list of available tracks changes (e.g. the stream just reported its tracks). Call the returned function to stop listening. |

Behavior to know: the very first time tracks become available, the player automatically picks the user's previously saved language (or the stream's default track, if there's no saved preference). Once you call `select()` yourself, this auto-pick behavior stops — your choice always wins from then on.

### `SubtitleController` (available as `player.subtitles`)

Lets the user pick which subtitles show, adjust their timing, and handles actually drawing them on screen.

| Member | Description |
| --- | --- |
| `attach(video)` | Tells the controller which `<video>` element to draw subtitles onto. You normally don't need to call this yourself — `MediaPlayer` does it for you. Safe to call again if you swap in a different video element. |
| `detach()` | Stops drawing subtitles and disconnects from the current video element. |
| `getTracks()` | Returns every subtitle track available, combined from all configured sources (native, VOD-extracted, remote, etc.). |
| `selectTrack(trackId)` | Turns on the given subtitle track, or pass `null` to turn subtitles off. |
| `.selectedTrack` | The subtitle track currently showing, or `null` if subtitles are off. |
| `onSelectionChanged(callback)` | Runs `callback` whenever the selected subtitle track changes. Call the returned function to stop listening. |
| `setDelaySeconds(offsetSeconds)` | Nudges subtitle timing — positive numbers delay subtitles (make them appear later), negative numbers make them appear earlier. Useful for a "sync subtitles" slider in your UI. |
| `onTracksChanged(callback)` | Runs `callback` whenever the combined subtitle track list changes. Call the returned function to stop listening. |
| `destroy()` | Shuts down subtitle handling and clears anything currently on screen. Call this once when you're done. Safe to call more than once. |

Good to know: some HLS engines (like hls.js) occasionally clear the video's subtitle tracks as a side effect of their own internal work. This controller detects that and automatically redraws the subtitles — you don't need to do anything about it.

### `HlsJsAdapter`

The ready-to-use way to play HLS streams — pass `new HlsJsAdapter()` to `MediaPlayer` and it handles the rest (using the [hls.js](https://github.com/video-dev/hls.js) library under the hood). Only reach for something else if you're plugging in a different HLS engine, or you already manage your own `Hls` instance elsewhere in your app (see `AttachedHlsAdapter` below).

| Member | Description |
| --- | --- |
| `constructor(options?)` | Configures retry behavior for network hiccups: `maxRetries` (how many times to retry before giving up — default `3`), `retryDelayMs` (how long to wait before retrying — default `0`, i.e. immediately), `shouldRetry(detail, errorType)` (your own function to decide whether a specific error is worth retrying at all), `reloadOnDetail` (specific error types that need a full reload instead of a lighter retry). Most apps can skip all of these and use the defaults. |
| `attach(video)` | Connects the adapter to a `<video>` element. Handled automatically by `MediaPlayer`. |
| `loadSource(url)` | Starts loading and playing the HLS stream at `url`. |
| `getAudioTracks()` / `getSubtitleTracks()` | Returns the current list of audio/subtitle tracks reported by the stream. These are what power `AudioTrackController`/`SubtitleController` above. |
| `setAudioTrack(trackId)` / `setSubtitleTrack(trackId or null)` | Switches which track is active. |
| `on(eventName, callback)` | Low-level event subscription (used internally by `MediaPlayer`) — you shouldn't normally need this directly. |
| `detach()` / `destroy()` | Disconnects from the video / fully shuts down and frees resources. |

### Other exports

These are the building blocks `MediaPlayer` assembles for you. You'll only reach for them directly if you're customizing behavior beyond what `MediaPlayer` offers out of the box.

| Export | What it's for |
| --- | --- |
| `AttachedHlsAdapter` | Use this instead of `HlsJsAdapter` if your app already creates and destroys its own `Hls` instance (for example, because you need custom retry logic or manage seeking yourself). Call `attachHls(hls)` whenever your app creates a new `Hls` instance, and `detachHls()` when you tear it down — this adapter only reports on tracks and forwards selections, it never creates or destroys the `Hls` instance itself. |
| `TextTrackCueRenderer` | The default way subtitles get drawn on screen. You won't usually touch this directly — `MediaPlayer` uses it automatically. It exists as a separate, swappable piece so you could replace it with something else (e.g. a custom overlay) if needed. |
| `HlsNativeSubtitleSource` | Supplies subtitles that are already embedded directly in the HLS stream itself (no extra setup needed — hls.js draws these on its own). |
| `VodExtractedSubtitleSource` | Supplies subtitles from a `.vtt` file your own backend generates during video processing (e.g. via ffmpeg) — even while that file is still being written to. It checks the file periodically and picks up new lines as they appear. |
| `OpenSubtitlesSource` | Supplies subtitles downloaded from an online subtitle provider like OpenSubtitles. Call `search(...)` to look up subtitles for a piece of content (by title, TMDB id, etc.); the user's pick is then downloaded in full when selected. |
| `PlayerError`, `SubtitleError` | The error types this library throws. Catch `PlayerError` to handle any failure from this library, or catch `SubtitleError` specifically to handle subtitle-related failures only. |

For exact technical details on any of these, the source files themselves carry full documentation — see also [`docs/public-api.md`](../../docs/public-api.md).

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
