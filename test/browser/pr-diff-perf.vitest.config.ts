import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/browser/pr-diff-perf.bench.ts"], environment: "node", testTimeout: 14_400_000, hookTimeout: 120000 },
});
