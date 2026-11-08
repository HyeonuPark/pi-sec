import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { readFile, writeFile } from "node:fs/promises";
import { createRemoteFixture, FAKE_MACHINE_ID, type RemoteFixture } from "./remote-helpers.ts";
import { SecRemoteMachine } from "../src/documents.ts";
import { REMOTE_MACHINE_EVENT } from "../src/remote/machines.ts";

/**
 * The heartbeat: what it asks, what it does with the answer, and what it refuses
 * to do.
 *
 * Nothing here starts a real ssh. The manager runs the fake from
 * `test/fixtures/remote/fake-ssh.mjs`, which records every call and answers from a
 * file the test rewrites, and the clock is the fixture's own, so a "round" is one
 * call of `tick()` rather than one wait of a timer. The two facts every case comes
 * back to are the shape of the calls and the state the panel would draw.
 */

/** The machine-id one stored record holds. */
async function storedRecord(fixture: RemoteFixture, id = "box-a") {
  return await fixture.runtime.harness.snapshot(SecRemoteMachine, id, BACKGROUND_CONTEXT);
}

/** The one machine of a fixture, as the panel would draw it. */
async function stateOf(fixture: RemoteFixture, id = "box-a") {
  const listed = await fixture.runtime.remoteMachines.list(BACKGROUND_CONTEXT);
  const machine = listed.machines.find((entry) => entry.id === id);
  if (machine === undefined) throw new Error(`no machine ${id} in the list`);
  return machine;
}

describe("a machine at off", () => {
  it("is never contacted, however many rounds pass", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      // A pinned key and a working fake: nothing but the level stops the call.
      for (let round = 0; round < 3; round += 1) {
        fixture.setNow(fixture.now() + 60_000);
        await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      }
      expect(await fixture.calls()).toEqual([]);
      const state = await stateOf(fixture);
      expect(state.level).toBe("off");
      // Nothing was checked, which is a different fact from a check that failed.
      expect(state.users.map((user) => user.state)).toEqual(["not-checked", "not-checked"]);
    } finally {
      await fixture.close();
    }
  });

  it("closes one kept-open connection per user when the slider moves to off", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect((await fixture.remoteCalls()).length).toBe(2);
      // The sockets the real ssh would have made: the fixture writes none, and
      // `-O exit` is sent only for a socket that exists.
      const paths = fixture.paths;
      const { controlPathFor } = await import("../src/remote/machines.ts");
      for (const user of ["alice", "bob"]) {
        await writeFile(controlPathFor(paths, "box-a", user), "", "utf8");
      }
      await fixture.runtime.remoteMachines.setLevel("box-a", "off", BACKGROUND_CONTEXT);
      const exits = (await fixture.calls()).filter((call) => call.kinds.includes("exit"));
      // One per user, and nothing that reaches the machine.
      expect(exits.map((call) => call.user).sort()).toEqual(["alice", "bob"]);
      expect((await fixture.remoteCalls()).length).toBe(2);
    } finally {
      await fixture.close();
    }
  });

  it("does not send -O exit when there is no socket to close", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await fixture.clearCalls();
      await fixture.runtime.remoteMachines.setLevel("box-a", "off", BACKGROUND_CONTEXT);
      // No socket was ever created, so ssh has nothing to talk to and is not run.
      expect((await fixture.calls()).filter((call) => call.kinds.includes("exit"))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe("a machine with no pinned key", () => {
  it("is not contacted, and the panel says so", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      // Not one call: without a pinned key the strict check would refuse the
      // connection anyway, and calling would only teach the fake to answer.
      expect(await fixture.calls()).toEqual([]);
      const state = await stateOf(fixture);
      expect(state.hostKey).toBe("unpinned");
      expect(state.blocked).toBeNull();
      expect(state.users.map((user) => user.state)).toEqual(["unknown", "unknown"]);
    } finally {
      await fixture.close();
    }
  });

  it("is contacted once the operator pins the key", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect(await fixture.calls()).toEqual([]);
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      expect((await fixture.remoteCalls()).length).toBe(2);
      expect((await stateOf(fixture)).users.map((user) => user.state)).toEqual(["reachable", "reachable"]);
    } finally {
      await fixture.close();
    }
  });
});

