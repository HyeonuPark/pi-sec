/**
 * A restart: its state, its notice, the runner and the route.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 *
 * `test/restart-runner-gate.test.ts` stays a file of its own, because it calls
 * `vi.mock`, which the runner hoists to the top of the file it is written in.
 */

import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { RestartState } from "../src/runtime/restart.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { RESTART_MARKER, readPendingRestart, reportPendingRestart, RUNNER_EXIT_CODE, RUNNER_VARIABLE, RestartLauncher, restartMarkerPath, type RestartHooks } from "../src/runtime/restart-helper.ts";
import { execFileSync } from "node:child_process";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, AssistantEntry, ResetEntry, SystemEntry, UserEntry, type Conversation, type ConversationId, type Submission, type SubmissionDraft } from "@earendil-works/pi-durable";
import { readMessage } from "../src/message-envelope.ts";
import type { AgentKind, AgentRecord, AgentStatus, JobRecord } from "../src/documents.ts";
import { NOTICE_LIST_LIMIT, NOTICE_SUPPRESS_MS, collectWaitingWork, notifyRestartNotice, zoneIso, type RestartNoticeDeps, type WaitingSubagent, type WaitingWork, type WaitingWorkSources } from "../src/runtime/restart-notice.ts";
import { existsSync } from "node:fs";
import type { StartedServer } from "../src/server/server.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { createSelfEditExtension } from "../src/extensions/self-edit.ts";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import type { SubagentHub } from "../src/extensions/subagents.ts";
import { readAuditTail, type AuditEvent } from "../src/runtime/audit.ts";
import type { RestartOutcome } from "../src/runtime/restart-helper.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { startTestServer } from "./server-helpers.ts";

describe("restart.test.ts", () => {
  /**
   * The restart state is what stops a restart from being taken up mid-batch, so
   * the two facts have to stay separable: recording another core edit must take
   * the go-ahead back without ever clearing the need.
   */
  describe("restart state", () => {
    it("starts with nothing required and nothing ready", () => {
      const state = new RestartState();
      expect(state.status.required).toBe(false);
      expect(state.status.ready).toBe(false);
    });

    it("records a need without asking for anything", () => {
      const state = new RestartState();
      state.requireRestart(1000);
      expect(state.status.required).toBe(true);
      expect(state.status.ready).toBe(false);
      expect(state.status.requiredAt).toBe(1000);
    });

    it("takes the go-ahead back when the batch moves again", () => {
      const state = new RestartState();
      state.requireRestart(1000);
      state.markReady(2000);
      expect(state.status.ready).toBe(true);
      expect(state.status.readyAt).toBe(2000);

      // Another core edit lands: what was verified is no longer what is on disk,
      // and a restart now would apply half the batch.
      state.requireRestart(3000);
      expect(state.status.required).toBe(true);
      expect(state.status.ready).toBe(false);
      expect(state.status.readyAt).toBeUndefined();
    });

    it("keeps the first time the need appeared", () => {
      const state = new RestartState();
      state.requireRestart(1000);
      state.requireRestart(5000);
      expect(state.status.requiredAt).toBe(1000);
    });

    it("withdraws the request and never the need", () => {
      const state = new RestartState();
      state.requireRestart(1000);
      state.markReady(2000);
      state.withdraw();
      expect(state.status.ready).toBe(false);
      expect(state.status.required).toBe(true);
    });

    it("does not invent a go-ahead when there is nothing to apply", () => {
      const state = new RestartState();
      state.markReady(2000);
      expect(state.status.ready).toBe(false);
      expect(state.status.required).toBe(false);
    });
  });

  /**
   * The marker a UI-triggered restart leaves behind. A restart asked for from the
   * web UI has nobody watching a terminal, so the process that comes up next is
   * the only place a failure can be reported — and it has to be reported once.
   */
  describe("a restart that never finished", () => {
    async function withMarker(contents: string): Promise<{ runDir: string; notes: AdminNotes }> {
      const runDir = await mkdtemp(join(tmpdir(), "pi-sec-restart-"));
      await writeFile(join(runDir, RESTART_MARKER), contents, { mode: 0o600 });
      return { runDir, notes: new AdminNotes() };
    }

    it("is reported once, at the next boot", async () => {
      const { runDir, notes } = await withMarker(JSON.stringify({ at: 1_700_000_000_000, source: "ui" }));

      const pending = await reportPendingRestart(runDir, notes, "/logs");
      expect(pending?.at).toBe(1_700_000_000_000);
      expect(pending?.source).toBe("ui");
      expect(notes.all()).toHaveLength(1);
      expect(notes.all()[0]!.text).toContain("did not finish");
      expect(notes.all()[0]!.text).toContain("/logs/update-and-restart.log");

      // Read once and cleared: a note that came back every boot would stop being a
      // signal and start being noise.
      expect(await reportPendingRestart(runDir, notes, "/logs")).toBeUndefined();
      expect(notes.all()).toHaveLength(1);
    });

    it("says nothing when the last restart completed", async () => {
      const runDir = await mkdtemp(join(tmpdir(), "pi-sec-restart-"));
      const notes = new AdminNotes();
      expect(await readPendingRestart(runDir)).toBeUndefined();
      expect(await reportPendingRestart(runDir, notes, "/logs")).toBeUndefined();
      expect(notes.all()).toHaveLength(0);
    });

    it("ignores a marker it cannot read", async () => {
      const { runDir, notes } = await withMarker("not json");
      expect(await reportPendingRestart(runDir, notes, "/logs")).toBeUndefined();
      expect(notes.all()).toHaveLength(0);
      // Cleared anyway: a marker nothing can parse would otherwise report itself forever.
      expect(await readPendingRestart(runDir)).toBeUndefined();
    });
  });
});

