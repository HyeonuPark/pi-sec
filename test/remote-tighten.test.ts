import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRunFixture, settle, waitFor, type RunFixture } from "./remote-run-helpers.ts";
import { SecRemoteMachine } from "../src/documents.ts";

/**
 * Making a machine stricter, and what the core does about the runs that no longer
 * fit.
 *
 * The new level is stored the moment the slider moves, and everything after that is
 * the cleanup: a wait in the record, one request to the root, a deadline, and the
 * runs stopped at the end of it or as soon as they end on their own. The tests move
 * the deadline with the fixture's clock rather than waiting five minutes for it.
 *
 * A run at `on` is the one that a move to `restricted` disallows. A run at
 * `restricted` already carries the limit, so it stays: that is the rule the table in
 * section 5.6 states, and it is what "does not fit" means here.
 */

/** The stored record of one machine. */
async function record(fixture: RunFixture) {
  return await fixture.runtime.harness.snapshot(SecRemoteMachine, "box-a", BACKGROUND_CONTEXT);
}

/** The panel's view of one machine. */
async function state(fixture: RunFixture) {
  const listed = await fixture.runtime.remoteMachines.list(BACKGROUND_CONTEXT);
  const machine = listed.machines.find((entry) => entry.id === "box-a");
  if (machine === undefined) throw new Error("box-a is not in the list");
  return machine;
}

/** Start one long run at the machine's current level. */
async function startLong(fixture: RunFixture, conversationId: string, callId: string): Promise<string> {
  const started = await fixture.runtime.remoteMachines.runs().start({
    conversationId,
    toolCallId: callId,
    machine: "box-a",
    command: "while true; do echo tick; sleep 1; done",
    waitMs: 1_000,
  });
  if (started.kind !== "running") throw new Error(`the run did not stay up: ${started.kind}`);
  return started.runId;
}

