# @electron-media/core

## 0.2.0

### Minor Changes

- cf51e12: Add `AttachedHlsAdapter`, an `IHlsAdapter` implementation for host applications that own their own `Hls` instance's lifecycle (create/destroy/retry policy) instead of delegating it to `HlsJsAdapter`/`MediaPlayer`. Formalizes the observe-only adapter pattern that host apps previously had to hand-roll themselves, with idempotent `attachHls`/`detachHls` and protection against stale events from a replaced `Hls` instance updating state after a swap.