describe("restart-notice.test.ts", () => {
  /**
   * The boot notice: one entry in the root conversation when the daemon comes up
   * after a restart, and nothing at all in the three cases that would be noise.
   *
   * Nothing here needs a real conversation or a real audit file. The decision
   * reads one tail and one conversation lookup, so a fixed tail of audit rows and
   * a fake conversation drive every branch, including the two failures that have
   * to stay inside the module.
   */

  /** A fixed instant, so the body's timestamp is a literal in the assertions. */
  const T0 = Date.parse("2030-10-17T04:50:00+09:00");
  const TREE = "/tmp/pi-sec-restart-notice-test/snapshot";
  const COMMIT = "89abcdef0123456789abcdef0123456789abcdef";
  const PID = 4242;

  interface Fixture {
    readonly deps: RestartNoticeDeps;
    /** The labelled content of every submission, in order. */
    readonly submitted: string[];
    /** The conversation every submission went to. */
    readonly conversationIds: ConversationId[];
    readonly audit: AuditEvent[];
    readonly warnings: string[];
    /** How many times the notice asked the store what was waiting. */
    readonly waitingReads: () => number;
  }

  function fixture(options: {
    readonly tail: readonly AuditEvent[];
    readonly startedAt: number;
    readonly hasRoot?: boolean;
    /** The kinds of the root's log, newest last; the default is one operator message. */
    readonly entryKinds?: readonly string[];
    readonly failSubmit?: boolean;
    readonly failTail?: boolean;
    readonly snapshotTree?: string;
    /** When true, the notice runs the real `git -C <tree> rev-parse HEAD`. */
    readonly realTreeCommit?: boolean;
    /** The pid the pid file held before this boot; undefined means no file. */
    readonly previousPid?: number;
    /** The harness time zone the notice writes the boot time in. */
    readonly timezone?: string;
    /** What the store reports as parked. Absent means the notice has no reader. */
    readonly waitingWork?: WaitingWork;
    /** A reader that throws, the way a store that cannot be read does. */
    readonly failWaitingWork?: boolean;
  }): Fixture {
    const submitted: string[] = [];
    const conversationIds: ConversationId[] = [];
    const audit: AuditEvent[] = [];
    const warnings: string[] = [];
    let waitingReads = 0;
    // The lookup of the transcript is a storage scan, so the fake returns the same
    // page shape the real one does: newest first, and no cursor to continue from.
    const log = [...(options.entryKinds ?? [UserEntry.kind])].reverse();
    const conversation = {
      entries: async () => ({ items: log.map((kind, at) => ({ id: at + 1, conversationId: ROOT_CONVERSATION_ID, kind })) }),
      submit: async (draft: SubmissionDraft): Promise<Submission> => {
        submitted.push(String(draft.type === "input" ? draft.content : ""));
        if (options.failSubmit === true) throw new Error("the conversation store is unreachable");
        return { id: 7 } as unknown as Submission;
      },
    } as unknown as Conversation;
    return {
      deps: {
        harness: {
          conversation: async (id: ConversationId) => {
            conversationIds.push(id);
            return options.hasRoot === false ? undefined : conversation;
          },
        },
        pid: PID,
        startedAt: options.startedAt,
        timezone: options.timezone ?? "Asia/Tokyo",
        previousPid: options.previousPid,
        snapshotTree: options.snapshotTree ?? TREE,
        auditFile: "/tmp/pi-sec-restart-notice-test/audit.jsonl",
        appendAudit: (event) => audit.push(event),
        logger: { warn: (message) => warnings.push(message) },
        readTail: async () =>
          options.failTail === true ? Promise.reject(new Error("the audit file is unreadable")) : [...options.tail],
        treeCommit: options.realTreeCommit === true ? undefined : () => COMMIT,
        ...(options.waitingWork === undefined && options.failWaitingWork !== true
          ? {}
          : {
              readWaitingWork: async () => {
                waitingReads += 1;
                if (options.failWaitingWork === true) throw new Error("the job store is unreachable");
                return options.waitingWork as WaitingWork;
              },
            }),
      },
      submitted,
      conversationIds,
      audit,
      warnings,
      waitingReads: () => waitingReads,
    };
  }

  /**
   * A small git repository for the real `git` path to answer for.
   *
   * The repository is built here rather than taken from this checkout: a copy
   * made with `git archive`, or any unpacked tarball, has no `.git` of its own.
   * The identity goes on the command line, so the test writes no git config.
   */
  async function makeRepository(dir: string): Promise<string> {
    const git = (...args: readonly string[]): string =>
      execFileSync("git", ["-c", "user.name=pi-sec test", "-c", "user.email=test@example.com", ...args], {
        encoding: "utf8",
      }).trim();
    git("init", "--quiet", "-b", "main", dir);
    await writeFile(join(dir, "tree.txt"), "the execution tree\n");
    git("-C", dir, "add", "--", "tree.txt");
    git("-C", dir, "commit", "--quiet", "-m", "add the tree");
    return dir;
  }

  /** The previous boot, its requested stop, and the start row this boot wrote. */
  function restartTail(startedAt: number): AuditEvent[] {
    return restartTailAt(T0, startedAt);
  }

  /** The same shape, for a boot at an instant other than `T0`. */
  function restartTailAt(previousStart: number, startedAt: number): AuditEvent[] {
    return [
      { time: previousStart, type: "server_start", pid: 1111, origin: "http://127.0.0.1:7131" },
      { time: previousStart + 1000, type: "restart_launched", unit: "pi-sec-restart", source: "ui" },
      { time: previousStart + 2000, type: "server_stop", signal: "SIGTERM" },
      { time: startedAt, type: "server_start", pid: PID },
    ];
  }

  describe("the boot time, written in a zone", () => {
    const instant = Date.parse("2030-10-16T19:50:05Z");

    it("carries the offset in force at that instant, minutes included", () => {
      expect(zoneIso(instant, "Asia/Tokyo")).toBe("2030-10-17T04:50:05+09:00");
      expect(zoneIso(instant, "UTC")).toBe("2030-10-16T19:50:05+00:00");
      // Kolkata is +05:30 all year: dropping the minutes would be half an hour wrong.
      expect(zoneIso(instant, "Asia/Kolkata")).toBe("2030-10-17T01:20:05+05:30");
      // West of UTC the sign is part of the answer.
      expect(zoneIso(instant, "America/Los_Angeles")).toBe("2030-10-16T12:50:05-07:00");
    });
  });

  describe("the restart notice", () => {
    it("writes one notice into the root conversation, and says what happened", async () => {
      const startedAt = T0 + 5000;
      const f = fixture({ tail: restartTail(startedAt), startedAt });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toEqual({ kind: "notified", submissionId: 7, suppressed: 0 });
      expect(f.submitted).toHaveLength(1);
      expect(f.conversationIds).toEqual([ROOT_CONVERSATION_ID]);
      expect(f.audit.map((event) => event.type)).toEqual(["restart_notice"]);

      const message = readMessage(f.submitted[0]!);
      expect(message?.source).toBe("restart");
      expect(message?.attrs["via"]).toBe("cold-start");
      expect(f.warnings).toEqual([]);
      const body = message?.body ?? "";
      expect(body).toContain("The server made a cold restart. (automatic notice)");
      expect(body).toContain(`- pid: ${PID}`);
      // 19:50:05Z on the 16th, written on the operator's clock.
      expect(body).toContain("- Started at: 2030-10-17T04:50:05+09:00");
      expect(body).toContain(`- Execution tree: ${TREE} (HEAD ${COMMIT})`);
      expect(body).toContain("- Previous stop: restart on request / downtime 3 s");
      expect(body).toContain("- Boot repair (conversations and children) runs in parallel with this notice.");
    });

    it("writes the boot time with the offset of the configured zone", async () => {
      const startedAt = T0 + 5000;
      const utc = fixture({ tail: restartTail(startedAt), startedAt, timezone: "UTC" });

      await notifyRestartNotice(utc.deps);

      // The same instant the Asia/Tokyo case writes as 04:50:05 on the 17th.
      const utcBody = readMessage(utc.submitted[0]!)?.body ?? "";
      expect(utcBody).toContain("- Started at: 2030-10-16T19:50:05+00:00");
    });

    it("reads the offset in force at that instant, so a zone with summer time is right", async () => {
      // 16 July is -04:00 in New York and 16 January is -05:00. A constant offset
      // would be an hour wrong for half the year.
      for (const [instant, expected] of [
        ["2026-07-16T12:00:00Z", "2026-07-16T08:00:00-04:00"],
        ["2026-01-16T12:00:00Z", "2026-01-16T07:00:00-05:00"],
      ] as const) {
        const startedAt = Date.parse(instant);
        const f = fixture({
          tail: restartTailAt(startedAt - 5000, startedAt),
          startedAt,
          timezone: "America/New_York",
        });

        await notifyRestartNotice(f.deps);

        expect(readMessage(f.submitted[0]!)?.body ?? "").toContain(`- Started at: ${expected}`);
      }
    });

    it("writes nothing on a first start", async () => {
      const startedAt = T0 + 5000;
      // Only the row this boot wrote: there is no earlier `server_start`.
      const f = fixture({ tail: [{ time: startedAt, type: "server_start", pid: PID }], startedAt });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toEqual({ kind: "skipped", reason: "first_start" });
      expect(f.submitted).toEqual([]);
      expect(f.conversationIds).toEqual([]);
      expect(f.audit).toEqual([{ type: "restart_notice_skipped", reason: "first_start" }]);
    });

    it("writes nothing when the root conversation does not exist", async () => {
      const startedAt = T0 + 5000;
      const f = fixture({ tail: restartTail(startedAt), startedAt, hasRoot: false });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toEqual({ kind: "skipped", reason: "no_root" });
      expect(f.submitted).toEqual([]);
      expect(f.conversationIds).toEqual([ROOT_CONVERSATION_ID]);
      expect(f.audit).toEqual([{ type: "restart_notice_skipped", reason: "no_root" }]);
    });

    it("writes nothing when the root conversation has no message yet", async () => {
      const startedAt = T0 + 5000;
      const f = fixture({ tail: restartTail(startedAt), startedAt, entryKinds: [] });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toEqual({ kind: "skipped", reason: "root_empty" });
      expect(f.submitted).toEqual([]);
      expect(f.audit).toEqual([{ type: "restart_notice_skipped", reason: "root_empty" }]);
    });

    it("counts neither a reset marker nor a system entry as a message", async () => {
      const startedAt = T0 + 5000;
      // A reset and the positional `pi.system` entries a request needs leave a log
      // that holds no message: nobody talked to the root yet.
      const f = fixture({
        tail: restartTail(startedAt),
        startedAt,
        entryKinds: [SystemEntry.kind, ResetEntry.kind, SystemEntry.kind],
      });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toEqual({ kind: "skipped", reason: "root_empty" });
      expect(f.submitted).toEqual([]);
    });

    it("writes the notice once the root has a message of its own", async () => {
      const startedAt = T0 + 5000;
      const f = fixture({
        tail: restartTail(startedAt),
        startedAt,
        entryKinds: [ResetEntry.kind, UserEntry.kind, AssistantEntry.kind],
      });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toEqual({ kind: "notified", submissionId: 7, suppressed: 0 });
      expect(f.audit.map((event) => event.type)).toEqual(["restart_notice"]);
    });

    it("stays quiet when a notice already went out inside the window", async () => {
      const startedAt = T0 + 30_000;
      const f = fixture({
        tail: [
          { time: T0, type: "server_start", pid: 1111 },
          { time: T0 + 1000, type: "restart_notice", pid: 1111, suppressed: 0 },
        ],
        startedAt,
      });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toEqual({ kind: "suppressed", sinceLastNoticeMs: 29_000 });
      expect(f.submitted).toEqual([]);
      expect(f.audit).toEqual([{ type: "restart_notice_suppressed", sinceLastNoticeMs: 29_000 }]);
    });

    it("carries the count of the boots it kept quiet into the next notice", async () => {
      const startedAt = T0 + 1000 + NOTICE_SUPPRESS_MS + 1000;
      const f = fixture({
        tail: [
          { time: T0, type: "server_start", pid: 1111 },
          { time: T0 + 1000, type: "restart_notice", pid: 1111, suppressed: 0 },
          { time: T0 + 30_000, type: "restart_notice_suppressed", sinceLastNoticeMs: 29_000 },
          { time: T0 + 45_000, type: "restart_notice_suppressed", sinceLastNoticeMs: 44_000 },
          { time: startedAt, type: "server_start", pid: PID },
        ],
        startedAt,
      });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toEqual({ kind: "notified", submissionId: 7, suppressed: 2 });
      expect(f.audit.map((event) => event.type)).toEqual(["restart_notice"]);
      const body = readMessage(f.submitted[0]!)?.body ?? "";
      expect(body).toContain("- 2 more starts in the previous 60 s");
    });

    it("keeps the boot alive when the tail cannot be read or the submission fails", async () => {
      const unreadable = fixture({ tail: [], startedAt: T0 + 5000, failTail: true });

      const first = await notifyRestartNotice(unreadable.deps);

      expect(first).toEqual({ kind: "failed", error: "the audit file is unreadable" });
      expect(unreadable.submitted).toEqual([]);
      expect(unreadable.audit).toEqual([
        { type: "restart_notice_failed", error: "the audit file is unreadable" },
      ]);

      const startedAt = T0 + 5000;
      const rejected = fixture({ tail: restartTail(startedAt), startedAt, failSubmit: true });

      const second = await notifyRestartNotice(rejected.deps);

      expect(second).toEqual({ kind: "failed", error: "the conversation store is unreachable" });
      expect(rejected.submitted).toHaveLength(1);
      // The notice row is written after the submission, so it must not appear.
      expect(rejected.audit).toEqual([
        { type: "restart_notice_failed", error: "the conversation store is unreachable" },
      ]);
    });

    it("reads a pid file that outlived its process as an abnormal exit", async () => {
      const startedAt = T0 + 5000;
      const f = fixture({
        tail: [
          { time: T0, type: "server_start", pid: 1111 },
          { time: T0 + 1000, type: "sections_stale", conversationId: "1" },
          { time: startedAt, type: "server_start", pid: PID },
        ],
        startedAt,
        previousPid: 1111,
      });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toMatchObject({ kind: "notified" });
      const body = readMessage(f.submitted[0]!)?.body ?? "";
      expect(body).toContain("- Previous stop: automatic start after an abnormal exit\n");
      // A process that died without shutting down wrote no `server_stop`.
      expect(body).not.toContain("downtime");
    });

    it("goes out without the sha when git cannot answer for the tree", async () => {
      const startedAt = T0 + 5000;
      const missing = fixture({
        tail: restartTail(startedAt),
        startedAt,
        snapshotTree: "/nonexistent/pi-sec-tree",
        realTreeCommit: true,
      });

      const outcome = await notifyRestartNotice(missing.deps);

      expect(outcome).toMatchObject({ kind: "notified" });
      expect(missing.warnings).toEqual(["the restart notice carries no commit sha"]);
      const body = readMessage(missing.submitted[0]!)?.body ?? "";
      expect(body).toContain("- Execution tree: /nonexistent/pi-sec-tree\n");
      expect(body).not.toContain("HEAD");

      // The same code against a real git tree carries the full commit.
      const temp = await mkdtemp(join(tmpdir(), "pi-sec-restart-notice-git-"));
      try {
        const root = await makeRepository(temp);
        const real = fixture({ tail: restartTail(startedAt), startedAt, snapshotTree: root, realTreeCommit: true });

        await notifyRestartNotice(real.deps);

        const expected = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
        expect(expected).toMatch(/^[0-9a-f]{40}$/);
        expect(real.warnings).toEqual([]);
        expect(readMessage(real.submitted[0]!)?.body).toContain(`- Execution tree: ${root} (HEAD ${expected})`);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    });

    it("reads a clean stop from the trail and reports the downtime", async () => {
      const startedAt = T0 + 11_000;
      const f = fixture({
        tail: [
          { time: T0, type: "server_start", pid: 1111 },
          { time: T0 + 5000, type: "server_stop", signal: "SIGTERM" },
          { time: startedAt, type: "server_start", pid: PID },
        ],
        startedAt,
      });

      await notifyRestartNotice(f.deps);

      // The pid file is gone after a clean stop, so nothing says "abnormal".
      expect(readMessage(f.submitted[0]!)?.body).toContain("- Previous stop: start after a normal stop / downtime 6 s\n");
    });

    it("says unknown and omits the downtime when the trail holds no stop", async () => {
      const startedAt = T0 + 5000;
      const f = fixture({
        tail: [
          { time: T0, type: "server_start", pid: 1111 },
          { time: T0 + 1000, type: "restart_incomplete", at: T0, source: "ui" },
          { time: startedAt, type: "server_start", pid: PID },
        ],
        startedAt,
      });

      await notifyRestartNotice(f.deps);

      const body = readMessage(f.submitted[0]!)?.body ?? "";
      expect(body).toContain("- Previous stop: unknown\n");
      expect(body).not.toContain("downtime");
    });
  });

  describe("the lists of what a restart left stopped", () => {
    const startedAt = T0 + 5000;

    it("names the waiting jobs and the subagents that wait for orders", async () => {
      const f = fixture({
        tail: restartTail(startedAt),
        startedAt,
        waitingWork: {
          jobs: [
            { id: "20261025-01M5QW1C06000000000000JHDV", title: "Write the plan" },
            { id: "20261024-01M5R1BQ4M0000000000000000", title: "Read the logs" },
          ],
          subagents: [
            { name: "researcher", conversationId: "42", parentName: "the root agent" },
            { name: "writer", conversationId: "43", parentName: "drafts" },
          ],
        },
      });

      await notifyRestartNotice(f.deps);

      const body = readMessage(f.submitted[0]!)?.body ?? "";
      expect(body).toContain(
        "- Jobs in waiting status (2):\n" +
          "  - 20261025-01M5QW1C06000000000000JHDV Write the plan\n" +
          "  - 20261024-01M5R1BQ4M0000000000000000 Read the logs\n",
      );
      expect(body).toContain(
        "- Subagents waiting for orders (2):\n" +
          "  - researcher (conversation 42, parent the root agent)\n" +
          "  - writer (conversation 43, parent drafts)\n",
      );
      // No overflow line while nothing is left out.
      expect(body).not.toContain("more.");
    });

    it("writes one none row for a list that holds nothing", async () => {
      const empty = fixture({ tail: restartTail(startedAt), startedAt, waitingWork: { jobs: [], subagents: [] } });
      const unread = fixture({ tail: restartTail(startedAt), startedAt });

      for (const f of [empty, unread]) {
        await notifyRestartNotice(f.deps);
        const body = readMessage(f.submitted[0]!)?.body ?? "";
        expect(body).toContain("- Jobs in waiting status (0):\n  - none\n");
        expect(body).toContain("- Subagents waiting for orders (0):\n  - none\n");
        expect(body).not.toContain("more.");
      }
      // The reader that is absent is not asked, and the count says so.
      expect(unread.waitingReads()).toBe(0);
    });

    it("shows twenty rows per list and counts the rest in one line", async () => {
      const jobs = Array.from({ length: 23 }, (_, at) => ({
        id: `20261025-${String(at).padStart(26, "0")}`,
        title: `job ${at}`,
      }));
      const subagents = Array.from({ length: 25 }, (_, at) => ({
        name: `agent-${at}`,
        conversationId: String(100 + at),
        parentName: "the root agent",
      }));
      const f = fixture({ tail: restartTail(startedAt), startedAt, waitingWork: { jobs, subagents } });

      await notifyRestartNotice(f.deps);

      const body = readMessage(f.submitted[0]!)?.body ?? "";
      const lines = body.split("\n");
      // The heading carries the whole count, the rows stop at the limit.
      expect(body).toContain("- Jobs in waiting status (23):");
      expect(lines.filter((line) => line.startsWith("  - 20261025-"))).toHaveLength(NOTICE_LIST_LIMIT);
      expect(body).toContain("  - and 3 more. `jobs_list` with status waiting shows every one.\n");
      expect(body).not.toContain("job 20 ");
      expect(body).toContain("- Subagents waiting for orders (25):");
      expect(lines.filter((line) => line.startsWith("  - agent-"))).toHaveLength(NOTICE_LIST_LIMIT);
      expect(body).toContain("  - and 5 more.\n");
      expect(body).not.toContain("agent-20 (conversation");
      // One overflow line per list, and it comes after the rows it counts.
      expect(lines.filter((line) => line.startsWith("  - and "))).toHaveLength(2);
    });

    it("writes the fixed text, with the values filled in", async () => {
      const f = fixture({
        tail: restartTail(startedAt),
        startedAt,
        waitingWork: {
          jobs: [{ id: "20261025-01M5QW1C06000000000000JHDV", title: "Write the plan" }],
          subagents: [{ name: "researcher", conversationId: "42", parentName: "the root agent" }],
        },
      });

      await notifyRestartNotice(f.deps);

      expect(readMessage(f.submitted[0]!)?.body).toBe(
        [
          "The server made a cold restart. (automatic notice)",
          `- pid: ${PID}`,
          "- Started at: 2030-10-17T04:50:05+09:00",
          `- Execution tree: ${TREE} (HEAD ${COMMIT})`,
          "- Previous stop: restart on request / downtime 3 s",
          "- Boot repair (conversations and children) runs in parallel with this notice.",
          "- Jobs in waiting status (1):",
          "  - 20261025-01M5QW1C06000000000000JHDV Write the plan",
          "- Subagents waiting for orders (1):",
          "  - researcher (conversation 42, parent the root agent)",
          "- Work that stopped for a restart stays stopped until someone resumes it. For each job or subagent above whose next step was this restart, resume it now.",
          "- If nothing above waits for this restart and you have nothing to tell the user, your whole answer is this one line, copied exactly with nothing added: [pi-sec no-response]",
        ].join("\n"),
      );
    });

    it("reads the lists only when the notice is written", async () => {
      const suppressed = fixture({
        tail: [
          { time: T0, type: "server_start", pid: 1111 },
          { time: T0 + 1000, type: "restart_notice", pid: 1111, suppressed: 0 },
        ],
        startedAt: T0 + 30_000,
        waitingWork: { jobs: [], subagents: [] },
      });

      const outcome = await notifyRestartNotice(suppressed.deps);

      expect(outcome).toMatchObject({ kind: "suppressed" });
      expect(suppressed.waitingReads()).toBe(0);
    });

    it("keeps the notice when the store cannot be read", async () => {
      const f = fixture({ tail: restartTail(startedAt), startedAt, failWaitingWork: true });

      const outcome = await notifyRestartNotice(f.deps);

      expect(outcome).toMatchObject({ kind: "notified" });
      expect(f.warnings).toEqual(["the restart notice could not read what was waiting"]);
      const body = readMessage(f.submitted[0]!)?.body ?? "";
      expect(body).toContain("- Jobs in waiting status (0):\n  - none\n");
    });
  });

  /** One agent record with the fields the walk reads, and placeholders for the rest. */
  function agentRecord(fields: {
    readonly conversationId: string;
    readonly name: string;
    readonly status: AgentStatus;
    readonly kind?: AgentKind;
    readonly parentConversationId?: string;
    readonly parentName?: string;
  }): AgentRecord {
    return {
      conversationId: fields.conversationId,
      kind: fields.kind ?? "subagent",
      name: fields.name,
      parentConversationId: fields.parentConversationId,
      parentName: fields.parentName,
      vmodel: "test",
      roles: [],
      status: fields.status,
      createdAt: T0,
      updatedAt: T0,
    };
  }

  describe("the walk over what was waiting", () => {
    it("reads the waiting jobs, and every subagent that waits at any depth under the root", async () => {
      const filters: unknown[] = [];
      const tree: Record<string, readonly AgentRecord[]> = {
        [String(ROOT_CONVERSATION_ID)]: [
          agentRecord({ conversationId: "10", name: "researcher", status: "waiting", parentConversationId: "1", parentName: "operator" }),
          agentRecord({ conversationId: "11", name: "busy", status: "running", parentConversationId: "1" }),
          // A focused chat waits for the operator, not for an order.
          agentRecord({ conversationId: "12", name: "chat", status: "waiting", kind: "focused", parentConversationId: "1" }),
        ],
        "10": [
          agentRecord({ conversationId: "20", name: "helper", status: "waiting", parentConversationId: "10", parentName: "researcher" }),
        ],
        "11": [agentRecord({ conversationId: "21", name: "stopped", status: "stopped", parentConversationId: "11" })],
        "20": [],
      };
      const sources: WaitingWorkSources = {
        jobs: {
          list: async (_ctx, filter) => {
            filters.push(filter);
            return [{ id: "20261025-01M5QW1C06000000000000JHDV", title: "Write the plan" } as unknown as JobRecord];
          },
        },
        subagents: { children: async (id) => tree[String(id)] ?? [] },
        ctx: BACKGROUND_CONTEXT,
      };

      const work = await collectWaitingWork(sources);

      expect(filters).toEqual([{ status: "waiting" }]);
      expect(work.jobs).toEqual([{ id: "20261025-01M5QW1C06000000000000JHDV", title: "Write the plan" }]);
      // The grandchild is listed, the running and stopped agents are not, and the
      // focused chat is not a subagent that waits for an order.
      expect(work.subagents.map((subagent) => subagent.name)).toEqual(["researcher", "helper"]);
      expect(work.subagents[0]).toEqual<WaitingSubagent>({
        name: "researcher",
        conversationId: "10",
        // The root's stored name is `operator`; the notice says what the prompt says.
        parentName: "the root agent",
      });
      expect(work.subagents[1]?.parentName).toBe("researcher");
    });

    it("lists no subagents when the extension is not installed", async () => {
      const work = await collectWaitingWork({
        jobs: { list: async () => [] },
        ctx: BACKGROUND_CONTEXT,
      });

      expect(work).toEqual({ jobs: [], subagents: [] });
    });
  });
});

describe("restart-runner.test.ts", () => {
  /**
   * The runner path of the restart request.
   *
   * A daemon under `user-tools/run` has no unit to hand the script to, so the
   * request ends the daemon instead: it writes the marker, answers, and exits with
   * the code the runner reads as "update and come back". What these tests hold to
   * is the order — no `systemctl` probe at all under the runner — because a probe
   * is the first step of driving a unit, and the live unit on a box with one is
   * not this daemon's to drive.
   */

  const roots = new Set<string>();

  interface Fixture {
    readonly home: string;
    readonly workspaceTree: string;
    readonly snapshotTree: string;
    readonly logsDir: string;
    readonly runDir: string;
  }

  async function fixture(options: { script?: boolean } = {}): Promise<Fixture> {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-runner-launcher-"));
    roots.add(home);
    const workspaceTree = join(home, "workspace");
    const snapshotTree = join(home, "snapshot");
    for (const tree of [workspaceTree, snapshotTree]) await mkdir(join(tree, "user-tools"), { recursive: true });
    if (options.script !== false) {
      await writeFile(join(workspaceTree, "user-tools", "update-and-restart"), "#!/usr/bin/env bash\nexit 0\n");
    }
    return {
      home,
      workspaceTree,
      snapshotTree,
      logsDir: join(home, "logs"),
      runDir: join(home, "run"),
    };
  }

  interface Recorded {
    readonly probes: { command: string; args: readonly string[] }[];
    readonly launched: { command: string; args: readonly string[]; logFile: string }[];
    readonly exits: number[];
  }

  function recorder(fx: Fixture): { hooks: RestartHooks; calls: Recorded } {
    const calls: Recorded = { probes: [], launched: [], exits: [] };
    const hooks: RestartHooks = {
      // The real hooks leave the process; these only record. A probe answers as the
      // user unit would, so a launcher that took the systemd path here would build
      // a `systemd-run` command, and the tests would see it.
      probe: async (command, args) => {
        calls.probes.push({ command, args });
        return { code: 0, stdout: "", stderr: "" };
      },
      launch: async (command, args, logFile) => {
        calls.launched.push({ command, args, logFile });
        return { code: 0 };
      },
      // The one hook that is real: whether a file is there is the thing under test.
      exists: (path) => existsSync(path),
    };
    return { hooks, calls };
  }

  function launcher(fx: Fixture, env: NodeJS.ProcessEnv, hooks: RestartHooks, exits: number[] = []): RestartLauncher {
    return new RestartLauncher({
      home: fx.home,
      workspaceTree: fx.workspaceTree,
      snapshotTree: fx.snapshotTree,
      logsDir: fx.logsDir,
      runDir: fx.runDir,
      env,
      nodePath: "/usr/bin/node",
      now: () => 1_700_000_000_000,
      hooks,
      exitForRunner: (code) => exits.push(code),
    });
  }

  async function marker(fx: Fixture): Promise<{ at: number; source: string }> {
    return JSON.parse(await readFile(restartMarkerPath(fx.runDir), "utf8")) as { at: number; source: string };
  }

  afterEach(async () => {
    for (const root of roots) await rm(root, { recursive: true, force: true });
    roots.clear();
  });

  describe("a restart requested under the runner", () => {
    it("writes the marker, answers with the runner mode, and probes nothing", async () => {
      const fx = await fixture();
      const { hooks, calls } = recorder(fx);
      const exits: number[] = [];
      const restart = launcher(fx, { [RUNNER_VARIABLE]: "1" }, hooks, exits);

      const outcome = await restart.launch("ui");

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.mode).toBe("runner");
      // No unit exists in this mode, so none is named.
      expect(outcome.unit).toBeUndefined();
      expect(outcome.script).toBe(join(fx.workspaceTree, "user-tools", "update-and-restart"));
      expect(outcome.requestedAt).toBe(1_700_000_000_000);

      // The whole point of asking the runner question first: no `systemctl` call,
      // not even `is-enabled`.
      expect(calls.probes).toEqual([]);
      expect(calls.launched).toEqual([]);

      expect(await marker(fx)).toEqual({ at: 1_700_000_000_000, source: "ui" });

      // The exit is deferred to the caller, which calls it once the answer is on
      // the wire, and it carries the one code the runner reads as a restart.
      expect(exits).toEqual([]);
      expect(outcome.exitAfterAnswer).toBeTypeOf("function");
      outcome.exitAfterAnswer?.();
      expect(exits).toEqual([RUNNER_EXIT_CODE]);
      // A second call is one shutdown, not two.
      outcome.exitAfterAnswer?.();
      expect(exits).toEqual([RUNNER_EXIT_CODE]);
    });

    it("refuses a second request in the same process before it writes anything", async () => {
      const fx = await fixture();
      const { hooks } = recorder(fx);
      const restart = launcher(fx, { [RUNNER_VARIABLE]: "1" }, hooks);

      expect((await restart.launch("ui")).ok).toBe(true);
      const second = await restart.launch("ui");

      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.status).toBe(409);
      expect(second.code).toBe("already_requested");
      expect(restart.requested).toBe(true);
    });

    it("refuses when neither tree has the update script", async () => {
      const fx = await fixture({ script: false });
      const { hooks, calls } = recorder(fx);
      const restart = launcher(fx, { [RUNNER_VARIABLE]: "1" }, hooks);

      const outcome = await restart.launch("ui");

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.code).toBe("script_missing");
      expect(calls.probes).toEqual([]);
      expect(restart.requested).toBe(false);
      await expect(marker(fx)).rejects.toThrow();
    });

    it("is not the runner path when the variable says something else", async () => {
      const fx = await fixture();
      const { hooks, calls } = recorder(fx);
      const restart = launcher(fx, { [RUNNER_VARIABLE]: "0" }, hooks);

      const outcome = await restart.launch("ui");

      // The systemd path runs its probes as before; the hook answers 0 for
      // `systemctl --user is-enabled`, so this is the transient-unit route.
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.mode).toBe("systemd");
      expect(calls.probes.map((call) => call.command)).toEqual(["systemctl", "systemd-run"]);
      expect(calls.launched).toHaveLength(1);
    });
  });
});

