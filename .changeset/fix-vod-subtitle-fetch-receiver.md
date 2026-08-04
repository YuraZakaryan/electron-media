---
"@electron-media/core": patch
---

Fix `VodExtractedSubtitleSource` never producing cues in a browser. Its default `fetchImpl` stored the global `fetch` on the instance, so calling `this.fetchImpl(...)` invoked it with the source as its receiver — which browsers reject with a synchronous `TypeError: Illegal invocation`. Because the throw was synchronous, the `.catch()` attached to the (never-returned) promise could not apply, and the failure escaped as an unhandled rejection in a caller that does not await it: every VOD-extracted subtitle track read as selected while silently rendering nothing. The default now calls `globalThis.fetch` through a wrapper, and a synchronously-throwing `fetchImpl` is contained rather than escaping.
