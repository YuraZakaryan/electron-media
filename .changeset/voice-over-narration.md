---
"@electron-media/core": minor
"@electron-media/react": minor
---

Add voice-over (TTS narration) support, ported from the reference app's
implementation and following the same class-based SOLID architecture as
subtitles and audio tracks.

- `packages/core`: `VoiceOverController`, `VoiceOverCueScheduler`,
  `VoiceOverDuckingPlayer`, `IVoiceOverGateway` contract, `VoiceOverTrack`/
  `VoiceOverTrackId`/`VoiceOverSourceId`, `VoiceOverError`, and the
  `voiceOverLineFailed`/`voiceOverPlaybackRejected` events. `MediaPlayer`
  gains an optional `voiceOverGateway`/`voiceOverOptions` and a nullable
  `voiceOver` property — fully additive, no existing behavior changes.
- `packages/react`: `useMediaPlayer` gains `voiceOverTracks`,
  `selectedVoiceOver`, `isGeneratingVoiceOver`, `selectVoiceOverTrack`,
  `disableVoiceOver`, and `bindVoiceOverSubtitleSource`.

The library only defines the TTS gateway interface; the actual synthesis
engine stays entirely in the host application. Fixes carried over from the
ported (previously untested) app logic: a cancel-then-supersede race is
closed with an epoch counter, the duck fade is now symmetric on normal
completion, autoplay rejection is surfaced as an event instead of swallowed,
and track ids are keyed by stable language code instead of a positional
index.

Follow-up hardening in the same release:

- Buffering-aware scheduling (`video.readyState` polled alongside
  `paused`) and a currently-playing line now pauses/resumes in step with
  the video (`onPlaybackPausedChanged` → `VoiceOverDuckingPlayer.setPaused`)
  instead of only reacting to hard stops. Synthesis is capped
  (`maxConcurrentSynthesis`, default 4) so a big seek can't fire an
  unbounded burst of `generateLine` calls.
- New `voiceOverLinePlayed`/`voiceOverLineSkipped` events (the latter
  exclusively for scheduling-reason skips — non-dialogue, late-grace miss,
  seek-past — never overlapping with `voiceOverLineFailed`).
- **Two independent, live-updatable volume levers** for a settings-UI-style
  "original sound" / "voice-over sound" pair: `setDuckVolume` (default 15%
  — how loud the original video audio plays while ducked) and the new
  `setVoiceOverVolume` (default 100% — the narration line's own volume).
  Neither derives from or scales the other. `setLookaheadSeconds`/
  `setLateStartGraceSeconds` are also now live-updatable. All four have
  React hook equivalents (`setVoiceOverDuckVolume`, `setVoiceOverVolume`,
  `setVoiceOverLookaheadSeconds`).
- `PlayerPreferenceStore.getVoiceOverLanguage`/`setVoiceOverLanguage`
  (both optional — non-breaking for existing implementers) drive the same
  auto-restore-once latch `AudioTrackController` already uses for audio,
  with voice-over's own default (no stored preference) staying OFF.
- `IVoiceOverGateway.generateLine` accepts an optional second
  `AbortSignal` parameter alongside the existing best-effort `cancelLine`,
  for gateways with a real cancellation hook.
- `VoiceOverDuckingPlayer` accepts a pluggable `fadeCurve` (default
  unchanged, linear; ships an `easeInOutQuadCurve` alternative).
  `VoiceOverLineResult`'s success branch gains an optional `clipped` flag,
  mirrored onto `voiceOverLinePlayed`, for a gateway that time-fits speech
  to a cue's duration to report when the fit had to clamp.
- **Extended Audio Description (WCAG 1.2.7)**, opt-in via `allowVideoPause`
  (default off): when a line's synthesized duration exceeds its cue's own
  window, the video is paused entirely for the line's duration instead of
  ducked, then resumed once it finishes. `voiceOverLinePlayed` gains an
  `isExtended` flag reporting which lines needed this, independent of
  whether `allowVideoPause` is on. Live-updatable via `setAllowVideoPause`
  / the hook's `setVoiceOverAllowVideoPause`. If resuming the video after
  the pause is itself rejected, it's surfaced via the new
  `voiceOverVideoResumeRejected` event rather than swallowed — consistent
  with `voiceOverPlaybackRejected` for the narration audio's own `play()`.
  The pause itself doesn't fire at the extended line's own start (that's
  merely when it began) — it fires right before the *next* cue's own
  start, via the new `onExtendedPauseDue` event and
  `VoiceOverDuckingPlayer.pauseForExtendedDescription`, so the freeze reads
  as "making room for the subtitle about to appear" rather than an early,
  unexplained stall. How far ahead of that next start it fires is
  configurable via `extendedPauseLeadSeconds` (default 150ms),
  live-updatable via `setExtendedPauseLeadSeconds` / the hook's
  `setVoiceOverExtendedPauseLeadSeconds`. An extended line's own end is no
  longer inferred from `video.currentTime` crossing its cue's `endSeconds`
  (that proxy only worked while the video froze immediately at line
  start); it now clears exclusively via the narration audio's real `ended`
  event, through the new `VoiceOverController.notifyLineEnded`.
