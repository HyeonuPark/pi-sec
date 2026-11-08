/**
 * The two subscription cards, drawn with pi-sec's own numbers under their own.
 *
 * The usage page draws the fields the answer holds and names no provider, so this
 * file states answers, not providers: a subscription card that carries the three
 * windows and the daily field draws those four rows after its own three, and one
 * that carries only the daily field draws one. A field the answer does not hold is
 * a row the card does not have, which is what keeps a provider that states none
 * exactly as it was.
 *
 * The page also pins the two failure lines apart: a ledger that cannot be read is
 * `Not available (ledger unreadable)` on those rows alone, and a provider that did
 * not answer is its own reason on its own rows alone.
 */
import { describe, expect, it } from "vitest";
import { loadUiPage, type UiPageHandle } from "./harness.ts";

/** The thirty slots a daily field holds, oldest first. */
function slots(each: (index: number) => { calls: number; cost: number }) {
  return Array.from({ length: 30 }, (_unused, index) => ({
    from: { at: index * 86_400, label: `2026-09-${String(index + 1).padStart(2, "0")} 00:00` },
    to: { at: (index + 1) * 86_400, label: `2026-09-${String(index + 1).padStart(2, "0")} 23:59` },
    ...each(index),
  }));
}

/** One subscription card holding these fields, and this note. */
function answer(fields: Record<string, unknown>, note?: string) {
  return {
    generatedAt: 1,
    timezone: "Asia/Tokyo",
    cards: [
      {
        provider: "card",
        name: "Card",
        shape: "subscription",
        receivedAt: { at: 1, label: "2026-10-25 07:30" },
        ...(note === undefined ? {} : { note }),
        fields,
      },
    ],
  };
}

/** The fields the provider itself states, which every card here starts with. */
const OWN_FIELDS = {
  fiveHour: { state: "value", value: { utilization: 28, resetsAt: { at: 2, label: "2026-10-26 20:59" } } },
  weekly: { state: "value", value: { utilization: 72, resetsAt: null } },
  credits: { state: "wip" },
};

/** pi-sec's four fields, all with a value. */
const LEDGER_FIELDS = {
  day: { state: "value", value: { calls: 863, tokens: 83_403_123, cost: 0.8426 } },
  week: { state: "value", value: { calls: 900, tokens: 90_000_000, cost: 0.9 } },
  month: { state: "value", value: { calls: 1_000, tokens: 100_000_000, cost: 1.1 } },
  daily: { state: "value", value: { slots: slots((index) => ({ calls: index + 1, cost: index === 5 ? 2 : 0 })) } },
};

async function open(body: unknown): Promise<UiPageHandle> {
  return await loadUiPage("usage", { fetch: { "/api/usage": { body } } });
}

/** The names of one card's rows, in the order the page drew them. */
function fieldNames(page: UiPageHandle): (string | null | undefined)[] {
  return [...page.document.querySelectorAll(".usage-field")].map(
    (field) => field.querySelector(".usage-field-name")?.textContent,
  );
}

describe("a subscription card with pi-sec's own fields", () => {
  it("draws the three windows and the daily columns after its own fields", async () => {
    const page = await open(answer({ ...OWN_FIELDS, ...LEDGER_FIELDS }, "pi-sec calls only · estimated credit use at subscription rates"));
    try {
      expect(fieldNames(page)).toEqual([
        "5-hour limit",
        "Weekly limit",
        "Credits",
        "Last 24 hours",
        "Last 7 days",
        "Last 30 days",
        "Usage per day",
      ]);
      const text = page.document.body.textContent ?? "";
      expect(text).toContain("863 calls · 83,403,123 tokens · $0.8426");
      // The note line says what the amount is, and it is the card's own line.
      expect(page.document.querySelector(".usage-note")?.textContent).toBe(
        "pi-sec calls only · estimated credit use at subscription rates",
      );
      // The thirty columns are drawn, with a height from the largest cost.
      const columns = [...page.document.querySelectorAll<HTMLElement>(".usage-day")];
      expect(columns).toHaveLength(30);
      expect(columns[5]?.style.height).toBe("100%");
      expect(columns[6]?.style.height).toBe("0%");
    } finally {
      page.close();
    }
  });

  it("draws the daily row alone when the answer carries no window", async () => {
    const page = await open(answer({ ...OWN_FIELDS, daily: LEDGER_FIELDS.daily }, "pi-sec calls only · API-equivalent cost"));
    try {
      expect(fieldNames(page)).toEqual(["5-hour limit", "Weekly limit", "Credits", "Usage per day"]);
      expect(page.document.body.textContent).not.toContain("Last 24 hours");
      expect(page.document.querySelectorAll(".usage-day")).toHaveLength(30);
      expect(page.document.querySelector(".usage-note")?.textContent).toBe("pi-sec calls only · API-equivalent cost");
    } finally {
      page.close();
    }
  });

  it("keeps the card it had when the answer carries none of them", async () => {
    const page = await open(answer(OWN_FIELDS));
    try {
      expect(fieldNames(page)).toEqual(["5-hour limit", "Weekly limit", "Credits"]);
      expect(page.document.querySelector(".usage-note")).toBeNull();
    } finally {
      page.close();
    }
  });

  it("says the ledger is unreadable on those rows only, and keeps the provider's own", async () => {
    const unreadable = { state: "error", reason: "ledger unreadable" };
    const page = await open(
      answer({ ...OWN_FIELDS, day: unreadable, week: unreadable, month: unreadable, daily: unreadable }, "pi-sec calls only · estimated credit use at subscription rates"),
    );
    try {
      expect(fieldNames(page)).toEqual([
        "5-hour limit",
        "Weekly limit",
        "Credits",
        "Last 24 hours",
        "Last 7 days",
        "Last 30 days",
        "Usage per day",
      ]);
      const errors = [...page.document.querySelectorAll(".usage-line.usage-error")].map((line) => line.textContent);
      expect(errors).toEqual([
        "Not available (ledger unreadable)",
        "Not available (ledger unreadable)",
        "Not available (ledger unreadable)",
        "Not available (ledger unreadable)",
      ]);
      // The provider's own numbers are still drawn, with their bars.
      const text = page.document.body.textContent ?? "";
      expect(text).toContain("28%");
      expect(text).toContain("72%");
      expect(page.document.querySelectorAll(".usage-bar")).toHaveLength(2);
      // A failed daily field draws no columns.
      expect(page.document.querySelectorAll(".usage-day")).toHaveLength(0);
    } finally {
      page.close();
    }
  });

  it("says the provider failed on its own rows only, and keeps pi-sec's own", async () => {
    const failed = { state: "error", reason: "HTTP 503" };
    const page = await open(
      answer({ fiveHour: failed, weekly: failed, credits: failed, ...LEDGER_FIELDS }, "pi-sec calls only · estimated credit use at subscription rates"),
    );
    try {
      const errors = [...page.document.querySelectorAll(".usage-line.usage-error")].map((line) => line.textContent);
      expect(errors).toEqual([
        "Not available (HTTP 503)",
        "Not available (HTTP 503)",
        "Not available (HTTP 503)",
      ]);
      expect(page.document.body.textContent).toContain("863 calls · 83,403,123 tokens · $0.8426");
      expect(page.document.querySelectorAll(".usage-day")).toHaveLength(30);
    } finally {
      page.close();
    }
  });
});
