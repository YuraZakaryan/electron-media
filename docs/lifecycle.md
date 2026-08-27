# Lifecycle & Ownership

## `MediaPlayer`

- **Construction**: takes an already-existing `HTMLVideoElement`. It never
  creates, inserts, or removes this element from the DOM — the host
  application owns the element's lifecycle entirely.
- **`loadSource(url)`**: safe to call repeatedly (e.g. switching episodes);
  tears down the previous `hls.js` instance first.
- **`destroy()`**: must be called exactly once, when the player is no longer
  needed (e.g. on component unmount). No method may be called afterwards —
  `MediaPlayer` does not guard against post-destroy calls, since checking for
  that on every call would cost every consumer for a mistake only a buggy
  caller makes.
- Every constituent class (`HlsController`, `AudioTrackController`,
  `SubtitleController`) follows the same rule: idempotent `destroy()`, no
  calls after.

## Video element ownership inside subtitle rendering

`TextTrackCueRenderer` creates at most one `TextTrack` via
`HTMLVideoElement.addTextTrack`. Per the WebVTT/HTML spec, a TextTrack added
this way **cannot be removed** — only disabled (`mode = "disabled"`). This is
why the renderer reuses one TextTrack across every track switch rather than
creating a new one per selection; creating one per switch would leak a
TextTrack (holding a full transcript) for the lifetime of the video element.

## `VodExtractedSubtitleSource` polling

`selectTrack` starts a poll of the active track's `.vtt` file (default every
8s) because the file may still be growing (the transcode is still running).
Calling `selectTrack(null)` or selecting a different track stops the
previous poll. `dispose()` stops any active poll unconditionally.

`activateForReading(trackId)` (see below) polls independently of
`selectTrack` — its own `Map<trackId, timer>`, keyed separately from
`selectTrack`'s single `pollTimer`. Switching the `selectTrack`-selected
track never stops an `activateForReading` poll, and vice versa; each is
stopped only by its own deactivate call (the function `activateForReading`
returns) or by `dispose()`, which clears both.

## `OpenSubtitlesSource` downloads

Unlike the VOD-extracted source, a selected track's full transcript is
downloaded once (no polling) and cached — reselecting the same track after
switching away reuses the cached cues rather than re-downloading. Because of
this, `activateForReading` and `selectTrack` don't need independent state
here the way they do on `VodExtractedSubtitleSource` — both just trigger the
same per-track cached download.

## `VoiceOverController`

- Does not own the `video` element passed to `attach` — same non-owning
  contract as `SubtitleController`; a remounted `<video>` requires a fresh
  `attach` call, not a persisted reference.
- `bindSubtitleSource(source, trackId)` subscribes to `source.onCuesChanged`
  and calls `source.activateForReading(trackId)` (falling back to
  `source.selectTrack(trackId)` for a source that doesn't implement it, e.g.
  `HlsNativeSubtitleSource` — see `extension-points.md`) — required for real
  `ISubtitleSource` implementations, which never fetch/emit a track's cue
  text until activated for that id. `activateForReading` is non-exclusive,
  specifically so narrating a subtitle track never has the side effect of
  disturbing whatever's visibly selected on the same source, even when it's
  a *different* track (e.g. Arabic subtitles on screen, English narration
  read from the same VOD-extracted source) — `selectTrack` alone would
  silently steal the source's one exclusive active-track slot and stop the
  visible track's own cue delivery once the two diverge.
- Ticks once per frame reading `video.currentTime`/`video.paused`/
  `video.readyState` fresh each time, rather than via `pause`/`play`/
  `seeking`/`waiting` listeners — a listener bound in `attach` would
  silently stop firing if the video element is later replaced without a
  fresh `attach` call; polling sidesteps that. Buffering (`readyState`
  below `HAVE_FUTURE_DATA` while not paused) is treated the same as a real
  pause for scheduling purposes — a currently-playing line is paused in
  step with it (mirrored via `onPlaybackPausedChanged` →
  `VoiceOverDuckingPlayer.setPaused`, not stopped/restarted), and no new
  line starts until playback genuinely resumes; in-flight synthesis keeps
  running regardless, so a stall doesn't waste already-requested work.
- Synthesis concurrency is capped (`maxConcurrentSynthesis`, default 4) —
  a large seek that makes many cues due at once queues the excess rather
  than firing an unbounded burst of `generateLine` calls; queued cues
  synthesize as earlier ones resolve.
- `IVoiceOverGateway.cancelLine` is **best-effort only** — the real engine
  behind it may keep synthesizing after the call resolves.
  `VoiceOverController`'s own epoch counter, not the gateway's cooperation,
  is what guarantees a superseded result never becomes playable. The
  optional `AbortSignal` passed to `generateLine` (aborted at the same
  points `cancelLine` is called) is the same best-effort story via a more
  idiomatic seam — a gateway with a real cancellation hook may use it, but
  nothing relies on it actually stopping generation.
- `duckVolume`, `voiceOverVolume`, `lookaheadSeconds`, and
  `lateStartGraceSeconds` can all be updated live (`setDuckVolume`/
  `setVoiceOverVolume`/`setLookaheadSeconds`/`setLateStartGraceSeconds`)
  without recreating the controller. `duckVolume` (default 15% — how loud
  the *original* video audio plays while ducked) and `voiceOverVolume`
  (default 100% — the narration line's own volume) are fully independent
  of each other, e.g. for two separate sliders in a settings popover. A
  duck-volume change applies to the next line started, not one already
  fading; a voice-over-volume change re-applies immediately to a line
  already playing.
- `preferenceStore.getVoiceOverLanguage`/`setVoiceOverLanguage` (both
  optional) drive the same auto-restore-once latch `AudioTrackController`
  uses for audio language — but voice-over's default, absent a stored
  preference, is OFF, not "pick something anyway".
- **Extended Audio Description** (WCAG 1.2.7, opt-in via `allowVideoPause`,
  default off): when a line's synthesized duration exceeds its cue's own
  window, the video is paused entirely for the line's duration instead of
  ducked, then resumed on `ended`. While this is happening,
  `onPlaybackPausedChanged`'s signal is **not** forwarded to
  `VoiceOverDuckingPlayer.setPaused` — the video's pause was caused by this
  class itself, and mirroring it back onto the narration audio would
  freeze the one thing that must keep playing through it. A seek or
  disable during an extended pause resumes the video via the same
  `stopLine` path a normal hard-stop already uses. If resuming the video
  itself rejects (both on natural `ended` and on an interrupt-triggered
  `stopLine`), it's surfaced via `voiceOverVideoResumeRejected` — never
  silently swallowed, consistent with `voiceOverPlaybackRejected` for the
  narration audio's own `play()`.
- `destroy()` is idempotent, matching every other controller in this
  library.

## Event subscriptions

Every `on*Changed`/`on*`-style method across the library returns an
unsubscribe function and never throws if called after the underlying object
is destroyed — but no method continues to fire callbacks after `dispose()`/
`destroy()`. Always capture and call the returned unsubscribe function in
your own cleanup path (a React `useEffect` return, for example).
