import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { createRemoteFixture, FAKE_MACHINE_ID, type RemoteFixture } from "./remote-helpers.ts";
import {
  SecAgent,
  SecRemoteMachine,
  SecRemoteRun,
  type RemoteMachineOutageRecord,
} from "../src/documents.ts";
import { decideOutage } from "../src/remote/outage.ts";
import { openPrivateSqliteStorage } from "../src/runtime/sqlite-file.ts";
import { zoneMinute } from "../src/time-format.ts";

/**
 * The long outage: the record, the automatic off, and the round that decides both.
 *
 * No test here starts a real ssh. The manager runs the fake from
 * `test/fixtures/remote/fake-ssh.mjs` and the clock is the fixture's own, so a
 * "round" is one call of `tick()` and an hour is a number the test writes. The three
 * facts every case comes back to are the stored machine record, the stored run
 * records, and what the user and the root were told.
 *
 * The texts are fixed here, word for word: the notice to the
 * root, the inbox item's title and body, and the message about a stranded run. They
 * are written out in full here, so a change to the code's wording fails a test
 * instead of passing it.
 */

/** What a machine that is down answers. */
const SSH_DOWN = "ssh: connect to host 192.0.2.10 port 22: No route to host";

/** The stored record of one machine. */
async function storedRecord(fixture: RemoteFixture, id = "box-a") {
  return await fixture.runtime.harness.snapshot(SecRemoteMachine, id, BACKGROUND_CONTEXT);
}

/** The stored record of one run. */
async function storedRun(fixture: RemoteFixture, id: string) {
  return await fixture.runtime.harness.snapshot(SecRemoteRun, id, BACKGROUND_CONTEXT);
}

/** Every notice this feature put into the root conversation. */
async function notices(fixture: RemoteFixture): Promise<string[]> {
  return await fixture.rootNotices();
}

/** The notices about an automatic off, which is one of several kinds this feature sends. */
async function offNotices(fixture: RemoteFixture): Promise<string[]> {
  return (await notices(fixture)).filter((body) => body.includes("has not answered since"));
}

/** The messages one other conversation received from this feature. */
async function noticesIn(fixture: RemoteFixture, conversationId: string): Promise<string[]> {
  const conversation = await fixture.runtime.harness.conversation(conversationId as never, BACKGROUND_CONTEXT);
  if (conversation === undefined) return [];
  const page = await conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
  const bodies: string[] = [];
  const entries = [
    ...(page.items as readonly { kind: string; model?: readonly { role?: string; content?: unknown }[] }[]),
  ].reverse();
  for (const entry of entries) {
    if (entry.kind !== UserEntry.kind) continue;
    for (const message of entry.model ?? []) {
      if (message.role !== "user" || typeof message.content !== "string") continue;
      if (!message.content.includes('via="remote-machines"')) continue;
      bodies.push(message.content.slice(message.content.indexOf(">") + 1, message.content.lastIndexOf("</pi-message>")));
    }
  }
  return bodies;
}

/** The user's inbox, as the operator sees it. */
async function inbox(fixture: RemoteFixture) {
  return await fixture.runtime.inbox.list(BACKGROUND_CONTEXT);
}

/** Every audit row of one type, and optionally of one reason. */
async function auditRows(
  fixture: RemoteFixture,
  type: string,
  reason?: string,
): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await readFile(fixture.paths.auditLog, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((row) => row["type"] === type && (reason === undefined || row["reason"] === reason));
}

