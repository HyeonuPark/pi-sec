import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRunFixture, settle, waitFor } from "./remote-run-helpers.ts";
import { SecRemoteRun } from "../src/documents.ts";

/**
 * A daemon that comes back.
 *
 * A run outlives the process that started it, so the checks have to as well: the
 * record in the store says which machine to ask and when the next check is due, and
 * a boot reads that. The two cases are these: a check that came
 * due while the daemon was down runs at once, and one that is not due yet gets its
 * timer back. Neither repeats the start, because the run directory is the run and
 * nothing here creates one.
 */
describe("the daemon comes back", { timeout: 30_000 }, () => {
  it("checks a run whose scheduled time passed at once, then keeps the interval", async () => {
    const fixture = await createRunFixture({ runCheckSeconds: 1_800 });
    let second: Awaited<ReturnType<typeof createRunFixture>> | undefined;
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-restart" });
      const started = await fixture.runtime.remoteMachines.runs().start({
        conversationId: conversation,
        toolCallId: "call-restart",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      expect(started.kind).toBe("running");
      const runId = (started as { runId: string }).runId;
      const before = await fixture.runtime.harness.snapshot(SecRemoteRun, runId, BACKGROUND_CONTEXT);
      expect(before?.notices).toBe(0);

      // The daemon is down for longer than one interval, which is exactly a missed
      // check: the promise is a message every interval, so the boot reads the run.
      fixture.clock.advanceTo(fixture.clock.now() + 2 * 1_800 * 1_000);
      second = await fixture.restart();
      await second.pinHostKey();
      // The boot resumes the checks; the message is what says it did, so the test
      // waits for the message rather than for a fixed number of turns.
      const arrived = await waitFor(async () =>
        (await second!.noticesIn(conversation)).some((body) => body.includes("[remote run check]")),
      );
      expect(arrived).toBe(true);
      const resumed = (await second.noticesIn(conversation)).filter((body) =>
        body.includes("[remote run check]"),
      );
      expect(resumed.length).toBe(1);
      expect(resumed[0]).toContain("is still running");

      // The next check is armed from the boot, one interval less the lead away.
      await second.clock.advance((1_800 - 30) * 1_000);
      const twice = await waitFor(async () =>
        (await second!.noticesIn(conversation)).filter((body) => body.includes("[remote run check]")).length >= 2,
      );
      expect(twice).toBe(true);

      // One directory, one record: the second daemon did not start a second run.
      const dirs = await (await import("node:fs/promises")).readdir(
        `${second.remote}/.local/state/pi-sec/runs`,
      );
      expect(dirs).toEqual([runId]);
    } finally {
      if (second !== undefined) await second.close();
      else await fixture.close();
    }
  });

  it("gives a run that is not due yet its timer back without checking it", async () => {
    const fixture = await createRunFixture({ runCheckSeconds: 1_800 });
    let second: Awaited<ReturnType<typeof createRunFixture>> | undefined;
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-early" });
      const started = await fixture.runtime.remoteMachines.runs().start({
        conversationId: conversation,
        toolCallId: "call-early",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      expect(started.kind).toBe("running");

      // A restart one minute later is before the first check is due.
      fixture.clock.advanceTo(fixture.clock.now() + 60_000);
      second = await fixture.restart();
      await second.pinHostKey();
      await settle();
      expect(
        (await second.noticesIn(conversation)).filter((body) => body.includes("[remote run check]")),
      ).toEqual([]);
      // The timer is back, which is the whole difference from the case above.
      expect(second.clock.future()).toBeGreaterThan(0);

      await second.clock.advance((1_800 - 30) * 1_000 - 60_000);
      const arrived = await waitFor(async () =>
        (await second!.noticesIn(conversation)).some((body) => body.includes("[remote run check]")),
      );
      expect(arrived).toBe(true);
    } finally {
      if (second !== undefined) await second.close();
      else await fixture.close();
    }
  });
});
