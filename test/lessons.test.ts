import { commitWrites } from "@earendil-works/pi-durable/testing";
import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { collapseSystemMessages } from "@earendil-works/pi-ai/utils/transcript";
import { getSystemMessageText } from "@earendil-works/pi-ai/utils/text";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type EntryDraft,
  type EntryId,
  type StorageWrite,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { defaultConfig } from "../src/config/schema.ts";
import { SecLessonCount } from "../src/documents.ts";
import { resolveDefaultConversation } from "../src/agent/conversation.ts";
import { SCHEDULED_TOOL_REMOVALS, SUBAGENT_TOOL_REMOVALS, toolFilterFor } from "../src/agent/tool-profile.ts";
import { wrapMessage } from "../src/message-envelope.ts";
import { REVIEW_MARKER } from "../src/review.ts";
import { NULL_REDACTOR, createRedactor, type Redactor } from "../src/secrets/redact.ts";
import {
  LESSON_COUNT_SECTION,
  LESSON_TOOL_NAMES,
  SCAN_YIELD_PAGES,
  fingerprintOf,
  getLesson,
  importLessons,
  lessonCountLine,
  lessonStats,
  listLessons,
  normalizeStatement,
  readImportFile,
  readLessons,
  recordLesson,
  refreshLessonCounter,
  rewordLesson,
  sanitizeLessonWrite,
  scanLessons,
  statementSimilarity,
  updateLesson,
  type LessonDeps,
  type LessonRecordInput,
  type LessonRecordOutcome,
  type LessonWriteApi,
} from "../src/extensions/lessons.ts";
import { openPrivateSqliteStorage } from "../src/runtime/sqlite-file.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

const ctx = BACKGROUND_CONTEXT;

// Korean text here is test data: the code under test handles Korean on purpose.
/**
 * A statement pair 0.95 similar: one short word added to a long sentence. The
 * plan's automatic recurrence band is 0.9 and above, and this is what the band is
 * for — the same lesson written again, not a second lesson.
 */
const RECURRENCE_BASE =
  "작업을 마친 워커는 결과를 한 번만 보고하고 부모의 지시를 기다리며 진행 상황을 따로 알리지 않는다는 규칙을 오늘 기록해 둔다";
const RECURRENCE_VARIANT =
  "작업을 마친 워커는 결과를 한 번만 보고하고 부모의 지시를 기다리며 진행 상황을 따로 알리지 않는다는 중요한 규칙을 오늘 기록해 둔다";

/** A statement pair 0.83 similar: the 0.6–0.9 band, where a merge candidate is written. */
const DUPLICATE_BASE = "the gate runs the typecheck and the whole test suite before anything is committed";
const DUPLICATE_VARIANT = "the gate runs the typecheck and the full test suite before anything is committed";

describe("statement normalization", () => {
  it("folds case, spacing, punctuation, and particles into one form", () => {
    expect(normalizeStatement("  커밋   전에 Typecheck 를 돌린다! ")).toBe("커밋 전에 typecheck 돌린다");
    expect(fingerprintOf("커밋 전에 typecheck를 돌린다.")).toBe(fingerprintOf("커밋 전에  Typecheck 를 돌린다"));
  });

  it("keeps two different lessons apart", () => {
    expect(fingerprintOf("커밋 전에 typecheck를 돌린다")).not.toBe(fingerprintOf("배포 전에 테스트를 돌린다"));
  });

  it("scores near-identical statements at 1 and unrelated ones below the merge band", () => {
    expect(statementSimilarity("리포트는 발행 전에 검수한다", "리포트는 발행 전에 검수한다.")).toBe(1);
    expect(statementSimilarity(RECURRENCE_BASE, RECURRENCE_VARIANT)).toBeGreaterThanOrEqual(0.9);
    expect(statementSimilarity(DUPLICATE_BASE, DUPLICATE_VARIANT)).toBeGreaterThanOrEqual(0.6);
    expect(statementSimilarity(DUPLICATE_BASE, DUPLICATE_VARIANT)).toBeLessThan(0.9);
    expect(statementSimilarity("커밋 전에 typecheck를 돌린다", "리포트는 발행 전에 검수한다")).toBeLessThan(0.6);
  });
});

describe("secret guard", () => {
  const bare = createRedactor([]);
  const value = "sk-live-0123456789abcdef";
  const registered = createRedactor([{ name: "model-auth.deepseek.key", value }]);

  it("replaces a registered value and refuses the placeholder it left behind", () => {
    const result = sanitizeLessonWrite({ statement: `키 값은 ${value} 였다` }, registered);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("secret placeholder");
  });

  it("refuses a placeholder that a caller wrote by hand", () => {
    const result = sanitizeLessonWrite({ statement: "값은 ⟦secret:token⟧ 이다" }, bare);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("secret placeholder");
  });

  it("accepts credential shapes and long ids the registry does not know about", () => {
    for (const statement of [
      "the retry used token=abc123 and then failed",
      "put the apiKey in the env file",
      "api_key 라는 낱말이 든 교훈도 저장한다",
      "Authorization 헤더를 확인한다",
      "the header was bearer abcdefgh12345678",
      "aB3kL9mN2pQ7rS4tU6vW8xY1zA5bC0dE2fG4hJ6k",
      "커밋 0123456789abcdef0123456789abcdef01234567 에 반영했다",
      `리비전 sha256 은 ${"ab12".repeat(16)} 이다`,
      "근거는 state/reports/01M58DMWGE000000000000KYSD/v1 에 있다",
    ]) {
      const result = sanitizeLessonWrite({ statement }, registered);
      expect(result).toEqual({ ok: true, statement, filePaths: [], tags: [] });
    }
  });

  it("accepts a long id in a file path and a tag", () => {
    const path = "state/reports/01M58DMWGE000000000000KYSD/v1";
    const tag = "0123456789abcdef0123456789abcdef01234567";
    const result = sanitizeLessonWrite({ statement: "문장", filePaths: [path], tags: [tag, "token=abc123"] }, registered);
    expect(result).toEqual({ ok: true, statement: "문장", filePaths: [path], tags: [tag, "token=abc123"] });
  });

  it("refuses a statement over the character limit and more file paths than allowed", () => {
    expect(sanitizeLessonWrite({ statement: "가".repeat(601) }, bare).ok).toBe(false);
    expect(sanitizeLessonWrite({ statement: "문장", filePaths: Array.from({ length: 11 }, (_, i) => `src/f${i}.ts`) }, bare).ok).toBe(false);
  });

  it("passes an ordinary statement with a file path", () => {
    const result = sanitizeLessonWrite(
      { statement: "커밋 전에 typecheck를 돌린다", filePaths: ["src/extensions/lessons.ts"], tags: ["gate"] },
      bare,
    );
    expect(result).toEqual({
      ok: true,
      statement: "커밋 전에 typecheck를 돌린다",
      filePaths: ["src/extensions/lessons.ts"],
      tags: ["gate"],
    });
  });

  it("refuses a tag and a file path that hold a registered secret", () => {
    const tag = sanitizeLessonWrite({ statement: "문장", tags: [`token=${value}`] }, registered);
    expect(tag.ok).toBe(false);
    expect(tag.ok === false && tag.reason).toContain("secret placeholder");
    expect(tag.ok === false && tag.reason).toContain("(tag)");

    const path = sanitizeLessonWrite({ statement: "문장", filePaths: [`state/${value}/notes.md`] }, registered);
    expect(path.ok).toBe(false);
    expect(path.ok === false && path.reason).toContain("secret placeholder");
    expect(path.ok === false && path.reason).toContain("(file path)");
  });
});

