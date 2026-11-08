/**
 * The two sentences the usage page gained: a balance no API states, and the
 * decision models card.
 *
 * The OpenAI card used to say `WIP` in its balance row, which promises a value
 * that nothing will send. It now states `No API for the balance` and links the
 * billing page. The decision models card counts the judgement models pi-sec calls
 * outside every conversation: one row per judge, three lines per row.
 *
 * Both are decided by the shape of the answer, not by a provider id: the page
 * names no provider, and a card whose balance states no notice draws the number it
 * always drew.
 */
import { describe, expect, it } from "vitest";
import { loadUiPage, type UiPageHandle } from "./harness.ts";

const OPENAI_BILLING = {
  label: "OpenAI billing page",
  url: "https://platform.openai.com/settings/organization/billing",
};

/** One answer holding the one provider card this file draws. */
function answer(card: Record<string, unknown>, judges?: unknown) {
  return {
    generatedAt: 1,
    timezone: "Asia/Tokyo",
    cards: [{ provider: "card", name: "Card", shape: "prepaid", receivedAt: null, ...card }],
    ...(judges === undefined ? {} : { judges }),
  };
}

/** The balance field of a card whose provider states no amount. */
const NOTICE = {
  state: "value",
  value: { amount: null, currency: null, note: "No API for the balance", billing: OPENAI_BILLING },
};

/** The three windows of a card, all filled, so the page has the rest to draw. */
function windows(calls = 3) {
  return {
    day: { state: "value", value: { calls, tokens: 4000, cost: 0.06 } },
    week: { state: "value", value: { calls, tokens: 12_000, cost: 0.18 } },
    month: { state: "value", value: { calls, tokens: 60_000, cost: 0.9 } },
    daily: { state: "wip" },
  };
}

/** One judgement row of the decision models card. */
const JUDGE_ROW = {
  name: "report-check",
  provider: "openai",
  model: "gpt-6-luna",
  day: { calls: 2, tokens: 800, cost: 0.0008, unanswered: 0 },
  week: { calls: 12, tokens: 4000, cost: 0.0042, unanswered: 2 },
  month: { calls: 57, tokens: 16_100, cost: 0.0199, unanswered: 9 },
};

/** Load the page with one answer, answering `GET /api/usage` the same way. */
async function open(body: unknown, extra: Parameters<typeof loadUiPage>[1] = {}): Promise<UiPageHandle> {
  return await loadUiPage("usage", { ...extra, fetch: { "/api/usage": { body }, ...extra.fetch } });
}

describe("a balance no API states", () => {
  it("writes the sentence and the link where the balance number would be", async () => {
    const page = await open(answer({ fields: { balance: NOTICE, ...windows() } }));
    try {
      const card = page.document.querySelector('[data-provider="card"]') as HTMLElement;
      const balanceField = [...card.querySelectorAll(".usage-field")][0] as HTMLElement;
      expect(balanceField.querySelector(".usage-field-name")?.textContent).toBe("Prepaid balance");
      expect(balanceField.querySelector(".usage-balance-note")?.textContent).toBe("No API for the balance");
      // The row draws no `WIP` and no amount: it is the sentence and the link.
      expect(balanceField.textContent).not.toContain("WIP");
      expect(balanceField.textContent).not.toContain("not stated");
      expect(balanceField.querySelector(".usage-wip")).toBeNull();
      // The link is the billing page, opened away from the page as every link is.
      const link = balanceField.querySelector(`a[href="${OPENAI_BILLING.url}"]`);
      expect(link?.textContent).toBe("OpenAI billing page");
      expect(link?.getAttribute("target")).toBe("_blank");
      expect(link?.getAttribute("rel")).toBe("noreferrer noopener");
      // The rest of the card still draws its own numbers.
      expect(card.textContent).toContain("3 calls · 4,000 tokens · $0.0600");
    } finally {
      page.close();
    }
  });

  it("keeps the large number for a card whose provider states an amount", async () => {
    const page = await open(answer({ fields: { balance: { state: "value", value: { amount: 11.25, currency: "USD" } }, ...windows() } }));
    try {
      const card = page.document.querySelector('[data-provider="card"]') as HTMLElement;
      expect(card.querySelector(".usage-balance")?.textContent).toBe("$11.25");
      expect(card.querySelector(".usage-balance-note")).toBeNull();
      expect(card.querySelector(".usage-balance-notice")).toBeNull();
    } finally {
      page.close();
    }
  });

  it("links nothing when the notice states no billing page", async () => {
    const page = await open(
      answer({ fields: { balance: { state: "value", value: { amount: null, currency: null, note: "No API for the balance" } }, ...windows() } }),
    );
    try {
      const card = page.document.querySelector('[data-provider="card"]') as HTMLElement;
      expect(card.querySelector(".usage-balance-note")?.textContent).toBe("No API for the balance");
      expect(card.querySelectorAll("a")).toHaveLength(0);
    } finally {
      page.close();
    }
  });
});