/** How many rows the audit trail holds, whatever their type. */
async function auditCount(fixture: RemoteFixture): Promise<number> {
  let text: string;
  try {
    text = await readFile(fixture.paths.auditLog, "utf8");
  } catch {
    return 0;
  }
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

/** Set the threshold through the config the manager reads on every use. */
function threshold(fixture: RemoteFixture, seconds: number): void {
  fixture.setConfig((config) => ({
    ...config,
    remoteMachines: {
      ...(config.remoteMachines as NonNullable<typeof config.remoteMachines>),
      outageSeconds: seconds,
    },
  }));
}

/**
 * Bring one machine to `restricted` with a pinned key, then make ssh fail and run
 * the round that starts an outage. The round's instant is the record's `since`.
 */
async function startOutage(fixture: RemoteFixture): Promise<number> {
  await fixture.pinHostKey();
  await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
  await fixture.respond({ default: { stderr: SSH_DOWN, exit: 255 } });
  const since = fixture.now() + 60_000;
  fixture.setNow(since);
  await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
  return since;
}

/** One round at one instant. */
async function roundAt(fixture: RemoteFixture, at: number): Promise<void> {
  fixture.setNow(at);
  await fixture.runtime.remoteMachines.tick(BACKGROUND_CONTEXT);
}

/** Write one run record, so the change has something to strand. */
async function writeRun(
  fixture: RemoteFixture,
  runId: string,
  options: { readonly settled: boolean; readonly conversationId?: string; readonly user?: string },
): Promise<void> {
  const now = fixture.now();
  await fixture.runtime.harness.commit(async (tx) => {
    const draft = await tx.doc(SecRemoteRun, runId, runId);
    Object.assign(draft, {
      id: runId,
      machine: "box-a",
      user: options.user ?? "alice",
      conversationId: options.conversationId ?? "",
      toolCallId: "",
      level: "restricted",
      startedAt: now,
      pid: 1,
      tick: "1",
      dueAt: now + 1_800_000,
      lastNotified: "",
      lastState: "running",
      bytes: 0,
      exitCode: -1,
      settled: options.settled,
      settledAt: options.settled ? now : 0,
      notices: 0,
      updatedAt: now,
    });
  }, BACKGROUND_CONTEXT);
}

/** A conversation that can still be read, as the one a run was started from. */
async function addConversation(fixture: RemoteFixture, name: string): Promise<string> {
  const conversation = await fixture.runtime.harness.createConversation(
    { ownership: { kind: "ownerless" } },
    BACKGROUND_CONTEXT,
  );
  const id = String(conversation.id);
  await fixture.runtime.harness.commit(async (tx) => {
    const record = await tx.doc(SecAgent, id, id);
    record.kind = "subagent";
    record.name = name;
    record.vmodel = "faux";
    record.status = "running";
    record.createdAt = fixture.now();
    record.updatedAt = fixture.now();
  }, BACKGROUND_CONTEXT);
  return id;
}

/**
 * A fixture on a store that lives in a file, which is what the daemon runs on.
 *
 * A conversation is looked up by its id on that store, and the message a run check
 * sends reaches the conversation that started the run only through that lookup. The
 * in-memory storage the plain fixture uses keeps its conversations under a number
 * and answers nothing for the same id as text, so a test that reads a message out of
 * a conversation opens the store the daemon uses.
 */
async function fileBackedFixture(): Promise<{ fixture: RemoteFixture; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-sec-outage-store-"));
  const storage = await openPrivateSqliteStorage(join(dir, "state.db"));
  return { fixture: await createRemoteFixture({ storage }), dir };
}

/** What one check of a finished run answers, in the shape the run scripts print. */
function finishedFacts(): string {
  return ["exists=yes", "exit=0", "stop=none", "bytes=12", "mtime=1800000000", "tail="].join("\n");
}

describe("the threshold", () => {
  it("keeps the stored level before the hour and makes it off at the hour", async () => {
    const fixture = await createRemoteFixture();
    try {
      const since = await startOutage(fixture);
      // The round that found the machine down wrote the record and changed nothing.
      expect((await storedRecord(fixture))?.outage?.since).toBe(since);
      expect((await storedRecord(fixture))?.level).toBe("restricted");
      expect(await offNotices(fixture)).toEqual([]);
      expect(await inbox(fixture)).toEqual([]);

      await roundAt(fixture, since + 3_599_000);
      expect((await storedRecord(fixture))?.level).toBe("restricted");
      expect((await storedRecord(fixture))?.outage?.since).toBe(since);
      expect(await offNotices(fixture)).toEqual([]);

      const at = since + 3_600_000;
      await roundAt(fixture, at);
      const record = await storedRecord(fixture);
      expect(record?.level).toBe("off");
      expect(record?.levelChangedAt).toBe(at);
      // The level moved twice today: the user to restricted, the core to off.
      expect(record?.levelSequence).toBe(2);
      expect(record?.pending).toBeNull();
      expect(record?.outage).toBeUndefined();
    } finally {
      await fixture.close();
    }
  });

  it("clears a wait a stricter level left, so nothing stops a run afterwards", async () => {
    const fixture = await createRemoteFixture();
    try {
      const since = await startOutage(fixture);
      // A wait the slider could have left: the machine is away, so no cleanup ran.
      await fixture.runtime.harness.commit(async (tx) => {
        const draft = await tx.doc(SecRemoteMachine, "box-a", "box-a");
        draft.pending = { level: "off", since, deadline: since + 300_000, runs: 1 };
      }, BACKGROUND_CONTEXT);

      await roundAt(fixture, since + 3_600_000);
      expect((await storedRecord(fixture))?.pending).toBeNull();
    } finally {
      await fixture.close();
    }
  });
});

describe("the round that makes the machine off", () => {
  it("opens no session of its own: its only calls are the round's own heartbeats", async () => {
    const fixture = await createRemoteFixture();
    try {
      const since = await startOutage(fixture);
      await fixture.clearCalls();

      await roundAt(fixture, since + 3_600_000);

      // Two users, one heartbeat each, and nothing else. A call the automatic off
      // made would be a third line here, and the only command it may still run is
      // the local `ssh -O exit`, which the fixture has no socket for.
      const calls = await fixture.calls();
      expect(calls.map((call) => call.kinds)).toEqual([["heartbeat"], ["heartbeat"]]);
      expect(calls.filter((call) => call.kinds.includes("exit"))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("writes one inbox item and one root notice, and the notice asks for no action", async () => {
    const fixture = await createRemoteFixture();
    try {
      const since = await startOutage(fixture);
      const at = since + 3_600_000;
      await roundAt(fixture, at);

      const items = await inbox(fixture);
      expect(items).toHaveLength(1);
      const time = zoneMinute(since, "UTC");
      expect(items[0]?.title).toBe('Remote machine "box-a" was set to off: it stopped answering');
      expect(items[0]?.body).toBe(
        [
          `The machine has not answered since ${time}, and that is longer than the 3600 seconds this install waits, so pi-sec made its level off. ssh said: ${SSH_DOWN}.`,
          "Runs of that machine that were live and are no longer watched: 0 (none).",
          "When the machine is back, raise its level again with the sidebar slider in the Machines panel.",
        ].join("\n"),
      );

      const delivered = await offNotices(fixture);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.trim()).toBe(
        `Remote machine "box-a" has not answered since ${time}, and that is longer than the 3600 seconds this install waits, so pi-sec made its level off. The level was restricted. ssh said: ${SSH_DOWN}. Runs of that machine that were live and are no longer watched: 0 (none). The user has one inbox item about this change. This message asks for no action: do not ask the user whether the machine is off. When the machine is back, the user raises the level again with the sidebar slider.`,
      );
      // The question is gone: nothing in the notice asks the root to ask the user.
      expect(delivered[0]).not.toContain("Ask the user once");
      expect(delivered[0]).toContain("asks for no action");
    } finally {
      await fixture.close();
    }
  });

  it("leaves the three rounds after it with no write, no message and no call", async () => {
    const fixture = await createRemoteFixture();
    try {
      const since = await startOutage(fixture);
      const at = since + 3_600_000;
      await roundAt(fixture, at);
      const written = await storedRecord(fixture);
      const rows = await auditCount(fixture);
      const told = (await notices(fixture)).length;
      await fixture.clearCalls();

      for (const hours of [7_200, 10_800, 14_400]) {
        await roundAt(fixture, since + hours * 1000);
      }

      expect((await storedRecord(fixture))?.updatedAt).toBe(written?.updatedAt);
      expect((await storedRecord(fixture))?.levelChangedAt).toBe(at);
      expect(await auditCount(fixture)).toBe(rows);
      expect((await notices(fixture)).length).toBe(told);
      expect(await inbox(fixture)).toHaveLength(1);
      expect(await fixture.calls()).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe("the runs that were live", () => {
  it("settles every one of them as stranded and tells the conversation that started it", async () => {
    const { fixture, dir } = await fileBackedFixture();
    try {
      await fixture.pinHostKey();
      const conversation = await addConversation(fixture, "worker-stranded");
      // One run from a conversation that is still there, one from a call that named
      // none: the message of the second falls back to the root.
      await writeRun(fixture, "run-stranded-0001", { settled: false, conversationId: conversation });
      await writeRun(fixture, "run-stranded-0002", { settled: false, conversationId: "", user: "bob" });
      await writeRun(fixture, "run-done-0003", { settled: true, conversationId: conversation });
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await fixture.respond({ default: { stderr: SSH_DOWN, exit: 255 } });
      const since = fixture.now() + 60_000;
      await roundAt(fixture, since);
      const at = since + 3_600_000;
      await roundAt(fixture, at);

      for (const [runId, user] of [
        ["run-stranded-0001", "alice"],
        ["run-stranded-0002", "bob"],
      ] as const) {
        const run = await storedRun(fixture, runId);
        expect(run?.settled).toBe(true);
        expect(run?.lastState).toBe("stranded");
        expect(run?.settledAt).toBe(at);
        expect(run?.user).toBe(user);
      }
      // A run that had already ended is not this change's business.
      expect((await storedRun(fixture, "run-done-0003"))?.lastState).toBe("running");

      // One message per stranded run, through the path a run check uses, so the
      // conversation that started each run reads what became of it.
      const told = await noticesIn(fixture, conversation);
      expect(told).toHaveLength(1);
      expect(told[0]).toContain("[remote machine off]");
      expect(told[0]).toContain("run-stranded-0001");
      expect(told[0]).toContain("is stranded");
      const atRoot = (await notices(fixture)).filter((body) => body.includes("[remote machine off]"));
      expect(atRoot).toHaveLength(1);
      expect(atRoot[0]).toContain("run-stranded-0002");

      // The item and the notice name the runs the core stopped watching.
      expect((await inbox(fixture))[0]?.body).toContain(
        "Runs of that machine that were live and are no longer watched: 2 (run-stranded-0001, run-stranded-0002).",
      );
    } finally {
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a stranded run once when the user raises the level, and reports what it found", async () => {
    const { fixture, dir } = await fileBackedFixture();
    try {
      await fixture.pinHostKey();
      const conversation = await addConversation(fixture, "worker-woken");
      await writeRun(fixture, "run-stranded-0004", { settled: false, conversationId: conversation });
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await fixture.respond({ default: { stderr: SSH_DOWN, exit: 255 } });
      const since = fixture.now() + 60_000;
      await roundAt(fixture, since);
      await roundAt(fixture, since + 3_600_000);
      expect((await storedRun(fixture, "run-stranded-0004"))?.lastState).toBe("stranded");

      // The machine is back, and the user raises the level with the slider.
      await fixture.respond({
        rules: [
          { contains: ["-O", "exit"], response: { exit: 0 } },
          { kinds: ["heartbeat"], response: { stdout: `${FAKE_MACHINE_ID}\n` } },
        ],
        default: { stdout: finishedFacts() },
      });
      await fixture.clearCalls();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);

      // One read of that run, and no more: a check is the only call that carries
      // neither the heartbeat's command nor a socket close.
      const reads = (await fixture.calls()).filter((call) => call.kinds.length === 0);
      expect(reads).toHaveLength(1);

      const run = await storedRun(fixture, "run-stranded-0004");
      expect(run?.settled).toBe(true);
      expect(run?.lastState).toBe("finished");

      const told = await noticesIn(fixture, conversation);
      const report = told.filter((body) => body.includes("[remote run check]") && body.includes("finished at"));
      expect(report).toHaveLength(1);
      expect(report[0]).toContain("run-stranded-0004");
      expect(report[0]).toContain("exit code 0");
    } finally {
      await fixture.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a root that cannot read the notice", () => {
  it("makes the level off and writes the item, and records why the notice was skipped", async () => {
    // A root with no message of its own is skipped on purpose. The level and the
    // item do not depend on it, and the audit row is the operator's trace.
    const fixture = await createRemoteFixture({ seedRoot: false });
    try {
      const since = await startOutage(fixture);
      await roundAt(fixture, since + 3_600_000);

      expect(await notices(fixture)).toEqual([]);
      expect((await storedRecord(fixture))?.level).toBe("off");
      expect(await inbox(fixture)).toHaveLength(1);

      const rows = await auditRows(fixture, "remote_machine_notice", "auto-off");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.["outcome"]).toBe("skipped");
      expect(rows[0]?.["skipped"]).toBe("root_empty");
      expect(rows[0]?.["since"]).toBe(since);
    } finally {
      await fixture.close();
    }
  });
});

describe("the audit trail of one change", () => {
  it("records the level, the automatic off, the stranded runs and the item", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await writeRun(fixture, "run-audit-0005", { settled: false });
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await fixture.respond({ default: { stderr: SSH_DOWN, exit: 255 } });
      const since = fixture.now() + 60_000;
      await roundAt(fixture, since);
      await roundAt(fixture, since + 3_600_000);

      const levels = await auditRows(fixture, "remote_machine_level");
      const moved = levels.filter((row) => row["by"] === "core-outage");
      expect(moved).toHaveLength(1);
      expect(moved[0]?.["from"]).toBe("restricted");
      expect(moved[0]?.["to"]).toBe("off");
      expect(moved[0]?.["since"]).toBe(since);

      const offs = await auditRows(fixture, "remote_machine_auto_off");
      expect(offs).toHaveLength(1);
      expect(offs[0]?.["runs"]).toBe(1);
      expect(offs[0]?.["runIds"]).toEqual(["run-audit-0005"]);

      const stranded = await auditRows(fixture, "remote_run_stranded");
      expect(stranded).toHaveLength(1);
      expect(stranded[0]?.["run"]).toBe("run-audit-0005");

      const items = await auditRows(fixture, "inbox_item");
      expect(items).toHaveLength(1);
      expect(items[0]?.["itemId"]).toBe((await inbox(fixture))[0]?.id);
    } finally {
      await fixture.close();
    }
  });
});

describe("the end of an outage", () => {
  it("drops the record when a user answers, and changes nothing", async () => {
    const fixture = await createRemoteFixture();
    try {
      const since = await startOutage(fixture);
      await roundAt(fixture, since + 1_000_000);
      expect((await storedRecord(fixture))?.outage?.since).toBe(since);

      // The machine comes back: one user's answer ends the outage.
      await fixture.respond({ default: { stdout: `${FAKE_MACHINE_ID}\n` } });
      await roundAt(fixture, since + 1_100_000);
      expect((await storedRecord(fixture))?.outage).toBeUndefined();
      expect((await storedRecord(fixture))?.level).toBe("restricted");
      expect(await offNotices(fixture)).toEqual([]);
      expect(await inbox(fixture)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("makes the level off again for a new outage, with a new start and a new change", async () => {
    const fixture = await createRemoteFixture();
    try {
      const first = await startOutage(fixture);
      await roundAt(fixture, first + 3_600_000);
      expect((await storedRecord(fixture))?.level).toBe("off");
      expect((await storedRecord(fixture))?.levelSequence).toBe(2);

      // The user raises the level, and the machine is still away: that is a new
      // outage, counted from the round that found it, not from the one before.
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      const second = first + 7_200_000;
      await roundAt(fixture, second);
      expect((await storedRecord(fixture))?.outage?.since).toBe(second);
      expect((await storedRecord(fixture))?.level).toBe("restricted");

      await roundAt(fixture, second + 3_600_000);
      expect((await storedRecord(fixture))?.level).toBe("off");
      expect((await storedRecord(fixture))?.levelSequence).toBe(4);
      const delivered = await offNotices(fixture);
      expect(delivered).toHaveLength(2);
      expect(delivered[1]).toContain(zoneMinute(second, "UTC"));
      expect(await inbox(fixture)).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  });
});

describe("a machine that was blocked", () => {
  it("sends the block's own notice and no automatic off, however long it stays away", async () => {
    const fixture = await createRemoteFixture();
    try {
      // An outage first, so the block has a record to drop: a stopped machine must
      // not leave the outage of the moment before it in place.
      const since = await startOutage(fixture);
      expect((await storedRecord(fixture))?.outage?.since).toBe(since);

      await fixture.respond({ default: { stderr: "Host key verification failed.", exit: 255 } });
      await roundAt(fixture, fixture.now() + 60_000);
      const blocked = await storedRecord(fixture);
      expect(blocked?.block?.reason).toBe("host-key-mismatch");
      expect(blocked?.outage).toBeUndefined();

      await roundAt(fixture, fixture.now() + 86_400_000);
      // The loosening and the block, and nothing else: a stopped machine is not a
      // machine that is off, and its notice already said what happened.
      expect(await notices(fixture)).toHaveLength(2);
      expect(await offNotices(fixture)).toEqual([]);
      expect(await auditRows(fixture, "remote_machine_auto_off")).toEqual([]);
      expect(await inbox(fixture)).toEqual([]);
      expect((await storedRecord(fixture))?.level).toBe("restricted");
    } finally {
      await fixture.close();
    }
  });
});

describe("a machine at off", () => {
  it("is not watched, and the record of an earlier outage goes with the level", async () => {
    const fixture = await createRemoteFixture();
    try {
      const since = await startOutage(fixture);
      expect((await storedRecord(fixture))?.outage?.since).toBe(since);

      await fixture.runtime.remoteMachines.setLevel("box-a", "off", BACKGROUND_CONTEXT);
      await fixture.clearCalls();
      await roundAt(fixture, since + 86_400_000);

      // No ssh call and no change: a machine the user set to off is not watched.
      expect(await fixture.calls()).toEqual([]);
      expect(await offNotices(fixture)).toEqual([]);
      expect((await storedRecord(fixture))?.outage).toBeUndefined();
      // The level the user chose is the level it keeps.
      expect((await storedRecord(fixture))?.levelSequence).toBe(2);
    } finally {
      await fixture.close();
    }
  });
});

describe("a machine with no pinned key", () => {
  it("starts no outage while it is unpinned, and counts from the moment it is pinned", async () => {
    const fixture = await createRemoteFixture();
    try {
      // No `pinHostKey`: the manager returns before any heartbeat, so no user state
      // is written and there is nothing for the watch to count, however long the
      // clock moves.
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await roundAt(fixture, fixture.now() + 86_400_000);
      expect(await fixture.calls()).toEqual([]);
      expect((await storedRecord(fixture))?.outage).toBeUndefined();
      expect(await offNotices(fixture)).toEqual([]);
      expect(await auditRows(fixture, "remote_machine_auto_off")).toEqual([]);

      // The key is pinned and the machine does not answer: the outage starts here,
      // and not a day earlier, because the day before was a machine never checked.
      await fixture.pinHostKey();
      await fixture.respond({ default: { stderr: SSH_DOWN, exit: 255 } });
      const since = fixture.now() + 60_000;
      await roundAt(fixture, since);
      expect((await storedRecord(fixture))?.outage?.since).toBe(since);
      expect(await auditRows(fixture, "remote_machine_auto_off")).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});

describe("a restart", () => {
  it("carries out an outage the previous process started, and never repeats it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-sec-outage-restart-"));
    const db = join(dir, "state.db");
    try {
      const first = await createRemoteFixture({ storage: await openPrivateSqliteStorage(db) });
      let since: number;
      try {
        since = await startOutage(first);
        expect((await storedRecord(first))?.outage?.since).toBe(since);
      } finally {
        await first.close();
      }

      // The process comes back over the same store, with its own home, its own
      // pinned key and its own clock: the record is the one the first one left.
      const second = await createRemoteFixture({ storage: await openPrivateSqliteStorage(db) });
      try {
        await second.pinHostKey();
        await second.respond({ default: { stderr: SSH_DOWN, exit: 255 } });
        await roundAt(second, since + 3_599_000);
        expect((await storedRecord(second))?.level).toBe("restricted");
        expect(await auditRows(second, "remote_machine_auto_off")).toEqual([]);

        await roundAt(second, since + 3_600_000);
        expect((await storedRecord(second))?.level).toBe("off");
        expect(await auditRows(second, "remote_machine_auto_off")).toHaveLength(1);

        // One outage made one change, whatever the rounds after it.
        for (const hours of [7_200, 14_400]) {
          await roundAt(second, since + hours * 1000);
        }
        expect(await auditRows(second, "remote_machine_auto_off")).toHaveLength(1);
        expect(await inbox(second)).toHaveLength(1);
        expect(await offNotices(second)).toHaveLength(1);
      } finally {
        await second.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reads a record that still carries the fields of the question this feature used to send", async () => {
    const fixture = await createRemoteFixture();
    try {
      await fixture.pinHostKey();
      await fixture.runtime.remoteMachines.setLevel("box-a", "restricted", BACKGROUND_CONTEXT);
      await fixture.respond({ default: { stderr: SSH_DOWN, exit: 255 } });
      // The store a previous version left behind: the start, and the two fields of
      // the question nothing asks any more. No reader looks at them, and no
      // migration is needed.
      const since = fixture.now() + 60_000;
      await fixture.runtime.harness.commit(async (tx) => {
        const draft = await tx.doc(SecRemoteMachine, "box-a", "box-a");
        draft.users = {
          alice: { state: "unreachable", since, error: SSH_DOWN },
          bob: { state: "unreachable", since, error: SSH_DOWN },
        };
        draft.outage = { since, questionAt: since + 3_500_000, questionSent: true } as unknown as RemoteMachineOutageRecord;
        draft.updatedAt = since;
      }, BACKGROUND_CONTEXT);

      await roundAt(fixture, since + 3_599_000);
      expect((await storedRecord(fixture))?.level).toBe("restricted");
      await roundAt(fixture, since + 3_600_000);
      expect((await storedRecord(fixture))?.level).toBe("off");
      expect((await storedRecord(fixture))?.outage).toBeUndefined();
      expect(await offNotices(fixture)).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });
});

describe("the decision alone", () => {
  /** One reading of one machine, as the round hands it over. */
  const reading = {
    level: "restricted" as const,
    blocked: false,
    now: 10_000_000,
    outageSeconds: 3600,
  };
  /** A record that reached its threshold. */
  const record: RemoteMachineOutageRecord = { since: 6_400_000 };
  const down = [{ state: "unreachable" }];

  it("answers the six readings of one round", () => {
    // The threshold passed with no answer: the core makes the level off itself.
    expect(decideOutage({ ...reading, users: down, outage: record })).toEqual({
      kind: "off",
      since: 6_400_000,
    });
    // A block and a level of off end the outage before anything else is read.
    expect(decideOutage({ ...reading, blocked: true, users: down, outage: record })).toEqual({ kind: "drop" });
    expect(decideOutage({ ...reading, level: "off", users: down, outage: record })).toEqual({ kind: "drop" });
    // One user answered, so the machine is not down, whatever the other user reads.
    expect(decideOutage({ ...reading, users: [{ state: "reachable" }, ...down], outage: record })).toEqual({
      kind: "drop",
    });
    // No record and a machine that reads down: the outage starts now.
    expect(decideOutage({ ...reading, users: down, outage: undefined })).toEqual({ kind: "start", since: 10_000_000 });
    // The record exists and the threshold has not passed.
    expect(decideOutage({ ...reading, now: 6_400_000 + 3_599_000, users: down, outage: record })).toEqual({
      kind: "none",
    });
  });

  it("counts no user that was never checked, so nothing starts from an empty state", () => {
    // An unpinned machine writes no user state: not answered, and not unreachable.
    expect(decideOutage({ ...reading, users: [], outage: undefined })).toEqual({ kind: "none" });
    expect(decideOutage({ ...reading, users: [], outage: record })).toEqual({ kind: "none" });
  });
});
