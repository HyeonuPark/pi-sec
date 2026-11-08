import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * The boot attachment sweep must sweep the harness's own roots, never the home.
 *
 * The sweep removes every file in the configured share directory and every
 * attachment body no row indexes, and a test harness boots with an empty store
 * and an in-memory index, so every file it can see looks unindexed. The built-in
 * default is `~/attachments` and `~/share`, which expanded against the run
 * account's home and emptied it on every harness boot. The decoy files here are
 * exactly that loss, made harmless: they live in the home of this file, and a
 * boot that reaches them fails this test instead of deleting a real file.
 */
describe("the boot attachment sweep and the home", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it("leaves the decoy files in the home of this test file alone", async () => {
    const home = process.env["HOME"];
    expect(home).toBeDefined();
    const shareFile = join(home!, "share", "decoy.png");
    const bodyFile = join(home!, "attachments", "01M5KHDH8W000000000000571X", "body.png");
    const shareBytes = "decoy-share\n";
    const bodyBytes = "decoy-attachment\n";
    await mkdir(dirname(shareFile), { recursive: true });
    await mkdir(dirname(bodyFile), { recursive: true });
    await writeFile(shareFile, shareBytes, "utf8");
    await writeFile(bodyFile, bodyBytes, "utf8");

    harness = await createTestHarness({ loadExtensions: true });

    // The sweep is one pass of the boot repair, and boot does not wait for that
    // pass (`void (async () => ...)` in src/agent/harness.ts). Watch for the loss
    // for a short window instead of trusting the return of the boot: a sweep that
    // reads the home removes the decoys at once, and the assertions then fail.
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && existsSync(shareFile) && existsSync(bodyFile)) {
      await delay(25);
    }

    // The sweep reads the two roots from the configuration, so the roots this
    // boot sweeps are the harness's own, not the ones in `$HOME`.
    expect(harness.config.attachments.shareDir.startsWith(harness.paths.home + sep)).toBe(true);
    expect(harness.config.attachments.dir.startsWith(harness.paths.home + sep)).toBe(true);

    expect(existsSync(shareFile)).toBe(true);
    expect(existsSync(bodyFile)).toBe(true);
    expect(await readFile(shareFile, "utf8")).toBe(shareBytes);
    expect(await readFile(bodyFile, "utf8")).toBe(bodyBytes);
  });
});
