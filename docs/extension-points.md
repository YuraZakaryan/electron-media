# Extension Points

## Add a new subtitle source

Implement `ISubtitleSource` (`packages/core/src/subtitles/subtitle-source.ts`):

```ts
class MySubtitleSource implements ISubtitleSource {
  readonly sourceId: SubtitleSourceId;
  getTracks(): readonly SubtitleTrack[] { /* ... */ }
  selectTrack(trackId: SubtitleTrackId | null): void { /* ... */ }
  activateForReading?(trackId: SubtitleTrackId): () => void { /* optional — see below */ }
  onTracksChanged(cb): () => void { /* ... */ }
  onCuesChanged(trackId, cb): () => void { /* ... */ }
  dispose(): void { /* ... */ }
}
```

`selectTrack` is the single exclusive "visibly selected" slot — only one
track per source may be active this way at a time. `activateForReading` is
its non-exclusive counterpart: implement it if your source can independently
serve more than one track's cues concurrently (most fetch/poll-based sources
can), so `VoiceOverController` can narrate a *different* track than whatever
is visibly selected on the same source without disturbing it (see
`VoiceOverController` in `lifecycle.md`). Omit it only when your source
genuinely cannot — see `HlsNativeSubtitleSource` below — `VoiceOverController`
falls back to `selectTrack` in that case, same as before this method existed.

Register it via `MediaPlayerOptions.subtitleSources`, or later at runtime via
the `SubtitleRegistry` (construct your own `SubtitleController` wiring rather
than the `MediaPlayer` facade if you need post-construction registration —
`MediaPlayer` does not currently expose the registry directly, by design,
to keep its own surface narrow).

Existing sources to use as reference:
- `HlsNativeSubtitleSource` — delegates entirely to `IHlsAdapter`; forwards
  whatever cue text the adapter reads back off hls.js's own native
  `TextTrack` (see `AttachedHlsAdapter`'s `subtitleCuesChanged` event) —
  cue text itself is not the limitation. The real constraint is
  `selectTrack`: it maps straight to the adapter's single
  `hls.subtitleTrack`, the one slot hls.js uses to decide which rendition
  is visibly showing, shared with whatever else (e.g. `SubtitleController`)
  also calls it on the same adapter instance. Activating a different
  rendition here — for narration only — visibly changes what's on screen.
  This is why it does **not** implement `activateForReading`: there is no
  way to independently serve a second rendition's cues without also
  demuxing/showing it.
- `VodExtractedSubtitleSource` — polls a growing `.vtt` file per track;
  `activateForReading` polls independently of `selectTrack` (own timer per
  trackId), so a narrated track and the visibly-selected one never fight
  over the same poll slot even when they differ.
- `OpenSubtitlesSource` — one-shot search + download via `ISubtitleGateway`,
  cached per track; `activateForReading` and `selectTrack` both just trigger
  that same per-track cache, so no independent state was needed here.

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

The `hls-native` special-casing below is the *only* case a host needs to
guard against — every other source implements `activateForReading`, so
narrating any of their tracks independently of what's visibly selected is
safe by construction; no per-source reasoning needed beyond this one check.

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
  // An HlsNativeSubtitleSource-backed track's cue text forwards fine, but
  // its selectTrack() is the same call that makes hls.js visibly activate
  // that rendition on screen (see this source's own doc comment) — there
  // is no way to read its cues without also showing it. Narrating a
  // different hls-native track than the one currently visible would
  // silently hijack the visible subtitle too, breaking the guarantee
  // bindSubtitleSource otherwise provides for every other source type. The
  // safe policy is to only ever narrate an hls-native track when it's
  // already the one visibly selected — never let an auto-pick activate one
  // on its own.
  const isNarratable = (t: SubtitleTrack) =>
    t.sourceId !== "hls-native" || t.trackId === visiblySelected?.trackId;

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

### Recipe: silencing narration on host-side cleanup without erasing the user's choice

`selectTrack(null)` and `stop()` both immediately silence any currently
playing line, but they mean different things — using the wrong one for
cleanup is an easy trap:

- `selectTrack(null)` is the user's own explicit "off" — it persists via
  `PlayerPreferenceStore.setVoiceOverLanguage(null)`, exactly as durably as
  picking a language does.
- `stop()` is a non-destructive hard-stop for a host that's tearing
  something down (closing the current title, detaching the player) while
  a line happens to be mid-narration. It doesn't touch the selected track
  or persisted preference at all.

Calling `selectTrack(null)` from a "close the title" handler looks
harmless — narration does go silent — but it also erases the user's
language choice, so the *next* title opens with voice-over off even
though the user never asked for that:

```ts
function onCloseTitle() {
  // Wrong: also persists "off", so the next title silently loses the
  // user's chosen narration language.
  player.voiceOver?.selectTrack(null);

  // Right: silences narration now; the same language auto-restores
  // the next time a bindSubtitleSource-backed track is available.
  player.voiceOver?.stop();
}
```

The distinction matters specifically because the underlying `<video>`
element commonly persists across titles (only its `src` changes) — a
title closed mid-line without *some* hard-stop leaves the video's volume
stuck at the ducked level, which the next title's own volume-capture would
then misread as "normal."

## Substitute a different HLS engine (or a test double)

Implement `IHlsAdapter` (`packages/core/src/hls/hls-adapter.ts`).
Two implementations ship: `HlsJsAdapter` (owns the `Hls` instance
end-to-end) and `AttachedHlsAdapter` (wraps an `Hls` instance the *host*
creates/destroys — see the transcoding/seek section below, which is exactly
what it's for). A unit test for `AudioTrackController` or `HlsController`
should use a hand-written mock adapter instead of a real `hls.js` instance.

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
`HlsJsAdapter` at all — use `AttachedHlsAdapter` (`packages/core/src/hls/attached-hls-adapter.ts`),
which wraps the `Hls` instance *you* create and destroy, and construct
`AudioTrackController`/`SubtitleController` against it directly (rather
than via `MediaPlayer`, which owns its `Hls` instance end-to-end). Call
`attachedAdapter.attachHls(hls)` whenever your app (re)creates its own `Hls`
instance and `detachHls()` whenever it tears one down — both are safe to
call redundantly and across many attach/detach cycles, e.g. a VOD seek that
destroys and recreates the stream mid-session. A reference implementation
of exactly this pattern keeps full ownership of `Hls` creation, retry
policy, and transcode-session teardown in the app, and only hands
`@electron-media/core` the thin adapter over it.
