import { describe, expect, it } from "vitest";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { createRunFixture, fakeMachineProcesses, settle, waitFor, type RunFixture } from "./remote-run-helpers.ts";
import { runIdFor } from "../src/remote/runs.ts";
import { SecRemoteRun } from "../src/documents.ts";

/**
 * One detached run, and the checks that follow it.
 *
 * Everything here runs a real command in a directory that plays the remote home:
 * the runner writes its pid and start time, the command writes its output, and the
 * exit status arrives in a file. So a judgment here is a judgment of the protocol
 * `src/remote/runs.ts` really uses, not of a stub that says what the test wants.
 *
 * The clock is the fixture's. A thirty-minute interval passes in `clock.advance`,
 * which is the only way to test the promise "a message every interval" without
 * waiting for one.
 */

/** The run directory of one run on the fake machine. */
function runDir(fixture: RunFixture, runId: string): string {
  return `${fixture.remote}/.local/state/pi-sec/runs/${runId}`;
}

/**
 * Kill a run the way an outside kill does: the whole process group goes.
 *
 * `src/remote/runs.ts` starts the runner with `setsid`, so the runner's number is
 * the group's. Killing only the runner would leave the command it started running,
 * which outlives the test that killed it. A run at `restricted` is not one group,
 * because `timeout` puts itself in a group of its own, and nothing here relies on
 * a group kill reaching such a run: `fixture.close()` sweeps the fixture's own
 * processes by their environment.
 */
function killRun(pid: number): void {
  process.kill(-pid, "SIGKILL");
}

/**
 * What is left of one fixture's machine, as one line per process.
 *
 * A test that fails here should name the processes that outlived the stop, not
 * only their numbers: the `timeout` wrapper and the command it watches are two
 * ways for the same stop to have missed.
 */
async function machineLeftovers(remote: string): Promise<string[]> {
  const lines: string[] = [];
  for (const pid of await fakeMachineProcesses(remote)) {
    let command = "";
    try {
      command = (await readFile(`/proc/${String(pid)}/cmdline`, "utf8"))
        .split("\u0000")
        .filter((part) => part !== "")
        .join(" ");
    } catch {
      // It went between the scan and the read, which is what the test waits for.
      continue;
    }
    lines.push(`${String(pid)} ${command}`);
  }
  return lines;
}

/** The record of one run, as the store holds it. */
async function recordOf(fixture: RunFixture, runId: string) {
  return await fixture.runtime.harness.snapshot(SecRemoteRun, runId, BACKGROUND_CONTEXT);
}

describe("a run starts once, however many times the call repeats", { timeout: 30_000 }, () => {
  it("makes one directory and answers the first run's state", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const runs = fixture.runtime.remoteMachines.runs();
      const call = {
        conversationId: "conv-1",
        toolCallId: "call-1",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      };
      const first = await runs.start(call);
      expect(first.kind).toBe("running");
      const runId = (first as { runId: string }).runId;
      expect(runId).toBe(runIdFor("conv-1", "call-1"));

      const second = await runs.start(call);
      expect(second.kind).toBe("running");
      expect((second as { runId: string }).runId).toBe(runId);
      expect((second as { startedAt: number }).startedAt).toBe((first as { startedAt: number }).startedAt);

      // One directory, and one run record: the second call started nothing.
      const dirs = await readdir(`${fixture.remote}/.local/state/pi-sec/runs`);
      expect(dirs).toEqual([runId]);
      // Two calls to the machine at most: the start and the wait. The repeat is
      // answered from the store, so it costs no ssh at all.
      // One start call carries the whole script, base64-encoded, so the start is
      // counted by what it did rather than by a word inside it: the run directory.
      const calls = await fixture.calls();
      expect(calls.length).toBeGreaterThan(0);
      expect(dirs.length).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("keeps the run id safe as a file name, whatever the ids hold", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const started = await fixture.runtime.remoteMachines.runs().start({
        conversationId: "../../etc/passwd",
        toolCallId: "call:1 / with ünicode",
        machine: "box-a",
        command: "echo hi",
        waitMs: 5_000,
      });
      expect(started.kind).toBe("done");
      const runId = (started as { runId: string }).runId;
      expect(runId).toMatch(/^run-[0-9a-f]{20}$/);
      const dirs = await readdir(`${fixture.remote}/.local/state/pi-sec/runs`);
      expect(dirs).toEqual([runId]);
    } finally {
      await fixture.close();
    }
  });
});

