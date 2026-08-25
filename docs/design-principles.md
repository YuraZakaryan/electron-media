# Design Principles

This library went through three review passes before implementation began;
each one is preserved here because the reasoning explains *why* a class
boundary sits where it does, which the code alone won't tell you.

## v1 — baseline architecture

Framework-agnostic core + a thin React adapter; explicit contracts
(`ILiveTranscodeGateway`, `IVodTranscodeGateway`, `ISubtitleGateway`) instead
of a direct Electron/ffmpeg dependency; ffmpeg itself stays entirely in the
host application's main process. `ISubtitleSource` chosen as the extension
point for adding subtitle providers (e.g. the OpenSubtitles case) without
touching the rest of the subtitle pipeline.

## v2 — SOLID decomposition

The v1 sketch had god-objects: one `HlsPlayerController` doing HLS lifecycle
*and* track management, one `SubtitleEngine` doing registry *and* selection
*and* delay *and* rendering, one `ITranscodeGateway` covering both live and
VOD. These were split:

- **SRP**: `HlsController` (lifecycle only) separated from
  `AudioTrackController` (track selection only); `SubtitleEngine` split into
  `SubtitleRegistry` / `SubtitleSelectionService` / `SubtitleDelayProcessor` /
  `ISubtitleRenderer`, composed by a `SubtitleController` facade.
- **DIP**: `TrackManager.attachHls(hls)` (a concrete `Hls` dependency)
  replaced by `IHlsAdapter`, an abstraction `HlsController` and
  `AudioTrackController` depend on instead.
- **ISP**: `ITranscodeGateway` split into `ILiveTranscodeGateway` and
  `IVodTranscodeGateway` so a consumer needing only one doesn't have to
  implement the other's methods. (Later removed entirely — see "post-launch
  scope correction" below; the split was right, but nothing ended up
  implementing either half.)
- **OCP**: `ISubtitleSource` kept and made consistent (`OpenSubtitlesSource`,
  not `OpenSubtitlesModule`, to match `VodExtractedSubtitleSource`'s naming).
- Event API changed from string-keyed `on("loading", cb)` with untyped
  payloads to `TypedEventEmitter<PlayerEvents>`.

## v3 — API design and DX

With the class boundaries settled, the second pass focused on the *shape* of
every public member: mandatory JSDoc, branded types, `readonly` array
results, enums over booleans, typed events and exceptions, options-object
constructors, no abbreviations, stability annotations. See
`naming-conventions.md` for the resulting rule set, applied from the first
line of code rather than retrofitted.

## Post-launch scope correction

A first review of the finished library (after the initial VOD/Live TV
integration attempt) found two things drafted speculatively rather than in
response to an actual caller:

- `ILiveTranscodeGateway`/`IVodTranscodeGateway`/`GatewayError` — removed.
  Transcode/seek orchestration turned out to be tightly coupled to each
  app's own ffmpeg session state machine (restart vs. seek-in-place, when
  to tear down the `Hls` instance) in a way a shared interface couldn't
  usefully describe — the actual integration ended up keeping `Hls`
  lifecycle entirely app-owned for exactly this reason (see
  `extension-points.md`).
- `HlsError` and the `loading`/`PlayerLoadingEvent` event — removed as
  permanently unused; nothing in the library ever threw the former or
  emitted the latter.
- `PlayerPreferenceStore.getSubtitleLanguage`/`setSubtitleLanguage` —
  removed. Subtitle preference restore needs source-aware matching (an
  embedded track and an OpenSubtitles result in the same language are not
  the same pick) and an "off" state distinguishable from "no preference
  yet" — both beyond what a two-method string contract can express. The
  reference integration implements this itself against
  `SubtitleController.getTracks()` instead.

The lesson generalized: a contract earns a place in the public API by
having an actual implementer inside this repo's own integration work, not
by being a plausible-sounding extension point.

## v4 — voice-over: one gateway, no registry

Voice-over narration was ported from the reference app's own (untested)
implementation, following the same class-based, SOLID pattern as subtitles
— but deliberately **without** a `SubtitleRegistry`/`ISubtitleSource`-style
split. `SubtitleRegistry` exists because subtitles genuinely have multiple
heterogeneous sources (embedded HLS, VOD-extracted polling, remote search)
that need merging and independent lifecycle. Voice-over has exactly one
kind of source — a TTS gateway producing lines on demand — and the ported
app code never had more than one engine either. Introducing
`IVoiceOverSource`/`VoiceOverRegistry` today would be exactly the kind of
speculative abstraction the "post-launch scope correction" above already
flagged for removal once: no second implementer, no concrete caller.
`VoiceOverController` instead mirrors `AudioTrackController`'s shape (one
controller, one backing abstraction, one selection dimension), composing a
`VoiceOverCueScheduler` (timing) and `VoiceOverDuckingPlayer` (audio/DOM
side effects) as private collaborators rather than public extension points.
If a second concurrent TTS provider ever needs supporting, that's the
trigger to extract a registry then — not speculatively now.

The port also fixed two things carried over from the untested app code
without changing behavior a user would notice as a regression: an
asymmetric duck fade (fade in, snap out — now symmetric except on a hard
stop) and an autoplay-rejection that was silently swallowed (now surfaced
as a `voiceOverPlaybackRejected` event, consistent with this library never
swallowing errors silently elsewhere).

## v4.1 — voice-over follow-ups: preference restore is safe here, unlike subtitles

A round of follow-up improvements added `PlayerPreferenceStore.
getVoiceOverLanguage`/`setVoiceOverLanguage` (both optional, so no existing
implementer breaks) and an `AudioTrackController`-style auto-restore latch
on `VoiceOverController`. This is deliberately **not** the same mistake as
the removed `getSubtitleLanguage`/`setSubtitleLanguage` pair (see
"Post-launch scope correction" above): subtitle restore needed
source-awareness (an embedded track and an OpenSubtitles result in the same
language aren't the same pick) and an "off" state distinguishable from "no
preference yet" — neither problem exists for voice-over, which has exactly
one gateway and one language dimension, identical in shape to audio's own
restore. The one real difference from audio: voice-over's default absent a
stored preference is OFF, not "pick something anyway" — audio always needs
some track selected, narration does not.

The same round added a synthesis concurrency cap and buffering-aware
scheduling (both in `VoiceOverCueScheduler`, still polling-only — no new
listeners, for the same video-remount reason the class already avoided
`pause`/`seeking` listeners), an optional `AbortSignal` on `generateLine`
alongside the existing best-effort `cancelLine` message, and a pluggable
`FadeCurve` on `VoiceOverDuckingPlayer` (default unchanged, linear). None of
these introduced a new abstraction layer — each extends an existing class
with an additional option or a narrower, single-purpose method, consistent
with this section's running theme of earning new surface area only when a
concrete need drives it.

## Deliberately rejected

- **mpv.js instead of `<video>` + hls.js** — would break `<video>`'s DOM/CSS
  styling semantics and the existing IPC contract built around a standard
  video element; rejected outright, not deferred.
- **`<track src="...">` for subtitle rendering** — a static `<track>` element
  fetches once; both VOD-extracted subtitles (a `.vtt` file that keeps
  growing) and OpenSubtitles-repaired-after-hls.js-wipe scenarios need cues
  added incrementally via `TextTrack.addCue()`, which also works around a
  documented Chromium/WebKit bug where a track flipped to `"showing"` before
  it has cues doesn't reliably re-render cues added afterward.
- **ASS/SSA rendering in this pass** — deferred, not rejected;
  `ISubtitleRenderer` is the seam a future `AssCueRenderer` would fill in.