describe("restart-runner-route.test.ts", () => {
  /**
   * `POST /api/admin/restart` when the daemon runs under `user-tools/run`.
   *
   * The route answers 202 and then the daemon ends, so the runner can apply the
   * update and start it again. The ending is injected (`exitForRunner`) and called
   * from the response's `finish`: the page that pressed the button has to get its
   * answer before the socket goes away with the process.
   */

  describe("the restart route under the runner", () => {
    let harness: TestHarness | undefined;
    let started: StartedServer | undefined;

    afterEach(async () => {
      await started?.close();
      started = undefined;
      await harness?.close();
      harness = undefined;
    });

    interface BootOptions {
      readonly runner?: boolean;
      readonly userUnit?: boolean;
    }

    /** Boot the real route over fake hooks; nothing here reaches systemd. */
    async function boot(options: BootOptions = {}): Promise<{
      origin: string;
      probes: string[];
      exits: number[];
      markerPath: string;
    }> {
      harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
      const probes: string[] = [];
      const exits: number[] = [];
      const workspaceTree = harness.paths.workspaceTree;
      await mkdir(join(workspaceTree, "user-tools"), { recursive: true });
      await writeFile(join(workspaceTree, "user-tools", "update-and-restart"), "#!/usr/bin/env bash\nexit 0\n");

      const launcher = new RestartLauncher({
        home: harness.paths.home,
        workspaceTree,
        snapshotTree: harness.paths.snapshotTree,
        logsDir: harness.paths.logsDir,
        runDir: harness.paths.runDir,
        // The runner is the only thing in this environment: the live one of the
        // test process is not carried, so no probe can find a real unit.
        env: options.runner === true ? { PATH: "/usr/bin:/bin", [RUNNER_VARIABLE]: "1" } : { PATH: "/usr/bin:/bin" },
        nodePath: "/usr/bin/node",
        now: () => 1_700_000_000_000,
        exitForRunner: (code) => exits.push(code),
        hooks: {
          probe: async (command, args) => {
            probes.push([command, ...args].join(" "));
            return { code: options.userUnit === true ? 0 : 1, stdout: "", stderr: "" };
          },
          launch: async () => ({ code: 0 }),
          exists: (path) => path.startsWith(workspaceTree),
        },
      });

      started = await startTestServer(harness, { deps: { restart: launcher } });
      return { origin: started.origin, probes, exits, markerPath: join(harness.paths.runDir, "restart-pending") };
    }

    const post = (origin: string, body = "{}") =>
      fetch(`${origin}/api/admin/restart`, { method: "POST", headers: { "Content-Type": "application/json" }, body });

    it("answers 202 for the runner mode and then ends the daemon", async () => {
      const { origin, probes, exits, markerPath } = await boot({ runner: true });

      const response = await post(origin);
      expect(response.status).toBe(202);
      const body = (await response.json()) as { status: string; mode: string; unit: string | null; script: string; logFile: string; requestedAt: number };

      // The fields the page already reads stay, and `mode` is what says a runner
      // will do the work. There is no unit, and `null` says so rather than leaving
      // the page to guess from a missing key.
      expect(body.status).toBe("launched");
      expect(body.mode).toBe("runner");
      expect(body.unit).toBeNull();
      expect(body.script).toBe(join(harness!.paths.workspaceTree, "user-tools", "update-and-restart"));
      expect(body.logFile).toBe(join(harness!.paths.logsDir, "update-and-restart.log"));
      expect(body.requestedAt).toBe(1_700_000_000_000);

      // No probe at all: under the runner, no unit is touched, not even to look.
      expect(probes).toEqual([]);
      // The marker is what the runner reads for `--reinstall`, and what the next
      // boot reads when the restart never finished.
      const pending = JSON.parse(await readFile(markerPath, "utf8")) as { at: number; source: string };
      expect(pending).toEqual({ at: 1_700_000_000_000, source: "ui" });

      // The exit follows the answer: it is registered on the response's `finish`,
      // and it carries the code the runner reads as "update and come back".
      const deadline = Date.now() + 5000;
      while (exits.length === 0 && Date.now() < deadline) await new Promise((settle) => setTimeout(settle, 10));
      expect(exits).toEqual([RUNNER_EXIT_CODE]);
    });

    it("still refuses a second press in the same process", async () => {
      const { origin, exits } = await boot({ runner: true });

      expect((await post(origin)).status).toBe(202);
      const second = await post(origin);
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: { code: string } };
      expect(body.error.code).toBe("already_requested");
      // One shutdown, however many presses: the second never reaches the launcher.
      const deadline = Date.now() + 2000;
      while (exits.length === 0 && Date.now() < deadline) await new Promise((settle) => setTimeout(settle, 10));
      expect(exits).toEqual([RUNNER_EXIT_CODE]);
    });

    it("refuses with the sentence that names both ways to restart when it has neither", async () => {
      const { origin, probes, exits } = await boot();

      const response = await post(origin);
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("no_unit");
      expect(body.error.message).toBe(
        "no systemd unit named pi-sec was found and the daemon is not running under user-tools/run; stop the daemon, run user-tools/update-and-restart, and start the daemon again",
      );
      // The refusal comes from the probes, which is the path that is left without
      // the runner, and nothing ends the process for it.
      expect(probes).toEqual(["systemctl --user is-enabled pi-sec", "systemctl is-enabled pi-sec"]);
      expect(exits).toEqual([]);
    });
  });
});

