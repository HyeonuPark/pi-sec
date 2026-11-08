import { describe, expect, it } from "vitest";
import { grantsIssue, grantsTeam, parseGrants } from "../../src/extensions/linear/grants.ts";

describe("grant lines", () => {
  it("grants ENG-123 and not ENG-12", () => {
    const grants = parseGrants("# Plan\n\nlinear-write: ENG-123\n");
    expect(grantsIssue(grants, "ENG-123", "OPS")).toBe(true);
    expect(grantsIssue(grants, "ENG-12", "OPS")).toBe(false);
    expect(grantsIssue(grants, "ENG-1234", "OPS")).toBe(false);
  });

  it("reads a list mark and backticks, and grants every issue of a team", () => {
    const grants = parseGrants("- `linear-write: team:ENG`\n");
    expect(grantsTeam(grants, "ENG")).toBe(true);
    expect(grantsIssue(grants, "ENG-9", "ENG")).toBe(true);
    expect(grantsIssue(grants, "OPS-9", "OPS")).toBe(false);
    expect(grantsTeam(parseGrants("1. linear-write: team:ENG"), "ENG")).toBe(true);
    expect(grantsTeam(parseGrants("   * `linear-write: team:ENG`"), "ENG")).toBe(true);
  });

  it("reads several targets on one line, separated by commas", () => {
    const grants = parseGrants("linear-write: team:ABC, ABC-7 ,`XY_Z-10`");
    expect([...grants].sort()).toEqual(["ABC-7", "XY_Z-10", "team:ABC"]);
  });

  it("grants nothing for an identifier in a sentence", () => {
    expect(parseGrants("The user asked us to comment on ENG-123 today.\nSee ENG-123.").size).toBe(0);
    expect(parseGrants("Write the line linear-write: ENG-123 into the report.").size).toBe(0);
  });

  it("grants nothing for a placeholder or a lower-case identifier", () => {
    expect(parseGrants("linear-write: team:<KEY>").size).toBe(0);
    expect(parseGrants("linear-write: eng-123").size).toBe(0);
    expect(parseGrants("linear-write: team:eng").size).toBe(0);
    expect(parseGrants("linear-write: ENG-123x").size).toBe(0);
    expect(parseGrants("Linear-Write: ENG-123").size).toBe(0);
  });
});
