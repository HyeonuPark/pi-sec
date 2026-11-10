import { options } from "preact";

/**
 * Run a component's passive effects inside the render that queued them.
 *
 * Preact does not run a `useEffect` when the commit ends. `afterNextFrame` in
 * `preact/hooks/src/index.js` waits for the next frame, or for a 35 ms timer when
 * the environment has none, and then calls `setTimeout` to flush. A test file
 * that renders a component and ends inside that window leaves the flush for after
 * its environment is gone: the callback finds no `window`, vitest reports an
 * unhandled error while every test passes, and the run exits 1, so the restart
 * gate refuses a tree whose tests all passed.
 *
 * Measured on 2026-11-10: `test/ui/github-pr-diff-render-scope.test.ts` renders
 * the diff page, whose `View` effect touches `window` when it is cleaned up, and
 * one run in about six reported `ReferenceError: window is not defined` from
 * `src/ui/github-pr/diff-page.tsx`. A probe file that rendered one component and
 * ended at once never ran its effect.
 *
 * Installing the scheduler puts the flush inside the commit, so no frame and no
 * timer can outlive the render, the test or the file. This is exact and not a
 * wait: the callback runs where Preact would have scheduled it. A page in these
 * tests has no layout to wait for, because jsdom does not lay out, so nothing
 * here needs the deferral. Pages that a browser serves keep the real scheduler:
 * they run from the bundle the server serves, not from this module.
 */
options.requestAnimationFrame = (callback) => {
  callback();
};