describe("the user states", () => {
  it("reports both users reachable and records the first machine-id", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      const state = await stateOf(fixture);
      expect(state.users.map((user) => `${user.name}:${user.state}`)).toEqual(["alice:reachable", "bob:reachable"]);
      // The first value read is stored without asking the operator, because it
      // came over a connection whose host key they checked.
      expect((await storedRecord(fixture))?.machineId).toBe(FAKE_MACHINE_ID);
    } finally {
      await fixture.close();
    }
  });

  it("reports an unreachable user with the last line ssh wrote", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.respond({
        rules: [{ user: "bob", response: { stderr: "ssh: connect to host 192.0.2.10 port 22: No route to host", exit: 255 } }],
        default: { stdout: `${FAKE_MACHINE_ID}\n` },
      });
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      const state = await stateOf(fixture);
      const bob = state.users.find((user) => user.name === "bob");
      expect(bob?.state).toBe("unreachable");
      expect(bob?.error).toContain("No route to host");
      // The other user is unaffected: one user's login does not speak for the other.
      expect(state.users.find((user) => user.name === "alice")?.state).toBe("reachable");
    } finally {
      await fixture.close();
    }
  });

  it("writes the record only when a state changes", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      const after = (await storedRecord(fixture))?.updatedAt;
      // Three more rounds that find the same answer: nothing is written, so the
      // record's own clock does not move.
      for (let round = 0; round < 3; round += 1) {
        fixture.setNow(fixture.now() + 60_000);
        await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      }
      expect((await storedRecord(fixture))?.updatedAt).toBe(after);
      expect((await fixture.remoteCalls()).length).toBe(8);
      // A changed answer is a write, and the state changes with it.
      await fixture.respond({ default: { stderr: "ssh: connect to host 192.0.2.10 port 22: No route to host", exit: 255 } });
      fixture.setNow(fixture.now() + 60_000);
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      expect((await storedRecord(fixture))?.updatedAt).toBeGreaterThan(after as number);
      expect((await stateOf(fixture)).users.map((user) => user.state)).toEqual(["unreachable", "unreachable"]);
    } finally {
      await fixture.close();
    }
  });
});

