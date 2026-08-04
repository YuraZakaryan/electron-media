import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "e2e/tests",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    // Fixture generation + `pnpm -r build` + harness bundling all happen in
    // the "pretest:e2e" package.json hook, which pnpm/npm run automatically
    // before "test:e2e" — by the time this starts, dist/ and .generated/
    // already exist, so the server only needs to serve static files.
    command: `node e2e/server.mjs`,
    url: `http://localhost:${PORT}/core.html`,
    reuseExistingServer: !process.env.CI,
    env: { E2E_PORT: String(PORT) },
    timeout: 15_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
