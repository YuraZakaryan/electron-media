# @electron-media/react

React binding for [`@electron-media/core`](https://www.npmjs.com/package/@electron-media/core) — a single `useMediaPlayer` hook exposing multi-audio and subtitle (native/VOD-extracted/OpenSubtitles) track selection plus playback state. Internal core classes (`MediaPlayer`, `SubtitleController`, `AudioTrackController`, etc.) are never exposed through the hook — only plain data and callbacks.

## Install

```bash
npm install @electron-media/react @electron-media/core hls.js
```

## Usage

```tsx
import { useRef } from "react";
import { useMediaPlayer } from "@electron-media/react";
import { HlsJsAdapter } from "@electron-media/core";

function Player({ sourceUrl }: { sourceUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const {
    audioTracks,
    selectedAudioTrack,
    subtitleTracks,
    selectedSubtitle,
    selectAudioTrack,
    selectSubtitleTrack,
    setSubtitleDelay,
    isLoading,
    error,
  } = useMediaPlayer(videoRef, sourceUrl, {
    hlsAdapter: new HlsJsAdapter(),
  });

  return (
    <div>
      <video ref={videoRef} />
      {isLoading && <span>Loading…</span>}
      {error && <span>Error: {error.code}</span>}

      <select
        value={selectedAudioTrack?.trackId ?? ""}
        onChange={(e) => selectAudioTrack(Number(e.target.value) as never)}
      >
        {audioTracks.map((track) => (
          <option key={track.trackId} value={track.trackId}>
            {track.displayName}
          </option>
        ))}
      </select>

      <select
        value={selectedSubtitle?.trackId ?? ""}
        onChange={(e) =>
          selectSubtitleTrack(
            e.target.value ? (Number(e.target.value) as never) : null
          )
        }
      >
        <option value="">Off</option>
        {subtitleTracks.map((track) => (
          <option key={track.trackId} value={track.trackId}>
            {track.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}
```

## API

### `useMediaPlayer(videoRef, sourceUrl, options)`

One hook that gives you a working HLS player with audio/subtitle track selection. It creates the underlying `MediaPlayer` for you and keeps it in sync with React state.

**Parameters:**

| Parameter | Type | What it's for |
| --- | --- | --- |
| `videoRef` | `RefObject<HTMLVideoElement \| null>` | A ref pointing at your `<video>` element (`useRef<HTMLVideoElement>(null)`). The `<video>` tag must always be rendered — never hide it behind a loading check (see [Ownership](#ownership) for why). |
| `sourceUrl` | `string \| null` | The HLS stream URL to play. Pass `null` if you don't have a URL yet (e.g. still fetching it) — the hook will simply wait. Changing this to a new URL later automatically switches to the new stream. |
| `options` | `UseMediaPlayerOptions` | Setup options. `hlsAdapter` is required — normally `new HlsJsAdapter()` from `@electron-media/core`. Optionally add `preferenceStore` (remembers the user's audio language), `subtitleSources`, `subtitleRenderer`. These are only read once, when the component first mounts. |

**What it returns:**

| Field | Type | What it's for |
| --- | --- | --- |
| `audioTracks` | `readonly AudioTrack[]` | The list of audio languages/tracks available right now — use this to build a language picker. |
| `selectedAudioTrack` | `AudioTrack \| null` | Which audio track is currently playing, or `null` if none has been selected yet. |
| `subtitleTracks` | `readonly SubtitleTrack[]` | The list of subtitle tracks available right now — use this to build a subtitles picker. |
| `selectedSubtitle` | `SubtitleTrack \| null` | Which subtitle track is currently showing, or `null` if subtitles are off. |
| `selectAudioTrack(trackId)` | `(trackId: AudioTrackId) => void` | Call this when the user picks an audio track. Their choice is remembered for next time if you passed a `preferenceStore`. |
| `selectSubtitleTrack(trackId)` | `(trackId: SubtitleTrackId \| null) => void` | Call this when the user picks a subtitle track. Pass `null` to turn subtitles off. |
| `setSubtitleDelay(offsetSeconds)` | `(offsetSeconds: number) => void` | Shifts subtitle timing — useful for an "adjust subtitle sync" slider. Positive values delay subtitles (later), negative values make them appear sooner. |
| `isLoading` | `boolean` | `true` while the stream is loading. Turns `false` once playback is ready to start — use it to show a spinner. |
| `error` | `PlayerErrorEvent \| null` | Set when something goes wrong (e.g. the stream fails to load). Contains `{ code, fatal, cause }` — check this to show an error message to the user. |

## Ownership

`useMediaPlayer` creates one `MediaPlayer` per mount of the component that calls it and destroys it on unmount. It assumes `videoRef.current` is non-null by the time its effects run — render the `<video>` element unconditionally, not behind a data-dependent conditional.

## When you own the `Hls` lifecycle yourself

If your app creates/destroys its own `Hls` instance (custom retry policy, transcode/seek session teardown, etc.), don't use `useMediaPlayer` — compose the lower-level classes from `@electron-media/core` directly (`AudioTrackController`, `SubtitleController` + sources) against a non-owning adapter that wraps your existing instance. See `@electron-media/core`'s `docs/extension-points.md`.

## License

MIT
