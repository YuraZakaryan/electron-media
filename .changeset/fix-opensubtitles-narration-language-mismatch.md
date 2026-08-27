---
"@electron-media/core": patch
---

Fix `OpenSubtitlesSource` silently dropping narration cues whenever the voice-over language differed from the visibly-selected open-subtitle language (e.g. an Italian subtitle on screen with Portuguese narration selected never spoke; narration only worked when both happened to match).

The download-in-flight staleness guard in `downloadAndEmitCues` checked only `activeTrackId`, which is set exclusively by `selectTrack` (the visible-subtitle slot). `activateForReading` — the non-exclusive method `VoiceOverController` uses for narration — never touched `activeTrackId`, so its downloads were always treated as "superseded" and discarded unless they happened to target the same track as the current visible selection. `activateForReading` now tracks its own trackIds separately, exempting them from that guard while preserving it for genuinely superseded `selectTrack` downloads.