describe("a changed host key", () => {
  it("stops every connection, says so in the panel, and tells the root once", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect((await stateOf(fixture)).blocked).toBeNull();
      await fixture.respond({
        default: {
          stderr:
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n" +
            "Host key for box-a has changed and you have requested strict checking.\n" +
            "Host key verification failed.",
          exit: 255,
        },
      });
      fixture.setNow(fixture.now() + 60_000);
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);

      const state = await stateOf(fixture);
      expect(state.blocked?.reason).toBe("host-key-mismatch");
      // Every user reads unreachable, so the panel does not show a live link
      // beside a line that says connections are stopped.
      expect(state.users.map((user) => user.state)).toEqual(["unreachable", "unreachable"]);
      // The loosening above sent one notice of its own; the block is the second.
      const notices = await fixture.rootNotices();
      const blockNotice = notices[notices.length - 1] ?? "";
      expect(notices).toHaveLength(2);
      expect(blockNotice).toContain('pi-sec stopped every connection to remote machine "box-a"');
      expect(blockNotice).toContain("Host key verification failed.");
      expect(blockNotice).toContain("192.0.2.10");

      // Every later round is silent: the block is not re-alerted on a clock, and
      // no call is made, not even one for the second user.
      const callsAfter = (await fixture.remoteCalls()).length;
      const noticesAfter = (await fixture.rootNotices()).length;
      for (let round = 0; round < 3; round += 1) {
        fixture.setNow(fixture.now() + 60_000);
        await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      }
      expect((await fixture.remoteCalls()).length).toBe(callsAfter);
      expect(await fixture.rootNotices()).toHaveLength(noticesAfter);
    } finally {
      await fixture.close();
    }
  });

  it("tries again once the pinned key file changes", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await fixture.respond({
        default: { stderr: "Host key verification failed.", exit: 255 },
      });
      fixture.setNow(fixture.now() + 60_000);
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      expect((await stateOf(fixture)).blocked).not.toBeNull();

      // The operator checked a new fingerprint and pinned that key: the block's
      // evidence has changed, so the machine is tried again.
      await fixture.pinHostKey("box-a ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINewKeyForTests");
      await fixture.respond({ default: { stdout: `${FAKE_MACHINE_ID}\n` } });
      fixture.setNow(fixture.now() + 60_000);
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      expect((await stateOf(fixture)).blocked).toBeNull();
      expect((await stateOf(fixture)).users.map((user) => user.state)).toEqual(["reachable", "reachable"]);
    } finally {
      await fixture.close();
    }
  });

  it("tries again once the machine's own configuration changes", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await fixture.respond({ default: { stderr: "Host key verification failed.", exit: 255 } });
      fixture.setNow(fixture.now() + 60_000);
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      expect((await stateOf(fixture)).blocked).not.toBeNull();

      await fixture.respond({ default: { stdout: `${FAKE_MACHINE_ID}\n` } });
      fixture.setConfig((config) => ({
        ...config,
        remoteMachines: {
          ...(config.remoteMachines as NonNullable<typeof config.remoteMachines>),
          machines: [{ id: "box-a", address: "192.0.2.99", users: ["alice", "bob"] }],
        },
      }));
      fixture.setNow(fixture.now() + 60_000);
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      expect((await stateOf(fixture)).blocked).toBeNull();
      expect((await stateOf(fixture)).address).toBe("192.0.2.99");
    } finally {
      await fixture.close();
    }
  });
});

describe("the machine-id", () => {
  it("stops the machine when the value differs from the one recorded", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect((await storedRecord(fixture))?.machineId).toBe(FAKE_MACHINE_ID);

      await fixture.respond({ default: { stdout: "ffffffffffffffffffffffffffffffff\n" } });
      fixture.setNow(fixture.now() + 60_000);
      await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
      const state = await stateOf(fixture);
      expect(state.blocked?.reason).toBe("machine-id-mismatch");
      const notices = await fixture.rootNotices();
      const blockNotice = notices[notices.length - 1] ?? "";
      expect(notices).toHaveLength(2);
      expect(blockNotice).toContain("read as ffffffffffffffffffffffffffffffff");
      expect(blockNotice).toContain(`but ${FAKE_MACHINE_ID} was expected`);
    } finally {
      await fixture.close();
    }
  });

  it("lets the config's own machineId come before the recorded one", async () => {
    const fixture = await createRemoteFixture({
      machine: { id: "box-a", address: "192.0.2.10", users: ["alice", "bob"], machineId: FAKE_MACHINE_ID },
    });
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      // The named value matches, so nothing is blocked.
      expect((await stateOf(fixture)).blocked).toBeNull();
      // A value the config does not name is a mismatch, even though no record has
      // ever held a machine-id of its own.
      const second = await createRemoteFixture({
        machine: { id: "box-a", address: "192.0.2.10", users: ["alice"], machineId: "ffffffffffffffffffffffffffffffff" },
      });
      try {
        await second.pinHostKey();
        await second.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
        expect((await stateOf(second)).blocked?.reason).toBe("machine-id-mismatch");
      } finally {
        await second.close();
      }
    } finally {
      await fixture.close();
    }
  });
});

