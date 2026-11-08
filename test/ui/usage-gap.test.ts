/**
 * The usage page's assertions that the old page's tests made and the new page's
 * tests did not.
 *
 * Each test here comes from one test of `test/usage-web.test.ts`, and looks at the
 * same thing with the same strength: a field with no limit draws no bar, a balance
 * is drawn as a balance and never as a bar, the mount prefix is on both requests,
 * a month that holds nothing draws thirty zero-height columns, a kept value with no
 * value ever received says only when the next refresh is, and the page never
 * writes a style attribute as text.
 *
 * That last one is the only line the page cannot show from its own markup: a
 * browser takes both a CSSOM write and a written attribute as the same attribute.
 * The old test read the page's source and spied on `setAttribute`; so does this
 * one, against the modules the page is built from and against a redraw.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadUiPage, root, settle, type FetchAnswer, type UiPageHandle } from "./harness.ts";

/* ------------------------------------------------------------- fixtures */

/** A subscription card: two windows and credits whose limit the answer does not state. */
const SUBSCRIPTION = {
  generatedAt: 1,
  timezone: "Asia/Tokyo",
  cards: [
    {
      provider: "anthropic",
      name: "Anthropic",
      shape: "subscription",
      receivedAt: { at: 1, label: "2026-10-25 07:30" },
      fields: {
        fiveHour: { state: "value", value: { utilization: 28, resetsAt: { at: 2, label: "2026-10-26 20:59" } } },
        weekly: { state: "value", value: { utilization: 72, resetsAt: null } },
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
      },
    },
  ],
};

/** A prepaid card: a balance, one window filled, and thirty daily columns. */
const PREPAID_CARD = {
  provider: "deepseek",
  name: "DeepSeek",
  shape: "prepaid",
  receivedAt: null,
  note: "Peak/off-peak rates applied · holidays ignored",
  fields: {
    balance: { state: "value", value: { amount: 11.25, currency: "USD" } },
    day: { state: "value", value: { calls: 12, tokens: 21_000, cost: 0.37 } },
    week: { state: "wip" },
    month: { state: "error", reason: "HTTP 429" },
    daily: { state: "value", value: { slots: [] as { from: unknown; to: unknown; calls: number; cost: number }[] } },
  },
};

const PREPAID = { generatedAt: 1, timezone: "Asia/Tokyo", cards: [PREPAID_CARD] };

/** Both cards, which is what a page with two logins gets. */
const TWO = { generatedAt: 1, timezone: "Asia/Tokyo", cards: [SUBSCRIPTION.cards[0]!, PREPAID_CARD] };

/** The 30 daily slots, oldest first, with `each` filling the numbers. */
function dailySlots(each: (index: number) => { calls: number; cost: number }) {
  return Array.from({ length: 30 }, (_unused, index) => ({
    from: { at: index * 86_400, label: `2026-09-${String(index + 1).padStart(2, "0")} 00:00` },
    to: { at: (index + 1) * 86_400, label: `2026-09-${String(index + 1).padStart(2, "0")} 23:59` },
    ...each(index),
  }));
}

/** A prepaid card whose daily field holds the slots `each` fills. */
function prepaidWith(each: (index: number) => { calls: number; cost: number }) {
  return {
    generatedAt: 1,
    timezone: "Asia/Tokyo",
    cards: [{ ...PREPAID_CARD, fields: { ...PREPAID_CARD.fields, daily: { state: "value", value: { slots: dailySlots(each) } } } }],
  };
}

/** The subscription card with one field changed, for the held-value answer. */
function subscriptionWith(patch: Record<string, unknown>) {
  return { generatedAt: 1, timezone: "Asia/Tokyo", cards: [{ ...SUBSCRIPTION.cards[0]!, ...patch }] };
}

/* -------------------------------------------------------------- helpers */

/** Load the page, answering `GET /api/usage` with `answer`. */
async function open(answer: unknown, extra: Parameters<typeof loadUiPage>[1] = {}): Promise<UiPageHandle> {
  return await loadUiPage("usage", { ...extra, fetch: { "/api/usage": { body: answer }, ...extra.fetch } });
}

/** One card, by the provider id the server gave it. */
function cardOf(page: UiPageHandle, provider: string): HTMLElement {
  const card = page.document.querySelector<HTMLElement>(`[data-provider="${provider}"]`);
  if (card === null) throw new Error(`the page drew no card for ${provider}`);
  return card;
}

/** The fields of one card, in the order the page drew them. */
function fieldsOf(page: UiPageHandle, provider: string): HTMLElement[] {
  return [...cardOf(page, provider).querySelectorAll<HTMLElement>(".usage-field")];
}

/** One refresh answer, which is the card the server read again. */
function refreshedCard(patch: Record<string, unknown>): FetchAnswer {
  return { body: { generatedAt: 2, timezone: "Asia/Tokyo", card: { ...SUBSCRIPTION.cards[0]!, ...patch } } };
}

/* ---------------------------------------------------------------- tests */

describe("the usage page's credits field", () => {
  it("draws no bar for a limit of none, because there is nothing to measure", async () => {
    const page = await open(SUBSCRIPTION);
    try {
      const credits = fieldsOf(page, "anthropic")[2]!;
      // The field is drawn: the test above is about its bar, not about a missing row.
      expect(credits.querySelector(".usage-field-name")?.textContent).toBe("Credits");
      expect(credits.textContent).toContain("monthly limit none");
      expect(credits.querySelectorAll(".usage-bar")).toHaveLength(0);
    } finally {
      page.close();
    }
  });
});

