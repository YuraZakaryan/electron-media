---
"@electron-media/core": minor
---

Fix voice-over narration silently stopping the visibly-selected subtitle track when the two differ (e.g. Arabic subtitles on screen, English narration read from the same source).

`VoiceOverController.bindSubtitleSource` used to call `source.selectTrack(trackId)` to activate a track's cue delivery for narration — but `selectTrack` is a single exclusive "active track" slot shared with whatever `SubtitleController` has visibly selected on the same source instance. Once narration picked a different track than the visible one, its `selectTrack` call silently superseded the visible selection: `VodExtractedSubtitleSource`'s polling for the previously-active (visible) track stopped, so no new cues from an in-progress transcode ever arrived again — already-cached lines kept rendering, so the break only became visible once the transcode produced content beyond what was already fetched ("subtitles stop after a while").

Adds `ISubtitleSource.activateForReading(trackId): () => void` — a non-exclusive counterpart to `selectTrack`, for a consumer that needs a track's cues without taking over the exclusive display-selection slot. `VoiceOverController` now uses it when a source implements it, falling back to `selectTrack` otherwise (declared optional on the interface specifically for `HlsNativeSubtitleSource`, whose embedded tracks share one `hls.js` demuxer index and genuinely cannot be independently active).

Implemented in `VodExtractedSubtitleSource` (independent per-track poll timers — the actual fix) and `OpenSubtitlesSource` (per-track cached download, already safe, added for interface symmetry). `HlsNativeSubtitleSource` does not implement it; narrating one of its tracks still requires it to already be the visible selection, unchanged from before.
