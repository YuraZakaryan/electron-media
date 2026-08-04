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

## Ownership

`useMediaPlayer` creates one `MediaPlayer` per mount of the component that calls it and destroys it on unmount. It assumes `videoRef.current` is non-null by the time its effects run — render the `<video>` element unconditionally, not behind a data-dependent conditional.

## When you own the `Hls` lifecycle yourself

If your app creates/destroys its own `Hls` instance (custom retry policy, transcode/seek session teardown, etc.), don't use `useMediaPlayer` — compose the lower-level classes from `@electron-media/core` directly (`AudioTrackController`, `SubtitleController` + sources) against a non-owning adapter that wraps your existing instance. See `@electron-media/core`'s `docs/extension-points.md`.

## License

MIT
