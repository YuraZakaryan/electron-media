# @electron-media/core

## 0.2.2

### Patch Changes

- cb51e15: `AudioTrackController` now re-applies the stored language preference when the adapter reports a fresh track list after having reported an empty one. A stream teardown that rebuilds the underlying engine (e.g. a seek that recreates the `Hls` instance) left the "user already selected" latch set, so the handler bailed out on the new track list and the replacement instance — which carries no selection of its own — fell back to the manifest default. The controller kept reporting the user's original pick, so the UI showed the right track while a different one was actually decoded.
- af37033: Fix `VodExtractedSubtitleSource` never producing cues in a browser. Its default `fetchImpl` stored the global `fetch` on the instance, so calling `this.fetchImpl(...)` invoked it with the source as its receiver — which browsers reject with a synchronous `TypeError: Illegal invocation`. Because the throw was synchronous, the `.catch()` attached to the (never-returned) promise could not apply, and the failure escaped as an unhandled rejection in a caller that does not await it: every VOD-extracted subtitle track read as selected while silently rendering nothing. The default now calls `globalThis.fetch` through a wrapper, and a synchronously-throwing `fetchImpl` is contained rather than escaping.

## 0.2.1

### Patch Changes

- c440d4a: Fix three bugs that together broke switching between subtitle sources:

  - `TextTrackCueRenderer` could not remove existing cues while its `TextTrack` was `"disabled"` — `TextTrack.cues` reads as `null` in that state, and hls.js disables every text track it does not own whenever its own `subtitleTrack` is set. The removal loop enumerated nothing, so stale cues survived and the mode flip at the end of `render()` put them back on screen. `clear()` had the same flaw.
  - `SubtitleController` only rendered from inside a source's `onCuesChanged` callback, so selecting a track on a source that emits nothing synchronously (a still-fetching `VodExtractedSubtitleSource`, or `HlsNativeSubtitleSource`, which never emits) left the previously selected track's cues rendered.
  - `VodExtractedSubtitleSource.selectTrack` emitted nothing when re-selecting a track whose `.vtt` had already been fully read, because `fetchAndMergeCues` only notifies on newly-seen cues. It now re-emits its cached cues synchronously, matching `OpenSubtitlesSource`.

## 0.2.0

### Minor Changes

- cf51e12: Add `AttachedHlsAdapter`, an `IHlsAdapter` implementation for host applications that own their own `Hls` instance's lifecycle (create/destroy/retry policy) instead of delegating it to `HlsJsAdapter`/`MediaPlayer`. Formalizes the observe-only adapter pattern that host apps previously had to hand-roll themselves, with idempotent `attachHls`/`detachHls` and protection against stale events from a replaced `Hls` instance updating state after a swap.
