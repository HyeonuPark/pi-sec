/**
 * The two sentences the synthetic.new card added to the usage page.
 *
 * The card states a weekly quota that comes back a little at a time: `next +2% at
 * <time>`, or `next regeneration at <time>` when the share could not be read. It
 * states no credit amounts at all, so the credit line says `Amounts not provided`
 * once and still links the page where a balance would be bought.
 *
 * Both are decided by the field's value shape, not by the provider's name: the page
 * names no provider. A card from a reader that states no regeneration share keeps
 * the `resets <time>` sentence it always wrote, which is what the Anthropic card
 * test here holds.
 */
import { describe, expect, it } from "vitest";
import { loadUiPage, settle, type UiPageHandle } from "./harness.ts";

const SYNTHETIC_BILLING = { label: "synthetic.new billing page", url: "https://synthetic.new/billing" };

/** One subscription answer holding the one card this file draws. */
function answer(card: Record<string, unknown>) {
  return {
    generatedAt: 1,
    timezone: "Asia/Tokyo",
    cards: [{ provider: "card", name: "Card", shape: "subscription", receivedAt: { at: 1, label: "2026-10-25 07:30" }, ...card }],
  };
}

/** The sentence beside a card's first quota percentage. */
function noteOf(page: UiPageHandle, index = 0): string | null | undefined {
  const notes = [...page.document.querySelectorAll(".usage-quota .usage-small")];
  return notes[index]?.textContent;
}

/** Load the page with one card whose fields the test states. */
async function open(fields: Record<string, unknown>): Promise<UiPageHandle> {
  return await loadUiPage("usage", { fetch: { "/api/usage": { body: answer({ fields }) } } });
}

/** A credit line bought on the provider's own billing page. */
function credits(amounts: { used: unknown; limit: unknown; balance: unknown }) {
  return {
    state: "value",
    value: { enabled: null, ...amounts, disabledReason: null, billing: SYNTHETIC_BILLING },
  };
}

const RESET_AT = { at: 1_790_000_000_000, label: "2026-10-28 04:56" };

describe("a quota that comes back a little at a time", () => {
  it("writes the share that returns and the moment, instead of the plain reset time", async () => {
    const page = await open({
      weekly: { state: "value", value: { utilization: 0, resetsAt: RESET_AT, regenPercent: 2 } },
      credits: credits({ used: null, limit: null, balance: null }),
    });
    try {
      expect(noteOf(page)).toBe("next +2% at 2026-10-28 04:56");
      expect(page.document.body.textContent).not.toContain("resets 2026-10-28 04:56");
    } finally {
      page.close();
    }
  });

  it("writes the moment alone when the share is stated but could not be read", async () => {
    const page = await open({
      weekly: { state: "value", value: { utilization: 40, resetsAt: RESET_AT, regenPercent: null } },
      credits: { state: "wip" },
    });
    try {
      expect(noteOf(page)).toBe("next regeneration at 2026-10-28 04:56");
    } finally {
      page.close();
    }
  });

  it("writes the plain reset time when the value states no such share at all", async () => {
    const page = await open({
      fiveHour: { state: "value", value: { utilization: 28, resetsAt: RESET_AT } },
      weekly: { state: "value", value: { utilization: 72, resetsAt: { at: 2, label: "2026-10-31 05:59" } } },
      credits: { state: "wip" },
    });
    try {
      expect(noteOf(page, 0)).toBe("resets 2026-10-28 04:56");
      expect(noteOf(page, 1)).toBe("resets 2026-10-31 05:59");
    } finally {
      page.close();
    }
  });

  it("reads the share on a five-hour window too, because the shape is the window's", async () => {
    const page = await open({
      fiveHour: { state: "value", value: { utilization: 10, resetsAt: RESET_AT, regenPercent: 1 } },
      weekly: { state: "wip" },
      credits: { state: "wip" },
    });
    try {
      expect(noteOf(page, 0)).toBe("next +1% at 2026-10-28 04:56");
    } finally {
      page.close();
    }
  });
});

describe("a credit line with no amounts", () => {
  it("says so in one line and still links the page where a balance is bought", async () => {
    const page = await open({
      weekly: { state: "value", value: { utilization: 0, resetsAt: RESET_AT, regenPercent: 2 } },
      credits: credits({ used: null, limit: null, balance: null }),
    });
    try {
      const card = page.document.querySelector('[data-provider="card"]') as HTMLElement;
      const creditsNode = card.querySelector(".usage-credits") as HTMLElement;
      expect(creditsNode.querySelector(".usage-line")?.textContent).toBe("Amounts not provided");
      // No amount is printed, and no bar: there is nothing to measure.
      expect(card.textContent).not.toContain("not stated");
      expect(creditsNode.querySelectorAll(".usage-bar")).toHaveLength(0);
      // The link line below the amounts is still there.
      const link = card.querySelector('a[href="https://synthetic.new/billing"]');
      expect(link?.textContent).toBe("synthetic.new billing page");
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
    } finally {
      page.close();
    }
  });

  it("keeps `not stated` for each amount when only some of them are missing", async () => {
    const page = await open({
      weekly: { state: "wip" },
      credits: credits({ used: null, limit: { amount: 24, currency: "USD" }, balance: null }),
    });
    try {
      const card = page.document.querySelector('[data-provider="card"]') as HTMLElement;
      const text = card.textContent ?? "";
      expect(text).toContain("used not stated");
      expect(text).toContain("limit $24.00");
      expect(text).toContain("balance not stated");
      expect(text).not.toContain("Amounts not provided");
    } finally {
      page.close();
    }
  });
});

describe("the credit line a provider states itself", () => {
  it("keeps the usage-credit and console sentences of a line with no billing page", async () => {
    const page = await open({
      weekly: { state: "wip" },
      credits: {
        state: "value",
        value: {
          enabled: false,
          used: { amount: 0, currency: "USD" },
          limit: null,
          disabledReason: "out_of_credits",
          balance: null,
        },
      },
    });
    try {
      const text = page.document.body.textContent ?? "";
      expect(text).toContain("Usage credits: off");
      expect(text).toContain("(out of credits)");
      expect(text).toContain("used $0.00");
      expect(text).toContain("monthly limit none");
      expect(text).toContain("Balance not available");
      expect(text).toContain("Monthly API credits: No API");
      expect(text).not.toContain("Amounts not provided");
    } finally {
      page.close();
    }
  });

  it("measures used against the limit when a billing line states one", async () => {
    const page = await open({
      weekly: { state: "wip" },
      credits: credits({
        used: { amount: 13.5, currency: "USD" },
        limit: { amount: 24, currency: "USD" },
        balance: { amount: 10.5, currency: "USD" },
      }),
    });
    try {
      const card = page.document.querySelector('[data-provider="card"]') as HTMLElement;
      const text = card.textContent ?? "";
      expect(text).toContain("used $13.50");
      expect(text).toContain("limit $24.00");
      expect(text).toContain("balance $10.50");
      expect([...card.querySelectorAll(".usage-bar")].map((track) => track.getAttribute("data-level"))).toEqual(["ok"]);
      expect((card.querySelector(".usage-bar-fill") as HTMLElement).style.width).toBe("56.3%");
    } finally {
      page.close();
    }
  });
});