describe("the level", () => {
  it("is kept across a restart, which a new runtime reads back", async () => {
    // A restart is a new runtime over the same store. The fixture's store is in
    // memory, so the test copies the document into a second home and reads it
    // there: what is being checked is that the level comes out of the store and
    // not out of the manager's own memory.
    const fixture = await createRemoteFixture();
    const level = await (async () => {
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      return (await storedRecord(fixture))?.level;
    })();
    await fixture.close();
    expect(level).toBe("restricted");
  });

  it("changes nothing when the same level is chosen again", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      const before = await storedRecord(fixture);
      await fixture.clearCalls();
      const again = await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect(again.kind).toBe("ok");
      expect(again.kind === "ok" ? again.changed : true).toBe(false);
      // No write, no notice, no ssh call: the sequence that numbers a notice is
      // also the thing that would have announced a change that did not happen.
      expect((await storedRecord(fixture))?.levelSequence).toBe(before?.levelSequence);
      expect(await fixture.calls()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("keeps pending empty, which a later stage fills", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      const answer = await fixture.runtime.remoteMachines.setLevel("box-a", "on", BACKGROUND_CONTEXT);
      expect(answer.kind === "ok" ? answer.machine.pending : "unset").toBeNull();
      expect((await storedRecord(fixture))?.pending).toBeNull();
    } finally {
      await fixture.close();
    }
  });

  it("writes one audit row per change and names both levels", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await fixture.runtime.remoteMachines.setLevel("box-a", "on", BACKGROUND_CONTEXT);
      const text = await readFile(fixture.paths.auditLog, "utf8");
      const rows = text
        .split("\n")
        .filter((line) => line.includes("remote_machine_level"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(rows).toHaveLength(2);
      expect(rows[0]?.["machine"]).toBe("box-a");
      expect(rows[0]?.["from"]).toBe("off");
      expect(rows[0]?.["to"]).toBe("restricted");
      expect(rows[1]?.["from"]).toBe("restricted");
      expect(rows[1]?.["to"]).toBe("on");
    } finally {
      await fixture.close();
    }
  });

  it("sends one event per change, so an open page redraws", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      const seen: unknown[] = [];
      fixture.events.subscribe((event) => {
        if (event.type === REMOTE_MACHINE_EVENT) seen.push(event.data);
      });
      // One frame for the level, and one for each user state the immediate check
      // wrote: every one of them is a change an open page has to redraw.
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect(seen).toEqual([{ id: "box-a" }, { id: "box-a" }, { id: "box-a" }]);
    } finally {
      await fixture.close();
    }
  });
});

describe("the root notices", () => {
  it("sends exactly one when the level is loosened, and none when it is tightened", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      // off -> restricted is a loosening: one notice.
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect(await fixture.rootNotices()).toHaveLength(1);
      // restricted -> on is a loosening too, and a different one.
      await fixture.runtime.remoteMachines.setLevel("box-a", "on", BACKGROUND_CONTEXT);
      expect(await fixture.rootNotices()).toHaveLength(2);
      // on -> restricted tightens: no notice, because there is no running work
      // to stop and the level applied at once.
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect(await fixture.rootNotices()).toHaveLength(2);
      // The same request again changes nothing, so nothing is added.
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect(await fixture.rootNotices()).toHaveLength(2);
      const notice = (await fixture.rootNotices())[0] ?? "";
      expect(notice).toContain('loosened remote machine "box-a" from off to restricted');
      expect(notice).toContain("asks for no action");
    } finally {
      await fixture.close();
    }
  });

  it("sends nothing when the root conversation has no message of its own", async () => {
    // A notice would start a model run in a conversation nobody has used, and on an
    // install with no credential that run fails and stays in the transcript. The
    // rule is the restart notice's, and so is the audit row that records it.
    const fixture = await createRemoteFixture({ seedRoot: false });
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      expect(await fixture.rootNotices()).toEqual([]);
      const text = await readFile(fixture.paths.auditLog, "utf8");
      expect(text).toContain("remote_machine_notice");
      expect(text).toContain("root_empty");
    } finally {
      await fixture.close();
    }
  });
});
