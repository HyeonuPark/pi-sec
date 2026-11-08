import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * One temporary directory per test file.
 *
 * The suite makes temporary directories in more than eighty places and most of
 * them are never removed, so a run piles `pi-sec-*` directories on the host.
 * This module runs before every test file (`setupFiles` in `vitest.config.ts`)
 * and gives that file a root of its own. `os.tmpdir()` reads `TMPDIR` on every
 * call, so the existing call sites and every child process the file starts make
 * their directories inside the root without a change. The root is removed when
 * the file ends, and `TMPDIR` goes back to the value the process started with.
 *
 * The value is per process, so the switch is bounded to one process: the runner
 * gives each test file its own child process with a fresh environment. Two test
 * runs at the same time therefore get different roots, and each file removes
 * only its own. Nothing sweeps the temporary directory as a whole.
 */

const original = process.env["TMPDIR"];
// The temporary directory node itself started with, before this file switches
// `TMPDIR`: a directory under it is shared by every test file of this run.
const runTmpdir = original ?? tmpdir();
const root = mkdtempSync(join(tmpdir(), "pi-sec-test-"));
process.env["TMPDIR"] = root;

// Node compiles the modules a child process loads, and it keeps the result when it
// is told where. A test that starts `node src/cli.ts`
// pays about 1.5 seconds for that compile, and about 1.0 second once the cache is
// warm. The cache only pays if it outlives one test file, so it goes under the
// temporary directory this process started with, not under the file's own root.
// Node keys an entry on the file's content and on the compiler options, so a changed
// file is compiled again, and a stale directory is safe to delete. A value that the
// environment already carries is left alone. A child that is given an environment of
// its own does not see this value, and the tests that start the CLI pass one, so those
// starts do not use the cache until their own call site names it.
if (process.env["NODE_COMPILE_CACHE"] === undefined) {
  const compileCache = join(runTmpdir, "pi-sec-node-compile-cache");
  mkdirSync(compileCache, { recursive: true });
  process.env["NODE_COMPILE_CACHE"] = compileCache;
}

// The same reason as `TMPDIR`, for the run account's home. Configuration defaults
// such as `~/attachments` and `~/share` expand against `$HOME`, so a test boot
// that sweeps them must sweep this file's root, not the real home.
const originalHome = process.env["HOME"];
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env["HOME"] = home;

afterAll(() => {
  if (original === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = original;
  if (originalHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = originalHome;
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
