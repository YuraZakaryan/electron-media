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

## `OpenSubtitlesSource` downloads

Unlike the VOD-extracted source, a selected track's full transcript is
downloaded once (no polling) and cached — reselecting the same track after
switching away reuses the cached cues rather than re-downloading.

## Event subscriptions

Every `on*Changed`/`on*`-style method across the library returns an
unsubscribe function and never throws if called after the underlying object
is destroyed — but no method continues to fire callbacks after `dispose()`/
`destroy()`. Always capture and call the returned unsubscribe function in
your own cleanup path (a React `useEffect` return, for example).
