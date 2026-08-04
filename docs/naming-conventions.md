# Naming Conventions

These rules apply to every exported (`@public`) member of
`@electron-media/core` and `@electron-media/react`. Internal/private
implementation details may be more compact.

1. **JSDoc on every public member** — interface, class, method, field. The
   comment answers "when is this called / who owns it / can it be reused /
   is it mutable", not "what does this do" (names already say that).
2. **Branded/domain types instead of bare primitives** — `AudioTrackId`,
   `SubtitleTrackId`, `SubtitleSourceId` instead of raw `number`/`string`, so
   a value from one domain can't be silently passed where another is
   expected.
3. **No abbreviations in public API** — `options` not `opts`, `callback` not
   `cb`, `configuration` not `cfg`, `context` not `ctx`.
4. **`readonly`/`ReadonlyArray` on every getter result** — signals that
   mutating a returned array/object has no effect on internal state; e.g.
   `getTracks(): readonly AudioTrack[]`.
5. **Enums over booleans once more than two states are plausible** —
   `kind: TrackKind` (`Default | Forced | Commentary | Dub | Manual`), not
   `isDefault: boolean`.
6. **Typed events, never `unknown` payloads** — `PlayerErrorEvent`,
   `PlayerLoadingEvent`, `PlayerReadyEvent` are concrete interfaces in
   `PlayerEvents`, subscribed to via `TypedEventEmitter<PlayerEvents>`.
7. **Typed exceptions, never bare `throw new Error(...)`** — `PlayerError`
   (base), `SubtitleError` `extends PlayerError`, so consumers can
   `catch (e) { if (e instanceof SubtitleError) ... }`. Only add a new
   subclass when something actually throws it — `HlsError`/`GatewayError`
   were drafted speculatively and removed for being permanently unused.
8. **Options-object constructors** — `new MediaPlayer({ video, hlsAdapter,
   ... })`, never positional parameters, so adding an option never breaks an
   existing call site. Applies to constructors; simple two-argument utility
   functions (e.g. `parseVttCues(text, offsetSeconds)`) are exempt where a
   positional signature is unambiguous and unlikely to grow.
9. **Stability annotations** — every export carries `@public`, `@internal`,
   `@experimental`, or `@deprecated`.
10. **Long, unambiguous names over short ones** — `SubtitleSelectionService`,
    not `SelectionService`; `TextTrackCueRenderer`, not `CueRenderer`.

See `design-principles.md` for why the SOLID decomposition looks the way it
does, and `public-api.md` for a map of the resulting surface.