describe("the four judgments", { timeout: 30_000 }, () => {
  it("reads a run that finished with its exit code and the end of its output", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const started = await fixture.runtime.remoteMachines.runs().start({
        conversationId: "conv-1",
        toolCallId: "call-short",
        machine: "box-a",
        command: "echo one; echo two; exit 3",
        waitMs: 10_000,
      });
      expect(started.kind).toBe("done");
      const done = started as { code: number; output: string };
      expect(done.code).toBe(3);
      expect(done.output).toContain("one");
      expect(done.output).toContain("two");
    } finally {
      await fixture.close();
    }
  });

  it("judges a run whose process is alive as running, and one whose process was killed as lost", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const runs = fixture.runtime.remoteMachines.runs();
      const started = await runs.start({
        conversationId: "conv-1",
        toolCallId: "call-long",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      expect(started.kind).toBe("running");
      const runId = (started as { runId: string }).runId;

      const running = await runs.status(runId);
      expect(running.kind).toBe("ok");
      if (running.kind === "ok") {
        expect(running.state).toBe("running");
        expect(running.output).toContain("tick");
        expect(running.grewAt).not.toBeNull();
      }

      // Somebody killed the process from outside: the exit file stays absent and
      // the pid is gone, which is "lost" and nothing else.
      const record = await recordOf(fixture, runId);
      killRun(record!.pid);
      // The run is gone when the number it wrote is no longer a process, which is the
      // fact the check reads with `kill -0`: wait for that, not for a window.
      const gone = await waitFor(async () => {
        try {
          process.kill(record!.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      expect(gone).toBe(true);

      const lost = await runs.status(runId);
      expect(lost.kind).toBe("ok");
      if (lost.kind === "ok") expect(lost.state).toBe("lost");
    } finally {
      await fixture.close();
    }
  });

  it("judges a live process number with another start time as lost", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const runs = fixture.runtime.remoteMachines.runs();
      const started = await runs.start({
        conversationId: "conv-1",
        toolCallId: "call-reused",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      const runId = (started as { runId: string }).runId;
      const record = await recordOf(fixture, runId);
      expect(record).toBeDefined();
      const pidFile = join(fixture.remote, ".local/state/pi-sec/runs", runId, "pid");

      // A process number that is reused is the case this whole comparison exists
      // for. The run's own process goes, and another one takes its number: the run
      // directory still names the number and the start time the run had, and only a
      // live process with another start time can say that it is not the run.
      killRun(record!.pid);
      const stand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      try {
        const standPid = stand.pid ?? 0;
        // The kernel makes the process before this reads its file: wait for the file.
        const up = await waitFor(async () => {
          try {
            await readFile(`/proc/${String(standPid)}/stat`, "utf8");
            return true;
          } catch {
            return false;
          }
        });
        expect(up).toBe(true);
        const stat = await readFile(`/proc/${String(standPid)}/stat`, "utf8");
        const standTick = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];

        // The number is the stand-in's and the start time is the run's.
        await writeFile(pidFile, `${String(standPid)} ${record!.tick}\n`, "utf8");
        const judged = await runs.status(runId);
        expect(judged.kind).toBe("ok");
        if (judged.kind === "ok") {
          // The process is alive, so the start time is the only thing that says it
          // is not the run: without that comparison this reads as running.
          expect(judged.state).toBe("lost");
        }

        // The same live process, recorded with its own start time, reads as
        // running: the comparison decides, and being alive alone decides nothing.
        await writeFile(pidFile, `${String(standPid)} ${String(standTick)}\n`, "utf8");
        const again = await runs.status(runId);
        expect(again.kind === "ok" && again.state).toBe("running");
      } finally {
        stand.kill("SIGKILL");
      }
    } finally {
      await fixture.close();
    }
  });

  it("judges a machine that cannot be asked as unreachable, not as a lost run", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const started = await fixture.runtime.remoteMachines.runs().start({
        conversationId: "conv-1",
        toolCallId: "call-away",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      const runId = (started as { runId: string }).runId;

      // The machine is away from now on. The manager's own ssh env is fixed at
      // boot, so the second boot is where a failing machine is expressed.
      const away = await fixture.restart({
        sshFail: "ssh: connect to host 192.0.2.10 port 22: No route to host",
      });
      try {
        await away.pinHostKey();
        const status = await away.runtime.remoteMachines.runs().status(runId);
        expect(status.kind).toBe("unreachable");
        if (status.kind === "unreachable") expect(status.reason).toContain("No route to host");
      } finally {
        await away.close();
      }
    } finally {
      await settle();
    }
  });

  it("judges a stopped run as stopped, and names who stopped it", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const runs = fixture.runtime.remoteMachines.runs();
      const started = await runs.start({
        conversationId: "conv-1",
        toolCallId: "call-stop",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      const runId = (started as { runId: string }).runId;
      const stopped = await runs.stop({ runId, who: "agent" });
      expect(stopped.kind).toBe("stopped");

      const after = await runs.status(runId);
      expect(after.kind).toBe("ok");
      if (after.kind === "ok") expect(after.state).toBe("stopped");
    } finally {
      await fixture.close();
    }
  });
  it("stops every process of a restricted run, not only the runner", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      // `restricted` wraps the command in `timeout`, and `timeout` puts itself in a
      // process group of its own: from then on the runner's group is the runner
      // alone, and a stop that signals only that group leaves the wrapper and the
      // command running until the level's limit runs out.
      await fixture.setLevel("box-a", "restricted");
      const runs = fixture.runtime.remoteMachines.runs();
      const started = await runs.start({
        conversationId: "conv-1",
        toolCallId: "call-stop-restricted",
        machine: "box-a",
        command: "while true; do sleep 1; done",
        waitMs: 1_000,
      });
      expect(started.kind).toBe("running");
      const runId = (started as { runId: string }).runId;

      // The run is up, and it is more than the runner: the wrapper and the command
      // are processes of the same run.
      const up = await waitFor(async () => (await fakeMachineProcesses(fixture.remote)).length >= 2);
      expect(up).toBe(true);

      const stopped = await runs.stop({ runId, who: "agent" });
      expect(stopped.kind).toBe("stopped");

      // Nothing of the run is left, and the assertion names what is, if anything.
      // The fixture's own cleanup must not be what empties the machine here, so it
      // runs in `finally`, after this check.
      const limit = Date.now() + 5_000;
      let left = await machineLeftovers(fixture.remote);
      while (left.length > 0 && Date.now() < limit) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        left = await machineLeftovers(fixture.remote);
      }
      expect(left).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 30_000);
});

