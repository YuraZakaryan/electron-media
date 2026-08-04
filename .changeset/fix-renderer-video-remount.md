---
"@electron-media/core": patch
---

Fix `TextTrackCueRenderer` rendering into a detached element after the host replaces its `<video>`. A `TextTrack` belongs to the element it was created on and cannot be moved, but the renderer cached its track without recording which element owned it — so a host that remounts its `<video>` (closing and reopening a player, swapping sources) kept writing every later cue into the previous, detached element's track. Nothing appeared on screen, no error was raised, switching subtitle tracks changed nothing, and the element actually being played carried no text track at all. The renderer now creates a fresh track whenever the element changes.
