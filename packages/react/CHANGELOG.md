# @electron-media/react

## 0.2.1

### Patch Changes

- Updated dependencies [c492ba8]
  - @electron-media/core@0.4.0

## 0.2.0

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

### Patch Changes

- Updated dependencies [437c53d]
  - @electron-media/core@0.3.0

## 0.1.10

### Patch Changes

- edba37c: Add `repository`/`bugs` fields pointing to the GitHub repo, and document every public method/hook return field in each package's README.
- Updated dependencies [edba37c]
  - @electron-media/core@0.2.5

## 0.1.9

### Patch Changes

- Updated dependencies [b4958dd]
  - @electron-media/core@0.2.4

## 0.1.8

### Patch Changes

- Updated dependencies [7eecc31]
  - @electron-media/core@0.2.3

## 0.1.7

### Patch Changes

- Updated dependencies [cb51e15]
- Updated dependencies [af37033]
  - @electron-media/core@0.2.2

## 0.1.6

### Patch Changes

- Updated dependencies [c440d4a]
  - @electron-media/core@0.2.1

## 0.1.5

### Patch Changes

- Updated dependencies [cf51e12]
  - @electron-media/core@0.2.0