describe("a check reports on its own clock", { timeout: 30_000 }, () => {
  it("sends one message per interval, each with its own request id", async () => {
    const fixture = await createRunFixture({ runCheckSeconds: 1_800 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-a" });
      const runs = fixture.runtime.remoteMachines.runs();
      const started = await runs.start({
        conversationId: conversation,
        toolCallId: "call-interval",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      const runId = (started as { runId: string }).runId;

      // The check is armed for one interval less the lead, so the first message is
      // inside the promised interval.
      await fixture.clock.advance((1_800 - 30) * 1_000);
      // The message follows an ssh round trip that can outlast the timer that started
      // it, so the test waits for the message and not for the timer.
      const arrived = await waitFor(async () => (await fixture.noticesIn(conversation)).length === 1);
      expect(arrived).toBe(true);
      const first = await fixture.noticesIn(conversation);
      expect(first.length).toBe(1);
      expect(first[0]).toContain("is still running");

      await fixture.clock.advance((1_800 - 30) * 1_000);
      const twice = await waitFor(async () => (await fixture.noticesIn(conversation)).length === 2);
      expect(twice).toBe(true);
      const second = await fixture.noticesIn(conversation);
      expect(second.length).toBe(2);
      expect(second[1]).toContain("is still running");

      // Each check has an id of its own, so the two are two inputs, not one.
      const record = await recordOf(fixture, runId);
      expect(record?.notices).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("reports a finished run once, with its exit code, and stops checking", async () => {
    const fixture = await createRunFixture({ runCheckSeconds: 1_800 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-b" });
      const runs = fixture.runtime.remoteMachines.runs();
      // It outlives the start's own wait and ends before the first check, so the
      // check is what reads the exit status: a run that ends inside the wait is
      // answered by the calling tool and never reported.
      const started = await runs.start({
        conversationId: conversation,
        toolCallId: "call-finish",
        machine: "box-a",
        command: "sleep 2; echo hi; exit 7",
        waitMs: 500,
      });
      expect(started.kind).toBe("running");
      const runId = (started as { runId: string }).runId;
      // The runner writes `exit` when the command ends, and that file is what a check
      // reads: wait for it rather than twice the length of the command.
      const ended = await waitFor(async () => {
        try {
          await access(join(runDir(fixture, runId), "exit"));
          return true;
        } catch {
          return false;
        }
      });
      expect(ended).toBe(true);
      // The command is done; the first check finds the exit status.
      await fixture.clock.advance((1_800 - 30) * 1_000);
      const arrived = await waitFor(async () => (await fixture.noticesIn(conversation)).length === 1);
      expect(arrived).toBe(true);
      const notices = await fixture.noticesIn(conversation);
      expect(notices.length).toBe(1);
      expect(notices[0]).toContain("finished");
      expect(notices[0]).toContain("exit code 7");

      // No timer is left for a run whose story ended.
      expect(fixture.clock.pending()).toBe(0);
      const again = await fixture.noticesIn(conversation);
      expect(again.length).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  it("reports a lost run once and stops", async () => {
    const fixture = await createRunFixture({ runCheckSeconds: 1_800 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-c" });
      const runs = fixture.runtime.remoteMachines.runs();
      const started = await runs.start({
        conversationId: conversation,
        toolCallId: "call-lost",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      const runId = (started as { runId: string }).runId;
      const record = await recordOf(fixture, runId);
      killRun(record!.pid);
      const gone = await waitFor(async () => {
        try {
          process.kill(record!.pid, 0);
          return false;
        } catch {
          return true;
        }
      });
      expect(gone).toBe(true);

      await fixture.clock.advance((1_800 - 30) * 1_000);
      const arrived = await waitFor(async () => (await fixture.noticesIn(conversation)).length === 1);
      expect(arrived).toBe(true);
      const notices = await fixture.noticesIn(conversation);
      expect(notices.length).toBe(1);
      expect(notices[0]).toContain("is lost");
      expect(fixture.clock.pending()).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("says a scheduled check could not read the run, and says nothing on the retry", async () => {
    const fixture = await createRunFixture({ runCheckSeconds: 1_800 });
    const runId = "run-0123456789abcdef0123";
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-d" });
      const runs = fixture.runtime.remoteMachines.runs();
      const started = await runs.start({
        conversationId: conversation,
        toolCallId: "call-away-check",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      const id = (started as { runId: string }).runId;
      // The machine goes away while the daemon is down: a directory that is not
      // there would read as a lost run, so the second boot is told its ssh fails.
      // The daemon stops before the check is due; the clock moves while nothing is
      // running, which is what makes the missed check a fact of the store.
      fixture.clock.jump((1_800 - 30) * 1_000);
      const away = await fixture.restart({
        sshFail: "ssh: connect to host 192.0.2.10 port 22: No route to host",
      });
      try {
        await away.pinHostKey();
        // The new daemon resumes: the due time has passed, so it checks now.
        await away.runtime.remoteMachines.runs().resume(BACKGROUND_CONTEXT);
        const arrived = await waitFor(async () =>
          (await away.noticesIn(conversation)).some((body) => body.includes("[remote run check]")),
        );
        expect(arrived).toBe(true);
        const notices = (await away.noticesIn(conversation)).filter((body) => body.includes("[remote run check]"));
        expect(notices.length).toBe(1);
        expect(notices[0]).toContain("cannot be read");
        expect(notices[0]).toContain("No route to host");

        // Sixty seconds later the retry runs and says nothing: the reader was told.
        await away.clock.advance(60_000);
        await settle();
        const afterRetry = (await away.noticesIn(conversation)).filter((body) => body.includes("[remote run check]"));
        expect(afterRetry.length).toBe(1);
        void id;
      } finally {
        await away.close();
      }
    } finally {
      void runId;
    }
  });

  it("sends a check to the root when the starting conversation is gone", async () => {
    const fixture = await createRunFixture({ runCheckSeconds: 1_800 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const runs = fixture.runtime.remoteMachines.runs();
      // A conversation that is not in the store: the record names it, nothing can
      // read it, so the root is where the message can be read.
      const started = await runs.start({
        conversationId: "conv-missing",
        toolCallId: "call-root",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      expect(started.kind).toBe("running");
      await fixture.clock.advance((1_800 - 30) * 1_000);
      const arrived = await waitFor(async () =>
        (await fixture.rootNotices()).some((body) => body.includes("[remote run check]")),
      );
      expect(arrived).toBe(true);
      const root = (await fixture.rootNotices()).filter((body) => body.includes("[remote run check]"));
      expect(root.length).toBe(1);
      expect(root[0]).toContain("is still running");
      expect(await fixture.noticesIn("conv-missing")).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

/**
 * The timer outlives the call that armed it.
 *
 * A remote run is started by a tool call, and the call ends as soon as the tool
 * answers: the run is still going, but the invocation that made it is over, and
 * every commit or read made with that call's context rejects. The timer a run
 * arms therefore cannot keep the call's context, and it cannot stop when one
 * check throws, because the run it checks is still on the machine.
 */
describe("a check does not depend on the call that started the run", { timeout: 30_000 }, () => {
  it("delivers a scheduled check after the starting call has ended", async () => {
    const fixture = await createRunFixture({ runCheckSeconds: 1_800 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-ended" });
      const runs = fixture.runtime.remoteMachines.runs();
      // The context of one tool call, shaped as the durable layer makes it: its
      // signal belongs to the invocation, and that signal aborts when the call
      // ends. A commit made with it then rejects with the invocation's reason,
      // which is what the daemon logged at the first check of a run whose
      // starting call was over.
      const call = withCancel(BACKGROUND_CONTEXT);
      const started = await runs.start({
        conversationId: conversation,
        toolCallId: "call-ended",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
        ctx: call.context,
      });
      expect(started.kind).toBe("running");
      call.cancel(new Error("Task call-ended invocation has ended"));

      await fixture.clock.advance((1_800 - 30) * 1_000);
      // The check finished before the clock's advance returned, so the message is
      // in the conversation and the run has its next timer.
      const arrived = await waitFor(async () => (await fixture.noticesIn(conversation)).length === 1);
      expect(arrived).toBe(true);
      const notices = await fixture.noticesIn(conversation);
      expect(notices.length).toBe(1);
      expect(notices[0]).toContain("is still running");
      expect(fixture.clock.pending()).toBe(1);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("arms the next check when one check throws, and that check delivers", async () => {
    const fixture = await createRunFixture({ runCheckSeconds: 1_800 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const conversation = await fixture.addConversation({ name: "worker-throw" });
      const runs = fixture.runtime.remoteMachines.runs();
      const started = await runs.start({
        conversationId: conversation,
        toolCallId: "call-throw",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      expect(started.kind).toBe("running");

      // A zone name that `Intl` refuses makes the check throw while it builds its
      // sentence, before it writes or sends anything: one real check failing, with
      // no stub of the manager behind it.
      fixture.setConfig((config) => ({ ...config, timezone: "Not/AZone" }));
      await fixture.clock.advance((1_800 - 30) * 1_000);
      expect(await fixture.noticesIn(conversation)).toEqual([]);
      // The run is still going, so a timer is still armed for it: the retry's
      // interval, not the check's own.
      expect(fixture.clock.pending()).toBe(1);

      // The next attempt is the delay after the failed one, and it reports: the
      // scheduled time did not move, so the message the interval promises arrives.
      fixture.setConfig((config) => ({ ...config, timezone: "UTC" }));
      await fixture.clock.advance(60_000);
      const arrived = await waitFor(async () => (await fixture.noticesIn(conversation)).length === 1);
      expect(arrived).toBe(true);
      const notices = await fixture.noticesIn(conversation);
      expect(notices.length).toBe(1);
      expect(notices[0]).toContain("is still running");
    } finally {
      await fixture.close();
    }
  });
});
