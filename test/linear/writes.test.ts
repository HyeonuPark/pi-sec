import { afterEach, describe, expect, it } from "vitest";
import type { ReportStore } from "../../src/reports/store.ts";
import { FAKE_KEY, CTX, approvedReport, createRig, issueNode, reply, type Rig } from "./helpers.ts";

let rig: Rig | undefined;
afterEach(async () => {
  await rig?.close();
  rig = undefined;
});

const NOTHING_SENT = /Nothing was sent to Linear\.$/;
const ONE_READ = /No write was sent to Linear\. One read was sent\.$/;
const GRANT_ENG_123 = "# Plan\n\nWrite on one issue.\n\nlinear-write: ENG-123\n";
const COMMENT_BODY = "[pi-sec test] a private sentence that must stay out of the audit row";

const updateOk = reply({ data: { issueUpdate: { success: true, issue: { id: "issue-uuid-1", identifier: "ENG-123", title: "New title", url: "https://linear.app/acme/issue/ENG-123/new-title" } } } });
const commentOk = reply({ data: { commentCreate: { success: true, comment: { id: "comment-1", createdAt: "2026-11-06T01:00:00Z", url: "https://linear.app/acme/issue/ENG-123#comment-comment-1" } } } });

function mutationsSent(r: Rig): number {
  return r.linear.seen.filter((call) => call.query.trimStart().startsWith("mutation")).length;
}

describe("the write gate refuses before any request", () => {
  it("refuses when writes is false in the configuration read now, also after boot", async () => {
    rig = await createRig({ writes: true });
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    rig.config.current = { ...rig.config.current, linear: { apiKeySecret: "linear.api-key", writes: false } };
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: COMMENT_BODY });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Refused at step 1: .*linear\.writes is false/);
    expect(result.text).toMatch(NOTHING_SENT);
    expect(rig.linear.seen).toHaveLength(0);
    expect(rig.rows[0]).toMatchObject({ type: "linear_write_refused", step: 1, tool: "linear_add_comment" });
  });

  it("refuses a call with no report_id, and a report that does not exist", async () => {
    rig = await createRig();
    for (const args of [{ id: "ENG-123", body: "x" }, { report_id: "", id: "ENG-123", body: "x" }, { report_id: "no-such-report", id: "ENG-123", body: "x" }]) {
      const result = await rig.call("linear_add_comment", args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/^Refused at step 2: /);
      expect(result.text).toMatch(NOTHING_SENT);
    }
    expect(rig.linear.seen).toHaveLength(0);
    expect(rig.rows.map((row) => row.step)).toEqual([2, 2, 2]);
  });

  it("refuses a briefing, a report whose job is done, and a revision without an approval", async () => {
    rig = await createRig();
    const briefing = await approvedReport(rig, GRANT_ENG_123, { kind: "briefing" });
    const finished = await approvedReport(rig, GRANT_ENG_123);
    await rig.harness.runtime.jobs.update(CTX, finished.jobId, { status: "done" });
    const unapproved = await approvedReport(rig, GRANT_ENG_123, { approve: false });
    for (const [report, word] of [
      [briefing, "briefing"],
      [finished, "done"],
      [unapproved, "no approval"],
    ] as const) {
      const result = await rig.call("linear_add_comment", { report_id: report.reportId, id: "ENG-123", body: "x" });
      expect(result.isError, word).toBe(true);
      expect(result.text, word).toContain(word);
      expect(result.text).toMatch(/^Refused at step 2: /);
      expect(result.text).toMatch(NOTHING_SENT);
    }
    expect(rig.linear.seen).toHaveLength(0);
  });

  it("refuses an approval that sits on an older revision only", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    await rig.harness.runtime.reports.addVersion(CTX, reportId, { content: GRANT_ENG_123 + "\nA second revision.\n", note: "v2" });
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Refused at step 2: .*no approval on its newest revision, v2/);
    expect(result.text).toMatch(NOTHING_SENT);
    expect(rig.linear.seen).toHaveLength(0);
  });

  it("refuses an approval whose sha256 differs from the revision's", async () => {
    rig = await createRig({
      wrapReports: (real) =>
        new Proxy(real as ReportStore, {
          get(target, property, receiver) {
            if (property === "checkApproval") {
              return async (...args: Parameters<ReportStore["checkApproval"]>) => {
                const check = await target.checkApproval(...args);
                if (check.ok || check.reason !== "already_approved") return check;
                return { ...check, approval: { ...check.approval, sha256: "0".repeat(64) } };
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        }),
    });
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: "x" });
    expect(result.text).toMatch(/^Refused at step 2: .*sha256/);
    expect(result.text).toMatch(NOTHING_SENT);
    expect(rig.linear.seen).toHaveLength(0);
  });

  it("refuses a text whose sha256 differs from the revision's", async () => {
    rig = await createRig({
      wrapReports: (real) =>
        new Proxy(real as ReportStore, {
          get(target, property, receiver) {
            if (property === "readVersion") return async () => "linear-write: ENG-123\nchanged after approval\n";
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        }),
    });
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: "x" });
    expect(result.text).toMatch(/^Refused at step 3: /);
    expect(result.text).toMatch(NOTHING_SENT);
    expect(rig.linear.seen).toHaveLength(0);
    expect(rig.rows[0]).toMatchObject({ type: "linear_write_refused", step: 3 });
  });

  it("refuses an approved text that holds no grant line, even when it names the issue", async () => {
    rig = await createRig();
    const prose = await approvedReport(rig, "# Plan\n\nWe will comment on ENG-123 and team:ENG.\nExample: linear-write: team:<KEY>\n");
    const result = await rig.call("linear_add_comment", { report_id: prose.reportId, id: "ENG-123", body: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Refused at step 4: .*holds no grant line/);
    expect(result.text).toMatch(NOTHING_SENT);
    expect(rig.linear.seen).toHaveLength(0);
    expect(rig.rows[0]).toMatchObject({ type: "linear_write_refused", step: 4 });
  });

  it("refuses a create or an update the same way, and bad arguments after the gate", async () => {
    rig = await createRig();
    const none = await approvedReport(rig, "# Plan\n\nNo grant here.\n");
    const created = await rig.call("linear_create_issue", { report_id: none.reportId, team: "ENG", title: "t" });
    const updated = await rig.call("linear_update_issue", { report_id: none.reportId, id: "ENG-1", title: "t" });
    for (const result of [created, updated]) expect(result.text).toMatch(/^Refused at step 4: [\s\S]*Nothing was sent to Linear\.$/);
    const granted = await approvedReport(rig, GRANT_ENG_123);
    const empty = await rig.call("linear_update_issue", { report_id: granted.reportId, id: "ENG-123" });
    expect(empty.text).toMatch(/^Refused: give at least one field to change\. Nothing was sent to Linear\.$/);
    expect(rig.linear.seen).toHaveLength(0);
  });
});

