# Releasing

This repo uses [Changesets](https://github.com/changesets/changesets) to version and publish `@electron-media/core` and `@electron-media/react`. **Never run `pnpm publish` or `npm publish` by hand** — always go through this flow. It is the only path that correctly rewrites `workspace:*` (used between `packages/react` → `packages/core`) into a real published version before the tarball is built.

## Why this matters

`packages/react/package.json` depends on core via:

```json
"dependencies": {
  "@electron-media/core": "workspace:*"
}
```

`pnpm publish` (and, by extension, `changeset publish`, which shells out to `pnpm publish`) resolves `workspace:*` to core's real version at pack time. A plain `npm publish`, or any tool that doesn't specifically invoke `pnpm publish`, does **not** do this rewrite — the raw `workspace:*` string ships to npm as-is, and every consumer's install breaks (`bun install`/strict installers refuse to resolve it; npm/yarn silently accept it but the dependency is meaningless). This exact bug shipped in `@electron-media/react@0.1.2` and `0.1.3` before this process existed — see the deprecation notices on those versions.

## Making a change to `core` or `react`

1. Make your code change in `packages/core` and/or `packages/react` as normal.
2. Before opening/merging the PR, record a changeset:
   ```bash
   pnpm changeset
   ```
   - Select the package(s) you changed (space to toggle, enter to confirm).
   - Choose the bump type for each: `patch` (bug fix, no API change), `minor` (new backwards-compatible API), `major` (breaking change).
   - Write a one-line summary — it becomes the changelog entry.
   - This writes a markdown file into `.changeset/`. Commit it alongside your code change.
3. If your change to `core` breaks or extends its API in a way `react` depends on, also select `react` (or let Changesets auto-bump it — dependents of a bumped package with `workspace:*` are patch-bumped automatically when the changeset is applied).

## Publishing a release

Once changeset(s) are merged to `main`:

```bash
pnpm release
```

This runs, in order:
1. `pnpm -r build` — builds both packages so the published `dist/` is current.
2. `changeset publish` — for each package with a pending changeset:
   - Bumps its `version` in `package.json` per the changeset(s).
   - Rewrites any `workspace:*` dependency to the real resolved version.
   - Runs `pnpm publish` (verified in `@changesets/cli` internals to spawn `pnpm`, not `npm`, whenever `packageManager` in the root `package.json` names pnpm — it does here).
   - Tags the release in git (`@electron-media/react@x.y.z`).

You'll be prompted for an npm OTP (2FA) — enter the code from your authenticator app.

### Sanity-check before trusting a publish

After `pnpm release` finishes, confirm the published tarball actually has a real version, not `workspace:*`:

```bash
curl -s https://registry.npmjs.org/@electron-media/react/<version> | grep -o '"dependencies":{[^}]*}'
# expect: "dependencies":{"@electron-media/core":"<real version>"}
# NOT:    "dependencies":{"@electron-media/core":"workspace:*"}
```

If you ever see `workspace:*` in that output, something bypassed `pnpm publish` (e.g. someone ran `npm publish` directly, or `corepack pnpm` silently fell through to a different package manager). Publish an immediate patch fixing it, then deprecate the broken version:

```bash
npm deprecate @electron-media/react@<broken-version> "broken: @electron-media/core pinned to workspace:*, use <fixed-version>+"
```

## Quick reference

| Step | Command |
| --- | --- |
| Record a change | `pnpm changeset` |
| Build all packages | `pnpm build` (alias: `pnpm prerelease:build`) |
| Version + publish | `pnpm release` |
| Verify a published tarball's deps | `curl -s https://registry.npmjs.org/<pkg>/<version> \| grep -o '"dependencies":{[^}]*}'` |
| Deprecate a broken version | `npm deprecate <pkg>@<version> "<reason>"` |