describe("p3-restart-refused-audit.test.ts", () => {
  const ctx = BACKGROUND_CONTEXT;

  /**
   * A `restart_refused` row is read by whatever wants to know why a restart was
   * not asked for. Three places record one: the two refusals inside
   * `request_restart` (the operator's approval is missing, or the gate said no)
   * and the web UI's own launch route.
   *
   * The shape is the contract, not the wording. Every row carries `source` (which
   * path refused), `code` (a stable machine-readable reason) and `reasons` (the
   * human-readable detail, always a list), so a reader can treat the three alike
   * instead of asking where the row came from. A fourth reason has a row of its
   * own here: `safe_point_waiting`, which is not a refusal of the change but of the
   * moment — a child conversation is still working and has been told to park.
   *
   * Two fields are added by the tool path alone, because only it can supply them:
   * the batch `title` and the `conversationId` the call came from. They are named
   * here so a row cannot grow a field nobody expected.
   */

  /** The fields every `restart_refused` row has to carry, whatever recorded it. */
  const CORE = ["time", "type", "source", "code", "reasons"] as const;
  /** The only fields a row may add beyond {@link CORE}, and which path may add them. */
  const EXTRA = ["title", "conversationId"] as const;

  describe("restart_refused rows have one shape", () => {
    let harness: TestHarness | undefined;
    let started: StartedServer | undefined;

    afterEach(async () => {
      await started?.close();
      started = undefined;
      await harness?.close();
      harness = undefined;
    });

    async function boot(): Promise<TestHarness> {
      harness = await createTestHarness({ config: { server: { ...defaultConfig().server, port: 0 } } });
      // Core work is recorded in the default conversation, so the tool has to find
      // it there.
      await resolveDefaultConversation(harness.runtime.harness, harness.runtime.getConfig(), harness.runtime.paths, ctx);
      return harness;
    }

    /** The execution api the harness hands a tool: an id, and a commit into the session. */
    function execApi(h: TestHarness): ToolExecutionApi {
      return {
        conversationId: 1,
        commit: (change: (tx: never) => unknown, context: Context) => h.runtime.harness.commit(change as never, context),
      } as unknown as ToolExecutionApi;
    }

    function restartTool(subagents?: SubagentHub): ToolRegistration {
      const runtime = harness!.runtime;
      const context = {
        getConfig: runtime.getConfig,
        paths: runtime.paths,
        secrets: runtime.secrets,
        audit: runtime.audit,
        logger: runtime.logger,
        events: runtime.events,
        restart: runtime.restart,
        sections: runtime.sections,
        storage: runtime.storage,
        reports: runtime.reports,
        ...(subagents === undefined ? {} : { subagents }),
      } as unknown as ExtensionContext;
      const tool = createSelfEditExtension(context).tools?.find((item) => item.name === "request_restart");
      if (tool === undefined) throw new Error("request_restart is not registered");
      return tool;
    }

    /**
     * A hub whose one child is still running a background call, so `request_restart`
     * stops at the safe-point wait. The note goes nowhere: this file is about the
     * row the wait writes, not about how a message reaches an inbox.
     */
    function busyHub(conversationId: string): SubagentHub {
      const child: AgentRecord = {
        conversationId,
        kind: "subagent",
        name: "still-working",
        parentConversationId: "1",
        vmodel: "faux",
        roles: [],
        status: "running",
        createdAt: 1,
        updatedAt: 1,
      };
      return {
        children: async (parent: ConversationId) => (String(parent) === "1" ? [child] : []),
        ownAsyncCalls: async () => ["a long call"],
        workingChildren: async () => [],
        nameOf: async () => ({ name: "operator", kind: "root" }),
        writeMessage: async (_ctx: Context, input: { readonly to: { readonly conversationId: string }; readonly kind: string; readonly body: string }) => ({
          id: "message-1",
          from: { conversationId: "1", name: "operator", agentKind: "root" },
          to: input.to,
          kind: input.kind,
          body: input.body,
          bytes: input.body.length,
          status: "pending" as const,
          createdAt: Date.now(),
        }),
        deliver: async () => ({ delivered: true }),
      } as unknown as SubagentHub;
    }

    /** A child conversation that exists, so a hub stub can name it. */
    async function seedChild(h: TestHarness): Promise<string> {
      let id = "";
      await h.runtime.harness.commit(async (tx) => {
        const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
        id = String(conversation.id);
      }, ctx);
      return id;
    }

    /** One live job with one report on it, and the report's id. */
    async function report(): Promise<string> {
      const job = await harness!.runtime.jobs.create(ctx, { title: "work" });
      const record = await harness!.runtime.reports.create(ctx, { jobId: job.id, title: "Plan", content: "one\n" });
      return record.id;
    }

    async function refusals(h: TestHarness): Promise<AuditEvent[]> {
      return (await readAuditTail(h.paths.auditLog, undefined, 50)).filter((event) => event.type === "restart_refused");
    }

    /**
     * The web UI's launch route over a launcher that refuses. What is under test is
     * the row the route writes, not the launcher, so the refusal is handed back
     * whole instead of being provoked out of the real one.
     */
    const LAUNCH_REFUSAL: RestartOutcome = {
      ok: false,
      status: 409,
      code: "already_requested",
      message: "this daemon has already asked for a restart; wait for it to come back",
    };

    async function serve(h: TestHarness): Promise<string> {
      started = await startTestServer(h, { deps: { restart: { launch: async () => LAUNCH_REFUSAL } } });
      return started.origin;
    }

    it("writes the same fields whichever of the three places refused", async () => {
      const h = await boot();
      // 1. The guard: a reportId that names no report.
      await restartTool().execute({ title: "batch", reportId: "no-such-report" } as never, execApi(h), ctx);
      // 2. The safe-point wait: an approved report, and a child still working.
      const id = await report();
      expect((await h.runtime.reports.approve(ctx, id, 1, { via: "panel" })).ok).toBe(true);
      await restartTool(busyHub(await seedChild(h))).execute({ title: "batch", reportId: id } as never, execApi(h), ctx);
      // 3. The gate: a call past the guard, refused for the tree it ran against.
      await restartTool().execute({ title: "batch", reportId: id } as never, execApi(h), ctx);
      // 4. The UI route, over a launcher that refuses.
      const origin = await serve(h);
      const response = await fetch(`${origin}/api/admin/restart`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(409);

      const rows = await refusals(h);
      // All four places wrote one, so the shape below is the shape of every one.
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((row) => row.source))).toEqual(new Set(["agent", "ui"]));
      for (const row of rows) {
        const keys = Object.keys(row);
        for (const field of CORE) expect(keys).toContain(field);
        for (const key of keys) expect([...CORE, ...EXTRA]).toContain(key);
        expect(row.time).toBeTypeOf("number");
        expect(row.source === "agent" || row.source === "ui").toBe(true);
        expect(row.code).toBeTypeOf("string");
        expect(row.code).not.toBe("");
        expect(Array.isArray(row.reasons)).toBe(true);
        expect((row.reasons as string[]).length).toBeGreaterThan(0);
        for (const reason of row.reasons as string[]) expect(reason).toBeTypeOf("string");
      }
      // The tool path keeps the two facts only it knows, and the UI path invents
      // neither of them rather than writing an empty one.
      for (const row of rows.filter((event) => event.source === "agent")) {
        expect(row.title).toBe("batch");
        expect(row.conversationId).toBe(1);
      }
      expect(Object.keys(rows.find((row) => row.source === "ui")!)).toHaveLength(CORE.length);
    });

    it("names the reason in the code, so a reader does not have to parse the text", async () => {
      const h = await boot();
      // A child that is still working: the wait comes before every other check, so
      // it needs an approved report to be reached at all.
      const waiting = await report();
      expect((await h.runtime.reports.approve(ctx, waiting, 1, { via: "panel" })).ok).toBe(true);
      await restartTool(busyHub(await seedChild(h))).execute({ title: "batch", reportId: waiting } as never, execApi(h), ctx);
      await restartTool().execute({ title: "batch" } as never, execApi(h), ctx);
      const id = await report();
      await restartTool().execute({ title: "batch", reportId: id } as never, execApi(h), ctx);
      expect((await h.runtime.reports.approve(ctx, id, 1, { via: "panel" })).ok).toBe(true);
      await restartTool().execute({ title: "batch", reportId: id } as never, execApi(h), ctx);
      await h.runtime.reports.addVersion(ctx, id, { content: "two\n", note: "second" });
      await restartTool().execute({ title: "batch", reportId: id } as never, execApi(h), ctx);

      const codes = (await refusals(h)).map((row) => row.code);
      // Five different outcomes, five different codes: the safe-point wait, the
      // guard's two, the gate's, and the stale approval's.
      expect(codes).toEqual(["safe_point_waiting", "report_id_required", "no_approval", "gate_failed", "no_approval"]);
    });

    it("keeps the launcher's own code and message on the UI path", async () => {
      const h = await boot();
      const origin = await serve(h);
      await fetch(`${origin}/api/admin/restart`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

      const rows = await refusals(h);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).toBe("ui");
      expect(rows[0]!.code).toBe(LAUNCH_REFUSAL.code);
      expect(rows[0]!.reasons).toEqual([LAUNCH_REFUSAL.message]);
    });
  });
});