describe("the write gate after the reads", () => {
  it("refuses a grant line for another target after exactly one read and no mutation", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, "linear-write: ENG-12, OPS-123, team:OPS\n");
    rig.linear.on("LinearIssueForWrite", reply({ data: { issue: issueNode() } }));
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: COMMENT_BODY });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Refused at step 6: /);
    expect(result.text).toMatch(ONE_READ);
    expect(rig.linear.operations).toEqual(["LinearIssueForWrite"]);
    expect(rig.rows[0]).toMatchObject({ type: "linear_write_refused", step: 6, reportId, revision: 1 });
  });

  it("refuses a create when no grant line names the team", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, "linear-write: ENG-123\n");
    rig.linear.on("LinearTeamForWrite", reply({ data: { teams: { nodes: [{ id: "team-uuid-1", key: "ENG", name: "Engineering" }] } } }));
    const result = await rig.call("linear_create_issue", { report_id: reportId, team: "eng", title: "t" });
    expect(result.text).toMatch(/^Refused at step 6: .*team:ENG/);
    expect(result.text).toMatch(ONE_READ);
    expect(rig.linear.operations).toEqual(["LinearTeamForWrite"]);
  });

  it("passes for an issue grant: reads first, then exactly one mutation", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    rig.linear.on("LinearIssueForWrite", reply({ data: { issue: issueNode() } }));
    rig.linear.on("LinearStatesForWrite", reply({ data: { workflowStates: { nodes: [{ id: "state-2", name: "In Progress" }, { id: "state-1", name: "Todo" }] } } }));
    rig.linear.on("LinearIssueUpdate", updateOk);
    const result = await rig.call("linear_update_issue", { report_id: reportId, id: "ENG-123", title: "New title", state: "in progress", priority: 1 });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("title: Old title -> New title");
    expect(result.text).toContain("state: Todo -> In Progress");
    expect(result.text).toContain("priority: Medium -> Urgent");
    expect(rig.linear.operations).toEqual(["LinearIssueForWrite", "LinearStatesForWrite", "LinearIssueUpdate"]);
    expect(mutationsSent(rig)).toBe(1);
    expect(rig.linear.seen[2]?.variables).toEqual({ id: "issue-uuid-1", input: { title: "New title", stateId: "state-2", priority: 1 } });
    expect(rig.rows).toHaveLength(1);
    expect(rig.rows[0]).toMatchObject({ type: "linear_write", tool: "linear_update_issue", target: "ENG-123", outcome: "sent", url: "https://linear.app/acme/issue/ENG-123/new-title" });
    expect(rig.rows[0]?.fields).toEqual(["title", "state", "priority"]);
  });

  it("passes for a team grant when the issue's team is that team", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, "- `linear-write: team:ENG`\n");
    rig.linear.on("LinearIssueForWrite", reply({ data: { issue: issueNode() } }));
    rig.linear.on("LinearCommentCreate", commentOk);
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "https://linear.app/acme/issue/ENG-123/x", body: COMMENT_BODY, reply_to: "parent-1" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Added comment comment-1 to ENG-123");
    expect(rig.linear.operations).toEqual(["LinearIssueForWrite", "LinearCommentCreate"]);
    expect(rig.linear.seen[1]?.variables).toEqual({ input: { issueId: "issue-uuid-1", body: COMMENT_BODY, parentId: "parent-1" } });
  });

  it("does not pass a team grant for an issue of another team", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, "linear-write: team:ENG\n");
    rig.linear.on("LinearIssueForWrite", reply({ data: { issue: issueNode({ identifier: "OPS-5", team: { id: "t2", key: "OPS" } }) } }));
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "OPS-5", body: "x" });
    expect(result.text).toMatch(/^Refused at step 6: /);
    expect(mutationsSent(rig)).toBe(0);
  });

  it("creates with a UUID id, resolves names inside the team, and answers the new identifier", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, "linear-write: team:ENG\n");
    rig.linear.on("LinearTeamForWrite", reply({ data: { teams: { nodes: [{ id: "team-uuid-1", key: "ENG", name: "Engineering" }] } } }));
    rig.linear.on("LinearStatesForWrite", reply({ data: { workflowStates: { nodes: [{ id: "s1", name: "Backlog" }, { id: "s2", name: "Todo" }] } } }));
    rig.linear.on("LinearLabelsForWrite", reply({ data: { issueLabels: { nodes: [{ id: "l1", name: "bug" }] } } }));
    rig.linear.on("LinearIssueCreate", reply({ data: { issueCreate: { success: true, issue: { id: "new", identifier: "ENG-200", title: "[pi-sec test] t", url: "https://linear.app/acme/issue/ENG-200", state: { name: "Todo" } } } } }));
    const result = await rig.call("linear_create_issue", { report_id: reportId, team: "ENG", title: "[pi-sec test] t", description: "body text", state: "todo", labels: ["Bug"], priority: 2 });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Created ENG-200: [pi-sec test] t [Todo]");
    expect(rig.linear.operations).toEqual(["LinearTeamForWrite", "LinearStatesForWrite", "LinearLabelsForWrite", "LinearIssueCreate"]);
    const input = rig.linear.seen[3]?.variables.input;
    expect(input).toMatchObject({ id: "00000000-0000-4000-8000-000000000001", teamId: "team-uuid-1", title: "[pi-sec test] t", description: "body text", stateId: "s2", labelIds: ["l1"], priority: 2 });
    expect(rig.rows[0]).toMatchObject({ type: "linear_write", target: "team:ENG" });
    expect(JSON.stringify(rig.rows)).not.toContain("body text");
  });

  it("refuses a state name that matches two states, and lists both, before any mutation", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, "linear-write: team:ENG\n");
    rig.linear.on("LinearTeamForWrite", reply({ data: { teams: { nodes: [{ id: "team-uuid-1", key: "ENG", name: "Engineering" }] } } }));
    rig.linear.on("LinearStatesForWrite", reply({ data: { workflowStates: { nodes: [{ id: "s1", name: "Done" }, { id: "s2", name: "done" }] } } }));
    const result = await rig.call("linear_create_issue", { report_id: reportId, team: "ENG", title: "t", state: "Done" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Refused at step 7: .*matches 2 items.*Done, done/);
    expect(mutationsSent(rig)).toBe(0);
    expect(rig.rows[0]).toMatchObject({ type: "linear_write_refused", step: 7 });
  });
});

