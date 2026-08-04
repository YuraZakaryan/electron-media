#!/usr/bin/env node
// Bundles the React harness's JSX with esbuild — the minimal amount of
// bundler needed to get JSX working, without pulling in a full dev-server
// dependency graph (Vite, webpack, etc.) that this fixture doesn't need.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(__dirname, "harness/react-app.jsx")],
  outfile: join(__dirname, "harness/react-app.bundle.js"),
  bundle: true,
  format: "esm",
  target: "es2020",
  jsx: "automatic",
  logLevel: "info",
  // The workspace packages aren't dependencies of the root package.json, so
  // plain node_modules resolution can't find them from e2e/ — point esbuild
  // straight at the just-built dist so the harness bundles the REAL
  // published artifact, not source.
  alias: {
    "@electron-media/core": join(__dirname, "../packages/core/dist/index.js"),
    "@electron-media/react": join(__dirname, "../packages/react/dist/index.js"),
  },
});
