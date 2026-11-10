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
import { loadUiPage, type UiPageHandle } from "./harness.ts";
import { quotaNote } from "../../src/ui/usage/values.tsx";
import type { UsageQuota } from "../../src/shared/wire/usage.ts";

const SYNTHETIC_BILLING = { label: "synthetic.new billing page", url: "https://synthetic.new/billing" };

/** One subscription answer holding the one card this file draws. */
function answer(card: Record<string, unknown>) {
  return {
    generatedAt: 1,
    timezone: "Asia/Tokyo",
    cards: [{ provider: "card", name: "Card", shape: "subscription", receivedAt: { at: 1, label: "2026-10-25 07:30" }, ...card }],
  };
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

/** One quota value: the reset moment, and optionally the share that returns. */
const quota = (extra: Record<string, unknown>, at = RESET_AT) => ({ utilization: 0, resetsAt: at, ...extra }) as UsageQuota;

describe("a quota that comes back a little at a time", () => {
  it.each([
    ["writes the share that returns and the moment, instead of the plain reset time", quota({ regenPercent: 2 }), "next +2% at 2026-10-28 04:56"],
    ["writes the moment alone when the share is stated but could not be read", quota({ utilization: 40, regenPercent: null }), "next regeneration at 2026-10-28 04:56"],
    ["writes the plain reset time when the value states no such share at all", quota({ utilization: 28 }), "resets 2026-10-28 04:56"],
    ["writes the plain reset time of a second window the same way", quota({ utilization: 72 }, { at: 2, label: "2026-10-31 05:59" }), "resets 2026-10-31 05:59"],
    ["reads the share on a five-hour window too, because the shape is the window's", quota({ utilization: 10, regenPercent: 1 }), "next +1% at 2026-10-28 04:56"],
  ])("%s", (_name, value, expected) => {
    expect(quotaNote(value)).toBe(expected);
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