describe("a write that fails", () => {
  it("is not retried after a 429", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    rig.linear.on("LinearIssueForWrite", reply({ data: { issue: issueNode() } }));
    rig.linear.on("LinearCommentCreate", reply({ errors: [{ message: "slow", extensions: { code: "RATELIMITED" } }] }, { status: 429, headers: { "Retry-After": "1" } }));
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: COMMENT_BODY });
    expect(result).toEqual({ text: "Linear rate limit; retry after 1 s.", isError: true });
    expect(mutationsSent(rig)).toBe(1);
    expect(rig.sleeps).toEqual([]);
    expect(rig.rows[0]).toMatchObject({ type: "linear_write_refused", step: 7 });
  });

  it("says the write may or may not have happened after a timeout, and records it as unknown", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    rig.linear.on("LinearIssueForWrite", reply({ data: { issue: issueNode() } }));
    rig.linear.on("LinearCommentCreate", () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: COMMENT_BODY });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Linear did not answer within 20 s.");
    expect(result.text).toContain("The write may or may not have happened. Read the issue before you try again.");
    expect(rig.rows[0]).toMatchObject({ type: "linear_write", outcome: "unknown" });
  });

  it("refuses the key's denial with the plain text, and the audit row says step 7", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    rig.linear.on("LinearIssueForWrite", reply({ data: { issue: issueNode() } }));
    rig.linear.on("LinearCommentCreate", reply({ errors: [{ message: "forbidden", extensions: { type: "forbidden" } }] }, { status: 403 }));
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: COMMENT_BODY });
    expect(result.text).toContain("Linear denied access.");
    expect(rig.rows[0]).toMatchObject({ type: "linear_write_refused", step: 7 });
  });
});