describe("lesson store", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  /** Boot with the lessons extension enabled; without it no lesson tool is offered. */
  async function boot(): Promise<TestHarness> {
    const base = defaultConfig();
    harness = await createTestHarness({
      config: {
        agent: { ...base.agent, extensions: { enabled: [...base.agent.extensions.enabled, "lessons"] } },
      },
    });
    return harness;
  }

  function depsOf(h: TestHarness, redactor?: () => Redactor): LessonDeps {
    return {
      storage: h.runtime.storage,
      reader: () => h.runtime.harness,
      redactor: redactor ?? (() => h.runtime.secrets.redactor()),
    };
  }

  function apiOf(h: TestHarness, conversationId = 1): LessonWriteApi {
    return {
      conversationId: conversationId as ConversationId,
      commit: (change, context) => h.runtime.harness.commit(change, context),
    };
  }

  async function record(h: TestHarness, input: LessonRecordInput, conversationId = 1): Promise<LessonRecordOutcome> {
    const result = await recordLesson(depsOf(h), apiOf(h, conversationId), ctx, input);
    if (!result.ok) throw new Error(result.reason);
    return result.outcome;
  }

  it("records a lesson and reads it back", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const statement = "커밋 전에 typecheck를 돌린다";
    const outcome = await record(h, {
      statement,
      category: "user_correction",
      severity: "high",
      evidence: { entryId: "12", filePaths: ["src/extensions/lessons.ts"] },
      promotionTarget: "prompt",
      tags: ["gate"],
    });

    expect(outcome.action).toBe("created");
    const stored = await getLesson(deps, ctx, outcome.lessonId);
    expect(stored).toMatchObject({
      id: outcome.lessonId,
      statement,
      category: "user_correction",
      status: "open",
      severity: "high",
      fingerprint: fingerprintOf(statement),
      promotionTarget: "prompt",
      source: "agent",
      tags: ["gate"],
    });
    expect(stored?.recurrence.count).toBe(1);
    expect(stored?.evidence).toEqual({ conversationId: "1", entryId: "12", filePaths: ["src/extensions/lessons.ts"] });
    expect(stored?.origin).toEqual({ conversationId: "1", agentName: "1", kind: "root" });

    const listed = await listLessons(deps, ctx, {});
    expect(listed.map((lesson) => lesson.id)).toEqual([outcome.lessonId]);
    const stats = await lessonStats(deps, ctx);
    expect(stats).toMatchObject({ total: 1, open: 1, proposed: 0, promoted: 0, recurrenceTotal: 1 });
    expect(stats.byCategory.user_correction).toBe(1);
  });

  it("counts a repeat as a recurrence instead of writing a second row", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const statement = "새 행 대신 재발 횟수를 올린다";

    const first = await record(h, { statement, category: "self_found", evidence: { entryId: "1" } }, 1);
    expect(first.action).toBe("created");
    const second = await record(h, { statement, category: "self_found", evidence: { entryId: "2" } }, 2);

    expect(second.action).toBe("recurrence_recorded");
    expect(second.lessonId).toBe(first.lessonId);
    expect(second.recurrenceCount).toBe(2);

    const all = await readLessons(deps, ctx);
    expect(all).toHaveLength(1);
    expect(all[0]?.recurrence).toMatchObject({ count: 2, seenIn: ["1", "2"] });
  });

  it("writes nothing when the same call arrives twice", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const input: LessonRecordInput = {
      statement: "같은 근거로 두 번 부르면 아무것도 하지 않는다",
      category: "self_found",
      evidence: { entryId: "5" },
    };

    const first = await record(h, input);
    const again = await record(h, input);

    expect(again.action).toBe("duplicate_ignored");
    expect(again.lessonId).toBe(first.lessonId);
    expect(again.recurrenceCount).toBe(1);
    expect(await readLessons(deps, ctx)).toHaveLength(1);

    // No entry id at all is the same evidence point as no entry id at all.
    const quiet = { statement: "근거 없는 재호출도 막는다", category: "self_found" as const };
    await record(h, quiet);
    const quietAgain = await record(h, quiet);
    expect(quietAgain.action).toBe("duplicate_ignored");
    expect(await readLessons(deps, ctx)).toHaveLength(2);
  });

  it("treats a 0.9-similar statement as a recurrence and returns ranked neighbours", async () => {
    const h = await boot();
    const deps = depsOf(h);

    const base = await record(h, { statement: RECURRENCE_BASE, category: "runtime_observed" });
    const variant = await record(h, { statement: RECURRENCE_VARIANT, category: "runtime_observed" }, 2);

    expect(variant.action).toBe("recurrence_recorded");
    expect(variant.lessonId).toBe(base.lessonId);
    expect(variant.recurrenceCount).toBe(2);
    expect(variant.similar[0]).toMatchObject({ id: base.lessonId });
    expect(variant.similar[0]?.similarity).toBeGreaterThanOrEqual(0.9);
    expect(await readLessons(deps, ctx)).toHaveLength(1);
  });

  it("writes a new row and marks it when the nearest lesson is only similar", async () => {
    const h = await boot();
    const deps = depsOf(h);

    const base = await record(h, { statement: DUPLICATE_BASE, category: "runtime_observed" });
    const variant = await record(h, { statement: DUPLICATE_VARIANT, category: "runtime_observed" }, 2);

    expect(variant.action).toBe("created");
    expect(variant.lessonId).not.toBe(base.lessonId);
    const stored = await getLesson(deps, ctx, variant.lessonId);
    expect(stored?.duplicateOf).toBe(base.lessonId);
    expect(variant.similar.map((neighbour) => neighbour.id)).toEqual([base.lessonId]);
  });

  it("returns the three closest lessons, best first", async () => {
    const h = await boot();
    const outcome = await record(h, { statement: "무관한 교훈 하나를 적어 둔다", category: "self_found" });
    await record(h, { statement: DUPLICATE_BASE, category: "runtime_observed" }, 2);
    await record(h, { statement: "another unrelated sentence about a completely different subject", category: "self_found" }, 3);
    await record(h, { statement: RECURRENCE_BASE, category: "runtime_observed" }, 4);

    const variant = await record(h, { statement: DUPLICATE_VARIANT, category: "runtime_observed" }, 5);
    expect(outcome.action).toBe("created");
    expect(variant.similar).toHaveLength(3);
    const scores = variant.similar.map((neighbour) => neighbour.similarity);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    expect(variant.similar[0]?.statement).toBe(DUPLICATE_BASE);
  });

  it("lets a caller say a different wording is the same lesson", async () => {
    const h = await boot();
    const base = await record(h, { statement: "리포트는 발행 전에 검수한다", category: "self_found" });
    const forced = await record(
      h,
      {
        statement: "초안은 루트가 검수한 뒤에 발행한다",
        category: "self_found",
        relation: "recurrence",
        duplicateOf: base.lessonId,
      },
      2,
    );

    expect(forced.action).toBe("recurrence_recorded");
    expect(forced.lessonId).toBe(base.lessonId);
    expect(forced.recurrenceCount).toBe(2);
  });

  it("refuses to call something a recurrence when it names no lesson", async () => {
    const h = await boot();
    const result = await recordLesson(depsOf(h), apiOf(h), ctx, {
      statement: "가리킬 교훈이 없는 재발 주장",
      category: "self_found",
      relation: "recurrence",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("duplicateOf");
  });

  it("refuses a promotion that carries no evidence", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const api = apiOf(h);
    const created = await record(h, { statement: "승격은 증거를 요구한다", category: "user_correction" });

    const refused = await updateLesson(deps, api, ctx, { id: created.lessonId, status: "promoted" });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("promotionRef");

    const promoted = await updateLesson(deps, api, ctx, {
      id: created.lessonId,
      status: "promoted",
      promotionTarget: "prompt",
      promotionRef: "prompts/role/worker.md",
      note: "규칙으로 옮겼다",
    });
    expect(promoted.ok).toBe(true);
    const stored = await getLesson(deps, ctx, created.lessonId);
    expect(stored).toMatchObject({ status: "promoted", promotionTarget: "prompt", promotionRef: "prompts/role/worker.md" });
    expect(stored?.notes).toHaveLength(1);
    expect(stored?.notes[0]?.text).toBe("규칙으로 옮겼다");

    const missing = await updateLesson(deps, api, ctx, { id: "no-such-lesson", status: "closed" });
    expect(missing.ok).toBe(false);
  });

  it("refuses a note that holds a secret", async () => {
    const h = await boot();
    const value = "sk-live-0123456789abcdef";
    const deps = depsOf(h, () => createRedactor([{ name: "token", value }]));
    const created = await record(h, { statement: "메모에도 시크릿을 남기지 않는다", category: "self_found" });

    const refused = await updateLesson(deps, apiOf(h), ctx, { id: created.lessonId, note: `값은 ${value} 였다` });
    expect(refused.ok).toBe(false);
    expect((await getLesson(deps, ctx, created.lessonId))?.notes).toHaveLength(0);
  });

  it("refuses a promotionRef that holds a registered secret", async () => {
    const h = await boot();
    const value = "sk-live-0123456789abcdef";
    const deps = depsOf(h, () => createRedactor([{ name: "token", value }]));
    const created = await record(h, { statement: "승격 근거에도 시크릿을 남기지 않는다", category: "self_found" });

    const refused = await updateLesson(deps, apiOf(h), ctx, {
      id: created.lessonId,
      status: "promoted",
      promotionRef: `memory/${value}.md`,
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("secret placeholder");
    expect((await getLesson(deps, ctx, created.lessonId))?.status).toBe("open");
  });

  it("stores a commit sha, a sha256, and a ULID path as promotionRef and note", async () => {
    const h = await boot();
    const value = "sk-live-0123456789abcdef";
    const deps = depsOf(h, () => createRedactor([{ name: "token", value }]));
    const api = apiOf(h);
    const created = await record(h, { statement: "근거에는 커밋 sha 를 적는다", category: "self_found" });
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const sha256 = "ab12".repeat(16);
    const note = `리비전 ${sha256} 을 state/reports/01M58DMWGE000000000000KYSD/v1 에서 확인했다. token=abc123, bearer abcdefgh12345678, api_key`;

    const promoted = await updateLesson(deps, api, ctx, { id: created.lessonId, status: "promoted", promotionRef: sha, note });
    expect(promoted.ok).toBe(true);
    const stored = await getLesson(deps, ctx, created.lessonId);
    expect(stored).toMatchObject({ status: "promoted", promotionRef: sha });
    expect(stored?.notes[0]?.text).toBe(note);
  });

  it("refuses to store a lesson whose statement still holds a secret", async () => {
    const h = await boot();
    const value = "sk-live-0123456789abcdef";
    const deps = depsOf(h, () => createRedactor([{ name: "token", value }]));

    const result = await recordLesson(deps, apiOf(h), ctx, {
      statement: `키 값은 ${value} 이다`,
      category: "runtime_observed",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("secret placeholder");
    expect(await readLessons(deps, ctx)).toHaveLength(0);
    expect((await lessonStats(deps, ctx)).total).toBe(0);
  });

  it("defaults source to agent and status to open, and stores what a caller asks for", async () => {
    const h = await boot();
    const deps = depsOf(h);

    // The defaults are what the stage-one callers rely on: a call with neither
    // argument must land exactly where it landed before the two existed.
    const plain = await record(h, { statement: "기본값은 그대로다", category: "self_found" });
    expect(await getLesson(deps, ctx, plain.lessonId)).toMatchObject({ source: "agent", status: "open" });

    const scanned = await record(h, {
      statement: "스캔이 제안한 교훈은 확인을 기다린다",
      category: "user_correction",
      source: "scan",
      status: "proposed",
    });
    expect(await getLesson(deps, ctx, scanned.lessonId)).toMatchObject({ source: "scan", status: "proposed" });
    const stats = await lessonStats(deps, ctx);
    expect(stats).toMatchObject({ total: 2, open: 1, proposed: 1 });
  });

  it("does not overwrite the stored source and status when a recurrence folds into the row", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const statement = "재발은 출처와 상태를 덮어쓰지 않는다";

    const first = await record(h, { statement, category: "user_correction", source: "scan", status: "proposed" }, 1);
    // The same words from another evidence point, with the defaults a plain call
    // carries: the row's origin is history and its status is a standing decision,
    // so neither moves. Only the counter does.
    const again = await record(h, { statement, category: "user_correction", evidence: { entryId: "9" } }, 2);

    expect(again.action).toBe("recurrence_recorded");
    expect(again.recurrenceCount).toBe(2);
    const stored = await getLesson(deps, ctx, first.lessonId);
    expect(stored).toMatchObject({ source: "scan", status: "proposed" });
  });

  it("refuses a creation that claims a promotion with no evidence", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const result = await recordLesson(deps, apiOf(h), ctx, {
      statement: "증거 없는 승격은 만들 수 없다",
      category: "user_correction",
      status: "promoted",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("promotionRef");
    expect(await readLessons(deps, ctx)).toHaveLength(0);
  });

  it("rewords a lesson in place, moves its fingerprint, and keeps the rest of the row", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const created = await record(h, {
      statement: "문면을 고치기 전의 교훈이다",
      category: "user_correction",
      evidence: { entryId: "3", filePaths: ["src/extensions/lessons.ts"] },
      tags: ["lessons"],
    });
    await record(h, { statement: "문면을 고치기 전의 교훈이다", category: "user_correction", evidence: { entryId: "4" } }, 2);
    expect((await getLesson(deps, ctx, created.lessonId))?.recurrence.count).toBe(2);

    const corrected = "문면을 고치면 지문이 함께 움직인다";
    const result = await rewordLesson(deps, apiOf(h), ctx, {
      id: created.lessonId,
      statement: corrected,
      note: "문면을 고쳤다",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.action).toBe("reworded");
    expect(result.outcome.previousStatement).toBe("문면을 고치기 전의 교훈이다");
    expect(result.outcome.lesson.statement).toBe(corrected);

    const after = await getLesson(deps, ctx, created.lessonId);
    expect(after).toMatchObject({
      id: created.lessonId,
      statement: corrected,
      fingerprint: fingerprintOf(corrected),
      category: "user_correction",
      tags: ["lessons"],
    });
    // The row is the lesson, so only the sentence and its fingerprint moved.
    expect(after?.recurrence.count).toBe(2);
    expect(after?.evidence).toEqual({ conversationId: "1", entryId: "3", filePaths: ["src/extensions/lessons.ts"] });
    expect(after?.notes.map((note) => note.text)).toEqual(["문면을 고쳤다"]);
    expect(await readLessons(deps, ctx)).toHaveLength(1);
    // A sentence is not counted, so no count moves.
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toMatchObject({ total: 1, byStatus: { open: 1 } });

    // A repeat is now recognised by the new wording, and the old one is a lesson
    // nobody has recorded any more.
    const again = await record(h, { statement: corrected, category: "user_correction", evidence: { entryId: "5" } }, 3);
    expect(again.action).toBe("recurrence_recorded");
    expect(again.lessonId).toBe(created.lessonId);
    expect(again.recurrenceCount).toBe(3);
    const stale = await record(h, { statement: "문면을 고치기 전의 교훈이다", category: "user_correction" }, 4);
    expect(stale.action).toBe("created");
    expect(await readLessons(deps, ctx)).toHaveLength(2);
  });

  it("refuses a reword of an unknown lesson, a collision with a stored statement, and a secret", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const first = await record(h, { statement: "먼저 적힌 교훈 하나", category: "self_found" });
    const second = await record(h, { statement: "나중에 적힌 교훈 둘", category: "self_found" }, 2);

    const missing = await rewordLesson(deps, apiOf(h), ctx, { id: "no-such-lesson", statement: "없는 교훈은 고칠 수 없다" });
    expect(missing.ok).toBe(false);
    const blank = await rewordLesson(deps, apiOf(h), ctx, { id: second.lessonId, statement: "   " });
    expect(blank.ok).toBe(false);

    // Two rows with one fingerprint would make a repeat land on whichever row is
    // found first, so the collision is refused and the row is left alone.
    const collision = await rewordLesson(deps, apiOf(h), ctx, { id: second.lessonId, statement: "먼저 적힌 교훈 하나" });
    expect(collision.ok).toBe(false);
    expect(collision.ok === false && collision.reason).toContain(first.lessonId);
    expect((await getLesson(deps, ctx, second.lessonId))?.statement).toBe("나중에 적힌 교훈 둘");

    const value = "sk-live-0123456789abcdef";
    const guarded = depsOf(h, () => createRedactor([{ name: "token", value }]));
    const refused = await rewordLesson(guarded, apiOf(h), ctx, {
      id: second.lessonId,
      statement: `키 값은 ${value} 였다`,
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("secret placeholder");
    expect((await getLesson(deps, ctx, second.lessonId))?.statement).toBe("나중에 적힌 교훈 둘");
  });

  it("says unchanged when the sentence is already stored, and reports what the new sentence resembles", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const target = await record(h, { statement: "같은 문면을 두 번 쓰지는 않는다", category: "self_found" });
    const neighbour = await record(h, { statement: DUPLICATE_BASE, category: "runtime_observed" }, 2);

    const same = await rewordLesson(deps, apiOf(h), ctx, { id: target.lessonId, statement: "같은 문면을 두 번 쓰지는 않는다" });
    expect(same.ok).toBe(true);
    expect(same.ok === true && same.outcome.action).toBe("unchanged");
    expect(same.ok === true && same.outcome.previousStatement).toBe("같은 문면을 두 번 쓰지는 않는다");

    // The rewrite is allowed: the neighbour is similar, not identical, so no
    // repeat becomes ambiguous. The reply is where the caller sees that.
    const moved = await rewordLesson(deps, apiOf(h), ctx, { id: target.lessonId, statement: DUPLICATE_VARIANT });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.outcome.action).toBe("reworded");
    expect(moved.outcome.similar.map((candidate) => candidate.id)).toEqual([neighbour.lessonId]);
    expect(moved.outcome.similar[0]?.similarity).toBeGreaterThanOrEqual(0.6);
    expect((await getLesson(deps, ctx, target.lessonId))?.statement).toBe(DUPLICATE_VARIANT);
    // The lesson itself is not ranked against the sentence it no longer holds.
    expect(moved.outcome.similar.map((candidate) => candidate.id)).not.toContain(target.lessonId);
    // `duplicateOf` is a record of why the row was written, so the reword leaves it.
    expect((await getLesson(deps, ctx, target.lessonId))?.duplicateOf).toBeUndefined();
  });

  it("establishes a counter that was never written, and still moves no count", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const created = await record(h, { statement: "문면을 고쳐도 개수는 그대로다", category: "self_found" });
    // A store that predates the counter, or a counter retired by hand: this write
    // path establishes it the same way `lessons_update` does.
    await h.runtime.harness.commit(async (tx) => {
      await tx.retireDoc(SecLessonCount);
    }, ctx);
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toBeUndefined();

    const result = await rewordLesson(deps, apiOf(h), ctx, { id: created.lessonId, statement: "문면을 고친 뒤의 교훈이다" });
    expect(result.ok).toBe(true);
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toMatchObject({
      total: 1,
      byStatus: { proposed: 0, open: 1, promoted: 0, dormant: 0, closed: 0 },
    });
    expect(await lessonStats(deps, ctx)).toMatchObject({ total: 1, open: 1, counterMatches: true });
  });
});

describe("lesson count and the prompt section", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    const base = defaultConfig();
    harness = await createTestHarness({
      config: {
        agent: { ...base.agent, extensions: { enabled: [...base.agent.extensions.enabled, "lessons"] } },
      },
    });
    return harness;
  }

  function depsOf(h: TestHarness): LessonDeps {
    return {
      storage: h.runtime.storage,
      reader: () => h.runtime.harness,
      redactor: () => h.runtime.secrets.redactor(),
    };
  }

  function apiOf(h: TestHarness, conversationId = 1): LessonWriteApi {
    return {
      conversationId: conversationId as ConversationId,
      commit: (change, context) => h.runtime.harness.commit(change, context),
    };
  }

  async function record(h: TestHarness, input: LessonRecordInput, conversationId = 1): Promise<LessonRecordOutcome> {
    const result = await recordLesson(depsOf(h), apiOf(h, conversationId), ctx, input);
    if (!result.ok) throw new Error(result.reason);
    return result.outcome;
  }

  /**
   * The section as the first request of a session renders it. `shown` is empty,
   * which is how the seal reads "this session is starting", so the render returns
   * the value it would commit, tags and all.
   */
  async function sectionText(h: TestHarness): Promise<string> {
    const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
    const agent = await conversation.agent(ctx);
    const section = agent.sections.find((candidate) => candidate.key === LESSON_COUNT_SECTION);
    if (section === undefined) throw new Error("the lessons extension carries no count section");
    const rendered = await section.render(
      { conversationId: conversation.id, agent, env: undefined, shown: {}, read: h.runtime.harness },
      ctx,
    );
    return rendered ?? "";
  }

  it("renders the counts when no counter document exists at all", async () => {
    const h = await boot();
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toBeUndefined();
    expect(await sectionText(h)).toBe(`<${LESSON_COUNT_SECTION}>\n${lessonCountLine(undefined)}\n</${LESSON_COUNT_SECTION}>`);
    // One line, no lesson text: it renders on every request.
    expect(lessonCountLine(undefined).split("\n")).toHaveLength(1);
    expect(lessonCountLine(undefined)).toBe("lessons: 0 open, 0 proposed. Record one with `lessons_record`.");
    // No rows and no counter is not a disagreement: nothing has to be repaired.
    expect(await lessonStats(depsOf(h), ctx)).toMatchObject({ total: 0, counterMatches: true });
  });

  it("moves the count in the same commit as the row, and not on a recurrence", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const first = await record(h, { statement: "개수를 세는 교훈 하나", category: "self_found" });
    await record(h, { statement: "개수를 세는 교훈 둘", category: "self_found" }, 2);
    await record(h, { statement: "제안으로 들어온 교훈", category: "user_correction", status: "proposed" }, 3);
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toMatchObject({
      total: 3,
      byStatus: { proposed: 1, open: 2, promoted: 0, dormant: 0, closed: 0 },
    });
    expect(await sectionText(h)).toContain("lessons: 2 open, 1 proposed");

    const promoted = await updateLesson(deps, apiOf(h), ctx, {
      id: first.lessonId,
      status: "promoted",
      promotionRef: "memory/pi-sec-notes.md",
    });
    expect(promoted.ok).toBe(true);
    const afterPromotion = await h.runtime.harness.snapshot(SecLessonCount, ctx);
    expect(afterPromotion).toMatchObject({ total: 3, byStatus: { proposed: 1, open: 1, promoted: 1 } });

    // An edit that moves no status leaves the counts alone, timestamp included.
    await updateLesson(deps, apiOf(h), ctx, { id: first.lessonId, note: "메모만 붙인다" });
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toMatchObject({
      total: 3,
      byStatus: { proposed: 1, open: 1, promoted: 1 },
      updatedAt: afterPromotion?.updatedAt,
    });

    // A recurrence is new evidence for a row that already exists. It bumps the
    // recurrence count and nothing else.
    const again = await record(
      h,
      { statement: "개수를 세는 교훈 하나", category: "self_found", evidence: { entryId: "77" } },
      4,
    );
    expect(again.action).toBe("recurrence_recorded");
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toMatchObject({
      total: 3,
      byStatus: { proposed: 1, open: 1, promoted: 1 },
      updatedAt: afterPromotion?.updatedAt,
    });
    expect(await lessonStats(deps, ctx)).toMatchObject({ total: 3, counterMatches: true });
  });

  it("counts an import item by item, and writes nothing on a dry run", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const items = [
      { statement: "들여온 교훈 하나", category: "runtime_observed" as const, status: "open" as const },
      { statement: "들여온 교훈 둘", category: "runtime_observed" as const, status: "dormant" as const },
    ];

    const preview = await importLessons(deps, apiOf(h), ctx, items, { dryRun: true });
    expect(preview.ok === true && preview.totals.created).toBe(2);
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toBeUndefined();

    const written = await importLessons(deps, apiOf(h), ctx, items, { dryRun: false });
    expect(written.ok === true && written.totals.created).toBe(2);
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toMatchObject({
      total: 2,
      byStatus: { open: 1, dormant: 1, proposed: 0 },
    });
    expect(await lessonStats(deps, ctx)).toMatchObject({ total: 2, counterMatches: true });
  });

  it("reports a counter that disagrees with the store, and repairs it on refresh", async () => {
    const h = await boot();
    const deps = depsOf(h);
    await record(h, { statement: "어긋난 카운터를 고친다", category: "self_found" });
    await record(h, { statement: "고칠 때 세는 두 번째 교훈", category: "self_found" }, 2);

    // A store that already held lessons when the counter arrived: the rows are
    // there and the document is not. The section reads zeros and says so.
    await h.runtime.harness.commit(async (tx) => {
      await tx.retireDoc(SecLessonCount);
    }, ctx);
    expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toBeUndefined();
    const missing = await lessonStats(deps, ctx);
    expect(missing).toMatchObject({ total: 2, counterMatches: false });
    expect(missing.counter).toBeUndefined();
    expect(await sectionText(h)).toContain(lessonCountLine(undefined));

    const refreshed = await refreshLessonCounter(deps, apiOf(h), ctx);
    expect(refreshed.ok && refreshed.counter).toMatchObject({ total: 2, byStatus: { open: 2 } });
    expect(await lessonStats(deps, ctx)).toMatchObject({ counterMatches: true });
    expect(await sectionText(h)).toContain("lessons: 2 open, 0 proposed");

    // A counter that holds other numbers is reported the same way, and the
    // section shows what it holds rather than what the store holds.
    await h.runtime.harness.commit(async (tx) => {
      const draft = await tx.doc(SecLessonCount);
      draft.total = 9;
      draft.byStatus.open = 9;
    }, ctx);
    const wrong = await lessonStats(deps, ctx);
    expect(wrong).toMatchObject({ total: 2, counterMatches: false });
    expect(wrong.counter?.total).toBe(9);
    expect(await sectionText(h)).toContain("lessons: 9 open, 0 proposed");

    expect((await refreshLessonCounter(deps, apiOf(h), ctx)).ok).toBe(true);
    expect(await lessonStats(deps, ctx)).toMatchObject({ total: 2, counterMatches: true });
    expect(await sectionText(h)).toContain("lessons: 2 open, 0 proposed");
  });

  it("keeps the count of its session, with no note and no stale banner", async () => {
    // This config names no `vmodel` of its own: the harness helper points the root
    // agent at the `faux` alias, and spreading `base.agent` would pin one the faux
    // provider does not serve.
    const base = defaultConfig();
    const heads: string[] = [];
    harness = await createTestHarness({
      config: {
        agent: { extensions: { enabled: [...base.agent.extensions.enabled, "lessons"] } },
        // The personality interview adds a request-scoped system message to the
        // first request of a fresh conversation, and a provider without
        // mid-conversation system messages replays it into the head. This test
        // compares heads, so the interview is switched off.
        personality: { file: "memory/personality.md", interview: false, roles: ["orchestrator"] },
      },
    });
    const h = harness;
    h.faux.setResponses([
      (context) => {
        heads.push(collapsedHead(context.messages));
        return fauxAssistantMessage([fauxText("first answer")]);
      },
      (context) => {
        heads.push(collapsedHead(context.messages));
        return fauxAssistantMessage([fauxText("second answer")]);
      },
      (context) => {
        heads.push(collapsedHead(context.messages));
        return fauxAssistantMessage([fauxText("third answer")]);
      },
    ]);
    const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
    const sectionNotes = async (): Promise<readonly string[]> => {
      const page = await h.runtime.storage.scanEntries({ conversationId: conversation.id }, 200, undefined, ctx);
      return page.items
        .filter((entry) => entry.kind === "sec.section-update")
        .map((entry) => (entry.model ?? []).map((message) => String(message.content)).join("\n"));
    };

    const first = await conversation.submit({ type: "input", content: "first" }, ctx);
    expect((await first.wait(ctx)).status).toBe("done");
    // The exact tagged block: a second wrapper would sit inside these tags and this
    // assertion would miss it if it only looked for the count line.
    expect(heads[0]).toContain(
      `<${LESSON_COUNT_SECTION}>\n${lessonCountLine(undefined)}\n</${LESSON_COUNT_SECTION}>`,
    );

    await record(h, { statement: "세션 중간에 적은 교훈", category: "self_found" });
    const second = await conversation.submit({ type: "input", content: "second" }, ctx);
    expect((await second.wait(ctx)).status).toBe("done");

    // The section renders the value this session committed, so a counter that moved
    // mid-session is not a section change at all: the head holds, no note is
    // appended, and nothing reports a stale source to the agent.
    expect(heads[1]).toBe(heads[0]);
    expect(h.runtime.sections.stale(conversation.id)).toEqual([]);
    expect(await sectionNotes()).toHaveLength(0);

    // The freeze lasts one session, not forever: a new session takes the count the
    // store holds now.
    await conversation.reset(undefined, ctx);
    const third = await conversation.submit({ type: "input", content: "third" }, ctx);
    expect((await third.wait(ctx)).status).toBe("done");
    expect(heads[2]).toContain("lessons: 1 open, 0 proposed");
    expect(heads[2]).not.toBe(heads[0]);
    expect(await sectionNotes()).toHaveLength(0);
    expect(h.runtime.sections.stale(conversation.id)).toEqual([]);
  });

  it("seeds a counter that was never written, in the commit of the next write", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const counter = () => h.runtime.harness.snapshot(SecLessonCount, ctx);
    const retireCounter = async (): Promise<void> => {
      await h.runtime.harness.commit(async (tx) => {
        await tx.retireDoc(SecLessonCount);
      }, ctx);
      expect(await counter()).toBeUndefined();
    };

    const first = await record(h, { statement: "카운터 없이 쌓인 교훈 하나", category: "self_found" });
    await record(h, { statement: "카운터 없이 쌓인 교훈 둘", category: "self_found" }, 2);

    // The state the live store is in: rows, and no counter document at all.
    await retireCounter();
    // A creation counts the store first, so the new row lands on top of the rows
    // that were already there instead of starting the count at one.
    await record(h, { statement: "카운터가 없을 때 적은 세 번째 교훈", category: "self_found" }, 3);
    expect(await counter()).toMatchObject({ total: 3, byStatus: { open: 3, promoted: 0 } });

    // A recurrence moves no count and still establishes the counter.
    await retireCounter();
    const again = await record(
      h,
      { statement: "카운터 없이 쌓인 교훈 하나", category: "self_found", evidence: { entryId: "91" } },
      4,
    );
    expect(again.action).toBe("recurrence_recorded");
    expect(await counter()).toMatchObject({ total: 3, byStatus: { open: 3 } });

    // A status change seeds the counter and then applies its own move to it.
    await retireCounter();
    await updateLesson(deps, apiOf(h), ctx, {
      id: first.lessonId,
      status: "promoted",
      promotionRef: "prompts/role/worker.md",
    });
    expect(await counter()).toMatchObject({ total: 3, byStatus: { open: 2, promoted: 1 } });

    // An import takes the same path, item by item.
    await retireCounter();
    await importLessons(
      deps,
      apiOf(h),
      ctx,
      [{ statement: "카운터 없이 들여온 교훈", category: "runtime_observed", status: "proposed" }],
      { dryRun: false },
    );
    expect(await counter()).toMatchObject({ total: 4, byStatus: { open: 2, promoted: 1, proposed: 1 } });
    expect(await lessonStats(deps, ctx)).toMatchObject({ total: 4, counterMatches: true });
  });

  it("moves a count after a status change made through the tool path", async () => {
    // The tool's own execute, not the library function: this is the path an agent
    // takes, and the counter is part of the same commit there too.
    const base = defaultConfig();
    const h = await createTestHarness({
      config: {
        agent: { ...base.agent, extensions: { enabled: [...base.agent.extensions.enabled, "lessons"] } },
      },
    });
    try {
      const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
      const agent = await conversation.agent(ctx);
      const tools = new Map(agent.tools.map((tool) => [tool.name, tool]));
      const api = {
        conversationId: conversation.id,
        commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: typeof ctx) =>
          h.runtime.harness.commit(change, context),
      } as unknown as ToolExecutionApi;
      const textOf = (result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
        result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");

      const recorded = textOf(
        await tools.get("lessons_record")!.execute({ statement: "도구 경로로 상태를 올린다", category: "self_found" }, api, ctx),
      );
      const id = recorded.split(" ")[1] ?? "";
      expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toMatchObject({ total: 1, byStatus: { open: 1 } });

      const updated = textOf(
        await tools
          .get("lessons_update")!
          .execute({ id, status: "promoted", promotionRef: "prompts/role/worker.md" }, api, ctx),
      );
      expect(updated).toContain("updated");
      expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toMatchObject({
        total: 1,
        byStatus: { open: 0, promoted: 1 },
      });

      // The tool's own stats call: `counterMatches` is what it reports back.
      const stats = textOf(await tools.get("lessons_stats")!.execute({}, api, ctx));
      expect(stats).toContain("\"counterMatches\": true");
      const refreshed = textOf(await tools.get("lessons_stats")!.execute({ refresh: true }, api, ctx));
      expect(refreshed).toContain("counter written: total=1 open=0 proposed=0");

      // A plain stats call establishes a counter that was never written: the
      // section reads the counter and the section never writes.
      await h.runtime.harness.commit(async (tx) => {
        await tx.retireDoc(SecLessonCount);
      }, ctx);
      const healed = textOf(await tools.get("lessons_stats")!.execute({}, api, ctx));
      expect(healed).toContain("\"counterMatches\": true");
      expect(healed).toContain("counter written: total=1 open=0 proposed=0");
      expect(await h.runtime.harness.snapshot(SecLessonCount, ctx)).toMatchObject({
        total: 1,
        byStatus: { open: 0, promoted: 1 },
      });
    } finally {
      await h.close();
    }
  });
});

