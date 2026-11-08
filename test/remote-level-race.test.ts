import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRemoteFixture, FAKE_MACHINE_ID } from "./remote-helpers.ts";

/**
 * Two defects in the level change.
 *
 * Both are about the same thing: a heartbeat that is already running when the
 * operator moves the slider. Stage 1 moved without looking at it, so a connection
 * it had just opened could stay open for up to five minutes after `off`, and the
 * immediate check that follows a change could run beside it.
 *
 * The fake ssh is a simple one, because these tests are about what the manager
 * does around a heartbeat, not about a run: the answer is a fixed line and the log
 * is the whole evidence.
 */

/** Wait for a condition, giving the runtime's promises a turn each time. */
async function until(check: () => Promise<boolean>, tries = 100): Promise<boolean> {
  for (let index = 0; index < tries; index += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe("a heartbeat that is running while the level moves", () => {
  it("waits for the heartbeat that opened a socket, then closes it", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.respond({ default: { stdout: `${FAKE_MACHINE_ID}\n`, exit: 0 } });
      await fixture.runtime.remoteMachines.setLevel("box-a", "on", BACKGROUND_CONTEXT);
      // The two sockets the real ssh would have left behind, per user: without them
      // `-O exit` is not sent at all, and this test would prove nothing.
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { controlPathFor } = await import("../src/remote/machines.ts");
      const settings = fixture.runtime.remoteMachines.settings();
      const machine = settings?.machines[0];
      if (machine === undefined) throw new Error("box-a is not configured");
      await mkdir(fixture.paths.sshSocketDir, { recursive: true, mode: 0o700 });
      for (const user of machine.users) {
        await writeFile(controlPathFor(fixture.paths, "box-a", user), "", "utf8");
      }

      // A round in flight, and the slider to off while it runs.
      const round = fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      await fixture.runtime.remoteMachines.setLevel("box-a", "off", BACKGROUND_CONTEXT);
      await round;
      const closed = await until(async () =>
        (await fixture.calls()).filter((call) => call.kinds.includes("exit")).length >= 2,
      );
      expect(closed).toBe(true);

      // Both closes came after every heartbeat: the wait is what this proves.
      const calls = await fixture.calls();
      const lastHeartbeat = calls.map((call) => call.kinds.includes("heartbeat")).lastIndexOf(true);
      const firstExit = calls.map((call) => call.kinds.includes("exit")).indexOf(true);
      expect(firstExit).toBeGreaterThan(lastHeartbeat);
    } finally {
      await fixture.close();
    }
  });

  it("skips the immediate check while a heartbeat for that machine is running", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.respond({ default: { stdout: `${FAKE_MACHINE_ID}\n`, exit: 0 } });
      await fixture.runtime.remoteMachines.setLevel("box-a", "on", BACKGROUND_CONTEXT);
      await fixture.clearCalls();

      // A round in flight, and a move to another level that would normally check at
      // once. The round is what records the answer, so the second check is skipped.
      const round = fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await round;

      const calls = await fixture.calls();
      const heartbeats = calls.filter((call) => call.kinds.includes("heartbeat"));
      // One round over two users: two calls, and the level change added none.
      expect(heartbeats.length).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("still checks at once when no heartbeat is running", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.respond({ default: { stdout: `${FAKE_MACHINE_ID}\n`, exit: 0 } });
      await fixture.runtime.remoteMachines.setLevel("box-a", "on", BACKGROUND_CONTEXT);
      await fixture.clearCalls();
      // Nothing else is running, so the change checks now: two users, two calls.
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      const calls = await fixture.calls();
      expect(calls.filter((call) => call.kinds.includes("heartbeat")).length).toBe(2);
    } finally {
      await fixture.close();
    }
  });
});
