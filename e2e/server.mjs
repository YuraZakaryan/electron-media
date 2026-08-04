#!/usr/bin/env node
// Minimal static file server for the E2E suite. Deliberately dependency-free
// (no http-server/serve) — the routing table below is the entire feature
// set Playwright's tests need: fixture stream, built dist artifacts, hls.js
// vendor ESM build, and the harness pages/bundles.
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

export const PORT = Number(process.env.E2E_PORT ?? 4173);

const ROUTES = [
  { prefix: "/fixtures/", dir: join(ROOT, "e2e/.generated/stream") },
  { prefix: "/core/", dir: join(ROOT, "packages/core/dist") },
  { prefix: "/react-dist/", dir: join(ROOT, "packages/react/dist") },
  {
    // Root node_modules has no hls.js of its own (only packages/core
    // declares it as a dependency) — resolve through core's own install.
    prefix: "/vendor/hls.mjs",
    file: join(ROOT, "packages/core/node_modules/hls.js/dist/hls.mjs"),
  },
  { prefix: "/", dir: join(__dirname, "harness") },
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".m3u8": "application/vnd.apple.mpegurl",
  ".ts": "video/mp2t",
  ".vtt": "text/vtt; charset=utf-8",
  ".mp4": "video/mp4",
  ".json": "application/json; charset=utf-8",
};

function contentTypeFor(filePath) {
  return MIME_TYPES[extname(filePath)] ?? "application/octet-stream";
}

function resolveRoute(pathname) {
  for (const route of ROUTES) {
    if (route.file && pathname === route.prefix) return route.file;
    if (route.dir && pathname.startsWith(route.prefix)) {
      const relative = pathname.slice(route.prefix.length) || "index.html";
      const resolved = normalize(join(route.dir, relative));
      // Prevent a crafted "../" request from escaping its mapped directory.
      if (!resolved.startsWith(route.dir + sep) && resolved !== route.dir) {
        continue;
      }
      return resolved;
    }
  }
  return null;
}

export function createFixtureServer() {
  return createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    const filePath = resolveRoute(pathname);

    if (!filePath || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end(`not found: ${pathname}`);
      return;
    }

    res.writeHead(200, {
      "content-type": contentTypeFor(filePath),
      // The suite is fully local/offline; no need for the browser to ever
      // reuse a stale cached copy of a just-regenerated fixture across runs.
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    createReadStream(filePath).pipe(res);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createFixtureServer();
  server.listen(PORT, () => {
    console.log(`[e2e-server] listening on http://localhost:${PORT}`);
  });
}
