import { defineConfig } from "vitest/config";

/**
 * The browser tests, kept out of the normal run.
 *
 * They drive a real Chromium through Playwright against a server on port 0, so
 * they are slow and they need a browser that the normal suite must not depend on.
 * The normal run collects files named `*.test.ts` and never this pattern, which
 * is why these files are named `*.browser.ts`.
 *
 *   npm run test:browser
 */
export default defineConfig({
  test: {
    include: ["test/browser/**/*.browser.ts"],
    environment: "node",
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
