import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  defineExtension,
  defineTool,
  hook,
  ToolTask,
  type Extension,
  type HookApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { bool, lit, num, obj, opt, str, union } from "@earendil-works/pi-schema";
import { type ClassifierQuestion, type ToolCall } from "@earendil-works/pi-ai";
import { PLANNER_ROLE } from "./agent-scope.ts";
import { requireDrafts, requireHarness, requireReports, type ExtensionContext } from "./context.ts";
import { SecAgent, type ReportDraftRecord, type ReportFeedback, type ReportKind, type ReportVersion } from "../documents.ts";
import { awaitingAnswer, reportKind, reportName, reportStanding } from "../reports/store.ts";
import { draftDigest } from "../reports/drafts.ts";
import { withLocal, zoneIso } from "../time-format.ts";

/** The judge `report_check` asks. Its `reviewBelow` sets the review threshold. */
const REPORT_CHECK_JUDGE = "report-check";

/** The threshold a check uses when its judge entry names none. */
const DEFAULT_REVIEW_BELOW = 0.95;

/** `retry after S s`, with ` (about H h)` when S is an hour or more. */
function retryAfterText(retryAfterMs: number): string {
  const seconds = Math.ceil(retryAfterMs / 1000);
  const hours = seconds >= 3600 ? ` (about ${(seconds / 3600).toFixed(1)} h)` : "";
  return `retry after ${String(seconds)} s${hours}`;
}

/** One item of the report rules, with the number a report writer knows it by. */
export interface ReportCheckQuestion {
  /** The item number of the report rules: 1 to 13. */
  readonly n: number;
  readonly text: string;
}

/**
 * The seven items `report_check` asks the judge, one judge item each, in item order.
 *
 * Three of the four rules an orchestrator applies to a draft are items 1 to 3, and
 * the ten items of the Reports section of the common conventions are items 4 to 13.
 * The fourth rule ("passes the ten items") is those ten items together with the
 * table check, so it has no question of its own. Items 10 to 14 are checked by a
 * program, and item 10 is asked as well: the program finds a reference whose place
 * is missing, and the judge reads whether the place holds what the sentence says.
 * Items 6 to 8 are checked by nobody here, because the judge did not answer them in
 * a useful way when they were measured.
 *
 * The tool sends all seven in one request, each under its own key, because the judge
 * answers one question per key. The text is the approved wording;
 * do not reword one here without a new approval.
 */
export const REPORT_CHECK_QUESTIONS: readonly ReportCheckQuestion[] = [
  {
    n: 1,
    text: "Does the document quote the user's original words without a change, in a place of their own? If the document is a plan or a result and carries a section with the user's words as quotes, answer yes.",
  },
  {
    n: 2,
    text: "Completion conditions: is the reinforcement, such as an extra observation or a later check, kept in its own section and not listed among the completion conditions? Answer yes if the document has no reinforcement or no completion conditions.",
  },
  {
    n: 3,
    text: "Does every appendix block that shows the full text of a file hold the text of that file and nothing else? If the document shows no full text of a file in an appendix, answer yes.",
  },
  {
    n: 4,
    text: "Opening paragraph: with only the first paragraph read, can a reader say in one sentence what the document asks to approve?",
  },
  {
    n: 5,
    text: "Approval request: does the sentence that asks for the approval list the approval scope as items, and do those items match the items in the body?",
  },
  {
    n: 9,
    text: "Revision history: does the body avoid describing earlier revisions of this document, such as what an earlier draft or revision said, what this revision changed, or why its wording changed? Measurements and facts that the work found, and quotes of the user's words or feedback, are not revision history. Answer yes if the body does not describe earlier revisions.",
  },
  {
    n: 10,
    text: "Cross reference: when a sentence points to a section or an appendix of this document, does that place hold what the sentence says it holds? For example, if a sentence says that the approval items are in section 11, section 11 must be the approval request. References that name another document do not count. Answer yes if the document has no such reference.",
  },
];

/**
 * The items that nothing in this tool checks.
 *
 * The judge did not answer them in a useful way when the questions were measured:
 * a rewrite that made good drafts clear lost as many problem drafts as it gained.
 * So the orchestrator's own check and the root's check are the only checks these
 * items get, and the answer of the tool says so.
 */
export const REPORT_CHECK_UNCHECKED_ITEMS: readonly number[] = [6, 7, 8];

/**
 * The tables in a markdown text, as far as the two lines that open one.
 *
 * A table starts on a line that begins with `|` when the line above it does not,
 * and its second line has to be a delimiter row (`|---|`). A line inside a fenced
 * code block opens no table: a fence of three or more backticks or tildes runs to
 * the line that closes it with at least as many of the same character and nothing
 * after them.
 *
 * The conventions say to check a table with a program and not with the eye, which
 * is why this is here and not one of the judge's questions. The line numbers are
 * 1-based, the numbers an editor shows.
 */
export function scanTables(text: string): { found: number; withoutDelimiter: number[] } {
  const lines = text.split(/\r?\n/);
  const delimiterRow = /^\|[-| :]+\|$/;
  const opens = (line: string): string | undefined => /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
  const closes = (line: string, fence: string): boolean => {
    const match = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
    return match !== null && match[1]![0] === fence[0] && match[1]!.length >= fence.length;
  };
  let fence: string | undefined;
  let found = 0;
  const withoutDelimiter: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence !== undefined) {
      if (closes(line, fence)) fence = undefined;
      continue;
    }
    const opening = opens(line);
    if (opening !== undefined) {
      fence = opening;
      continue;
    }
    if (!line.startsWith("|")) continue;
    if (index > 0 && lines[index - 1]!.startsWith("|")) continue;
    found += 1;
    const second = lines[index + 1];
    if (second === undefined || !delimiterRow.test(second)) withoutDelimiter.push(index + 1);
  }
  return { found, withoutDelimiter };
}

/**
 * The program checks, one per item that a rule can decide without a model.
 *
 * These are approximations: a reference that names another
 * document without looking like one is reported, and so is a reference to this
 * document that follows a word that looks like a document name. Item 14 reports a
 * rare real word as well, because such a word can sit outside the 2350 common
 * syllables. Each rule reads the body only, which ends at the first top-level
 * appendix heading, and never a line inside a fenced code block.
 */
export const PROGRAM_CHECK_ITEMS: readonly number[] = [10, 11, 12, 13, 14];

/** One place a program check found, with the item it belongs to and its 1-based line. */
export interface ProgramFinding {
  readonly item: number;
  readonly line: number;
  /** What the check found, as the phrase that follows the colon of its `CHECK` line. */
  readonly what: string;
}

/**
 * The 2350 Hangul syllables of KS X 1001, read from the EUC-KR byte ranges of
 * that standard: a lead byte of 0xB0 to 0xC8 and a trail byte of 0xA1 to 0xFE.
 *
 * The decoder is the WHATWG one, whose `euc-kr` label is CP949, so the two ranges
 * hold the 2350 common syllables of KS X 1001 and nothing else. Building the set
 * costs about 4 ms at load, and a test pins the count.
 */
export const COMMON_SYLLABLES: ReadonlySet<string> = (() => {
  const decoder = new TextDecoder("euc-kr");
  const set = new Set<string>();
  for (let lead = 0xb0; lead <= 0xc8; lead += 1) {
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      const syllable = decoder.decode(new Uint8Array([lead, trail]));
      if ([...syllable].length === 1) set.add(syllable);
    }
  }
  return set;
})();

/**
 * Item 14: a Korean syllable outside the 2350 common syllables of KS X 1001,
 * with a few characters of context. A broken character leaves one behind, and a
 * rare real word lands here too, so the finding is a place to look at once. It is
 * not one of the 13 report rules, and it reads the body only, as every program
 * check does.
 */
export function checkSyllables(text: string, context = 6): { line: number; syllable: string; context: string }[] {
  const lines = text.split(/\r?\n/);
  const mask = fenceMask(lines);
  const end = bodyEnd(lines, mask);
  const found: { line: number; syllable: string; context: string }[] = [];
  for (let index = 0; index < end; index += 1) {
    if (mask[index]) continue;
    const line = lines[index]!;
    for (let at = 0; at < line.length; at += 1) {
      const code = line.charCodeAt(at);
      if (code < 0xac00 || code > 0xd7a3 || COMMON_SYLLABLES.has(line[at]!)) continue;
      found.push({
        line: index + 1,
        syllable: line[at]!,
        context: line.slice(Math.max(0, at - context), at + 1 + context),
      });
    }
  }
  return found;
}

