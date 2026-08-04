# Architecture

`@electron-media/core` is framework-agnostic; `@electron-media/react`
is a thin binding (one hook, `useMediaPlayer`) on top of it. Nothing in
`core` imports React, Electron, or ffmpeg.

## Composition root

`MediaPlayer` (`packages/core/src/player/media-player.ts`) is the only class
a host application typically constructs directly. It wires together three
independent subsystems behind one facade:

```
MediaPlayer
├── HlsController        — HLS lifecycle only (attach/loadSource/destroy)
│     └── IHlsAdapter     — HlsJsAdapter (hls.js) is the only implementation
├── AudioTrackController  — audio track listing/selection, preference restore
│     └── IHlsAdapter      (same instance as above — audio tracks come from hls.js)
└── SubtitleController    — subtitle listing/selection/delay/rendering facade
      ├── SubtitleRegistry           — merges tracks across N sources
      │     └── ISubtitleSource[]    — HlsNativeSubtitleSource, VodExtractedSubtitleSource, OpenSubtitlesSource
      ├── SubtitleSelectionService   — which track is active
      ├── SubtitleDelayProcessor     — user-facing timing nudge
      │     └── CueProjector          — pure cue-shift arithmetic
      └── ISubtitleRenderer          — TextTrackCueRenderer is the only implementation
```

## Why this shape

- **`IHlsAdapter` (DIP)** — `HlsController` and `AudioTrackController` depend
  on this interface, not on `hls.js` directly. A test can substitute a mock
  adapter; a future non-hls.js backend can substitute a different one,
  without touching either controller.
- **`ISubtitleSource` (OCP)** — three very different subtitle mechanisms
  (embedded HLS tracks, a growing VOD-extracted `.vtt`, a fully-downloaded
  remote file) implement the same narrow interface. Adding a fourth source
  (e.g. a burned-in OCR source) requires no change to `SubtitleRegistry`,
  `SubtitleSelectionService`, or `SubtitleController`.
- **Split subtitle responsibilities (SRP)** — listing (`SubtitleRegistry`),
  selection (`SubtitleSelectionService`), timing (`SubtitleDelayProcessor`),
  and rendering (`ISubtitleRenderer`) are four separate classes because they
  change for different reasons and at different rates (e.g. a new renderer
  for ASS/SSA support should never require touching selection logic).
- **Narrow gateway contract (ISP)** — `ISubtitleGateway` covers only what
  `OpenSubtitlesSource` needs (search/download). A live/VOD transcode
  gateway contract was drafted at the same time but never adopted by
  anything in this repo and was removed — transcode/seek orchestration
  turned out to be tightly coupled to each app's own ffmpeg session
  state machine, not something a shared interface could describe usefully.

See `design-principles.md` for the fuller rationale and the plan's revision
history behind these choices.

## What's deliberately NOT in this library

- ffmpeg itself, or any transcode/seek orchestration — this stays entirely
  in the host application, including the HLS instance lifecycle when it's
  tied to a transcode session (see `extension-points.md`).
- Partner-specific live-stream fallback policy (e.g. "switch to transcoded
  output after N seconds of stall") — this is application/business policy
  layered on top of `HlsController`, not a player concern.
- ASS/SSA subtitle rendering — deferred; `ISubtitleRenderer` is the
  extension point a future `AssCueRenderer` would implement.
