#!/usr/bin/env node
// Bundles the React harness's JSX with esbuild — the minimal amount of
// bundler needed to get JSX working, without pulling in a full dev-server
// dependency graph (Vite, webpack, etc.) that this fixture doesn't need.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// The workspace packages aren't dependencies of the root package.json, so
// plain node_modules resolution can't find them from e2e/ — point esbuild
// straight at the just-built dist so the harness bundles the REAL
// published artifact, not source.
const sharedOptions = {
  bundle: true,
  format: "esm",
  target: "es2020",
  jsx: "automatic",
  logLevel: "info",
  alias: {
    "@electron-media/core": join(__dirname, "../packages/core/dist/index.js"),
    "@electron-media/react": join(__dirname, "../packages/react/dist/index.js"),
    // Root node_modules has no hls.js of its own (only packages/core
    // declares it as a dependency) — same reason e2e/server.mjs's own
    // "/vendor/hls.mjs" route resolves through core's install for core.html.
    "hls.js": join(__dirname, "../packages/core/node_modules/hls.js/dist/hls.mjs"),
  },
};

await build({
  ...sharedOptions,
  entryPoints: [join(__dirname, "harness/react-app.jsx")],
  outfile: join(__dirname, "harness/react-app.bundle.js"),
});

// Exercises the one construction pattern the other harnesses don't: host-
// constructed AudioTrackController/SubtitleController/VoiceOverController
// bound through the standalone useAudioTrackController/useSubtitleController/
// useVoiceOverController hooks, instead of the all-in-one useMediaPlayer.
await build({
  ...sharedOptions,
  entryPoints: [join(__dirname, "harness/react-standalone-app.jsx")],
  outfile: join(__dirname, "harness/react-standalone-app.bundle.js"),
});