/** `true` for every line that is a fence of a code block or inside one. */
function fenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== undefined) {
      mask.push(true);
      if (
        match !== null &&
        match[1]![0] === fence[0] &&
        match[1]!.length >= fence.length &&
        /^ {0,3}(`+|~+)\s*$/.test(line)
      ) {
        fence = undefined;
      }
      continue;
    }
    if (match !== null) {
      fence = match[1];
      mask.push(true);
      continue;
    }
    mask.push(false);
  }
  return mask;
}

/**
 * The index of the first top-level appendix heading, or the line count when there is none.
 *
 * The lookahead stands in for a word boundary: `\b` never matches after a Korean
 * syllable, because it asks for a change between a word character and a non-word
 * one and 부록 is neither, so a rule written with `\b` would read a `## 부록 A`
 * heading as prose and never end the body.
 */
function bodyEnd(lines: readonly string[], mask: readonly boolean[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    if (!mask[index] && /^##\s+(?:부록|Appendix)(?![0-9A-Za-z])/i.test(lines[index]!)) return index;
  }
  return lines.length;
}

/** The section numbers and appendix letters the document has a heading for. */
function headingsOf(lines: readonly string[], mask: readonly boolean[]): { sections: Set<string>; appendices: Set<string> } {
  const sections = new Set<string>();
  const appendices = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    if (mask[index]) continue;
    const appendix = /^#{1,4}\s+(?:부록|Appendix)\s+([A-Z])\b/i.exec(lines[index]!);
    if (appendix !== null) {
      appendices.add(appendix[1]!.toUpperCase());
      continue;
    }
    const section = /^#{1,4}\s+(\d+(?:\.\d+)*)[.\s]/.exec(lines[index]!);
    if (section !== null) sections.add(section[1]!.replace(/\.$/, ""));
  }
  return { sections, appendices };
}

/** A word that ends in the name of another document, so a reference after it belongs there. */
const OTHER_DOCUMENT = /(리포트|계획|문서|노트|로드맵|판|\.md|plan|report|notes)`?\s*(의\s*)?$/i;

/** Whether the text before a reference names another document, through parentheses and 의. */
function namesOtherDocument(original: string, index: number): boolean {
  let before = original.slice(Math.max(0, index - 80), index);
  for (let round = 0; round < 3; round += 1) {
    before = before.replace(/\s*(의)?\s*$/, "").replace(/\([^()]*\)$/, "");
  }
  return OTHER_DOCUMENT.test(before);
}

/** A hexadecimal value of 7 to 64 characters that holds a letter a-f and a digit. */
const HASH_VALUE = /(?<![0-9A-Za-z])[0-9a-f]{7,64}(?![0-9A-Za-z])/g;

/** Item 12: a hash value in the body, where the reader cannot judge one. */
export function checkHashes(text: string): { line: number; text: string }[] {
  const lines = text.split(/\r?\n/);
  const mask = fenceMask(lines);
  const end = bodyEnd(lines, mask);
  const found: { line: number; text: string }[] = [];
  for (let index = 0; index < end; index += 1) {
    if (mask[index]) continue;
    for (const match of lines[index]!.matchAll(HASH_VALUE)) {
      if (/[a-f]/.test(match[0]) && /[0-9]/.test(match[0])) found.push({ line: index + 1, text: match[0] });
    }
  }
  return found;
}

/** Item 10: a reference to a section or an appendix that this document has no heading for. */
export function checkRefs(text: string): { line: number; text: string }[] {
  const lines = text.split(/\r?\n/);
  const mask = fenceMask(lines);
  const end = bodyEnd(lines, mask);
  const { sections, appendices } = headingsOf(lines, mask);
  const found: { line: number; text: string }[] = [];
  const REFERENCE = /(?<![\d.])(\d+(?:\.\d+)*)\s?절|부록\s+([A-Z])(?![A-Za-z])/g;
  for (let index = 0; index < end; index += 1) {
    if (mask[index] || /^#/.test(lines[index]!) || /^>/.test(lines[index]!)) continue;
    const line = lines[index]!
      .replace(/`[^`]*`/g, (span) => " ".repeat(span.length))
      .replace(/"[^"]*"/g, (span) => " ".repeat(span.length));
    let skippedEnd = -1;
    for (const match of line.matchAll(REFERENCE)) {
      // A reference joined to a skipped one ("문서 4.2절과 4.3절") points to the same document.
      const joined =
        skippedEnd >= 0 && /^\s*(과|와|,|및|부터|에서|or|and)\s*$/.test(line.slice(skippedEnd, match.index));
      if (joined || namesOtherDocument(lines[index]!, match.index)) {
        skippedEnd = match.index + match[0].length;
        continue;
      }
      skippedEnd = -1;
      const known = match[1] !== undefined ? sections.has(match[1]) : appendices.has(match[2]!);
      if (!known) found.push({ line: index + 1, text: match[0] });
    }
  }
  return found;
}

/** Item 13: a table cell longer than `maxChars` characters, which a reader cannot judge at one look. */
export function checkCells(text: string, maxChars = 120): { line: number; text: string; chars: number }[] {
  const lines = text.split(/\r?\n/);
  const mask = fenceMask(lines);
  const found: { line: number; text: string; chars: number }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (mask[index] || !/^\|/.test(lines[index]!) || /^\|[-| :]+\|$/.test(lines[index]!)) continue;
    const cells = lines[index]!
      .replace(/\\\|/g, "  ")
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    for (const cell of cells) {
      const chars = [...cell].length;
      if (chars > maxChars) found.push({ line: index + 1, text: cell.slice(0, 40), chars });
    }
  }
  return found;
}