describe("lesson scan and import", () => {
  let harness: TestHarness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  async function boot(): Promise<TestHarness> {
    const base = defaultConfig();
    harness = await createTestHarness({
      config: {
        agent: { ...base.agent, extensions: { enabled: [...base.agent.extensions.enabled, "lessons"] } },
      },
    });
    // The root conversation is created when a client first asks for it, and the
    // scan needs conversation 1 to exist.
    await resolveDefaultConversation(harness.runtime.harness, harness.config, harness.runtime.paths, ctx);
    return harness;
  }

  function depsOf(h: TestHarness, redactor?: () => Redactor): LessonDeps {
    return {
      storage: h.runtime.storage,
      reader: () => h.runtime.harness,
      redactor: redactor ?? (() => h.runtime.secrets.redactor()),
    };
  }

  function apiOf(h: TestHarness, conversationId = 1): LessonWriteApi {
    return {
      conversationId: conversationId as ConversationId,
      commit: (change, context) => h.runtime.harness.commit(change, context),
    };
  }

  async function append(h: TestHarness, conversationId: number, entry: EntryDraft): Promise<void> {
    await h.runtime.harness.commit(async (tx) => {
      await tx.appendEntry(conversationId as ConversationId, entry);
    }, ctx);
  }

  /** A review note, pushed into the conversation the way the report route pushes one. */
  function reviewEntry(body: string, at = Date.now()): EntryDraft {
    return { kind: "pi.user", model: [{ role: "user", content: `${REVIEW_MARKER} report=demo\n\n${body}`, timestamp: at }] };
  }

  it("collects a marked message and the exchange after a failed tool call, capped and redacted", async () => {
    const h = await boot();
    const value = "sk-live-0123456789abcdef";
    const deps = depsOf(h, () => createRedactor([{ name: "token", value }]));
    const long = "긴 발췌 ".repeat(200);
    expect(long.length).toBeGreaterThan(600);

    await append(h, 1, reviewEntry(`키 값은 ${value} 였다. ${long}`));
    await append(h, 1, {
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [fauxText("exit 1: the flag was wrong")],
          isError: true,
          timestamp: Date.now(),
        },
      ],
    });
    await append(h, 1, { kind: "pi.assistant", model: [fauxAssistantMessage("the flag was wrong, so I read the help first")] });

    const result = await scanLessons(deps, ctx, {});

    // Newest first: that order is what makes `before`/`nextBefore` paginate.
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual(["failed_tool", "review"]);
    const [failed, review] = result.candidates;
    for (const candidate of result.candidates) expect(candidate.excerpt.length).toBeLessThanOrEqual(600);
    expect(review?.conversationId).toBe("1");

    // The registered value is gone and the dummy it became is what is left.
    expect(review?.excerpt).not.toContain(value);
    expect(review?.excerpt).toContain("secret:token");

    expect(failed?.excerpt).toContain("bash");
    expect(failed?.excerpt).toContain("the flag was wrong");
    expect(failed?.excerpt).toContain("read the help first");
  });

  it("leaves an unmarked message alone, stops at the limit, and honours since", async () => {
    const h = await boot();
    const deps = depsOf(h);

    await append(h, 1, { kind: "pi.user", model: [{ role: "user", content: "plain operator input", timestamp: Date.now() }] });
    // A second apart, so the page cut has one candidate to cut at. Two notes in
    // one millisecond would both come on the page, which is the tie rule.
    await append(h, 1, reviewEntry("첫 번째 지적", Date.now() - 2_000));
    await append(h, 1, reviewEntry("두 번째 지적", Date.now() - 1_000));

    const all = await scanLessons(deps, ctx, {});
    expect(all.candidates).toHaveLength(2);
    expect(all.candidates.every((candidate) => candidate.kind === "review")).toBe(true);

    const one = await scanLessons(deps, ctx, { limit: 1 });
    expect(one.candidates).toHaveLength(1);
    expect(one.truncated).toBe(true);

    const none = await scanLessons(deps, ctx, { since: Date.now() + 60_000 });
    expect(none.candidates).toHaveLength(0);
  });

  it("pages with before and nextBefore, newest first", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const base = Date.now() - 60_000;
    await append(h, 1, reviewEntry("첫 번째 지적", base));
    await append(h, 1, reviewEntry("두 번째 지적", base + 1_000));
    await append(h, 1, reviewEntry("세 번째 지적", base + 2_000));

    const first = await scanLessons(deps, ctx, { limit: 2 });
    expect(first.candidates.map((candidate) => candidate.excerpt)).toEqual([
      expect.stringContaining("세 번째 지적"),
      expect.stringContaining("두 번째 지적"),
    ]);
    expect(first.truncated).toBe(true);
    expect(first.nextBefore).toBe(first.candidates[1]?.at);

    // The next page is everything older than the cursor, so the page before it
    // cannot be returned again and the walk moves on.
    const second = await scanLessons(deps, ctx, { limit: 2, before: first.nextBefore });
    expect(second.before).toBe(first.nextBefore);
    expect(second.candidates.map((candidate) => candidate.excerpt)).toEqual([
      expect.stringContaining("첫 번째 지적"),
    ]);
    expect(second.nextBefore).toBeLessThan(first.nextBefore ?? 0);
    expect(second.counts).toEqual({ review: 1, failed_tool: 0 });
    expect(second.truncated).toBe(false);

    // The window is spent: an empty page carries no cursor, so a caller stops.
    const third = await scanLessons(deps, ctx, { limit: 2, before: second.nextBefore });
    expect(third.candidates).toHaveLength(0);
    expect(third.nextBefore).toBeUndefined();
  });

  it("returns both kinds by default, filters by kind, and counts what it returns", async () => {
    const h = await boot();
    const deps = depsOf(h);
    await append(h, 1, reviewEntry("지적 하나"));
    await append(h, 1, {
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [fauxText("exit 1: the flag was wrong")],
          isError: true,
          timestamp: Date.now(),
        },
      ],
    });

    // The default is unchanged: a call with no `kinds` gets both, which is what
    // the tool returned before the argument existed.
    const both = await scanLessons(deps, ctx, {});
    expect(both.candidates.map((candidate) => candidate.kind)).toEqual(["failed_tool", "review"]);
    expect(both.counts).toEqual({ review: 1, failed_tool: 1 });

    const reviews = await scanLessons(deps, ctx, { kinds: ["review"] });
    expect(reviews.candidates.map((candidate) => candidate.kind)).toEqual(["review"]);
    expect(reviews.candidates[0]?.excerpt).toContain("지적 하나");
    expect(reviews.counts).toEqual({ review: 1, failed_tool: 0 });

    // The kind that fills a page is visible in the counts, which is how a caller
    // sees that failures, not corrections, took the room.
    const failures = await scanLessons(deps, ctx, { kinds: ["failed_tool"] });
    expect(failures.candidates.map((candidate) => candidate.kind)).toEqual(["failed_tool"]);
    expect(failures.counts).toEqual({ review: 0, failed_tool: 1 });

    // An empty list narrows nothing, the same as an absent argument.
    expect((await scanLessons(deps, ctx, { kinds: [] })).candidates).toHaveLength(2);
  });

  const SEED_ITEM = {
    statement: "게이트는 커밋 전에 typecheck와 테스트를 돌린다",
    category: "runtime_observed",
    severity: "normal",
    status: "open",
    source: "seed",
    promotionTarget: "memory",
    promotionRef: "memory/pi-sec-notes.md",
    evidence: { filePaths: ["memory/pi-sec-notes.md"] },
    tags: ["seed"],
  };

  it("writes nothing on a dry run, which is the default", async () => {
    const h = await boot();
    const deps = depsOf(h);

    const preview = await importLessons(deps, apiOf(h), ctx, [SEED_ITEM]);
    expect(preview.ok).toBe(true);
    expect(preview.ok === true && preview.dryRun).toBe(true);
    expect(preview.ok === true && preview.totals).toMatchObject({ total: 1, created: 1, refused: 0 });
    expect(await readLessons(deps, ctx)).toHaveLength(0);
    expect((await lessonStats(deps, ctx)).total).toBe(0);

    const explicit = await importLessons(deps, apiOf(h), ctx, [SEED_ITEM], { dryRun: true });
    expect(explicit.ok === true && explicit.totals.created).toBe(1);
    expect(await readLessons(deps, ctx)).toHaveLength(0);
  });

  it("stores the rows when the dry run is turned off", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const second = { ...SEED_ITEM, statement: "시드 교훈은 출처를 남긴다", tags: ["seed", "memory"] };

    const written = await importLessons(deps, apiOf(h), ctx, [SEED_ITEM, second], { dryRun: false });
    expect(written.ok).toBe(true);
    expect(written.ok === true && written.dryRun).toBe(false);
    expect(written.ok === true && written.totals).toMatchObject({ total: 2, created: 2, refused: 0 });

    // Two rows written in the same millisecond sort by id, which is random, so
    // the row is looked up by its statement rather than by position.
    const findSeed = async () => (await readLessons(deps, ctx)).find((record) => record.statement === SEED_ITEM.statement);

    const all = await readLessons(deps, ctx);
    expect(all).toHaveLength(2);
    expect(await findSeed()).toMatchObject({
      statement: SEED_ITEM.statement,
      category: "runtime_observed",
      source: "seed",
      status: "open",
      promotionTarget: "memory",
      promotionRef: "memory/pi-sec-notes.md",
      tags: ["seed"],
    });
    expect((await findSeed())?.evidence.filePaths).toEqual(["memory/pi-sec-notes.md"]);

    // Twice the same statement from the same evidence point: the same replay rule
    // as a second `lessons_record` call, so nothing moves.
    const repeated = await importLessons(deps, apiOf(h), ctx, [SEED_ITEM], { dryRun: false });
    expect(repeated.ok === true && repeated.totals.duplicateIgnored).toBe(1);
    expect(await readLessons(deps, ctx)).toHaveLength(2);
    expect((await findSeed())?.recurrence.count).toBe(1);

    // The same statement from another evidence point is a recurrence.
    const elsewhere = await importLessons(
      deps,
      apiOf(h),
      ctx,
      [{ ...SEED_ITEM, evidence: { ...SEED_ITEM.evidence, entryId: "42" } }],
      { dryRun: false },
    );
    expect(elsewhere.ok === true && elsewhere.totals.recurrenceRecorded).toBe(1);
    expect((await findSeed())?.recurrence.count).toBe(2);
  });

  it("refuses an item that carries a secret or a leftover placeholder and stores a credential-like shape", async () => {
    const h = await boot();
    const value = "sk-live-0123456789abcdef";
    const deps = depsOf(h, () => createRedactor([{ name: "token", value }]));

    const result = await importLessons(
      deps,
      apiOf(h),
      ctx,
      [
        { statement: `키 값은 ${value} 였다`, category: "runtime_observed" },
        { statement: "값은 ⟦secret:token⟧ 이다", category: "runtime_observed" },
        { statement: "the retry used token=abc123", category: "self_found" },
        { statement: SEED_ITEM.statement, category: "runtime_observed" },
      ],
      { dryRun: false },
    );

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.totals).toMatchObject({ total: 4, created: 2, refused: 2 });
    const items = result.ok === true ? result.items : [];
    expect(items.map((item) => item.outcome)).toEqual(["refused", "refused", "created", "created"]);
    expect(items[0]?.reason).toContain("secret placeholder");
    expect(items[1]?.reason).toContain("secret placeholder");
    expect(await readLessons(deps, ctx)).toHaveLength(2);
  });

  it("refuses a malformed item and keeps the rest of the batch", async () => {
    const h = await boot();
    const deps = depsOf(h);
    const result = await importLessons(
      deps,
      apiOf(h),
      ctx,
      [
        { statement: "", category: "self_found" },
        { statement: "분류가 없다", category: "nonsense" },
        "not an object",
        { statement: "오타 난 필드가 있다", category: "self_found", statment: "typo" },
        { statement: SEED_ITEM.statement, category: "runtime_observed" },
      ],
      { dryRun: true },
    );

    expect(result.ok).toBe(true);
    expect(result.ok === true && result.totals).toMatchObject({ total: 5, created: 1, refused: 4 });
    const items = result.ok === true ? result.items : [];
    expect(items.map((item) => item.outcome)).toEqual(["refused", "refused", "refused", "refused", "created"]);
    expect(items[3]?.reason).toContain("statment");
    expect(await readLessons(deps, ctx)).toHaveLength(0);
  });

  it("refuses a caller that is not the root chat", async () => {
    const h = await boot();
    const deps = depsOf(h);

    // Conversation 2 carries no `sec.agent` row and is not the root id, so
    // `originOf` reads it as a subagent. The gate is inside the tool rather than
    // in `SUBAGENT_TOOL_REMOVALS`, so this refusal is the only thing that stops it.
    const result = await importLessons(deps, apiOf(h, 2), ctx, [SEED_ITEM], { dryRun: false });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("root chat");
    expect(await readLessons(deps, ctx)).toHaveLength(0);
  });

  it("reads an import file inside the workspace tree and refuses anything outside it", async () => {
    const h = await boot();
    await mkdir(h.paths.workspaceTree, { recursive: true });
    await writeFile(join(h.paths.workspaceTree, "seed.json"), JSON.stringify({ items: [SEED_ITEM] }), "utf8");
    await writeFile(join(h.paths.workspaceTree, "broken.json"), "{ not json", "utf8");

    const inside = await readImportFile(h.paths.workspaceTree, "seed.json");
    expect(inside.ok).toBe(true);
    expect(inside.ok === true && inside.items).toHaveLength(1);

    const outside = await readImportFile(h.paths.workspaceTree, "../secrets/model.json");
    expect(outside.ok).toBe(false);
    expect(outside.ok === false && outside.reason).toContain("outside the workspace tree");

    const absolute = await readImportFile(h.paths.workspaceTree, "/etc/passwd");
    expect(absolute.ok).toBe(false);

    const missing = await readImportFile(h.paths.workspaceTree, "nope.json");
    expect(missing.ok).toBe(false);

    const broken = await readImportFile(h.paths.workspaceTree, "broken.json");
    expect(broken.ok).toBe(false);
    expect(broken.ok === false && broken.reason).toContain("not JSON");
  });
  it("refuses an import file that is a link to a file outside the workspace tree", async () => {
    const h = await boot();
    await mkdir(h.paths.workspaceTree, { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "pi-sec-import-outside-"));
    try {
      await writeFile(join(outside, "seed.json"), JSON.stringify({ items: [SEED_ITEM] }), "utf8");
      await symlink(join(outside, "seed.json"), join(h.paths.workspaceTree, "linked.json"));
      const read = await readImportFile(h.paths.workspaceTree, "linked.json");
      expect(read.ok).toBe(false);
      expect(read.ok === false && read.reason).toContain("outside the workspace tree");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
  it("scans entries held in file-backed sqlite storage, not just in memory", async () => {
    // The scan enumerates through `Storage.scanConversations`/`scanEntries`, so it
    // is worth one run against the engine the daemon really uses. No runtime is
    // built here: the scan needs storage and a redactor and nothing else.
    const home = await mkdtemp(join(tmpdir(), "pi-sec-scan-"));
    const storage = await openPrivateSqliteStorage(join(home, "sec.sqlite"));
    try {
      const now = Date.now();
      const writes: StorageWrite[] = [
        { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
        {
          type: "entry",
          value: {
            id: 2 as EntryId,
            conversationId: ROOT_CONVERSATION_ID,
            kind: "pi.user",
            model: [{ role: "user", content: `${REVIEW_MARKER} report=demo\n\n지적입니다`, timestamp: now }],
          },
        },
        {
          type: "entry",
          value: {
            id: 3 as EntryId,
            conversationId: ROOT_CONVERSATION_ID,
            kind: "pi.tool-result",
            model: [
              {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "bash",
                content: [fauxText("boom")],
                isError: true,
                timestamp: now,
              },
            ],
          },
        },
        {
          type: "entry",
          value: {
            id: 4 as EntryId,
            conversationId: ROOT_CONVERSATION_ID,
            kind: "pi.assistant",
            model: [fauxAssistantMessage("그래서 다른 방법을 썼다")],
          },
        },
      ];
      await commitWrites(storage, writes, ctx);

      const deps: LessonDeps = {
        storage,
        reader: () => {
          throw new Error("the scan needs no document reader");
        },
        redactor: () => NULL_REDACTOR,
      };
      const result = await scanLessons(deps, ctx, {});
      expect(result.conversationsExamined).toBe(1);
      expect(result.candidates.map((candidate) => candidate.kind)).toEqual(["failed_tool", "review"]);
      expect(result.candidates[0]?.conversationId).toBe(String(ROOT_CONVERSATION_ID));
      expect(result.candidates[1]?.excerpt).toContain("지적입니다");
      expect(result.candidates[0]?.excerpt).toContain("다른 방법을 썼다");

      // The `since` bound behaves the same on this side.
      expect((await scanLessons(deps, ctx, { since: Date.now() + 60_000 })).candidates).toHaveLength(0);
    } finally {
      await storage.close(ctx);
    }
  });

  /**
   * Runs `body` against a store of its own, and removes that store afterwards.
   *
   * Same shape as the storage run above: the scan enumerates through
   * `Storage.scanConversations`/`scanEntries`, so the engine the daemon uses is
   * the one under test, and no runtime is needed.
   */
  async function withStore<T>(
    writes: readonly StorageWrite[],
    body: (deps: LessonDeps) => Promise<T>,
    entryBudget?: number,
  ): Promise<T> {
    const home = await mkdtemp(join(tmpdir(), "pi-sec-scan-cap-"));
    const storage = await openPrivateSqliteStorage(join(home, "sec.sqlite"));
    try {
      await commitWrites(storage, writes, ctx);
      return await body({
        storage,
        reader: () => {
          throw new Error("the scan needs no document reader");
        },
        redactor: () => NULL_REDACTOR,
        // The extension never passes this; a test does, so a small store can
        // reach the cut path the real 150000-entry budget takes.
        ...(entryBudget !== undefined ? { entryBudget } : {}),
      });
    } finally {
      await storage.close(ctx);
      await rm(home, { recursive: true, force: true });
    }
  }

  /**
   * `count` entries one second apart, oldest first, from id `firstId` and time
   * `firstAt`. An index in `reviews` becomes a review note instead of a turn, so
   * a test places one candidate at a known distance from the newest entry.
   */
  function scanEntriesOf(
    conversationId: number,
    count: number,
    firstId: number,
    firstAt: number,
    reviews: ReadonlyMap<number, string>,
  ): StorageWrite[] {
    const writes: StorageWrite[] = [];
    for (let index = 0; index < count; index += 1) {
      const at = firstAt + index * 1000;
      const body = reviews.get(index);
      writes.push({
        type: "entry",
        value: {
          id: (firstId + index) as EntryId,
          conversationId: conversationId as ConversationId,
          kind: body === undefined ? "pi.assistant" : "pi.user",
          model:
            body === undefined
              ? [fauxAssistantMessage(`turn ${index}`, { timestamp: at })]
              : [{ role: "user", content: `${REVIEW_MARKER} report=demo\n\n${body}`, timestamp: at }],
        },
      });
    }
    return writes;
  }

  it("finds a review note far back in a long conversation", async () => {
    // A conversation carries a busy day's entries. A note far below the newest
    // one is still a note, and one call reads the window to its start.
    const firstAt = Date.now() - 3_600_000;
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
      ...scanEntriesOf(1, 450, 100, firstAt, new Map([[0, "루트 대화의 오래된 지적입니다"]])),
    ];
    await withStore(writes, async (deps) => {
      const result = await scanLessons(deps, ctx, {});
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.kind).toBe("review");
      expect(result.candidates[0]?.conversationId).toBe(String(ROOT_CONVERSATION_ID));
      expect(result.candidates[0]?.excerpt).toContain("루트 대화의 오래된 지적입니다");
      // The whole window fits in one call, so nothing was cut.
      expect(result.windowsCut).toBeUndefined();
    });
  });

  it("stops at the entry budget, names the cut, counts the unopened, and gives no cursor", async () => {
    // No per-conversation cap exists any more, so a small store reaches the cut
    // path only through the budget a test passes in. The walk is newest first by
    // conversation id: three, then two, then one.
    const base = Date.now() - 600_000;
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: 1 as ConversationId } },
      { type: "conversation", value: { id: 2 as ConversationId } },
      { type: "conversation", value: { id: 3 as ConversationId } },
      ...scanEntriesOf(3, 5, 300, base + 300_000, new Map([[4, "가장 새 대화의 지적입니다"]])),
      ...scanEntriesOf(2, 5, 200, base + 200_000, new Map([[4, "가운데 대화의 지적입니다"]])),
      ...scanEntriesOf(1, 5, 100, base + 100_000, new Map([[4, "가장 오래된 대화의 지적입니다"]])),
    ];
    await withStore(
      writes,
      async (deps) => {
        const result = await scanLessons(deps, ctx, {});
        // Eight entries: all five of conversation 3, then the newest three of
        // conversation 2, which is where the read stopped.
        expect(result.windowsCut).toEqual([{ conversationId: "2", at: base + 202_000 }]);
        expect(result.conversationsUnread).toBe(1);
        expect(result.nextBefore).toBeUndefined();
        expect(result.truncated).toBe(true);
        // The three entries read in conversation 2 hold its newest candidate, so
        // the page carries it; what is lost is everything below the cut.
        expect(result.candidates.map((candidate) => candidate.conversationId)).toEqual(["3", "2"]);
      },
      8,
    );
  });

  it("merges every conversation by time, so a newer subagent candidate comes first", async () => {
    // A page is the newest candidates of the window, not the newest candidates of
    // the conversations the walk reached first.
    const base = Date.now() - 600_000;
    const subagent = 2;
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
      { type: "conversation", value: { id: subagent as ConversationId } },
      ...scanEntriesOf(1, 2, 100, base, new Map([[0, "루트 대화의 오래된 지적입니다"], [1, "루트 대화의 조금 새 지적입니다"]])),
      ...scanEntriesOf(subagent, 1, 500, base + 5_000, new Map([[0, "하위 대화의 새 지적입니다"]])),
    ];
    await withStore(writes, async (deps) => {
      const first = await scanLessons(deps, ctx, { limit: 2 });
      expect(first.candidates.map((candidate) => candidate.conversationId)).toEqual([
        String(subagent),
        String(ROOT_CONVERSATION_ID),
      ]);
      expect(first.candidates[0]?.excerpt).toContain("하위 대화의 새 지적입니다");
      expect(first.nextBefore).toBe(base + 1_000);

      // Paging below the cursor still reaches the root conversation's older note.
      const second = await scanLessons(deps, ctx, { limit: 2, before: first.nextBefore });
      expect(second.candidates.map((candidate) => candidate.excerpt)).toEqual([
        expect.stringContaining("루트 대화의 오래된 지적입니다"),
      ]);
    });
  });

  it("reads every conversation in the window, past the old hundred-conversation cap", async () => {
    const base = Date.now() - 600_000;
    const count = 105;
    const writes: StorageWrite[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = index + 1;
      writes.push({ type: "conversation", value: { id: id as ConversationId } });
      writes.push(...scanEntriesOf(id, 1, 1000 + index * 10, base + index * 1_000, new Map([[0, `대화 ${id}의 지적입니다`]])));
    }
    await withStore(writes, async (deps) => {
      // `limit` is capped at 50, so the window needs three pages.
      const seen: string[] = [];
      let before: number | undefined;
      for (;;) {
        const page = await scanLessons(deps, ctx, { ...(before !== undefined ? { before } : {}), limit: 50 });
        seen.push(...page.candidates.map((candidate) => candidate.conversationId));
        if (page.candidates.length === 0 || page.nextBefore === undefined) break;
        before = page.nextBefore;
      }
      expect(seen).toHaveLength(count);
      expect(new Set(seen).size).toBe(count);
      // The oldest conversation is in the answer, which the hundred-slot list
      // never reached.
      expect(seen).toContain("1");
    });
  });

  it("counts a failed background call in the envelope shape as a failed tool call", async () => {
    const at = Date.now() - 60_000;
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
      {
        type: "entry",
        value: {
          id: 2 as EntryId,
          conversationId: ROOT_CONVERSATION_ID,
          kind: "pi.user",
          model: [
            {
              role: "user",
              content: wrapMessage("tool-output", "the remote build stopped", {
                title: "build-far",
                tool: "remote_run",
                status: "failed",
              }),
              timestamp: at,
            },
          ],
        },
      },
    ];
    await withStore(writes, async (deps) => {
      const result = await scanLessons(deps, ctx, { since: at - 60_000 });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.kind).toBe("failed_tool");
      expect(result.candidates[0]?.excerpt).toBe("background call build-far (remote_run) failed: the remote build stopped");
    });
  });

  it("reads the older tag shape, and refuses the statuses that are not a failure", async () => {
    const at = Date.now() - 60_000;
    const entry = (id: number, status: "failed" | "done" | "cancelled", body: string): StorageWrite => ({
      type: "entry",
      value: {
        id: id as EntryId,
        conversationId: ROOT_CONVERSATION_ID,
        kind: "pi.user",
        model: [
          {
            role: "user",
            content: `<tool-call-output title="call-${id}" tool="bash" status="${status}">\n${body}\n</tool-call-output>`,
            timestamp: at + id,
          },
        ],
      },
    });
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
      entry(2, "failed", "exit 1"),
      entry(3, "done", "exit 0"),
      entry(4, "cancelled", "stopped by the caller"),
    ];
    await withStore(writes, async (deps) => {
      const result = await scanLessons(deps, ctx, { since: at - 60_000 });
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.kind).toBe("failed_tool");
      expect(result.candidates[0]?.excerpt).toBe("background call call-2 (bash) failed: exit 1");
    });
  });

  it("yields the event loop while it walks the store", async () => {
    // A page read is a synchronous sqlite call, so only an explicit yield lets a
    // timer run. The fixture is just over three yield periods of page reads.
    const firstAt = Date.now() - 10_800_000;
    const entries = SCAN_YIELD_PAGES * 3 * 100 + 1;
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
      ...scanEntriesOf(1, entries, 100, firstAt, new Map()),
    ];
    await withStore(writes, async (deps) => {
      let timerRan = false;
      const timer = setTimeout(() => {
        timerRan = true;
      }, 0);
      const result = await scanLessons(deps, ctx, {});
      clearTimeout(timer);
      expect(result.conversationsExamined).toBe(1);
      expect(timerRan).toBe(true);
    });
  });

  it("keeps the old answer for a conversation under its cap", async () => {
    const firstAt = Date.now() - 600_000;
    const writes: StorageWrite[] = [
      { type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
      ...scanEntriesOf(1, 5, 100, firstAt, new Map([[1, "다섯 건 가운데 지적입니다"]])),
    ];
    await withStore(writes, async (deps) => {
      const result = await scanLessons(deps, ctx, {});
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]?.excerpt).toContain("다섯 건 가운데 지적입니다");
      // Nothing was cut, so no window is named and the cursor is the candidate.
      expect(result.windowsCut).toBeUndefined();
      expect(result.truncated).toBe(false);
      expect(result.nextBefore).toBe(firstAt + 1000);
    });
  });
});