describe("the decision models card", () => {
  it("draws one row per judge, with the provider and model beside the name", async () => {
    const page = await open(answer({ fields: { balance: NOTICE, ...windows() } }, { rows: [JUDGE_ROW] }));
    try {
      const card = page.document.querySelector('[data-card="judges"]') as HTMLElement;
      expect(card).not.toBeNull();
      expect(card.querySelector(".usage-card-name")?.textContent).toBe("Decision models");
      const rows = [...card.querySelectorAll(".usage-field")];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.getAttribute("data-judge")).toBe("report-check");
      expect(rows[0]?.querySelector(".usage-field-name")?.textContent).toBe("report-check · openai/gpt-6-luna");
    } finally {
      page.close();
    }
  });

  it("states the three windows of a row, with the cost and the unanswered count", async () => {
    const page = await open(answer({ fields: { balance: NOTICE, ...windows() } }, { rows: [JUDGE_ROW] }));
    try {
      const card = page.document.querySelector('[data-card="judges"]') as HTMLElement;
      const lines = [...card.querySelectorAll(".usage-field-value .usage-line")].map((line) => line.textContent);
      expect(lines).toEqual([
        "Last 24 hours: 2 calls · 800 tokens · $0.0008 · 0 unanswered",
        "Last 7 days: 12 calls · 4,000 tokens · $0.0042 · 2 unanswered",
        "Last 30 days: 57 calls · 16,100 tokens · $0.0199 · 9 unanswered",
      ]);
      // The card says what its numbers are, and where they sit against the rest.
      expect(card.querySelector(".usage-note")?.textContent).toBe(
        "pi-sec's own judgement calls · not counted in the provider cards",
      );
    } finally {
      page.close();
    }
  });

  it("draws no card at all when the answer carries no judgement rows", async () => {
    for (const judges of [undefined, { rows: [] }]) {
      const page = await open(answer({ fields: { balance: NOTICE, ...windows() } }, judges));
      try {
        expect(page.document.querySelector('[data-card="judges"]')).toBeNull();
        // The provider card is still there: this is an absence, not an empty page.
        expect(page.document.querySelectorAll("article.usage-card")).toHaveLength(1);
      } finally {
        page.close();
      }
    }
  });

  it("draws the card below the provider cards, and keeps it across a reload", async () => {
    const body = answer({ fields: { balance: NOTICE, ...windows() } }, { rows: [JUDGE_ROW] });
    const page = await open(body);
    try {
      const cards = page.document.getElementById("usage-cards");
      const drawn = [...(cards?.children ?? [])];
      expect(drawn.map((element) => element.getAttribute("data-card") ?? element.getAttribute("data-provider"))).toEqual([
        "card",
        "judges",
      ]);

      // A reload that answers no judgement drops the card; one that answers rows
      // puts it back. It is not a provider card, so nothing about it is keyed.
      page.respond("/api/usage", { body: answer({ fields: { balance: NOTICE, ...windows() } }) });
      (page.document.getElementById("reload-usage") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(page.document.querySelector('[data-card="judges"]')).toBeNull();

      page.respond("/api/usage", { body });
      (page.document.getElementById("reload-usage") as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(page.document.querySelector('[data-card="judges"]')).not.toBeNull();
    } finally {
      page.close();
    }
  });

  it("draws the rows the page is served with, and asks the server for nothing", async () => {
    const body = answer({ fields: { balance: NOTICE, ...windows() } }, { rows: [JUDGE_ROW] });
    const page = await loadUiPage("usage", { firstPaint: body });
    try {
      expect(page.fetchCalls.filter((call) => call.path === "/api/usage")).toEqual([]);
      const card = page.document.querySelector('[data-card="judges"]') as HTMLElement;
      expect(card.querySelectorAll(".usage-field")).toHaveLength(1);
    } finally {
      page.close();
    }
  });

  it("draws no text a judgement was shown, because the answer carries none", async () => {
    const planted = "the judged text that must not reach the screen";
    const page = await open(answer({ fields: { balance: NOTICE, ...windows() } }, { rows: [JUDGE_ROW] }));
    try {
      expect(page.document.body.textContent).not.toContain(planted);
      // A row's own fields, and nothing else, are what the card prints.
      expect(page.document.body.textContent).toContain("report-check");
    } finally {
      page.close();
    }
  });
});
