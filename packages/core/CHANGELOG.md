# @electron-media/core

## 0.4.1

### Patch Changes

- beb676c: Fix `OpenSubtitlesSource` silently dropping narration cues whenever the voice-over language differed from the visibly-selected open-subtitle language (e.g. an Italian subtitle on screen with Portuguese narration selected never spoke; narration only worked when both happened to match).

  The download-in-flight staleness guard in `downloadAndEmitCues` checked only `activeTrackId`, which is set exclusively by `selectTrack` (the visible-subtitle slot). `activateForReading` — the non-exclusive method `VoiceOverController` uses for narration — never touched `activeTrackId`, so its downloads were always treated as "superseded" and discarded unless they happened to target the same track as the current visible selection. `activateForReading` now tracks its own trackIds separately, exempting them from that guard while preserving it for genuinely superseded `selectTrack` downloads.

## 0.4.0

### Minor Changes

- c492ba8: Fix voice-over narration silently stopping the visibly-selected subtitle track when the two differ (e.g. Arabic subtitles on screen, English narration read from the same source).

  `VoiceOverController.bindSubtitleSource` used to call `source.selectTrack(trackId)` to activate a track's cue delivery for narration — but `selectTrack` is a single exclusive "active track" slot shared with whatever `SubtitleController` has visibly selected on the same source instance. Once narration picked a different track than the visible one, its `selectTrack` call silently superseded the visible selection: `VodExtractedSubtitleSource`'s polling for the previously-active (visible) track stopped, so no new cues from an in-progress transcode ever arrived again — already-cached lines kept rendering, so the break only became visible once the transcode produced content beyond what was already fetched ("subtitles stop after a while").

  Adds `ISubtitleSource.activateForReading(trackId): () => void` — a non-exclusive counterpart to `selectTrack`, for a consumer that needs a track's cues without taking over the exclusive display-selection slot. `VoiceOverController` now uses it when a source implements it, falling back to `selectTrack` otherwise (declared optional on the interface specifically for `HlsNativeSubtitleSource`, whose embedded tracks share one `hls.js` demuxer index and genuinely cannot be independently active).

  Implemented in `VodExtractedSubtitleSource` (independent per-track poll timers — the actual fix) and `OpenSubtitlesSource` (per-track cached download, already safe, added for interface symmetry). `HlsNativeSubtitleSource` does not implement it; narrating one of its tracks still requires it to already be the visible selection, unchanged from before.

## 0.3.0

### Minor Changes

