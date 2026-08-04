# electron-media

Monorepo for `@electron-media/*` — framework-agnostic HLS playback, multi-audio-track selection, and subtitle (native/VOD-extracted/remote) composition for Electron media apps, built on [hls.js](https://github.com/video-dev/hls.js).

## Packages

| Package | Description |
| --- | --- |
| [`@electron-media/core`](packages/core) | Playback engine: `MediaPlayer`, `HlsJsAdapter`, audio-track selection, subtitle sources/rendering. |
| [`@electron-media/react`](packages/react) | React binding — a single `useMediaPlayer` hook over `@electron-media/core`. |

Each package's own README has install instructions and usage examples; this file covers the workspace as a whole.

## Development

Requires [pnpm](https://pnpm.io) and, for the E2E suite, `ffmpeg` on `PATH`.

```bash
pnpm install
pnpm build      # tsc -p, both packages
pnpm test       # vitest unit tests, both packages
pnpm lint
```

### End-to-end tests

`pnpm run test:e2e` runs Playwright against a real Chromium instance and real hls.js, driving both packages against a locally generated HLS fixture stream (no network dependency on third-party CDNs):

1. `e2e/generate-stream.mjs` uses `ffmpeg` to synthesize a short multi-audio-track VOD stream with an embedded WebVTT subtitle rendition into `e2e/.generated/` (gitignored, regenerated on every run).
2. `pnpm -r build` builds both packages so the suite exercises the real published `dist/` artifacts, the way a real consumer would.
3. `e2e/build-react-harness.mjs` bundles the React test harness with esbuild.
4. `e2e/server.mjs` serves the fixture stream, built packages, and harness pages; Playwright drives `e2e/tests/core.spec.ts` and `e2e/tests/react.spec.ts` against it.

Covers real playback, audio-track switching, subtitle rendering/delay/toggling, error/retry behavior (`shouldRetry`, `maxRetries`, transient-failure recovery), reload/destroy lifecycle, and the React hook's mount/unmount/source-change behavior. See `e2e/tests/*.spec.ts` for the full list — a few things are deliberately out of scope (see the comments at the top of each spec file): live streams, non-HLS subtitle sources (already unit-tested), and anything Electron's Chromium-only runtime makes moot (WebKit/Safari fallback paths).

## Docs

See [`docs/`](docs): `architecture.md`, `public-api.md`, `lifecycle.md`, `extension-points.md`, `naming-conventions.md`, `design-principles.md`.

## License

MIT
