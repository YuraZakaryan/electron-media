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

## Add a voice-over (TTS narration) provider

Implement `IVoiceOverGateway` (`packages/core/src/voice-over/voice-over-gateway.ts`):

```ts
class MyVoiceOverGateway implements IVoiceOverGateway {
  readonly isAvailable = true;
  listVoices(): Promise<readonly VoiceOverVoiceDescriptor[]> { /* ... */ }
  generateLine(request: VoiceOverLineRequest): Promise<VoiceOverLineResult> { /* ... */ }
  cancelLine(request): Promise<void> { /* best-effort */ }
}
```

Pass it via `MediaPlayerOptions.voiceOverGateway`; omit it to disable
voice-over entirely (`player.voiceOver` is `null`). `generateLine` must
never throw — report failure via `{ success: false, error }`. `cancelLine`
is best-effort only: `VoiceOverController` independently guards against a
stale in-flight result becoming playable, so a gateway that ignores
cancellation and finishes synthesizing anyway is still safe.

Unlike subtitles, there is intentionally no `IVoiceOverSource`/
`VoiceOverRegistry` extension point — `VoiceOverController` talks to exactly
one gateway. See `design-principles.md` for why a registry layer here would
be the same kind of speculative abstraction this library's own history
already removed once.

`generateLine` also accepts an optional second `AbortSignal` parameter,
aborted by `VoiceOverController` for the same reasons it would call
`cancelLine` (superseded, disabled, disposed). A gateway backed by `fetch`
or another abortable primitive may honor it; one that ignores it behaves
exactly as if it were never passed.

### Recipe: deciding which subtitle track to narrate

`VoiceOverController.bindSubtitleSource` takes an explicit
`(source, trackId)` pair — it deliberately has no auto-pick policy of its
own (unlike `AudioTrackController`, which does auto-restore from
`PlayerPreferenceStore`, because narration's "which subtitle track" question
is one layer removed from a simple language preference). A host app
choosing which subtitle track to narrate typically needs to:

```ts
function pickNarrationTrack(
  subtitleTracks: readonly SubtitleTrack[],
  visiblySelected: SubtitleTrack | null,
  isStillLoading: (track: SubtitleTrack) => boolean,
): SubtitleTrack | null {
  // Never narrate off an HlsNativeSubtitleSource-backed track: that source
  // never emits onCuesChanged (hls.js renders its own hidden TextTrack), so
  // VoiceOverController's bindSubtitleSource would just sit there with no
  // cues — and if it somehow did have cues, selecting it for narration must
  // never have the side effect of visibly turning subtitles on, which is
  // exactly the guarantee bindSubtitleSource itself provides.
  const isNarratable = (t: SubtitleTrack) => t.sourceId !== "hls-native";

  if (visiblySelected && isNarratable(visiblySelected)) return visiblySelected;

  // Prefer a track that's still loading (e.g. an in-flight OpenSubtitles
  // search) over concluding "nothing available" too early — the two are not
  // the same state, and treating them alike would flicker narration off
  // for a track that's about to become available a moment later.
  const candidates = subtitleTracks.filter(isNarratable);
  const stillLoading = candidates.some(isStillLoading);
  if (stillLoading) return null; // wait, don't fall back yet

  return candidates[0] ?? null;
}
```

This is application policy, not library code — deliberately, per the
`design-principles.md` decision to keep `VoiceOverController` itself
narrow.

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
`getVoiceOverLanguage`/`setVoiceOverLanguage` are optional — implement them
too to get the same auto-restore for narration language; omitting them is
equivalent to omitting the whole store, just for voice-over.

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
