import { describe, expect, it, vi } from "vitest";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * A gate over the boot migration, so one test can hold it open.
 *
 * `Scheduler.start()` runs `migrateRoutines()` as a floating promise, and the
 * fix under test is that `runtime.close()` waits for it. To see the wait, the
 * migration has to be in flight while the close runs, and the test must decide
 * when it ends: a sleep or an artificial load would make the test depend on the
 * machine instead of on the code.
 *
 * `Scheduler` takes no migration in its options, so the seam is the module the
 * scheduler imports. The factory below delegates to the real function once the
 * gate opens, and no production code changes for it.
 */
const gate = vi.hoisted(() => {
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  return {
    held,
    started,
    calls: 0,
    release: () => release(),
    entered: () => entered(),
  };
});

vi.mock("../src/jobs/routine-migration.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/jobs/routine-migration.ts")>();
  return {
    ...actual,
    migrateRoutines: async (options: Parameters<typeof actual.migrateRoutines>[0]) => {
      gate.calls += 1;
      gate.entered();
      await gate.held;
      return await actual.migrateRoutines(options);
    },
  };
});

/**
 * How long a close that does not wait gets to finish. The fixed close cannot
 * resolve at all while the gate is held, so this number only has to be longer
 * than the rest of a close that skips the wait; the failure it guards against is
 * measured in tens of milliseconds, and this leaves an order of magnitude.
 */
const BROKEN_CLOSE_WINDOW_MS = 1500;

describe("runtime close", () => {
  it("waits for the boot migration a start already began", async () => {
    const harness: TestHarness = await createTestHarness({ loadExtensions: true });
    // The migration is running now: `start()` called it before boot returned.
    await gate.started;
    expect(gate.calls).toBe(1);

    let closed = false;
    const closing = harness.close().then(() => {
      closed = true;
    });
    try {
      const resolvedEarly = await Promise.race([
        closing.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), BROKEN_CLOSE_WINDOW_MS)),
      ]);
      // A close that returns here has left the migration writing under `state/`,
      // and the removal that follows the close in every test harness races it.
      expect(resolvedEarly, "close() resolved while the boot migration was held").toBe(false);
      expect(closed).toBe(false);
    } finally {
      // A failed assertion above must not leave the gate closed: the close is the
      // only thing that removes the harness home, and it is still waiting.
      gate.release();
      await closing;
    }
    expect(closed).toBe(true);
  });
});