describe("the usage page's prepaid balance", () => {
  it("draws the balance large and with no bar, because a balance has no maximum", async () => {
    const page = await open(PREPAID);
    try {
      const balance = fieldsOf(page, "deepseek")[0]!;
      expect(balance.querySelector(".usage-balance")?.textContent).toBe("$11.25");
      expect(balance.querySelectorAll(".usage-bar")).toHaveLength(0);
    } finally {
      page.close();
    }
  });
});

describe("the usage page under a mount prefix", () => {
  it("keeps the mount prefix on the request", async () => {
    const page = await open(PREPAID, { base: "/sec" });
    try {
      // The page's one read, and nothing else, with the prefix the server stamped.
      expect(page.fetchCalls.map((call) => call.url)).toEqual(["/sec/api/usage"]);
    } finally {
      page.close();
    }
  });

  it("keeps the mount prefix on the refresh request", async () => {
    const page = await open(TWO, {
      base: "/sec",
      fetch: { "/api/usage/refresh": refreshedCard({ receivedAt: { at: 2, label: "2026-10-25 07:41" } }) },
    });
    try {
      const button = cardOf(page, "anthropic").querySelector(".usage-card-refresh") as HTMLButtonElement;
      button.click();
      await settle();
      await settle();
      expect(page.fetchCalls[1]?.url).toBe("/sec/api/usage/refresh");
      expect(page.fetchCalls[1]?.method).toBe("POST");
    } finally {
      page.close();
    }
  });
});

describe("the usage page's daily columns", () => {
  it("draws 30 zero-height columns when the month holds nothing", async () => {
    const page = await open(prepaidWith(() => ({ calls: 0, cost: 0 })));
    try {
      const columns = [...page.document.querySelectorAll<HTMLElement>(".usage-day")];
      expect(columns).toHaveLength(30);
      expect(columns.every((column) => column.style.height === "0%")).toBe(true);
      expect(page.document.querySelector(".usage-days-label")?.textContent).toBe("by calls");
    } finally {
      page.close();
    }
  });
});

describe("the usage page's held value", () => {
  it("leaves the kept value out when no value was ever received", async () => {
    const page = await open(
      subscriptionWith({ hold: { kind: "kept", nextAt: { at: 4, label: "2026-10-25 08:10" } }, receivedAt: null }),
    );
    try {
      expect(page.document.querySelector(".usage-hold")?.textContent).toBe("next refresh after 08:10");
    } finally {
      page.close();
    }
  });
});

describe("the usage page under the policy", () => {
  /** The modules the usage page is built from: the ones that can write a length. */
  const SOURCES = [
    "src/ui/usage/values.tsx",
    "src/ui/usage/card.tsx",
    "src/ui/usage/cards.tsx",
    "src/ui/usage/status.tsx",
    "src/ui/usage/reload.tsx",
    "src/ui/usage/format.ts",
    "src/ui/state/usage.ts",
    "src/ui/pages/usage.tsx",
  ];

  it("never writes a style attribute as text", async () => {
    for (const relative of SOURCES) {
      const source = await readFile(join(root, relative), "utf8");
      expect(source, relative).not.toMatch(/setAttribute\(\s*["'`]style/);
      expect(source, relative).not.toMatch(/\.style\.cssText/);
      expect(source, relative).not.toMatch(/createElement\(\s*["'`]style/);
      // `style={{ … }}` writes the CSSOM, which the policy allows; `style="…"` is text.
      expect(source, relative).not.toMatch(/style\s*=\s*["'`]/);
    }
  });

  it("writes every length through the CSSOM, on the first draw and on a redraw", async () => {
    const page = await open(TWO, { fetch: { "/api/usage/refresh": refreshedCard({}) } });
    try {
      const drawn = [...page.document.querySelectorAll<HTMLElement>(".usage-bar-fill")];
      expect(drawn.length).toBeGreaterThan(0);
      // A length that went in through the CSSOM is readable back as a style property.
      expect(drawn.every((fill) => fill.style.width !== "")).toBe(true);

      // The attribute a text write would produce is what the spy watches for. A
      // CSSOM write never comes through `setAttribute`, which is the difference.
      const written: string[] = [];
      const proto = page.window.Element.prototype;
      const original = proto.setAttribute;
      proto.setAttribute = function (name: string, value: string): void {
        if (String(name).toLowerCase() === "style") written.push(String(value));
        original.call(this, name, value);
      };
      try {
        const button = cardOf(page, "anthropic").querySelector(".usage-card-refresh") as HTMLButtonElement;
        button.click();
        await settle();
        await settle();

        expect(written).toEqual([]);
        // The spy is proven on a write that is one, so the empty list above means
        // something: the same call on a scratch element is recorded.
        page.document.createElement("div").setAttribute("style", "width: 1px");
        expect(written).toEqual(["width: 1px"]);
      } finally {
        proto.setAttribute = original;
      }

      const redrawn = cardOf(page, "anthropic").querySelector(".usage-bar-fill") as HTMLElement;
      expect(redrawn.style.width).not.toBe("");
    } finally {
      page.close();
    }
  });
});