describe("the audit rows", () => {
  it("hold the length of a body and never its text, and never the key", async () => {
    rig = await createRig();
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    rig.linear.on("LinearIssueForWrite", reply({ data: { issue: issueNode() } }));
    rig.linear.on("LinearCommentCreate", commentOk);
    await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: COMMENT_BODY }, "42");
    const refused = await approvedReport(rig, "no grant\n");
    await rig.call("linear_add_comment", { report_id: refused.reportId, id: "ENG-123", body: COMMENT_BODY });
    expect(rig.rows).toHaveLength(2);
    expect(rig.rows[0]).toMatchObject({ type: "linear_write", conversationId: "42", lengths: { body: COMMENT_BODY.length } });
    expect(rig.rows[1]).toMatchObject({ type: "linear_write_refused", step: 4, lengths: { body: COMMENT_BODY.length } });
    const all = JSON.stringify(rig.rows);
    expect(all).not.toContain(COMMENT_BODY);
    expect(all).not.toContain("private sentence");
    expect(all).not.toContain(FAKE_KEY);
  });

  it("do not exist for a missing key's refusal before the gate, and name the step after it", async () => {
    rig = await createRig({ keyFile: "missing" });
    const { reportId } = await approvedReport(rig, GRANT_ENG_123);
    const result = await rig.call("linear_add_comment", { report_id: reportId, id: "ENG-123", body: "x" });
    expect(result.text).toContain("No Linear key");
    expect(rig.linear.seen).toHaveLength(0);
    expect(rig.rows[0]).toMatchObject({ type: "linear_write_refused", step: 5 });
  });
});
