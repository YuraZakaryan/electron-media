---
"@electron-media/core": patch
---

`SubtitleController` now rebinds the active selection when the source instance behind it is replaced. A host starting a new session (e.g. a seek that re-runs its transcode) unregisters a source and registers a fresh instance under the same `sourceId`; since the selection itself does not change, the selection service stayed silent and the controller kept its cue subscription on the disposed instance while the replacement was never told anything was selected. The selected track read as selected and rendered nothing until the user picked it again — on every seek. Cues emitted late by a replaced instance are now ignored as well.
