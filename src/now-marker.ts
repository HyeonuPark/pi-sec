/**
 * The `[[pi-sec:now]]` marker: the current time, written when a file is saved.
 *
 * An agent that writes a time into a note has to read the clock first, and a
 * clock read a turn earlier, or copied from the wrong line, is a wrong time in a
 * document nobody rechecks. So a note may carry the marker instead, and the
 * harness puts the current time there when the tool saves the file. The time is
 * `zoneMinute` of the instant of the save, in the zone `config.json` names:
 * `2030-01-15 16:30 +00:00`.
 *
 * Three conditions all have to hold, and this module is the one place that
 * decides them:
 *
 *   1. the tool is `write` or `edit`, whether the agent called it or a `js`
 *      script did;
 *   2. the path ends with `.md`;
 *   3. the resolved path is outside the workspace tree and the snapshot tree.
 *      A relative path resolves against the agent's working directory, which is
 *      the workspace tree, so a file written by a relative path is left alone.
 *
 * `write` replaces in the whole `content`. `edit` replaces only in
 * `edits[].newText`: `oldText` is matched against the file's current text, so a
 * replacement inside it would change what the call has to find.
 *
 * A backslash right before the marker keeps the marker as text. Markdown renders
 * `\[[pi-sec:now]]` as `[[pi-sec:now]]`, so a note that explains the marker
 * writes the backslash and the file keeps it.
 */

import { resolve, isAbsolute, relative as relativePath } from "node:path";
import { zoneMinute } from "./time-format.ts";

/** The literal an agent writes, and the shape of the line that reports it. */
export const NOW_MARKER = "[[pi-sec:now]]";

/**
 * The marker where no backslash stands right before it.
 *
 * The lookbehind is the whole escape rule: one backslash is enough, and the
 * backslash stays in the text as the file was given it.
 */
const MARKER = /(?<!\\)\[\[pi-sec:now\]\]/g;

/** What the rule needs to know about one save. */
export interface NowMarkerScope {
  /** The directory a relative path resolves against: the workspace tree. */
  readonly workingDirectory: string;
  /** The code tree an agent edits. A file inside it is left alone. */
  readonly workspaceTree: string;
  /** The tree the daemon runs. A file inside it is left alone. */
  readonly snapshotTree: string;
  /** The zone `config.json` names, which is the zone a printed time is in. */
  readonly timeZone: string;
}

/** One call after the rule ran: the arguments to save, the count, the time. */
export interface NowMarkerOutcome {
  readonly arguments: Record<string, unknown>;
  readonly count: number;
  readonly time: string;
}

/**
 * The one line a result carries when the rule replaced something.
 *
 * `Replaced [[pi-sec:now]] 1 time with 2030-01-15 16:30 +00:00.` The count says
 * how many the call put there, so an agent can tell a marker that went in from
 * one that did not.
 */
export function nowMarkerNote(count: number, time: string): string {
  return `Replaced ${NOW_MARKER} ${count} ${count === 1 ? "time" : "times"} with ${time}.`;
}

/** Replace every unescaped marker in one text, and count what was replaced. */
export function replaceNowMarkers(text: string, time: string): { text: string; count: number } {
  let count = 0;
  const replaced = text.replace(MARKER, () => {
    count += 1;
    return time;
  });
  return { text: replaced, count };
}

/** Whether `target` is `tree` or a path under it. Both are already absolute. */
function inside(tree: string, target: string): boolean {
  const treePath = resolve(tree);
  const step = relativePath(treePath, target);
  return step === "" || (!step.startsWith("..") && !isAbsolute(step));
}

/** The tool names the rule applies to. */
const FILE_TOOLS: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * Apply the rule to one call's arguments, or answer nothing when it does not apply.
 *
 * `undefined` means "leave the call as it is": another tool, another path, a
 * file inside a code tree, or a marker that was not there. The caller saves the
 * answered arguments and reports the count, which is why the time is returned
 * with them: the line the agent reads must name the instant the file got.
 */
export function applyNowMarker(
  toolName: string,
  args: Record<string, unknown>,
  scope: NowMarkerScope,
  now: number = Date.now(),
): NowMarkerOutcome | undefined {
  if (!FILE_TOOLS.has(toolName)) return undefined;
  const path = args.path;
  if (typeof path !== "string" || !path.endsWith(".md")) return undefined;
  // The tool resolves a relative path against the environment's working
  // directory, which is the same directory this resolves against, and `resolve`
  // collapses `..` before the check, so a path cannot climb out of a tree into
  // one it is then compared against.
  const absolute = resolve(scope.workingDirectory, path);
  if (inside(scope.workspaceTree, absolute) || inside(scope.snapshotTree, absolute)) return undefined;

  const time = zoneMinute(now, scope.timeZone);
  let count = 0;
  const replaced = { ...args };
  const take = (text: string): string => {
    const one = replaceNowMarkers(text, time);
    count += one.count;
    return one.text;
  };

  if (toolName === "write") {
    if (typeof args.content === "string") replaced.content = take(args.content);
  } else if (Array.isArray(args.edits)) {
    // Only `newText`. A replacement inside `oldText` would change the text the
    // tool has to find in the file, and the edit would then fail.
    replaced.edits = args.edits.map((edit) => {
      if (edit === null || typeof edit !== "object") return edit;
      const pair = edit as Record<string, unknown>;
      if (typeof pair.newText !== "string") return edit;
      return { ...pair, newText: take(pair.newText) };
    });
  }

  if (count === 0) return undefined;
  return { arguments: replaced, count, time };
}
