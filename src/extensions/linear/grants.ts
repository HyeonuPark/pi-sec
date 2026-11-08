/**
 * Grant lines: how an approved report names the Linear writes it allows.
 *
 * A grant line is a line that starts with `linear-write:` once list marks,
 * spaces and backticks are taken off its front. The rest of the line lists
 * targets separated by commas. A target is an issue identifier such as ENG-123,
 * or `team:` and a team key such as `team:ENG`. A target counts only as a whole
 * entry, so ENG-12 does not grant ENG-123, and an identifier that stands in
 * prose grants nothing. An entry that is neither form, such as a placeholder
 * `team:<KEY>` or a lower-case `eng-123`, is ignored.
 */

const ISSUE_TARGET = /^[A-Z][A-Z0-9_]*-[0-9]+$/;
const TEAM_TARGET = /^team:[A-Z][A-Z0-9_]*$/;

/** Marks that may stand before a grant line: list bullets, numbers, quotes, spaces and backticks. */
const LINE_PREFIX = /^(?:[\s>*+\u2022-]|\d+[.)]|`)*/;

/** The valid targets of every grant line in `text`. An empty set means the text grants nothing. */
export function parseGrants(text: string): Set<string> {
  const granted = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const body = line.replace(LINE_PREFIX, "");
    if (!body.startsWith("linear-write:")) continue;
    for (const entry of body.slice("linear-write:".length).split(",")) {
      const target = entry.trim().replace(/^`+|`+$/g, "").trim();
      if (ISSUE_TARGET.test(target) || TEAM_TARGET.test(target)) granted.add(target);
    }
  }
  return granted;
}

/** True when a grant set holds the issue identifier or the issue's team. */
export function grantsIssue(granted: ReadonlySet<string>, identifier: string, teamKey: string): boolean {
  return granted.has(identifier) || granted.has(`team:${teamKey}`);
}

/** True when a grant set holds the team. */
export function grantsTeam(granted: ReadonlySet<string>, teamKey: string): boolean {
  return granted.has(`team:${teamKey}`);
}
