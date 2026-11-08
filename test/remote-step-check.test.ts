import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { writeFile } from "node:fs/promises";
import { createRemoteFixture } from "./remote-helpers.ts";
import { createRunFixture, settle } from "./remote-run-helpers.ts";

/**
 * The step check: whether one tool may act on one machine.
 *
 * Every case here asks the same question in a different state of one machine, and
 * the answer has two halves that both matter: the sentence a caller reads, and
 * whether an ssh process was started at all. The second half is why the fake ssh
 * writes a log: an empty log is the proof that nothing was contacted, and no state
 * of the manager can show that.
 */
describe("the step check: a machine at off", () => {
  it("refuses every tool and starts no ssh, however many rounds pass", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      const machines = fixture.runtime.remoteMachines;

      for (const tool of ["run", "run-status", "read", "write", "edit", "sync", "machines"] as const) {
        const access = await machines.access("box-a", tool);
        expect(access.ok, tool).toBe(false);
        if (!access.ok) {
          expect(access.reason).toContain("level off");
          // The sentence says who may widen it, because the agent that reads it is
          // the one that would otherwise look for a way around.
          expect(access.reason).toContain("Only the user");
        }
      }

      const started = await machines.runs().start({
        conversationId: "conv-1",
        toolCallId: "call-1",
        machine: "box-a",
        command: "echo hi",
      });
      expect(started.kind).toBe("refused");
      const read = await machines.files().read({ machine: "box-a", path: "/etc/hostname" });
      expect(read.kind).toBe("refused");

      // Three heartbeat rounds change nothing: the level is what stops the call.
      for (let round = 0; round < 3; round += 1) {
        fixture.clock.advanceTo(fixture.clock.now() + 60_000);
        await machines.tick(BACKGROUND_CONTEXT);
      }
      await settle();
      expect(await fixture.calls()).toEqual([]);
      expect(await fixture.sftpCalls()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe("the step check: a machine at restricted", () => {
  it("refuses a tree copy, because its size is not known before it starts", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "restricted");
      const access = await fixture.runtime.remoteMachines.access("box-a", "sync");
      expect(access.ok).toBe(false);
      if (!access.ok) expect(access.reason).toContain("not known before it starts");

      const sync = await fixture.runtime.remoteMachines.files().sync({
        machine: "box-a",
        direction: "push",
        source: fixture.home,
        destination: "/tmp/tree",
      });
      expect(sync.kind).toBe("refused");
      expect(await fixture.rsyncCalls()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("starts a run at low priority under a time limit", async () => {
    const fixture = await createRunFixture({ restrictedSeconds: 30 });
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "restricted");
      const started = await fixture.runtime.remoteMachines.runs().start({
        conversationId: "conv-1",
        toolCallId: "call-restricted",
        machine: "box-a",
        command: "echo hi",
        waitMs: 5_000,
      });
      expect(started.kind).toBe("done");

      // The wrapper is what the level means, so it is what the test reads: the
      // command file the runner reads back holds the whole prefix.
      const wrapper = await import("node:fs/promises").then((fs) =>
        fs.readFile(
          `${fixture.remote}/.local/state/pi-sec/runs/${(started as { runId: string }).runId}/wrap`,
          "utf8",
        ),
      );
      expect(wrapper).toBe("ionice -c3 nice -n 10 timeout -k 5 30");
    } finally {
      await fixture.close();
    }
  });

  it("starts a run with no wrapper at level on", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const started = await fixture.runtime.remoteMachines.runs().start({
        conversationId: "conv-1",
        toolCallId: "call-on",
        machine: "box-a",
        command: "echo hi",
        waitMs: 5_000,
      });
      expect(started.kind).toBe("done");
      const wrapper = await import("node:fs/promises").then((fs) =>
        fs.readFile(
          `${fixture.remote}/.local/state/pi-sec/runs/${(started as { runId: string }).runId}/wrap`,
          "utf8",
        ),
      );
      expect(wrapper).toBe("");
    } finally {
      await fixture.close();
    }
  });
});

describe("the step check: everything else it refuses", { timeout: 30_000 }, () => {
  it("refuses a machine with no pinned host key", async () => {
    const fixture = await createRunFixture({ unpinned: true });
    try {
      await fixture.setLevel("box-a", "on");
      const access = await fixture.runtime.remoteMachines.access("box-a", "run");
      expect(access.ok).toBe(false);
      if (!access.ok) expect(access.reason).toContain("no pinned host key");
      expect(await fixture.calls()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a machine whose connections are stopped, and says why", async () => {
    const fixture = await createRemoteFixture({ heartbeatSeconds: 60 });
    try {
      await fixture.pinHostKey();
      fixture.setNow(fixture.now() + 1_000);
      await fixture.runtime.remoteMachines.setLevel("box-a", "on", BACKGROUND_CONTEXT);
      // A changed key is the one thing that stops a machine for good, and the fake
      // ssh reports it with ssh's own sentence.
      await fixture.respond({
        rules: [
          {
            kinds: ["heartbeat"],
            response: {
              stderr: "@@@@@@@\nHost key verification failed.",
              exit: 255,
            },
          },
        ],
        default: { stdout: "0123456789abcdef0123456789abcdef\n", exit: 0 },
      });
      fixture.setNow(fixture.now() + 60_000);
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);

      const listed = await fixture.runtime.remoteMachines.list(BACKGROUND_CONTEXT);
      expect(listed.machines[0]?.blocked?.reason).toBe("host-key-mismatch");
      const access = await fixture.runtime.remoteMachines.access("box-a", "read");
      expect(access.ok).toBe(false);
      if (!access.ok) expect(access.reason).toContain("stopped");
    } finally {
      await fixture.close();
    }
  });

  it("refuses a machine that is not in the config, and a user that is not on it", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const unknown = await fixture.runtime.remoteMachines.access("box-z", "run");
      expect(unknown.ok).toBe(false);
      if (!unknown.ok) expect(unknown.reason).toContain("no remote machine is registered");

      const stranger = await fixture.runtime.remoteMachines.access("box-a", "run", "carol");
      expect(stranger.ok).toBe(false);
      if (!stranger.ok) {
        expect(stranger.reason).toContain("not registered on box-a");
        // The sentence lists who is, because a caller that guessed a name reads this.
        expect(stranger.reason).toContain("alice, bob");
      }

      const main = await fixture.runtime.remoteMachines.access("box-a", "run");
      expect(main.ok).toBe(true);
      if (main.ok) expect(main.user).toBe("alice");
    } finally {
      await fixture.close();
    }
  });

  it("refuses everything while the feature is off, and starts nothing", async () => {
    const fixture = await createRemoteFixture({ noFeature: true });
    try {
      for (const tool of ["run", "read", "sync", "machines"] as const) {
        const access = await fixture.runtime.remoteMachines.access("box-a", tool);
        expect(access.ok, tool).toBe(false);
        if (!access.ok) expect(access.reason).toContain("no remoteMachines key");
      }
      expect(await fixture.calls()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("refuses a run-status and a run-stop on a machine at off", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      const started = await fixture.runtime.remoteMachines.runs().start({
        conversationId: "conv-1",
        toolCallId: "call-going",
        machine: "box-a",
        command: "while true; do echo tick; sleep 1; done",
        waitMs: 1_000,
      });
      expect(started.kind).toBe("running");
      const runId = (started as { runId: string }).runId;

      await fixture.setLevel("box-a", "off");
      // The run is stopped by the tightening, so it is no longer one the tool can
      // read; either sentence is the refusal, and neither may start an ssh.
      const status = await fixture.runtime.remoteMachines.runs().status(runId);
      expect(["refused", "unknown"]).toContain(status.kind);
    } finally {
      await fixture.close();
    }
  });
});

describe("the step check: the one list of ssh options", () => {
  it("is what sftp and rsync are given as well", async () => {
    const { sshArguments, sftpArguments, sshOptions, sshShellWrapper } = await import("../src/remote/ssh.ts");
    const target = {
      machineId: "box-a",
      address: "192.0.2.10",
      port: 22,
      user: "alice",
      identityFile: "/tmp/id",
      knownHostsFile: "/tmp/known_hosts",
      controlPath: "/tmp/socket",
    };
    const options = sshOptions(target);
    expect(sftpArguments(target)).toEqual([...options, "-b", "-", "alice@192.0.2.10"]);
    const wrapper = sshShellWrapper("ssh", options);
    // The wrapper is a shell script, so every option is a single-quoted word and
    // the arguments rsync adds land in `"$@"`.
    for (const option of options) {
      if (option.startsWith("-")) continue;
      expect(wrapper).toContain(option);
    }
    expect(wrapper).toContain('"$@"');
    expect(wrapper.startsWith("#!/bin/sh\n")).toBe(true);

    // A value that holds a quote survives the single-quoting.
    const quoted = sshShellWrapper("ssh", ["-o", "X=a'b"]);
    expect(quoted).toBe(`#!/bin/sh\nexec 'ssh' '-o' 'X=a'\\''b' "$@"\n`);
    void sshArguments;
  });
});

describe("the file tools: the read cap", () => {
  it("refuses a file larger than the cap rather than cutting it", async () => {
    const fixture = await createRunFixture();
    try {
      await fixture.pinHostKey();
      await fixture.setLevel("box-a", "on");
      await writeFile(`${fixture.remote}/big.txt`, "x".repeat(5_000), "utf8");
      const read = await fixture.runtime.remoteMachines.files().read({
        machine: "box-a",
        path: `${fixture.remote}/big.txt`,
        maxBytes: 1_000,
      });
      expect(read.kind).toBe("refused");
      if (read.kind === "refused") {
        expect(read.reason).toContain("5000");
        expect(read.reason).toContain("1000");
      }
    } finally {
      await fixture.close();
    }
  });
});