- 437c53d: Add voice-over (TTS narration) support, following the same class-based
  SOLID architecture as subtitles and audio tracks.

  - `packages/core`: `VoiceOverController`, `VoiceOverCueScheduler`,
    `VoiceOverDuckingPlayer`, `IVoiceOverGateway` contract, `VoiceOverTrack`/
    `VoiceOverTrackId`/`VoiceOverSourceId`, `VoiceOverError`, and the
    `voiceOverLineFailed`/`voiceOverLinePlayed`/`voiceOverLineSkipped`/
    `voiceOverPlaybackRejected`/`voiceOverVideoResumeRejected` events.
    `MediaPlayer` gains an optional `voiceOverGateway`/`voiceOverOptions` and
    a nullable `voiceOver` property — fully additive, no existing behavior
    changes.
  - `packages/react`: `useMediaPlayer` gains `voiceOverTracks`,
    `selectedVoiceOver`, `isGeneratingVoiceOver`, `selectVoiceOverTrack`,
    `disableVoiceOver`, and `bindVoiceOverSubtitleSource`.

  The library only defines the TTS gateway interface; the actual synthesis
  engine stays entirely in the host application. Track ids are keyed by
  stable language code rather than a positional index, so a track's
  identity survives the voice list being re-fetched.

  Capabilities:

  - Buffering-aware scheduling (`video.readyState` polled alongside
    `paused`) and a currently-playing line pauses/resumes in step with the
    video (`onPlaybackPausedChanged` → `VoiceOverDuckingPlayer.setPaused`).
    Synthesis is capped (`maxConcurrentSynthesis`, default 4) so a big seek
    can't fire an unbounded burst of `generateLine` calls.
  - **Two independent, live-updatable volume levers** for a settings-UI-style
    "original sound" / "voice-over sound" pair: `setDuckVolume` (default 15%
    — how loud the original video audio plays while ducked) and
    `setVoiceOverVolume` (default 100% — the narration line's own volume).
    Neither derives from or scales the other; both re-apply immediately to
    whatever's currently playing. `setLookaheadSeconds`/
    `setLateStartGraceSeconds` are also live-updatable. `useVoiceOverController`
    (and `useMediaPlayer`'s nested `voiceOver.actions`) expose the exact same
    names — `setDuckVolume`, `setVoiceOverVolume`, `setLookaheadSeconds`.
  - **`narrationRate`** (default 1, live-updatable via `setNarrationRate` /
    the hook's same name): a multiplier the scheduler applies to each cue's
    own window (`endSeconds - startSeconds`) before requesting it as
    `targetDurationSeconds` — a rate above 1 asks a length-fitting gateway
    for a shorter window (so it speaks faster to fit), below 1 a longer one.
    Purely a hint to the gateway; a gateway that ignores
    `targetDurationSeconds` is unaffected. Exists for hosts whose chosen TTS
    voice has a naturally slower/faster pace than fits its per-cue timing
    well by default.
  - **Main/master volume scaling**: both of the levers above are, by
    default, live-multiplied by `setMainVolume` (the host's own top-level
    player volume, `0`–`1`) — the standard "master volume" pattern from
    game/media audio settings, where a master level scales every
    sub-channel and each sub-channel keeps its own independent range for
    relative adjustment. At main volume 50%, a duck/voice-over slider at
    100% still only plays at 50%. Opt out entirely via `setIgnoreMainVolume`
    (default off) for a host that wants narration at its sliders' nominal
    levels regardless of the main volume. Defaults to `mainVolume: 1`, so a
    host that never calls `setMainVolume` sees no behavior change. Same
    unprefixed names on `useVoiceOverController`/`voiceOver.actions`.
  - `PlayerPreferenceStore.getVoiceOverLanguage`/`setVoiceOverLanguage`
    (both optional — non-breaking for existing implementers) drive the same
    auto-restore-once latch `AudioTrackController` already uses for audio.
    Voice-over's own default (no stored preference) stays OFF, and an
    explicit `selectTrack(null)` persists that "off" choice just as durably
    as an explicit language pick — `setVoiceOverLanguage`'s parameter type
    is `string | null` to express this.
  - `VoiceOverController.stop()` / `VoiceOverCueScheduler.stop()` —
    immediately hard-stops a currently playing line, restoring the video's
    volume, without changing the selected track or persisted preference.
    Unlike `selectTrack(null)`, this isn't an "off" decision: for a host
    that closes/tears down the current title while a line is mid-narration,
    where the user's own choice should still apply, unchanged, next time.
  - `IVoiceOverGateway.generateLine` accepts an optional second
    `AbortSignal` parameter alongside the existing best-effort `cancelLine`,
    for gateways with a real cancellation hook.
  - `VoiceOverDuckingPlayer` accepts a pluggable `fadeCurve` (default
    linear; ships an `easeInOutQuadCurve` alternative).
    `VoiceOverLineResult`'s success branch has an optional `clipped` flag,
    mirrored onto `voiceOverLinePlayed`, for a gateway that time-fits speech
    to a cue's duration to report when the fit had to clamp.
  - **Extended Audio Description (WCAG 1.2.7)**, opt-in via `allowVideoPause`
    (default off): when a line's synthesized duration exceeds its cue's own
    window, the video is paused entirely for the line's duration instead of
    ducked, then resumed once it finishes. `voiceOverLinePlayed` gains an
    `isExtended` flag reporting which lines needed this, independent of
    whether `allowVideoPause` is on. Live-updatable via `setAllowVideoPause`
    / the hook's `setVoiceOverAllowVideoPause`. If resuming the video after
    the pause is itself rejected, it's surfaced via
    `voiceOverVideoResumeRejected` rather than swallowed — consistent with
    `voiceOverPlaybackRejected` for the narration audio's own `play()`. The
    pause fires right before the _next_ cue's own start (via
    `onExtendedPauseDue` / `VoiceOverDuckingPlayer.pauseForExtendedDescription`),
    so the freeze reads as "making room for the subtitle about to appear"
    rather than an early, unexplained stall — how far ahead is configurable
    via `extendedPauseLeadSeconds` (default 150ms), live-updatable via
    `setExtendedPauseLeadSeconds` / the hook's
    `setVoiceOverExtendedPauseLeadSeconds`. An extended line's own end
    clears exclusively via the narration audio's real `ended` event, through
    `VoiceOverController.notifyLineEnded`.
  - Ticking (which cue is due, when a line starts) falls back to
    `setInterval` while the document is hidden — a minimized window or a
    backgrounded Electron host — rather than relying solely on
    `requestAnimationFrame`, which browsers fully suspend while hidden.
    Narration keeps advancing on schedule instead of appearing to pause
    until the app is focused again.

## 0.2.5

### Patch Changes

- edba37c: Add `repository`/`bugs` fields pointing to the GitHub repo, and document every public method/hook return field in each package's README.

## 0.2.4

### Patch Changes

- b4958dd: Fix `TextTrackCueRenderer` rendering into a detached element after the host replaces its `<video>`. A `TextTrack` belongs to the element it was created on and cannot be moved, but the renderer cached its track without recording which element owned it — so a host that remounts its `<video>` (closing and reopening a player, swapping sources) kept writing every later cue into the previous, detached element's track. Nothing appeared on screen, no error was raised, switching subtitle tracks changed nothing, and the element actually being played carried no text track at all. The renderer now creates a fresh track whenever the element changes.

## 0.2.3

### Patch Changes

- 7eecc31: `SubtitleController` now rebinds the active selection when the source instance behind it is replaced. A host starting a new session (e.g. a seek that re-runs its transcode) unregisters a source and registers a fresh instance under the same `sourceId`; since the selection itself does not change, the selection service stayed silent and the controller kept its cue subscription on the disposed instance while the replacement was never told anything was selected. The selected track read as selected and rendered nothing until the user picked it again — on every seek. Cues emitted late by a replaced instance are now ignored as well.

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
