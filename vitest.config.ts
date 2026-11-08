import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

/**
 * The normal test run: `npm test`.
 *
 * The pool and the isolation below are the defaults of the test runner, written
 * out because the setup module depends on them. One test file per child process
 * with a fresh environment is what keeps the `TMPDIR` switch of
 * `test/setup-tmpdir.ts` inside one file's process, and it is what gives two test
 * runs at the same time their own roots.
 *
 * `oxc.jsx` is what lets a test import a page module: `src/ui/` is TSX, and the
 * page bundles are built for the `automatic` runtime of Preact
 * (`scripts/build-ui.mjs` sets the same two values). Vite 8 transforms TSX with
 * Oxc by default and reads this block; without it a `.tsx` import would be read
 * as React and look for `react/jsx-runtime`.
 */
export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic",
      importSource: "preact",
    },
  },
  test: {
    pool: "forks",
    isolate: true,
    setupFiles: ["test/setup-tmpdir.ts"],
    // Node 25 and later have their own global localStorage, which hides the one
    // that jsdom provides. Start the workers without it. Node 22 and 24 accept
    // this option too, while `--no-webstorage` is refused by them.
    execArgv: ["--no-experimental-webstorage"],
    // One and a half times the available CPUs, with a floor of 4.
    //
    // The runner's own default is the CPU count less one, which is 3 on this
    // 4-CPU machine. The suite then uses 2.92 of the 4 CPUs on average and takes
    // 177.7 to 178.7 seconds. Six workers use 3.89 to 3.90 of them, because a
    // test file spends part of its time waiting, and the same suite takes 156.2
    // seconds. Four workers measured 160.5 seconds. Above six there is nothing
    // left to fill: the CPUs are already full.
    maxWorkers: Math.max(4, Math.floor(availableParallelism() * 1.5)),
  },
});