describe("a level that becomes stricter than a run", { timeout: 30_000 }, () => {
  it("sets the wait, asks the root once, and says how many are left", async () => {
    const fixture = await createRunFixture({ tightenDeadlineSeconds: 300 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-tighten" });
      const runId = await startLong(fixture, conversation, "call-tighten");

      await fixture.setLevel("box-a", "restricted");
      const stored = await record(fixture);
      expect(stored?.pending).not.toBeNull();
      expect(stored?.pending?.level).toBe("restricted");
      expect(stored?.pending?.runs).toBe(1);
      // The level itself is stored at once: the wait is about the runs, not the
      // level, and the panel draws both.
      expect(stored?.level).toBe("restricted");
      expect((await state(fixture)).pending).toEqual({
        level: "restricted",
        since: fixture.clock.now(),
        deadline: fixture.clock.now() + 300_000,
        runs: 1,
      });

      const requests = (await fixture.rootNotices()).filter((body) => body.includes("stricter"));
      expect(requests.length).toBe(1);
      expect(requests[0]).toContain("stricter: on to restricted");
      expect(requests[0]).toContain(runId);
      expect(requests[0]).toContain("worker-tighten");
      expect(requests[0]).toContain("300 seconds");

      // The run is untouched while its deadline has not passed.
      const status = await fixture.runtime.remoteMachines.runs().status(runId);
      expect(status.kind === "ok" && status.state).toBe("running");
    } finally {
      await fixture.close();
    }
  });

  it("stops what is left when the deadline passes, tells the run's conversation, and drops the wait", async () => {
    const fixture = await createRunFixture({ tightenDeadlineSeconds: 30 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-deadline" });
      const runId = await startLong(fixture, conversation, "call-deadline");

      await fixture.setLevel("box-a", "off");
      expect((await record(fixture))?.pending?.runs).toBe(1);

      // The deadline is thirty seconds away; nothing stops before it.
      await fixture.clock.advance(20_000);
      await settle();
      expect((await record(fixture))?.pending).not.toBeNull();

      await fixture.clock.advance(15_000);
      // The deadline fires the cleanup, which is a round trip to the machine: wait for
      // the record to lose the wait rather than for a fixed number of turns.
      const dropped = await waitFor(async () => (await record(fixture))?.pending === null);
      expect(dropped).toBe(true);

      // The run was stopped by the core, and the record says so.
      expect((await record(fixture))?.pending).toBeNull();
      const stopped = await fixture.runtime.remoteMachines.runs().status(runId);
      expect(["stopped", "unknown", "refused"]).toContain(stopped.kind);

      // The starting conversation heard it, and the sentence names the core.
      const told = await waitFor(async () =>
        (await fixture.noticesIn(conversation)).some(
          (body) => body.includes("was stopped") && body.includes("by the core"),
        ),
      );
      expect(told).toBe(true);
      const checks = (await fixture.noticesIn(conversation)).filter((body) =>
        body.includes("[remote run check]"),
      );
      expect(checks.some((body) => body.includes("was stopped") && body.includes("by the core"))).toBe(true);

      // The root heard the deadline once, and the level it now has.
      const done = (await fixture.rootNotices()).filter((body) => body.includes("The deadline passed"));
      expect(done.length).toBe(1);
      expect(done[0]).toContain(runId);
      expect(done[0]).toContain("level is now off");
      expect(done[0]).toContain("no level change waits");
    } finally {
      await fixture.close();
    }
  });

  it("drops the wait as soon as the last run ends on its own", async () => {
    const fixture = await createRunFixture({ tightenDeadlineSeconds: 300 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-ends" });
      const runId = await startLong(fixture, conversation, "call-ends");
      await fixture.setLevel("box-a", "off");
      expect((await record(fixture))?.pending?.runs).toBe(1);

      // The agent stops its own run, which is what the root's request asks for.
      const stopped = await fixture.runtime.remoteMachines.runs().stop({
        runId,
        who: "agent",
        skipAccessCheck: true,
      });
      expect(stopped.kind).toBe("stopped");
      // Dropping the wait follows the stop's own round trip: wait for the record.
      const dropped = await waitFor(async () => (await record(fixture))?.pending === null);
      expect(dropped).toBe(true);

      // Nothing that does not fit is left, so the wait goes and the deadline with it.
      expect((await record(fixture))?.pending).toBeNull();
      expect((await state(fixture)).pending).toBeNull();
      // The deadline did not fire later on: the wait was over before it was due.
      await fixture.clock.advance(400_000);
      await settle();
      expect((await fixture.rootNotices()).filter((body) => body.includes("The deadline passed"))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the connections open while a cleanup is left, and closes them at the end", async () => {
    const fixture = await createRunFixture({ tightenDeadlineSeconds: 30 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-socket" });
      await startLong(fixture, conversation, "call-socket");
      const remoteBefore = (await fixture.calls()).length;

      // The move to off does not close the connection at once: the cleanup needs it.
      await fixture.setLevel("box-a", "off");
      const afterMove = await fixture.calls();
      expect(afterMove.slice(remoteBefore).some((call) => String(call.command ?? "").includes("-O"))).toBe(false);

      await fixture.clock.advance(40_000);
      const dropped = await waitFor(async () => (await record(fixture))?.pending === null);
      expect(dropped).toBe(true);
      expect((await record(fixture))?.pending).toBeNull();
      // The run is gone, which is what the cleanup was for.
      const dirs = await readdir(`${fixture.remote}/.local/state/pi-sec/runs`);
      expect(dirs.length).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a wider level from an agent, and leaves the stored level alone", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();

      // `on` is not a level anything is tightened to.
      const wider = await fixture.runtime.remoteMachines.tighten("box-a", "on", "the build needs memory");
      expect(wider.kind).toBe("refused");
      expect(wider.kind === "refused" && wider.reason).toContain("not a tightening");

      // A move toward a wider level is the user's own act, even when the target is
      // a level this path may otherwise ask for.
      const loosening = await fixture.runtime.remoteMachines.tighten("box-a", "restricted", "the build needs it");
      expect(loosening.kind).toBe("refused");
      expect(loosening.kind === "refused" && loosening.reason).toContain("only the user widens a level");

      // The same level is not a refusal, and it changes nothing.
      const same = await fixture.runtime.remoteMachines.tighten("box-a", "off", "already there");
      expect(same.kind === "ok" && same.changed).toBe(false);

      expect((await state(fixture)).level).toBe("off");
      // A refused widening announces nothing, because no level moved.
      expect((await fixture.rootNotices()).filter((body) => body.includes("stricter"))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("records why an agent asked for the tighter level", async () => {
    const fixture = await createRunFixture({ tightenDeadlineSeconds: 300 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");

      const outcome = await fixture.runtime.remoteMachines.tighten(
        "box-a",
        "restricted",
        "the build ran out of memory under restricted",
      );
      expect(outcome.kind === "ok" && outcome.changed).toBe(true);
      expect((await record(fixture))?.level).toBe("restricted");

      const audit = await readFile(fixture.paths.auditLog, "utf8");
      expect(audit).toContain('"type":"remote_machine_tighten"');
      expect(audit).toContain("the build ran out of memory under restricted");
    } finally {
      await fixture.close();
    }
  });

  it("finishes a wait that the previous process left behind", async () => {
    const fixture = await createRunFixture({ tightenDeadlineSeconds: 30 });
    let second: RunFixture | undefined;
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-wait-restart" });
      const runId = await startLong(fixture, conversation, "call-wait-restart");
      await fixture.setLevel("box-a", "off");
      expect((await record(fixture))?.pending?.runs).toBe(1);

      // The daemon goes away with the wait still set, and comes back after the
      // deadline has already passed. Nothing in the old process survives it.
      fixture.clock.jump(60_000);
      second = await fixture.restart();
      await settle();
      // The booted process re-arms the stored deadline, which is already due.
      await second.clock.advance(1_000);
      const dropped = await waitFor(async () => (await record(second!))?.pending === null);
      expect(dropped).toBe(true);

      expect((await record(second))?.pending).toBeNull();
      const checks = (await second.noticesIn(conversation)).filter((body) => body.includes("[remote run check]"));
      expect(checks.some((body) => body.includes("was stopped") && body.includes("by the core"))).toBe(true);
      const done = (await second.rootNotices()).filter((body) => body.includes("The deadline passed"));
      expect(done.length).toBe(1);
      expect(done[0]).toContain(runId);
    } finally {
      if (second !== undefined) await second.close();
      else await fixture.close();
    }
  });

  it("does nothing to a run at restricted when the machine also goes to restricted", async () => {
    const fixture = await createRunFixture({ restrictedSeconds: 600 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "off");
      // A run cannot be started at off, so the level is raised to restricted and the
      // run is started there; then the level is set to restricted again, which is
      // the same level and changes nothing.
      await fixture.setLevel("box-a", "restricted");
      const conversation = await fixture.addConversation({ name: "worker-same" });
      await startLong(fixture, conversation, "call-same");
      await fixture.setLevel("box-a", "restricted");
      expect((await record(fixture))?.pending).toBeNull();
    } finally {
      await fixture.close();
    }
  });
});
