# Extension Points

## Add a new subtitle source

Implement `ISubtitleSource` (`packages/core/src/subtitles/subtitle-source.ts`):

```ts
class MySubtitleSource implements ISubtitleSource {
  readonly sourceId: SubtitleSourceId;
  getTracks(): readonly SubtitleTrack[] { /* ... */ }
  selectTrack(trackId: SubtitleTrackId | null): void { /* ... */ }
  onTracksChanged(cb): () => void { /* ... */ }
  onCuesChanged(trackId, cb): () => void { /* ... */ }
  dispose(): void { /* ... */ }
}
```

Register it via `MediaPlayerOptions.subtitleSources`, or later at runtime via
the `SubtitleRegistry` (construct your own `SubtitleController` wiring rather
than the `MediaPlayer` facade if you need post-construction registration —
`MediaPlayer` does not currently expose the registry directly, by design,
to keep its own surface narrow).

Existing sources to use as reference:
- `HlsNativeSubtitleSource` — delegates entirely to `IHlsAdapter`; never emits
  cues (hls.js renders its own tracks).
- `VodExtractedSubtitleSource` — polls a growing `.vtt` file.
- `OpenSubtitlesSource` — one-shot search + download via `ISubtitleGateway`.

## Add a new subtitle renderer (e.g. ASS/SSA)

Implement `ISubtitleRenderer` (`packages/core/src/subtitles/subtitle-renderer.ts`)
and pass it as `MediaPlayerOptions.subtitleRenderer`. `TextTrackCueRenderer`
is the shipped default; a future `AssCueRenderer` would additionally apply
positioning/RTL/vertical-text rules, likely by wrapping or subclassing
`CueProjector`'s output rather than changing `SubtitleController`,
`SubtitleRegistry`, or any `ISubtitleSource`.

## Substitute a different HLS engine (or a test double)

Implement `IHlsAdapter` (`packages/core/src/hls/hls-adapter.ts`).
`HlsJsAdapter` is the only shipped implementation; a unit test for
`AudioTrackController` or `HlsController` should use a hand-written mock
adapter instead of a real `hls.js` instance.

## Persist preferences somewhere other than the default

Implement `PlayerPreferenceStore` (`packages/core/src/contracts/preference-store.ts`)
over whatever storage the host application already uses (`localStorage`,
`electron-store`, a remote profile API). Passing no `preferenceStore` simply
disables auto-restore of the user's last-picked audio/subtitle language.

## ffmpeg-backed transcoding and seek

Out of scope by design — the library never spawns, manages, or has a typed
contract for ffmpeg/transcode/seek orchestration. An earlier draft
(`ILiveTranscodeGateway`/`IVodTranscodeGateway`) was removed because no
consumer actually implemented it: that orchestration is tightly coupled to
each app's own session state machine (when to restart vs. seek-in-place,
when to tear down and recreate the underlying `Hls` instance), which is
policy the library has no useful generic shape for.

If your app's HLS lifecycle is itself owned by a transcode/seek session
(rather than a plain HLS URL), don't route it through `HlsController`/
`HlsJsAdapter` at all — write a thin `IHlsAdapter` that wraps the `Hls`
instance *you* create and destroy, and use `AudioTrackController`/
`SubtitleController` against it. See `media-player-core`'s own reference
integration for exactly this pattern: the consuming app's VOD player keeps
full ownership of `Hls` creation, retry policy, and transcode-session
teardown, and only hands the library a thin adapter over it.