/** An identifier as item 11 counts one: inline code, a path, a job id, a ULID, or a hex value. */
const IDENTIFIER = /`[^`]+`|(?:~|\/)[\w.\-/]+\/[\w.\-]+|\b\d{8}-[0-9A-Z]{26}\b|\b[0-9A-HJKMNP-TV-Z]{26}\b|(?<![0-9A-Za-z])[0-9a-f]{7,64}(?![0-9A-Za-z])/g;

/** Item 11: a paragraph or a list item that is mostly identifiers, which is hard to read. */
export function checkIds(text: string, min = 10, share = 0.5): { line: number; ids: number; share: number }[] {
  const lines = text.split(/\r?\n/);
  const mask = fenceMask(lines);
  const end = bodyEnd(lines, mask);
  const found: { line: number; ids: number; share: number }[] = [];
  let paragraph: string[] = [];
  let start = 0;
  const flush = (): void => {
    if (paragraph.length === 0) return;
    const joined = paragraph.join(" ");
    const ids = [...joined.matchAll(IDENTIFIER)];
    const chars = ids.reduce((total, match) => total + match[0].length, 0);
    if (ids.length >= min && chars / joined.length >= share) {
      found.push({ line: start + 1, ids: ids.length, share: Number((chars / joined.length).toFixed(2)) });
    }
    paragraph = [];
  };
  for (let index = 0; index < end; index += 1) {
    const line = lines[index]!;
    if (mask[index] || /^\s*$/.test(line) || /^[#|>]/.test(line)) {
      flush();
      continue;
    }
    // A list item is a paragraph of its own.
    if (/^\s*([-*]|\d+\.)\s/.test(line)) {
      flush();
      start = index;
      paragraph = [line];
      continue;
    }
    if (paragraph.length === 0) start = index;
    paragraph.push(line);
  }
  flush();
  return found;
}

/** Every finding of the four program checks, in item order. */
export function programFindings(text: string): ProgramFinding[] {
  const found: ProgramFinding[] = [];
  for (const reference of checkRefs(text)) {
    found.push({ item: 10, line: reference.line, what: `a reference this document has no heading for: ${reference.text}` });
  }
  for (const paragraph of checkIds(text)) {
    found.push({
      item: 11,
      line: paragraph.line,
      what: `a paragraph that is ${Math.round(paragraph.share * 100)}% identifiers: ${paragraph.ids} of them`,
    });
  }
  for (const hash of checkHashes(text)) {
    found.push({ item: 12, line: hash.line, what: `a hash value in the body: ${hash.text}` });
  }
  for (const cell of checkCells(text)) {
    found.push({ item: 13, line: cell.line, what: `a table cell of ${cell.chars} characters: ${cell.text}` });
  }
  for (const syllable of checkSyllables(text)) {
    found.push({
      item: 14,
      line: syllable.line,
      what: `a Korean syllable outside the 2350 of KS X 1001: ${syllable.syllable} in ${syllable.context}`,
    });
  }
  return found;
}

/** The newest revision the operator has approved, or `undefined` when there is none. */
function approvedRevision(versions: readonly ReportVersion[]): number | undefined {
  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const version = versions[index]!;
    if (version.approval !== undefined) return version.n;
  }
  return undefined;
}

/**
 * The digest the store records for a revision body: sha256 of the utf8 text it
 * wrote. The same input and encoding as `sha256` in `src/reports/store.ts`, so a
 * body read back from disk can be compared with the record it belongs to.
 */
function bodyDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The size cap `read_full` uses when the config names none: 256 KiB. */
const DEFAULT_DRAFT_MAX_BYTES = 256 * 1024;

/** A whole, positive byte count, or undefined for anything else. */
function positiveBytes(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * The note a published revision carries.
 *
 * A note given to the publish call is what the revision says, so it wins. Without
 * one the draft's own note stands in, which is what saves the root from retyping
 * the words the draft already holds. A draft written before the note field has
 * none, and reads as a draft with no note.
 */
function publishedNote(given: string | undefined, draft: { readonly note?: string }): string | undefined {
  if (given !== undefined) return given;
  return draft.note === undefined || draft.note === "" ? undefined : draft.note;
}

/**
 * One draft line under the reports of its job.
 *
 * A draft is open work of its job, so a reader that asks for that job's reports
 * sees what the job still holds: an id to read with `reports_get`, what the draft
 * is, when it was written, and which conversation wrote it.
 */
function formatDraft(draft: Readonly<ReportDraftRecord>, timeZone: string): string {
  const note = draft.note === undefined ? "" : ` note=${draft.note}`;
  return `${draft.id} "${draft.title}"${note} written=${zoneIso(draft.createdAt, timeZone)} by=${draft.agentConversationId}`;
}

/**
 * Whether `jobId` sits below `ancestorId` in the live job tree.
 *
 * The walk follows `parentId` upwards. A live job's ancestors are live too, so
 * the live store is enough. A cycle in hand-edited data ends the walk with no.
 */
async function descendsFrom(
  context: ExtensionContext,
  ctx: Parameters<NonNullable<ExtensionContext["jobs"]>["get"]>[0],
  jobId: string,
  ancestorId: string,
): Promise<boolean> {
  if (context.jobs === undefined) return false;
  const seen = new Set<string>([jobId]);
  let parentId = (await context.jobs.get(ctx, jobId))?.parentId;
  while (parentId !== undefined && !seen.has(parentId)) {
    if (parentId === ancestorId) return true;
    seen.add(parentId);
    parentId = (await context.jobs.get(ctx, parentId))?.parentId;
  }
  return false;
}

/** A compact one-line summary of a report, for listing. */
function formatReport(record: {
  id: string;
  name: string;
  title: string;
  jobId: string;
  kind?: ReportKind;
  versions: readonly ReportVersion[];
  feedback: readonly ReportFeedback[];
  updatedAt: number;
  pendingAt?: number;
  answeredAt?: number;
}, timeZone: string): string {
  const approved = approvedRevision(record.versions);
  // A result report and a briefing say so in their own field, in the same place
  // the other marks sit. A plan says nothing: `plan` is what a line with no kind
  // already means.
  const named = reportKind(record);
  const kind = named === "plan" ? "" : ` kind=${named}`;
  return `${record.id} /report/${record.name} "${record.title}" job=${record.jobId}${kind} v=${record.versions.length}${record.pendingAt === undefined ? "" : " pending"}${awaitingAnswer(record) ? " unanswered" : ""}${approved === undefined ? "" : ` approved v${approved}`} feedback=${record.feedback.length} updated=${zoneIso(record.updatedAt, timeZone)}`;
}

/**
 * The bundled `reports` extension: long documents owned by a job.
 *
 * This exists so a plan, a survey, or a findings write-up does not have to be
 * pasted into the transcript. The document lives as a file with an append-only
 * revision history, the job owns it, and the chat carries the address.
 */
export function createReportsExtension(context: ExtensionContext): Extension<ToolRegistration> {
  // Every time this extension prints is the harness zone, read from the config
  // each call rather than captured: the zone is config, and config can be reloaded.
  const zone = (): string => context.getConfig().timezone;
  const create = defineTool({
    name: "reports_create",
    description:
      "Publish a long document as a report owned by an existing job. The chat gets the reference, never the document.",
    parameters: obj(
      {
        jobId: str({ description: "The job this report belongs to." }),
        title: str(),
        content: str({ description: "The document, in markdown." }),
        name: opt(str({ description: "URL slug. Defaults to one derived from the title." })),
        note: opt(str({ description: "What this revision is, in a few words." })),
        kind: opt(
          union([lit("plan"), lit("result"), lit("briefing")], {
            description:
              "`result` for a result report: a report about work that already ran, such as the work of an approved plan, an experiment, or an investigation. The viewer shows a result report with Done and Feedback and lists it under Results. `plan`, the default, for a plan, which shows Approve. `briefing` for the morning briefing, on the job of the routine that sent it: it shows only Feedback, it is listed at the top under Briefing, and it can never be approved. A new briefing report moves every earlier briefing report with its inbox notices, and every inbox notice of kind `briefing`, to the archive.",
          }),
        ),
      },
    ),
    replay: "unsafe",
    execute: async (args, _api, ctx) => {
      const reports = requireReports(context);
      const job = await context.jobs?.get(ctx, args.jobId);
      if (context.jobs !== undefined && job === undefined) {
        return {
          output: [{ type: "text" as const, text: `Job not found: ${args.jobId}. A report must belong to a job.` }],
          isError: true,
        };
      }
      const record = await reports.create(ctx, {
        jobId: args.jobId,
        title: args.title,
        content: args.content,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.note !== undefined ? { note: args.note } : {}),
        ...(args.kind === "result" || args.kind === "briefing" ? { kind: args.kind } : {}),
      });
      context.audit.append({ type: "report_created", reportId: record.id, jobId: record.jobId });
      // The inbox notice is written by the report's own commit (see ReportStore's
      // `onChange`); this event is what tells an open UI to read the inbox again.
      context.events.emit("report_created", record as unknown as Record<string, unknown>);
      return {
        output: [
          {
            type: "text" as const,
            text: `published ${formatReport(record, zone())}\nThe inbox notice carries this to the user; do not post the reference in the chat.`,
          },
        ],
      };
    },
  });

  const addVersion = defineTool({
    name: "reports_add_version",
    description: "Append a new revision to a report. Revisions are never overwritten, so they can be compared.",
    parameters: obj(
      {
        id: str(),
        content: str({ description: "The full document for this revision, in markdown." }),
        note: opt(str({ description: "What changed." })),
      },
    ),
    replay: "unsafe",
    execute: async (args, _api, ctx) => {
      const reports = requireReports(context);
      const record = await reports.addVersion(ctx, args.id, {
        content: args.content,
        ...(args.note !== undefined ? { note: args.note } : {}),
      });
      context.events.emit("report_updated", record as unknown as Record<string, unknown>);
      return { output: [{ type: "text" as const, text: `updated ${formatReport(record, zone())}` }] };
    },
  });

  const setPending = defineTool({
    name: "reports_set_pending",
    description:
      "Set a live report aside as `pending`, or bring it back to its open standing: `active` for a plan and `result` for a result report. `pending` means the user does not have to answer about it right now: it keeps its text, its feedback and its revision history, and the user can still open it and approve a revision. A result report that still waits for the user's Done or Feedback cannot be set aside, because the user has to look at it: it stays under Results, and the call is refused. A briefing report cannot be set aside either: it stays at the top under Briefing while its job lives, and a call with `pending` true for it is refused. Moving the flag on its own writes no inbox notice, which is the point of it. A finished or archived report is refused, because its job decides that rather than this call. Bring a report back with `answer` when the answer to user feedback is a message rather than a revision: that call clears the flag and writes the inbox notice for that answer in the same commit, so an answer is never silent.",
    parameters: obj(
      {
        id: str(),
        pending: bool({ description: "true sets the report aside, false brings it back to its open standing." }),
        answer: opt(
          str({
            description:
              "The answer to the user's feedback, when that answer is a message rather than a new revision. It is required when the report is waiting on an answer and `pending` is false; that call clears the flag and writes the inbox notice for the answer in the same commit. It is ignored when `pending` is true.",
          }),
        ),
      },
    ),
    replay: "unsafe",
    execute: async (args, _api, ctx) => {
      const reports = requireReports(context);
      const outcome = await reports.setPending(
        ctx,
        args.id,
        args.pending,
        args.answer === undefined ? undefined : { answer: args.answer },
      );
      if (!outcome.ok) {
        const why =
          outcome.reason === "not_found"
            ? `no live report with id ${args.id}, and a report that has moved to the archive cannot be set aside`
            : outcome.reason === "not_active"
              ? outcome.status === undefined
                ? "its job is no longer live, so it cannot be set aside"
                : `its job is ${outcome.status}, so it cannot be set aside`
              : outcome.reason === "needs_user_check"
                ? "it is a result report that still waits for the user's Done or Feedback, so it stays under Results"
                : outcome.reason === "briefing"
                  ? "it is a briefing report, so it stays at the top under Briefing while its job lives"
                  : outcome.reason === "answer_required"
                  ? "the user left feedback on it, so bringing it back needs the answer in `answer`"
                  : "it is not waiting on an answer, so there is nothing for `answer` to answer";
        return {
          output: [{ type: "text" as const, text: `Report not changed: ${why}.` }],
          isError: true,
        };
      }
      context.events.emit("report_updated", outcome.report as unknown as Record<string, unknown>);
      // Bringing a report back names its own standing, because a result report
      // comes back to `result` rather than to `active`.
      const open = reportKind(outcome.report) === "result" ? "result" : "active";
      return {
        output: [
          {
            type: "text" as const,
            text: `${args.pending ? "pending" : open} ${formatReport(outcome.report, zone())}`,
          },
        ],
      };
    },
  });

  const move = defineTool({
    name: "reports_move",
    description:
      "Move a live report to another live job. Its revisions, approvals, feedback, name and title stay as they are, and the report is listed under the new job from then on. A report that is archived or whose job has ended is refused, and so is a job that is missing or finished; a refused call writes nothing. Only the root has this tool.",
    parameters: obj(
      {
        id: str({ description: "The report id." }),
        jobId: str({ description: "The live job the report should belong to." }),
      },
    ),
    replay: "unsafe",
    execute: async (args, _api, ctx) => {
      const reports = requireReports(context);
      const outcome = await reports.moveToJob(ctx, args.id, args.jobId);
      if (!outcome.ok) {
        if (outcome.reason === "same_job") {
          const current = await reports.get(ctx, args.id);
          return {
            output: [
              {
                type: "text" as const,
                text:
                  current === undefined
                    ? `Report ${args.id} already belongs to job ${args.jobId}.`
                    : `Report ${args.id} already belongs to job ${args.jobId}, so nothing was moved: ${formatReport(current, zone())}`,
              },
            ],
          };
        }
        const why =
          outcome.reason === "not_found"
            ? `no live report with id ${args.id}, and a report that has moved to the archive cannot be moved`
            : outcome.reason === "not_active"
              ? outcome.status === undefined
                ? "its job is no longer live, so it cannot be moved"
                : `its job is ${outcome.status}, so it cannot be moved`
              : outcome.reason === "job_not_found"
                ? `no live job with id ${args.jobId}, and a report belongs to a live job`
                : `job ${args.jobId} is ${outcome.status}, so it cannot take a report`;
        return {
          output: [{ type: "text" as const, text: `Report not moved: ${why}.` }],
          isError: true,
        };
      }
      // The move changes where the report is listed, so an open UI re-reads it.
      // Nothing goes in the inbox: the document did not change, and the user is not
      // being asked anything.
      context.events.emit("report_updated", outcome.report as unknown as Record<string, unknown>);
      context.audit.append({
        type: "report_moved",
        reportId: outcome.report.id,
        fromJobId: outcome.fromJobId,
        toJobId: outcome.report.jobId,
      });
      return {
        output: [
          {
            type: "text" as const,
            text: `moved ${outcome.report.id} from job ${outcome.fromJobId} to job ${outcome.report.jobId}: ${formatReport(outcome.report, zone())}\nThe report keeps its revisions, approvals, feedback, name and title. Drafts stay with the job they were written in.`,
          },
        ],
      };
    },
  });

  const list = defineTool({
    name: "reports_list",
    description: "List reports, optionally narrowed to one job. Archived reports are excluded unless asked for.",
    parameters: obj(
      {
        jobId: opt(str()),
        includeArchived: opt(bool()),
      },
    ),
    replay: "safe",
    execute: async (args, _api, ctx) => {
      const reports = requireReports(context);
      const live = await reports.list(ctx, args.jobId === undefined ? undefined : { jobId: args.jobId });
      const archived = args.includeArchived === true ? await reports.listArchived(ctx) : [];
      const lines = live.map((record) => formatReport(record, zone()));
      if (archived.length > 0) {
        // An archived report left the live store in one of two ways: with its job,
        // or on its own when a newer briefing replaced it.
        lines.push("", "Archived (moved out of the live store; still readable by id):", ...archived.map((record) => formatReport(record, zone())));
      }
      // Narrowed to one job, the list also shows what that job still holds: its
      // drafts, which nobody published yet. A whole-store list shows reports only,
      // because a draft belongs to a job and not to the store.
      const drafts =
        args.jobId === undefined
          ? []
          : ((await context.drafts?.list(ctx)) ?? []).filter((draft) => draft.jobId === args.jobId);
      const reportsText = lines.join("\n") || "(no reports)";
      const draftsText =
        drafts.length === 0 ? "" : `Drafts (written, not yet published):\n${drafts.map((draft) => formatDraft(draft, zone())).join("\n")}`;
      return {
        output: [
          { type: "text" as const, text: draftsText === "" ? reportsText : `${reportsText}\n\n${draftsText}` },
        ],
      };
    },
  });

  const get = defineTool({
    name: "reports_get",
    description:
      "Read one report: its revisions, its feedback, and optionally the current text. Archived reports still resolve. A draft id resolves too, and then the response carries the draft's record instead of a report's.",
    parameters: obj(
      {
        id: str(),
        includeBody: opt(bool({ description: "Also return the latest revision's text, or the draft's text." })),
        version: opt(num({ description: "Which revision to return with includeBody. Defaults to the latest." })),
      },
    ),
    replay: "safe",
    execute: async (args, _api, ctx) => {
      const reports = requireReports(context);
      const record = await reports.getAny(ctx, args.id);
      if (record === undefined) {
        // A report wins over a draft, but both live under the same kind of id, so
        // one lookup answers for either. The row is read before the body: reading
        // the body first cannot tell a missing draft from a missing file.
        const drafts = requireDrafts(context);
        const draft = await drafts.get(ctx, args.id);
        if (draft === undefined) {
          return {
            output: [{ type: "text" as const, text: `No report or draft with id ${args.id}` }],
            isError: true,
          };
        }
        // Read whatever the flag says, because the missing-file case has to be
        // told apart from the missing-draft case in every response.
        const body = await drafts.read(draft).catch(() => undefined);
        if (body === undefined) {
          return {
            output: [
              {
                type: "text" as const,
                text: `draft ${draft.id} exists (status ${draft.status}) but its body file is gone`,
              },
            ],
            isError: true,
          };
        }
        return {
          output: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  kind: "draft",
                  ...withLocal(draft, ["createdAt", "updatedAt"], zone()),
                  url: null,
                  publish:
                    draft.jobId === undefined
                      ? "Publish it with reports_publish_draft, giving it this id and a jobId. Only the root has that tool."
                      : `This draft belongs to job ${draft.jobId}. Publish it with reports_publish_draft, giving it this id and jobId ${draft.jobId}: a draft publishes into its own job and no other. Only the root has that tool.`,
                  ...(args.includeBody === true ? { body } : {}),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      const live = await context.jobs?.get(ctx, record.jobId);
      const job = live ?? (await context.archive?.get(ctx, record.jobId));
      const n = args.version ?? record.versions.length;
      const body = args.includeBody === true ? await reports.readVersion(record.id, n) : undefined;
      return {
        output: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                // Every number stays, and the times a reader would convert by
                // hand get a readable twin in the harness zone. A revision and a
                // note carry their own instant, so each is twinned inside.
                ...withLocal(record, ["createdAt", "updatedAt", "pendingAt"], zone()),
                versions: record.versions.map((version) => ({
                  ...withLocal(version, ["at"], zone()),
                  ...(version.approval === undefined ? {} : { approval: withLocal(version.approval, ["at"], zone()) }),
                })),
                feedback: record.feedback.map((note) => withLocal(note, ["at"], zone())),
                url: `/report/${record.name}`,
                standing: reportStanding(record, live?.status),
                job: job === undefined ? null : { id: job.id, title: job.title, status: job.status },
                ...(body === undefined
                  ? {}
                  : {
                      body,
                      bodyVersion: n,
                      // The file on disk is what the reader gets, so a body that no
                      // longer matches the revision's recorded digest is called out.
                      // A body that matches adds no key at all: the shape of a
                      // healthy response does not change.
                      ...(bodyDigest(body) === record.versions[n - 1]?.sha256 ? {} : { bodySha256Mismatch: true }),
                    }),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  const draft = defineTool({
    name: "reports_draft",
    description:
      "Write a draft report owned by a job and keep its id, so your parent can read it with `reports_get` and publish it with `reports_publish_draft`. A subagent cannot publish: publishing is the root's decision, which is why this is the only report-writing tool a subagent has. `jobId` is required, and a draft belongs to the job it names: it stays as open work of that job until it is published or dropped, it is dropped when that job ends, not when its author is deleted, and it publishes into that job and no other. Give the document as `content`, or name the markdown file that holds it with `path`. With `path`, the draft holds the text of the file as it is when the call runs, and the text does not pass through you.",
    parameters: obj(
      {
        jobId: str({ description: "The job this draft belongs to (required)." }),
        title: str(),
        content: opt(
          str({ description: "The document, in markdown. Give this or `path`, not both." }),
        ),
        path: opt(
          str({
            description:
              "A markdown file that holds the document. Give this or `content`, not both. A file larger than the size cap of `read_full` is refused.",
          }),
        ),
        note: opt(str({ description: "What this draft is, in a few words." })),
        kind: opt(
          union([lit("plan"), lit("result"), lit("briefing")], {
            description:
              "`result` for a result report: a report about work that already ran, such as the work of an approved plan, an experiment, or an investigation. The viewer shows a result report with Done and Feedback and lists it under Results. `plan`, the default, for a plan, which shows Approve. The root checks the kind when it publishes. A briefing is refused here: the root writes a briefing report itself with `reports_create`, and no draft stands behind one.",
          }),
        ),
      },
    ),
    replay: "unsafe",
    // The file is read when the call runs, so the whole bundle runs one call at a
    // time: a draft written after an edit of the same file then holds the text
    // the edit wrote, not the text from before it.
    executionMode: "sequential",
    execute: async (args, api, ctx) => {
      const drafts = requireDrafts(context);
      // Nothing is written before every check has passed: a refused call must
      // leave neither a file nor a row behind.
      // The document comes one way or the other, never both: a `content` beside
      // a `path` leaves the reader guessing which one the draft holds.
      const givenPath = args.path?.trim();
      const hasPath = givenPath !== undefined && givenPath !== "";
      if ((args.content === undefined) === !hasPath) {
        return {
          output: [
            {
              type: "text" as const,
              text: "reports_draft takes exactly one of `content` and `path`: the document as text, or the markdown file that holds it. Nothing was written.",
            },
          ],
          isError: true,
        };
      }
      // A file is read here rather than by the model, so the draft is the file's
      // own text. A file the tool cannot read, or one over the size cap that
      // `read_full` uses, is refused, and the refusal leaves no file and no row.
      let content = args.content ?? "";
      if (hasPath) {
        const size = await stat(givenPath).catch(() => undefined);
        if (size === undefined || !size.isFile()) {
          return {
            output: [
              {
                type: "text" as const,
                text: `Cannot read ${givenPath}: no such file, or it is not a file. Nothing was written.`,
              },
            ],
            isError: true,
          };
        }
        // Read on every call, as `read_full` does, so a config an operator
        // changed is the cap the next call enforces.
        const maxBytes = positiveBytes(context.getConfig().readFull.maxBytes) ?? DEFAULT_DRAFT_MAX_BYTES;
        if (size.size > maxBytes) {
          return {
            output: [
              {
                type: "text" as const,
                text: `${givenPath} is ${size.size} bytes, over the ${maxBytes} byte size cap of read_full, so it was refused and not cut. Nothing was written.`,
              },
            ],
            isError: true,
          };
        }
        const read = await readFile(givenPath, "utf8").catch(() => undefined);
        if (read === undefined) {
          return {
            output: [
              {
                type: "text" as const,
                text: `Cannot read ${givenPath}: no such file, or it is not readable as UTF-8 text. Nothing was written.`,
              },
            ],
            isError: true,
          };
        }
        // The file never passed through the model, so a registered secret in it
        // was never replaced on the way in. The draft is what publishing would
        // put in front of the user, so the same redaction is applied here.
        content = context.secrets.redactor().redact(read);
      }
      const jobId = args.jobId?.trim() ?? "";
      if (jobId === "") {
        return {
          output: [
            {
              type: "text" as const,
              text: "No jobId was given. Name the job this draft belongs to with `jobId`: a draft is a job's document, and a draft with no job has no owner.",
            },
          ],
          isError: true,
        };
      }
      const job = await context.jobs?.get(ctx, jobId);
      if (context.jobs !== undefined && job === undefined) {
        return {
          output: [
            {
              type: "text" as const,
              text: `Job not found: ${jobId}. A draft must belong to a live job.`,
            },
          ],
          isError: true,
        };
      }
      // A conversation that was handed a job may file a draft for that job or for
      // one of its subjobs, and nowhere else. The agent that holds a top-level job
      // also owns the plans of the jobs below it.
      const assigned = (await requireHarness(context).snapshot(SecAgent, String(api.conversationId), ctx))?.jobId;
      if (assigned !== undefined && assigned !== jobId && !(await descendsFrom(context, ctx, jobId, assigned))) {
        return {
          output: [
            {
              type: "text" as const,
              text: `This conversation is assigned to job ${assigned}, so its draft must name that job or one of its subjobs, and ${jobId} is neither. Call again with jobId ${assigned} or the id of a job below it.`,
            },
          ],
          isError: true,
        };
      }
      // A briefing is never a draft: the root writes it with `reports_create`, so
      // nothing stands between the writing and the user. Refused before the file
      // and the row, like every other refusal here.
      if (args.kind === "briefing") {
        return {
          output: [
            {
              type: "text" as const,
              text: "A briefing report is written by the root with `reports_create` and `kind: \"briefing\"`, and no draft stands behind one. Nothing was written.",
            },
          ],
          isError: true,
        };
      }
      const record = await drafts.create(ctx, {
        agentConversationId: String(api.conversationId),
        jobId,
        title: args.title,
        content,
        ...(args.note === undefined ? {} : { note: args.note }),
        ...(args.kind === "result" ? { kind: "result" as const } : {}),
      });
      context.audit.append({
        type: "report_draft",
        draftId: record.id,
        conversationId: api.conversationId,
        jobId: record.jobId,
      });
      const lines = [
        `draft ${record.id} written (${record.bytes} bytes) at ${record.path}. The user has not been told: send your parent the id and what it is for, and the root publishes or refuses it.`,
        `job: ${record.jobId}`,
      ];
      // The kind is the author's to name, and it is said back so the author can see
      // what the root will publish: a draft with no kind is a plan.
      lines.push(`kind: ${reportKind(record)}`);
      // A top-level job produces no document of its own, so a draft filed against
      // one is almost always a mistake — but losing a draft is worse than keeping
      // a misplaced one, so this warns rather than refuses.
      if (job !== undefined && job.parentId === undefined) {
        lines.push(
          "not recommended: this is a top-level job; a draft belongs to the job that produced it. It is still recorded.",
        );
      }
      if (args.note !== undefined) lines.push(`note: ${args.note}`);
      return { output: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  const dropDraft = defineTool({
    name: "reports_draft_drop",
    description:
      "Delete a draft report. Publishing and refusing both delete it already, so this is for a draft nobody will use.",
    parameters: obj({ id: str() }),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const drafts = requireDrafts(context);
      const dropped = await drafts.drop(ctx, args.id, "dropped");
      // A draft is gone from the store the moment it is disposed of, so the audit
      // trail is the only place its fate survives.
      if (dropped) {
        context.audit.append({
          type: "report_draft_disposed",
          draftId: args.id,
          outcome: "dropped",
          conversationId: api.conversationId,
        });
      }
      return {
        output: [
          {
            type: "text" as const,
            text: dropped ? `dropped draft ${args.id}` : `no draft ${args.id}`,
          },
        ],
        ...(dropped ? {} : { isError: true }),
      };
    },
  });

  const publishDraft = defineTool({
    name: "reports_publish_draft",
    description:
      "Publish a draft report as a report owned by a job, or, with `reportId`, as the next revision of that existing report. The draft's text is read from its file, so the document never passes through the chat. The file must still hold the text the draft was written with: a draft file changed after it was written is refused, and the fix is a new draft. A revision goes only into a live report of the draft's own job. Refuses a name that a live report already holds. Every refusal leaves the draft in place.",
    parameters: obj(
      {
        id: str({ description: "The draft id." }),
        jobId: str({ description: "The job the published report belongs to." }),
        reportId: opt(
          str({
            description:
              "An existing live report of the same job. When given, the draft becomes that report's next revision instead of a new report, and `title` and `name` are refused because a revision keeps the report's own.",
          }),
        ),
        title: opt(str({ description: "Overrides the draft's title. Not with `reportId`." })),
        name: opt(str({ description: "URL slug. Defaults to one derived from the title. Not with `reportId`." })),
        note: opt(str({ description: "What this revision is, in a few words." })),
        kind: opt(
          union([lit("plan"), lit("result"), lit("briefing")], {
            description:
              "The kind of the published report: `plan` or `result`. Defaults to the kind the draft names. Not with `reportId`, because a revision keeps the kind of its report. A `briefing` is refused: the root writes a briefing report itself with `reports_create`.",
          }),
        ),
      },
    ),
    replay: "unsafe",
    execute: async (args, api, ctx) => {
      const reports = requireReports(context);
      const drafts = requireDrafts(context);
      // A briefing is written by the root and published in one call, so no draft
      // publishes as one. Refused before the draft is read, so nothing is dropped.
      if (args.kind === "briefing") {
        return {
          output: [
            {
              type: "text" as const,
              text: "A briefing report is written by the root with `reports_create` and `kind: \"briefing\"`, so it is not published from a draft. Nothing was published, and the draft is still there.",
            },
          ],
          isError: true,
        };
      }

      /**
       * The draft as the next revision of a report that already exists.
       *
       * `ReportStore.addVersion` writes it, so the inbox notice is the one
       * `reports_add_version` leaves, from the same commit. The draft goes the way
       * a published one goes: dropped as accepted, and audited with the report.
       */
      const publishAsRevision = async (
        reportId: string,
        draft: NonNullable<Awaited<ReturnType<typeof drafts.get>>>,
        content: string,
      ) => {
        const refuse = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });
        if (args.title !== undefined || args.name !== undefined) {
          return refuse(
            "`title` and `name` name a new report, and a revision keeps the title and name of its report. Call again without them.",
          );
        }
        // A revision keeps the kind of its report, so the arg has no meaning here
        // and is refused rather than silently ignored.
        if (args.kind !== undefined) {
          return refuse(
            "`kind` names the kind of a new report, and a revision keeps the kind of its report. Call again without it.",
          );
        }
        if (content.trim() === "") return refuse("a report body must not be empty");
        // The draft's own job decides where it goes, as it does for a new report.
        // A row written before the job field existed has none, and the job given
        // in the call stands in for it.
        const owner = draft.jobId ?? args.jobId;
        if (owner !== args.jobId) {
          return refuse(
            `draft ${draft.id} belongs to job ${owner}, so it must be published into that job. Call again with jobId ${owner}.`,
          );
        }
        const report = await reports.get(ctx, reportId);
        if (report === undefined) {
          return refuse(
            `no live report with id ${reportId}. A revision goes only into a live report, and a report that has moved to the archive takes none.`,
          );
        }
        if (report.jobId !== owner) {
          return refuse(
            `report ${report.id} belongs to job ${report.jobId}, and draft ${draft.id} belongs to job ${owner}. A draft becomes a revision only of a report of its own job.`,
          );
        }
        const note = publishedNote(args.note, draft);
        const record = await reports.addVersion(ctx, report.id, {
          content,
          ...(note === undefined ? {} : { note }),
        });
        // The same event `reports_add_version` emits; the notice came with the commit.
        context.events.emit("report_updated", record as unknown as Record<string, unknown>);
        await drafts.drop(ctx, draft.id, "accepted");
        context.audit.append({
          type: "report_draft_disposed",
          draftId: draft.id,
          outcome: "accepted",
          reportId: record.id,
          conversationId: api.conversationId,
        });
        const version = record.versions[record.versions.length - 1]!;
        return {
          output: [
            {
              type: "text" as const,
              text: `updated ${formatReport(record, zone())}\nrevision v${version.n} of report ${record.id}, sha256 ${version.sha256}\nThe inbox notice carries this to the user; do not post the reference in the chat.`,
            },
          ],
        };
      };

      const draft = await drafts.get(ctx, args.id);
      if (draft === undefined) {
        return { output: [{ type: "text" as const, text: `No draft with id ${args.id}` }], isError: true };
      }
      const content = await drafts.read(draft).catch(() => undefined);
      if (content === undefined) {
        return {
          output: [
            {
              type: "text" as const,
              text: `draft ${draft.id} exists (status ${draft.status}) but its body file is gone`,
            },
          ],
          isError: true,
        };
      }
      // The text published is the text read here, and it must be the text the draft
      // was written with: a file edited after the fact would publish something the
      // root never reviewed. A row written before the digest existed has nothing to
      // compare with, and keeps publishing as it did.
      if (draft.sha256 !== undefined && draftDigest(content) !== draft.sha256) {
        return {
          output: [
            {
              type: "text" as const,
              text: `draft ${draft.id}: the draft file changed after it was written, so its text is not the text the draft recorded; write a new draft.`,
            },
          ],
          isError: true,
        };
      }
      if (args.reportId !== undefined) {
        return await publishAsRevision(args.reportId, draft, content);
      }
      const title = args.title ?? draft.title;
      // Draft creation validates nothing, so the checks `ReportStore.create` makes
      // are made here, before anything is written.
      if (title.trim() === "") {
        return {
          output: [{ type: "text" as const, text: "a report title must not be empty" }],
          isError: true,
        };
      }
      if (content.trim() === "") {
        return {
          output: [{ type: "text" as const, text: "a report body must not be empty" }],
          isError: true,
        };
      }
      // A draft belongs to the job that produced it, so a report made from one
      // goes into that job and no other. A row written before the job field
      // existed has no job, and keeps the older freedom.
      if (draft.jobId !== undefined && draft.jobId !== args.jobId) {
        return {
          output: [
            {
              type: "text" as const,
              text: `draft ${draft.id} belongs to job ${draft.jobId}, so it must be published into that job. Call again with jobId ${draft.jobId}.`,
            },
          ],
          isError: true,
        };
      }
      const job = await context.jobs?.get(ctx, args.jobId);
      if (context.jobs !== undefined && job === undefined) {
        return {
          output: [{ type: "text" as const, text: `Job not found: ${args.jobId}. A report must belong to a job.` }],
          isError: true,
        };
      }
      // `reports_create` renames its way out of a collision, silently. This tool
      // refuses instead: its caller holds only a draft id, so a name it did not ask
      // for is a surprise it can still avoid by passing another one, and refusing
      // costs the draft nothing. Only live reports are consulted, which is the same
      // uniqueness rule `ReportStore` keeps. The candidate comes from the same
      // helper the store names reports with, so the two cannot disagree about what
      // a free name looks like.
      const candidate = reportName(args.name ?? title);
      const holder = (await reports.list(ctx)).find((item) => item.name === candidate);
      if (holder !== undefined) {
        return {
          output: [
            {
              type: "text" as const,
              text: `report ${holder.id} "${holder.title}" already holds the name ${candidate}. Pass a different name, or change the draft's title.`,
            },
          ],
          isError: true,
        };
      }
      const note = publishedNote(args.note, draft);
      // The root decides the kind: it can correct what the draft named, and a
      // draft that named none publishes as a plan.
      const kind = args.kind ?? reportKind(draft);
      const record = await reports.create(ctx, {
        jobId: args.jobId,
        title,
        content,
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(note === undefined ? {} : { note }),
        ...(kind === "result" ? { kind: "result" as const } : {}),
      });
      context.audit.append({ type: "report_created", reportId: record.id, jobId: record.jobId });
      // The inbox notice is written by the report's own commit (see ReportStore's
      // `onChange`); this event is what tells an open UI to read the inbox again.
      context.events.emit("report_created", record as unknown as Record<string, unknown>);
      // This is a second commit, so a crash in between leaves the draft behind as
      // `pending`. That cannot publish the same document twice: the report above
      // now holds the name, so a second call stops at the collision check.
      await drafts.drop(ctx, args.id, "accepted");
      context.audit.append({
        type: "report_draft_disposed",
        draftId: args.id,
        outcome: "accepted",
        reportId: record.id,
        conversationId: api.conversationId,
      });
      return {
        output: [
          {
            type: "text" as const,
            text: `published ${formatReport(record, zone())}\nThe inbox notice carries this to the user; do not post the reference in the chat.`,
          },
        ],
      };
    },
  });

  const guide = {
    key: "reports",
    render: () => `A long document belongs in a report, not in the chat. The root writes it with \`reports_create\` against an existing job. A subagent cannot publish: it writes a draft with \`reports_draft\`, naming the job the draft belongs to with the required \`jobId\`, and sends its parent the draft id, then the root reads that draft with \`reports_get\` and publishes it with \`reports_publish_draft\`. Either way, the write leaves one notice in the user's inbox, and the user opens the document from there. Do not post the reference in the chat.
A report has a kind. A plan, the default, shows the Approve button. A result report, written with \`kind: "result"\`, shows Done and Feedback and is listed under Results. Done records the same approval that Approve records, and Done with text also asks for follow-up work. A briefing report, written by the root with \`kind: "briefing"\` in \`reports_create\`, carries the morning briefing on the job of the routine that sent it. It shows only Feedback, it is listed at the top under Briefing, and it can never be approved. A new briefing report moves every earlier briefing report with its inbox notices, and every inbox notice of kind \`briefing\`, to the archive.
A draft is registered to a job, not to the session that wrote it. It is open work of that job until it is published or dropped, and \`jobs_get\` and \`reports_list\` with \`jobId\` show it. Deleting the author leaves it in place, it is dropped when its job ends (done, failed or cancelled), and it publishes into its own job and no other.
Revisions accumulate: \`reports_add_version\` appends, it never overwrites, so two revisions can be compared in the viewer. Archiving a report is not a thing you do — a report goes to the archive when its job does, and a briefing report also goes when a newer briefing replaces it.
Publishing a report and appending a revision each leave one notice in the user's inbox. Do not announce either of those, and do not announce a note the user writes in the viewer: that note arrives in the conversation as a review.
\`reports_set_pending\` moves a live report between its open standing, \`active\` for a plan and \`result\` for a result report, and \`pending\`. Set one aside when the user does not have to answer about it yet: it is listed under Pending instead, it keeps its revisions and its buttons, and moving the flag on its own writes no notice. A result report that still waits for the user's Done or Feedback cannot be set aside, because the user has to look at it. A report whose job has finished is finished whatever the flag says, because the job alone decides that. Bring a report back with \`answer\` when the answer to user feedback is a message rather than a revision: that call clears the flag and writes the inbox notice for that answer in the same commit, so an answer is never silent. A report that is waiting on an answer is refused without one, and that is what \`unanswered\` in \`reports_list\` marks. A briefing report cannot be set aside: it stays at the top while its job lives, and a call with \`pending\` true for it is refused. Feedback on it is answered with \`answer\` like any feedback.`,
  };

  /**
   * Check a draft with the judge named `report-check`, and the mechanical items with a program.
   *
   * The shape of the answer is fixed: one header line with the counts, one `REVIEW` line per item
   * under the threshold, one `CHECK` line per program finding, one `TABLE` line per
   * table without a delimiter row, then the items that need no review, the program
   * checks that found nothing, the items that nothing checks, the sentence that
   * says what the threshold means, and the two sentences that say a mark is not a
   * failure and that this is a quick self-test. It never answers `pass` or `fail`:
   * the orchestrator judges a marked item, and the root makes the final judgement.
   *
   * An item the judge refused to answer is an item to review whose line carries
   * "refused to answer" in place of a probability. The refusal is the answer to
   * that one question, so the other items in the same reply keep theirs.
   *
   * A judge that does not answer is not an error of the tool. The answer names the
   * outcome and its reason, and the program checks still run, because the
   * orchestrator goes on without the judge and gives the reason in its note (see
   * `prompts/role/orchestrator.md`).
   *
   * The text under check is never written to the audit trail or the log: the judge
   * writes the same one line it writes for any call, and this tool writes none.
   */
  const reportCheck = defineTool({
    name: "report_check",
    description:
      "Check a draft before you send it: one request asks the judge named `report-check` seven of the 13 items of the report rules, each as an item of its own, and a program checks items 10 to 14 and every table. Item 14 is not one of the 13 report rules: it names a Korean syllable outside the 2350 of KS X 1001, which a broken character leaves behind. The answer marks for review each item whose probability of yes is below the review threshold, with its number, its question and the probability, marks each item that the judge refused to answer, with its number, its question and the words \"refused to answer\", names each program finding with its item and its line, names each table whose second line is not a delimiter row, with its line, and names the items that nothing checks. A probability at or above the threshold means that the item is clear. A mark for review means that you look at the item once, and it does not mean that the item is bad: you judge it, and the root makes the final judgement. This is a quick self-test, and it does not replace your own check or the root's. An item that nothing checks has those two checks only. Only an orchestrator has this tool.",
    parameters: obj(
      {
        draftId: opt(str({ description: "A draft id: the text is read from the draft store." })),
        path: opt(
          str({ description: "A markdown file to check, for the text you are still writing." }),
        ),
      },
    ),
    replay: "safe",
    // The same reason as `reports_draft`: a check reads the file when the call
    // runs, so a bundle that holds one runs its calls in the order they are
    // written.
    executionMode: "sequential",
    execute: async (args, _api, ctx) => {
      const draftId = args.draftId?.trim();
      const path = args.path?.trim();
      const refuse = (text: string) => ({ output: [{ type: "text" as const, text }], isError: true });
      if ((draftId === undefined || draftId === "") === (path === undefined || path === "")) {
        return refuse(
          "report_check takes exactly one of `draftId` and `path`: a draft id for the draft you are about to send, or the file that holds the text you are still writing.",
        );
      }
      let text: string;
      if (draftId !== undefined && draftId !== "") {
        const found = await requireDrafts(context).readById(ctx, draftId);
        if (found === undefined) {
          return refuse(`No draft with id ${draftId}, or its body file is gone. Nothing was checked.`);
        }
        text = found.content;
      } else {
        const read = await readFile(path!, "utf8").catch(() => undefined);
        if (read === undefined) return refuse(`Cannot read ${path}: no such file, or it is not readable. Nothing was checked.`);
        text = read;
      }
      // Read on every call, so a reloaded config reaches the next check.
      const threshold = context.getConfig().judges[REPORT_CHECK_JUDGE]?.reviewBelow ?? DEFAULT_REVIEW_BELOW;
      const tables = scanTables(text);
      const tableSummary = `Tables: ${tables.found} found, ${tables.withoutDelimiter.length} without a delimiter row.`;
      const tableLines = tables.withoutDelimiter.map(
        (line) => `TABLE at line ${line}: the second line is not a delimiter row.`,
      );
      const selfTest =
        "This is a quick self-test. It does not replace your own check or the root's check.";
      const findingWord = (count: number): string => (count === 1 ? "finding" : "findings");
      // The program checks read the text on their own, so they run whatever the
      // judge does. A finding is a place to look at once, not a failure.
      const findings = programFindings(text);
      const checkLines = findings.map((entry) => `CHECK ${entry.item} at line ${entry.line}: ${entry.what}`);
      const checkedClearItems = PROGRAM_CHECK_ITEMS.filter((item) => !findings.some((entry) => entry.item === item));
      const programSummary = `${PROGRAM_CHECK_ITEMS.length} program checks, ${findings.length} ${findingWord(findings.length)}.`;
      const uncheckedLine = `not checked, your own check and the root's check only: ${REPORT_CHECK_UNCHECKED_ITEMS.join(", ")}`;
      const clearProgramLine =
        checkedClearItems.length === 0 ? [] : [`program checks with no finding: ${checkedClearItems.join(", ")}`];
      // What the threshold means, in fixed words: a mark is a look,
      // not a verdict, and the last word belongs to the orchestrator.
      const thresholdMeaning =
        `Yes at ${String(threshold)} or more means that the item is clear. An item to review is one to look at once, and it does not mean that the item is bad.`;
      const judgeVerdict =
        "An item to review is not a failure. You judge it, and the root makes the final judgement.";
      const questions: Record<string, ClassifierQuestion> = {};
      for (const question of REPORT_CHECK_QUESTIONS) {
        questions[`q${question.n}`] = {
          type: "bool",
          instructions: question.text,
          criteria: { true: "Yes", false: "No" },
        };
      }
      const result = await context.judges.judge(REPORT_CHECK_JUDGE, { state: { text }, questions });
      const programDetails = {
        checks: [...PROGRAM_CHECK_ITEMS],
        findings: findings.map((entry) => ({ item: entry.item, line: entry.line, what: entry.what })),
        unchecked: [...REPORT_CHECK_UNCHECKED_ITEMS],
      };
      if (result.outcome !== "answered") {
        const why = result.reason;
        const failure = result.outcome === "failed" ? result : undefined;
        const facts = [
          ...(failure?.status === undefined ? [] : [`status ${String(failure.status)}`]),
          ...(failure?.errorType === undefined ? [] : [`type ${failure.errorType}`]),
          ...(failure?.errorCode === undefined ? [] : [`code ${failure.errorCode}`]),
          ...(failure?.retryAfterMs === undefined ? [] : [retryAfterText(failure.retryAfterMs)]),
        ];
        const reasonText = facts.length === 0 ? why : `${why}; ${facts.join(", ")}`;
        const earlyLine =
          failure?.reason === "rate_limited" && failure.retryAfterMs !== undefined
            ? ["A check before the retry time gets the same answer."]
            : [];
        return {
          output: [
            {
              type: "text" as const,
              text: [
                `report_check: the judge did not answer (${result.outcome}: ${reasonText}). ${programSummary} ${tableSummary}`,
                ...checkLines,
                ...tableLines,
                ...clearProgramLine,
                uncheckedLine,
                `None of the ${REPORT_CHECK_QUESTIONS.length} questions was checked. Send the draft, and give this reason in your note.`,
                ...earlyLine,
                selfTest,
              ].join("\n"),
            },
          ],
          details: {
            judge: REPORT_CHECK_JUDGE,
            outcome: result.outcome,
            reason: why,
            status: failure?.status ?? null,
            retryAfterMs: failure?.retryAfterMs ?? null,
            errorType: failure?.errorType ?? null,
            errorCode: failure?.errorCode ?? null,
            reviewBelow: threshold,
            review: [],
            refused: [],
            questions: {},
            program: programDetails,
            tables: { found: tables.found, withoutDelimiter: tables.withoutDelimiter },
          },
        };
      }
      // A refused item is an item to review, and its line says why: the judge gave
      // no probability, and the orchestrator decides what the refusal means for it.
      const refusedKeys = new Set(result.refused);
      const review: { n: number; question: string; probability: number | null }[] = [];
      const fine: { n: number; probability: number }[] = [];
      const refusedItems: number[] = [];
      const details: Record<string, { probability: number | null; review: boolean }> = {};
      for (const question of REPORT_CHECK_QUESTIONS) {
        const key = `q${question.n}`;
        if (refusedKeys.has(key)) {
          details[key] = { probability: null, review: true };
          review.push({ n: question.n, question: question.text, probability: null });
          refusedItems.push(question.n);
          continue;
        }
        const answer = result.answers[key];
        // An answer the judge left out counts as no evidence of yes, so the item is
        // marked for review rather than passed.
        const probability = answer !== undefined && answer.type === "bool" ? answer.probability : 0;
        details[key] = { probability, review: probability < threshold };
        if (probability < threshold) review.push({ n: question.n, question: question.text, probability });
        else fine.push({ n: question.n, probability });
      }
      const lines = [
        `report_check: ${REPORT_CHECK_QUESTIONS.length} questions, ${review.length} to review (yes below ${String(threshold)}). ${programSummary} ${tableSummary}`,
        ...review.map(
          (item) =>
            `REVIEW ${item.n}. ${item.question} ${item.probability === null ? "(refused to answer)" : `(yes ${item.probability.toFixed(2)})`}`,
        ),
        ...checkLines,
        ...tableLines,
        ...(fine.length === 0
          ? []
          : [`no review needed: ${fine.map((item) => `${item.n} (${item.probability.toFixed(2)})`).join(", ")}`]),
        ...clearProgramLine,
        uncheckedLine,
        thresholdMeaning,
        judgeVerdict,
        selfTest,
      ];
      return {
        output: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          judge: REPORT_CHECK_JUDGE,
          outcome: result.outcome,
          reason: null,
          status: null,
          retryAfterMs: null,
          errorType: null,
          errorCode: null,
          reviewBelow: threshold,
          review: review.map((item) => item.n),
          refused: refusedItems,
          questions: details,
          program: programDetails,
          tables: { found: tables.found, withoutDelimiter: tables.withoutDelimiter },
        },
      };
    },
  });

  /**
   * The two report tools that belong to one role each.
   *
   * The stored tool filter is written when a conversation is created, so a tool
   * added later is offered to conversations that already exist. The gate is this
   * hook, which reads the agent record of the calling conversation on every call:
   * the roles a spawn wrote, the same way `agentScopeOf` reads them.
   *
   *   `report_check`   An orchestrator writes the report, so it checks the report.
   *                    A planner, a worker, a root and a focused chat get no
   *                    `report_check`, and a conversation with no record has no
   *                    role at all. The prompt of a planner says the tool is
   *                    refused, so the refusal here is the gate behind that.
   *
   *   `reports_draft`  Not for a planner. It writes the working document as a file
   *                    in the job directory, and the orchestrator writes the draft
   *                    from it, so a draft written by a planner is a draft written
   *                    by the wrong role and one the orchestrator would have to
   *                    rewrite.
   */
  const roleGates = hook(ToolTask, {
    beforeTool: async (call: ToolCall, api: HookApi, ctx) => {
      if (call.name !== "report_check" && call.name !== "reports_draft") return undefined;
      const record = await context.subagents?.recordOf(api.conversationId, ctx);
      const roles = record?.roles ?? [];
      if (call.name === "report_check") {
        if (roles.includes("orchestrator")) return undefined;
        return { block: "`report_check` is available to an orchestrator only." };
      }
      if (roles.includes(PLANNER_ROLE)) {
        return {
          block:
            "`reports_draft` is not available to a planner. Write the working document as a file, and your orchestrator writes the draft from it.",
        };
      }
      return undefined;
    },
  });

  return defineExtension({
    name: "reports",
    tools: [create, addVersion, setPending, move, list, get, draft, dropDraft, publishDraft, reportCheck],
    sections: [guide],
    hooks: [roleGates],
  });
}
