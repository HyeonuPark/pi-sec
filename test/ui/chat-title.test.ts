import { describe, expect, it } from "vitest";
import { TITLE_MAX, checkTitle } from "../../src/ui/state/chat-title.ts";

describe("the title check both rename presses make", () => {
  it("refuses an empty title and one over the limit, and takes the rest trimmed", () => {
    expect(TITLE_MAX).toBe(80);
    const table: readonly (readonly [string, unknown])[] = [
      ["   ", { refusal: "A title cannot be empty." }],
      ["", { refusal: "A title cannot be empty." }],
      ["x".repeat(81), { refusal: "A title holds at most 80 characters." }],
      ["x".repeat(80), { title: "x".repeat(80) }],
      ["  a  ", { title: "a" }],
    ];
    expect(table.map(([answer]) => checkTitle(answer))).toEqual(table.map(([, expected]) => expected));
  });
});
