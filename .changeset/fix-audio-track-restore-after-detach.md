---
"@electron-media/core": patch
---

`AudioTrackController` now re-applies the stored language preference when the adapter reports a fresh track list after having reported an empty one. A stream teardown that rebuilds the underlying engine (e.g. a seek that recreates the `Hls` instance) left the "user already selected" latch set, so the handler bailed out on the new track list and the replacement instance — which carries no selection of its own — fell back to the manifest default. The controller kept reporting the user's original pick, so the UI showed the right track while a different one was actually decoded.