describe("lessons tool surface", () => {
  it("offers every lessons tool to the root, and to a subagent too", () => {
    // The removal lists are the gate: a name in one of them is a tool the kind
    // cannot reach at all, nested calls included (`src/agent/tool-profile.ts`).
    // `lessons_import` is deliberately not in one: its root-only rule is a check
    // inside the tool (`importLessons`), so the tool is offered and refuses.
    for (const name of LESSON_TOOL_NAMES) {
      expect(SUBAGENT_TOOL_REMOVALS).not.toContain(name);
      expect(SCHEDULED_TOOL_REMOVALS).not.toContain(name);
    }
  });

  it("registers the eight tools with their replay flags", async () => {
    const base = defaultConfig();
    const h = await createTestHarness({
      config: {
        agent: { ...base.agent, extensions: { enabled: [...base.agent.extensions.enabled, "lessons"] } },
      },
    });
    try {
      const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
      const agent = await conversation.agent(ctx);
      const replay = new Map(agent.tools.map((tool) => [tool.name, tool.replay]));
      expect(replay.get("lessons_record")).toBe("unsafe");
      expect(replay.get("lessons_list")).toBe("safe");
      expect(replay.get("lessons_get")).toBe("safe");
      expect(replay.get("lessons_update")).toBe("unsafe");
      expect(replay.get("lessons_reword")).toBe("unsafe");
      expect(replay.get("lessons_stats")).toBe("safe");
      expect(replay.get("lessons_scan")).toBe("safe");
      expect(replay.get("lessons_import")).toBe("unsafe");
      expect(LESSON_TOOL_NAMES).toHaveLength(8);

      // What a subagent would be offered: the root's list minus that kind's
      // removals. Every lessons tool survives the subtraction.
      const removed = new Set(toolFilterFor("subagent")?.remove ?? []);
      const offered = agent.tools.map((tool) => tool.name).filter((name) => LESSON_TOOL_NAMES.includes(name));
      expect(offered.filter((name) => !removed.has(name)).sort()).toEqual([...LESSON_TOOL_NAMES].sort());
    } finally {
      await h.close();
    }
  });

  it("runs the scan and the import through their registered execute", async () => {
    const base = defaultConfig();
    const h = await createTestHarness({
      config: {
        agent: { ...base.agent, extensions: { enabled: [...base.agent.extensions.enabled, "lessons"] } },
      },
    });
    try {
      const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
      const agent = await conversation.agent(ctx);
      const tools = new Map(agent.tools.map((tool) => [tool.name, tool]));
      const deps = {
        storage: h.runtime.storage,
        reader: () => h.runtime.harness,
        redactor: () => h.runtime.secrets.redactor(),
      };
      const api = {
        conversationId: conversation.id,
        commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: typeof ctx) =>
          h.runtime.harness.commit(change, context),
      } as unknown as ToolExecutionApi;
      const textOf = (result: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string =>
        result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");

      await h.runtime.harness.commit(async (tx) => {
        await tx.appendEntry(conversation.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `${REVIEW_MARKER} report=demo\n\n지적입니다`, timestamp: Date.now() }],
        });
      }, ctx);

      const scanned = textOf(await tools.get("lessons_scan")!.execute({}, api, ctx));
      expect(scanned).toContain("review");
      expect(scanned).toContain("지적입니다");

      // The import tool's own default is a dry run, and it says so in the text.
      const importTool = tools.get("lessons_import")!;
      const preview = textOf(await importTool.execute({ items: [{ statement: "도구 경로로 들여온다", category: "self_found" }] }, api, ctx));
      expect(preview).toContain("dry run");
      expect(preview).toContain("created");
      expect(await readLessons(deps, ctx)).toHaveLength(0);

      const written = textOf(await importTool.execute({ items: [{ statement: "도구 경로로 들여온다", category: "self_found" }], dryRun: false }, api, ctx));
      expect(written).toContain("written");
      expect(await readLessons(deps, ctx)).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("runs the reword through its registered execute", async () => {
    // The tool's own execute, not the library function: this is the path an agent
    // takes, and the one the description and the arguments are for.
    const base = defaultConfig();
    const h = await createTestHarness({
      config: {
        agent: { ...base.agent, extensions: { enabled: [...base.agent.extensions.enabled, "lessons"] } },
      },
    });
    try {
      const conversation = await resolveDefaultConversation(h.runtime.harness, h.config, h.runtime.paths, ctx);
      const agent = await conversation.agent(ctx);
      const tools = new Map(agent.tools.map((tool) => [tool.name, tool]));
      const deps: LessonDeps = {
        storage: h.runtime.storage,
        reader: () => h.runtime.harness,
        redactor: () => h.runtime.secrets.redactor(),
      };
      const api = {
        conversationId: conversation.id,
        commit: (change: Parameters<typeof h.runtime.harness.commit>[0], context: typeof ctx) =>
          h.runtime.harness.commit(change, context),
      } as unknown as ToolExecutionApi;
      const textOf = (result: {
        readonly content: readonly { readonly type: string; readonly text?: string }[];
        readonly isError?: boolean;
      }): string => result.output.map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("\n");

      const recorded = textOf(
        await tools.get("lessons_record")!.execute({ statement: "도구 경로로 문면을 고친다", category: "self_found" }, api, ctx),
      );
      const id = recorded.split(" ")[1] ?? "";
      const rewordTool = tools.get("lessons_reword")!;

      const reworded = textOf(await rewordTool.execute({ id, statement: "도구 경로로 고친 문면이다" }, api, ctx));
      expect(reworded).toContain("reworded");
      expect(reworded).toContain("was: 도구 경로로 문면을 고친다");
      expect((await getLesson(deps, ctx, id))?.statement).toBe("도구 경로로 고친 문면이다");

      // The same sentence twice writes nothing and says so.
      const again = textOf(await rewordTool.execute({ id, statement: "도구 경로로 고친 문면이다" }, api, ctx));
      expect(again).toContain("unchanged");

      const refused = await rewordTool.execute({ id: "no-such-lesson", statement: "없는 교훈의 문면" }, api, ctx);
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("no lesson no-such-lesson");
    } finally {
      await h.close();
    }
  });
});

/**
 * The leading system message of a request as an API without mid-conversation
 * system messages receives it: every system message replayed into one heading
 * prompt. The same reading `test/agent-and-focused-chats.test.ts` uses, because that is
 * the shape the count section has to survive.
 */
function collapsedHead(messages: Parameters<typeof collapseSystemMessages>[0]["messages"]): string {
  const collapsed = collapseSystemMessages({ messages }).messages;
  const head = collapsed[0];
  return head !== undefined && head.role === "system" ? getSystemMessageText(head) : "";
}
