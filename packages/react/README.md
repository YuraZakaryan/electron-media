# @electron-media/react

React binding for [`@electron-media/core`](https://www.npmjs.com/package/@electron-media/core) — `useMediaPlayer`, one hook exposing multi-audio track selection, subtitle (native/VOD-extracted/OpenSubtitles) track selection, voice-over (TTS narration) and playback state. Internal core classes (`MediaPlayer`, `SubtitleController`, `AudioTrackController`, `VoiceOverController`, etc.) are never exposed through the hook — only plain data and callbacks. Three standalone hooks (`useAudioTrackController`, `useSubtitleController`, `useVoiceOverController`) are also exported, for hosts that build the underlying classes themselves — see [When you own the `Hls` lifecycle yourself](#when-you-own-the-hls-lifecycle-yourself).

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
  const { audio, subtitles, isLoading, error } = useMediaPlayer(videoRef, sourceUrl, {
    hlsAdapter: new HlsJsAdapter(),
  });

  return (
    <div>
      <video ref={videoRef} />
      {isLoading && <span>Loading…</span>}
      {error && <span>Error: {error.code}</span>}

      <select
        value={audio.state.selectedTrack?.trackId ?? ""}
        onChange={(e) => audio.actions.select(Number(e.target.value) as never)}
      >
        {audio.state.tracks.map((track) => (
          <option key={track.trackId} value={track.trackId}>
            {track.displayName}
          </option>
        ))}
      </select>

      <select
        value={subtitles.state.selectedTrack?.trackId ?? ""}
        onChange={(e) =>
          subtitles.actions.selectTrack(
            e.target.value ? (Number(e.target.value) as never) : null
          )
        }
      >
        <option value="">Off</option>
        {subtitles.state.tracks.map((track) => (
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

One hook that gives you a working HLS player with audio/subtitle track selection and voice-over. It creates the underlying `MediaPlayer` for you and keeps it in sync with React state.

**Parameters:**

| Parameter | Type | What it's for |
| --- | --- | --- |
| `videoRef` | `RefObject<HTMLVideoElement \| null>` | A ref pointing at your `<video>` element (`useRef<HTMLVideoElement>(null)`). The `<video>` tag must always be rendered — never hide it behind a loading check (see [Ownership](#ownership) for why). |
| `sourceUrl` | `string \| null` | The HLS stream URL to play. Pass `null` if you don't have a URL yet (e.g. still fetching it) — the hook will simply wait. Changing this to a new URL later automatically switches to the new stream. |
| `options` | `UseMediaPlayerOptions` | Setup options. `hlsAdapter` is required — normally `new HlsJsAdapter()` from `@electron-media/core`. Optionally add `preferenceStore` (remembers the user's audio/voice-over language), `subtitleSources`, `subtitleRenderer`, `voiceOverGateway` (enables voice-over; omit to disable it entirely), `voiceOverOptions`. These are only read once, when the component first mounts. |

**What it returns:**

| Field | Type | What it's for |
| --- | --- | --- |
| `audio` | `{ state, actions }` | Exactly `useAudioTrackController`'s own return value — `state.tracks`, `state.selectedTrack`, `actions.select(trackId)`. |
| `subtitles` | `{ state, actions }` | Exactly `useSubtitleController`'s own return value — `state.tracks`, `state.selectedTrack`, `actions.selectTrack(trackId \| null)`, `actions.setDelaySeconds(offsetSeconds)`. |
| `voiceOver` | `{ state, actions }` | Exactly `useVoiceOverController`'s own return value. `state.tracks` is empty and every action is a harmless no-op when the player was constructed without a `voiceOverGateway`. |
| `isLoading` | `boolean` | `true` while the stream is loading. Turns `false` once playback is ready to start — use it to show a spinner. |
| `error` | `PlayerErrorEvent \| null` | Set when something goes wrong (e.g. the stream fails to load). Contains `{ code, fatal, cause }` — check this to show an error message to the user. |

## Ownership

`useMediaPlayer` creates one `MediaPlayer` per mount of the component that calls it and destroys it on unmount. It assumes `videoRef.current` is non-null by the time its effects run — render the `<video>` element unconditionally, not behind a data-dependent conditional.

## When you own the `Hls` lifecycle yourself

If your app creates/destroys its own `Hls` instance (custom retry policy, transcode/seek session teardown, etc.), don't use `useMediaPlayer` — compose the lower-level classes from `@electron-media/core` directly (`AudioTrackController`, `SubtitleController`, `VoiceOverController` + sources, against `AttachedHlsAdapter` rather than `HlsJsAdapter`) and bind each one through this package's standalone `useAudioTrackController`/`useSubtitleController`/`useVoiceOverController` hooks — each returns the identical `{ state, actions }` shape `useMediaPlayer`'s own `audio`/`subtitles`/`voiceOver` fields do. See `@electron-media/core`'s `docs/extension-points.md`.

## License

MIT
