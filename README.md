# electron-media

[![CI](https://github.com/YuraZakaryan/electron-media/actions/workflows/ci.yml/badge.svg)](https://github.com/YuraZakaryan/electron-media/actions/workflows/ci.yml)

Monorepo for `@electron-media/*` — framework-agnostic HLS playback, multi-audio-track selection, subtitle (native/VOD-extracted/remote) composition, and voice-over (TTS narration) for Electron media apps, built on [hls.js](https://github.com/video-dev/hls.js).

## Packages

| Package | Description |
| --- | --- |
| [`@electron-media/core`](packages/core) | Playback engine: `MediaPlayer`, `HlsJsAdapter`/`AttachedHlsAdapter`, audio-track selection, subtitle sources/rendering, `VoiceOverController`. |
| [`@electron-media/react`](packages/react) | React binding — the all-in-one `useMediaPlayer` hook plus standalone `useAudioTrackController`/`useSubtitleController`/`useVoiceOverController` hooks over `@electron-media/core`. |

Each package's own README has install instructions and usage examples; this file covers the workspace as a whole.

## Development

Requires [pnpm](https://pnpm.io) and, for the E2E suite, `ffmpeg` on `PATH`.

```bash
pnpm install
pnpm build      # tsc -p, both packages
pnpm test       # vitest unit tests, both packages
pnpm typecheck  # tsc --noEmit against tsconfig.eslint.json — covers tests/e2e too
pnpm lint
```

### End-to-end tests

`pnpm run test:e2e` runs Playwright against a real Chromium instance and real hls.js, driving both packages against a locally generated HLS fixture stream (no network dependency on third-party CDNs):

1. `e2e/generate-stream.mjs` uses `ffmpeg` to synthesize a short multi-audio-track VOD stream with an embedded WebVTT subtitle rendition into `e2e/.generated/` (gitignored, regenerated on every run).
2. `pnpm -r build` builds both packages so the suite exercises the real published `dist/` artifacts, the way a real consumer would.
3. `e2e/build-react-harness.mjs` bundles the React test harness with esbuild.
4. `e2e/server.mjs` serves the fixture stream, built packages, and harness pages; Playwright drives all five spec files against it: `core.spec.ts`, `attached-adapter.spec.ts`, `react.spec.ts`, `react-standalone-hooks.spec.ts`, and `voice-over.spec.ts`.

Covers real playback, audio-track switching, subtitle rendering/delay/toggling, error/retry behavior (`shouldRetry`, `maxRetries`, transient-failure recovery), reload/destroy lifecycle, the React hooks' mount/unmount/source-change behavior (both the all-in-one `useMediaPlayer` and the standalone per-controller hooks bound to a host-constructed controller), and voice-over (ducking, ducking volume, Extended Audio Description, cancellation). See `e2e/tests/*.spec.ts` for the full list — a few things are deliberately out of scope (see the comments at the top of each spec file): live streams, non-HLS subtitle sources (already unit-tested), and anything Electron's Chromium-only runtime makes moot (WebKit/Safari fallback paths).

## Docs

See [`docs/`](docs): `architecture.md`, `public-api.md`, `lifecycle.md`, `extension-points.md`, `naming-conventions.md`, `design-principles.md`, [`releasing.md`](docs/releasing.md).

## Releasing

Publishing goes through [Changesets](https://github.com/changesets/changesets) — see [`docs/releasing.md`](docs/releasing.md) for the full flow. Short version:

```bash
pnpm changeset   # after changing packages/core or packages/react — record what changed
pnpm release     # on main — builds, versions, and publishes via `pnpm publish`
```

Never call `pnpm publish` / `npm publish` directly — only `changeset publish` correctly rewrites the `workspace:*` dependency between `react` and `core` into a real version.

## License

MIT
