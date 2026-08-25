import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // A config object with only `ignores` applies to every other object below.
  // ESLint does not read .gitignore, so generated artifacts are repeated here.
  {
    ignores: [
      "**/dist/**",
      // Not merely noise: e2e/generate-stream.mjs emits MPEG-TS video
      // segments here, and MPEG-TS segments are named *.ts. `file` reports
      // them as binary `data`. The **/*.ts glob below would otherwise hand
      // them to the TypeScript parser.
      "e2e/.generated/**",
      // 2.2 MB of esbuild output each.
      "e2e/harness/*.bundle.js",
      "e2e/harness/*.bundle.js.map",
      "playwright-report/**",
      "test-results/**",
      "blob-report/**",
    ],
  },

  js.configs.recommended,

  {
    linterOptions: {
      // A stale eslint-disable is a latent lie about the code.
      reportUnusedDisableDirectives: "error",
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // TypeScript, type-aware, on every hand-written .ts file in the repo —
  // including tests and e2e specs, which `tsconfig.eslint.json` exists to
  // bring into a program (the two build tsconfigs deliberately exclude
  // tests, and nothing owns e2e/ at all).
  //
  // Covering them is the point rather than an afterthought: e2e/tests is
  // ~1.1k lines of nothing but async Playwright, where a missing `await` on
  // an assertion does not fail — it passes for the wrong reason. The
  // scheduler unit tests are similarly promise-heavy. `no-floating-promises`
  // and `no-misused-promises` (both already in recommendedTypeChecked) are
  // worth more there than on the published source, which has no `any` at
  // all and already marks its deliberate fire-and-forget calls with `void`.
  // ───────────────────────────────────────────────────────────────────────
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.eslint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The one rule no preset ships. Locks in the `import type` convention
      // the codebase already follows throughout.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      // Matches the repo's existing `_`-prefix convention for intentionally
      // unused callback parameters.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "after-used",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // React hooks — the react package only; core has no React.
  // ───────────────────────────────────────────────────────────────────────
  {
    files: ["packages/react/src/**/*.ts"],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      // Why this plugin is here at all: validate the useCallback dependency
      // arrays feeding useSyncExternalStore. A wrong dep array is a
      // correctness bug, so it blocks rather than warns.
      "react-hooks/exhaustive-deps": "error",

      // eslint-plugin-react-hooks v7's `recommended` bundles the React
      // Compiler rule set, and two of its rules are structurally
      // unavoidable for a package whose entire job is bridging imperative
      // core classes into React:
      //   refs                — use-media-player.ts writes optionsRef.current
      //                         during render, deliberately (options are read
      //                         once at construction; see its own comment).
      //   set-state-in-effect — mirroring an external store's initial value
      //                         into state is the documented pattern for the
      //                         non-synchronous half of these hooks (the
      //                         async getTracks() in useVoiceOverController).
      // Every other compiler rule stays on.
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },

  // Unit tests and test doubles. Type-aware rules stay on — that is what
  // tsconfig.eslint.json bought — with two carve-outs.
  {
    files: ["packages/*/src/**/*.test.ts", "packages/*/src/testing/**/*.ts"],
    rules: {
      // Test doubles implement async interfaces with synchronous bodies: the
      // `async` keyword is required by the contract, not by the body.
      "@typescript-eslint/require-await": "off",
      // Harnesses legitimately pass detached methods around (`unmount:
      // utils.unmount`).
      "@typescript-eslint/unbound-method": "off",
      // vitest's own asymmetric matchers are typed loosely by design —
      // `objectContaining: <T = any>(expected: T) => any`,
      // `stringContaining: (expected: string) => any` (see
      // @vitest/expect's index.d.ts). Every `expect.objectContaining(...)`/
      // `expect.any(...)`/`expect.stringContaining(...)` in a `toEqual`/
      // `toHaveBeenCalledWith` call trips these three as a structural
      // consequence of the library's types, not a real unsafe value in our
      // test code.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // The react test files render real components and capture the hook result
  // by mutating an outer `let` from a render-phase callback — a deliberate
  // harness, not product code. rules-of-hooks still applies.
  {
    files: ["packages/react/src/**/*.test.ts"],
    extends: [reactHooks.configs.flat.recommended],
    rules: {
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-render": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
    },
  },

  // Playwright specs and root configs. Type-aware rules stay on (that is
  // where they pay); what has to go is the `any` family, because the specs
  // reach the harness pages' `window.__*` test hooks through
  // `(window as any)`. Typing that would mean maintaining a parallel .d.ts
  // for HTML fixtures that are never shipped.
  {
    files: ["e2e/**/*.ts", "*.config.ts", "packages/*/vitest.config.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },

  // Plain-JS Node scripts. No type information by design — build glue.
  // `globals` is needed because js.configs.recommended enables no-undef and
  // these use `process`/`console`.
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: globals.node },
  },

  // Browser React harnesses: esbuild inputs, never published. They exist to
  // be driven from Playwright, which means they deliberately break React
  // purity (publishing `window.__*` test hooks during render) and
  // deliberately pin effects to []. rules-of-hooks stays on.
  {
    files: ["**/*.jsx"],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "react-hooks/purity": "off",
      "react-hooks/refs": "off",
      "react-hooks/globals": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/set-state-in-render": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  }
);
