/**
 * The usage page, drawn from a fake answer: the two card shapes, the bars, the
 * daily columns, the two controls and the structure the stylesheet expects.
 *
 * The server sends values, not sentences: a field is a value, `wip`, or a failure
 * with a reason, and every moment already carries the label of the zone the
 * harness runs in. This file pins what the page says for each of those, because
 * those words are the part nobody can check from the server side.
 *
 * It also pins the structure: the page draws the same element tree, ids and
 * classes the hand-written page drew, because `usage.css` styles exactly that tree
 * and the switch commit changes no CSS. Two tests compare this page with a tree
 * frozen in `fixtures/old-dom/`, which the hand-written page printed before the
 * switch commit deleted it; `fixtures/old-dom/README.md` says how.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM, VirtualConsole } from "jsdom";
import { describe, expect, it } from "vitest";
import { loadUiPage, root, settle, type UiPageHandle } from "./harness.ts";

const BILLING_URL = "https://platform.claude.com/settings/billing";
const SYNTHETIC_BILLING_URL = "https://synthetic.new/billing";

/** A subscription card: two windows, one of them without a reset time, and credits. */
const ANTHROPIC = {
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

/** One subscription card with a single 5-hour utilization and nothing else. */
function quotaAnswer(utilization: number) {
  return {
    generatedAt: 1,
    timezone: "Asia/Tokyo",
    cards: [
      {
        provider: "anthropic",
        name: "Anthropic",
        shape: "subscription",
        receivedAt: { at: 1, label: "2026-10-25 07:30" },
        fields: {
          fiveHour: { state: "value", value: { utilization, resetsAt: null } },
          weekly: { state: "wip" },
          credits: { state: "wip" },
        },
      },
    ],
  };
}

/** The 30 daily slots, oldest first, with `each` filling the numbers. */
function dailySlots(each: (index: number) => { calls: number; cost: number }) {
  return Array.from({ length: 30 }, (_unused, index) => ({
    from: { at: index * 86_400, label: `2026-09-${String(index + 1).padStart(2, "0")} 00:00` },
    to: { at: (index + 1) * 86_400, label: `2026-09-${String(index + 1).padStart(2, "0")} 23:59` },
    ...each(index),
  }));
}

/** A prepaid card: one window filled, one `wip`, one failed, and thirty columns. */
const DEEPSEEK = {
  generatedAt: 1,
  timezone: "Asia/Tokyo",
  cards: [
    {
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
        daily: { state: "value", value: { slots: dailySlots((index) => ({ calls: index + 1, cost: index === 5 ? 2 : 0 })) } },
      },
    },
  ],
};

/** Both cards, which is what a page with two logins gets. */
const BOTH = {
  generatedAt: 1,
  timezone: "Asia/Tokyo",
  cards: [ANTHROPIC.cards[0]!, DEEPSEEK.cards[0]!],
};

/** The fills of the bars inside one element, with the level each track states. */
function bars(node: Element): { level: string | null; width: string }[] {
  return [...node.querySelectorAll(".usage-bar")].map((track) => ({
    level: track.getAttribute("data-level"),
    width: (track.querySelector(".usage-bar-fill") as HTMLElement).style.width,
  }));
}

/** The names of the fields of one card, in the order the page drew them. */
function fieldNames(card: Element): (string | null | undefined)[] {
  return [...card.querySelectorAll(".usage-field")].map((field) => field.querySelector(".usage-field-name")?.textContent);
}

/** One card, by the provider id the server gave it. */
function cardOf(page: UiPageHandle, provider: string): HTMLElement {
  const card = page.document.querySelector<HTMLElement>(`[data-provider="${provider}"]`);
  if (card === null) throw new Error(`the page drew no card for ${provider}`);
  return card;
}

/** Load the page with `answer` answering `GET /api/usage`. */
async function open(answer: unknown, extra: Parameters<typeof loadUiPage>[1] = {}): Promise<UiPageHandle> {
  return await loadUiPage("usage", { ...extra, fetch: { "/api/usage": { body: answer }, ...extra.fetch } });
}

describe("the cards of a usage page", () => {
  it("draws one card per provider that has a login, and says so when none has one", async () => {
    const page = await open(BOTH);
    try {
      const cards = [...page.document.querySelectorAll(".usage-card")];
      expect(cards.map((card) => card.getAttribute("data-provider"))).toEqual(["anthropic", "deepseek"]);
      expect(page.fetchCalls.map((call) => call.path)).toEqual(["/api/usage"]);
      // The status line has nothing to say while there are cards.
      expect(page.document.getElementById("usage-status")?.className).toBe("usage-status hidden");
    } finally {
      page.close();
    }

    const empty = await open({ generatedAt: 1, timezone: "Asia/Tokyo", cards: [] });
    try {
      expect(empty.document.querySelectorAll(".usage-card")).toHaveLength(0);
      const status = empty.document.getElementById("usage-status");
      expect(status?.textContent).toBe("No model provider has a login yet.");
      expect(status?.className).toBe("usage-status");
    } finally {
      empty.close();
    }
  });

  it("draws both card shapes, with the subscription fields first and the shape's own word", async () => {
    const page = await open(BOTH);
    try {
      const subscription = cardOf(page, "anthropic");
      expect(subscription.querySelector(".usage-chip")?.textContent).toBe("subscription");
      expect(fieldNames(subscription)).toEqual(["5-hour limit", "Weekly limit", "Credits"]);
      expect(subscription.querySelector(".usage-card-name")?.textContent).toBe("Anthropic");
      expect(subscription.querySelector(".usage-received")?.textContent).toBe("value received 2026-10-25 07:30");

      const prepaid = cardOf(page, "deepseek");
      expect(prepaid.querySelector(".usage-chip")?.textContent).toBe("prepaid");
      expect(fieldNames(prepaid)).toEqual(["Prepaid balance", "Last 24 hours", "Last 7 days", "Last 30 days", "Usage per day"]);
      // A card that never received a value says so instead of naming a time.
      expect(prepaid.querySelector(".usage-received")?.textContent).toBe("no value received yet");
    } finally {
      page.close();
    }
  });

  it("draws a bar and a percentage per measurable number, with the reset time beside it", async () => {
    const page = await open(ANTHROPIC);
    try {
      const card = cardOf(page, "anthropic");
      const text = card.textContent ?? "";
      expect(text).toContain("28%");
      expect(text).toContain("resets 2026-10-26 20:59");
      expect(text).toContain("72%");
      expect(text).toContain("reset time not stated");
      expect(bars(card)).toEqual([
        { level: "ok", width: "28%" },
        { level: "warn", width: "72%" },
      ]);
    } finally {
      page.close();
    }
  });

  it("reads a bar's level as ok under 70, warn from 70 to 89, danger from 90", async () => {
    for (const [utilization, level] of [
      [69, "ok"],
      [70, "warn"],
      [89, "warn"],
      [90, "danger"],
    ] as const) {
      const page = await open(quotaAnswer(utilization));
      try {
        expect(bars(cardOf(page, "anthropic"))).toEqual([{ level, width: `${utilization}%` }]);
      } finally {
        page.close();
      }
    }

    const short = await open(quotaAnswer(43.5));
    try {
      expect(bars(cardOf(short, "anthropic"))[0]?.width).toBe("43.5%");
    } finally {
      short.close();
    }

    const over = await open(quotaAnswer(140));
    try {
      expect(bars(cardOf(over, "anthropic"))[0]).toEqual({ level: "danger", width: "100%" });
    } finally {
      over.close();
    }
  });

  it("writes WIP for a field with no reader, the reason for one that failed, and nothing for a field the answer omits", async () => {
    const wip = await open({
      generatedAt: 1,
      timezone: "Asia/Tokyo",
      cards: [
        {
          ...ANTHROPIC.cards[0]!,
          fields: {
            fiveHour: { state: "value", value: { utilization: 10, resetsAt: null } },
            weekly: { state: "wip" },
            credits: { state: "wip" },
          },
        },
      ],
    });
    try {
      const subscription = cardOf(wip, "anthropic");
      const weekly = [...subscription.querySelectorAll(".usage-field")][1] as HTMLElement;
      expect(weekly.textContent).toContain("WIP");
      expect(weekly.querySelectorAll(".usage-bar")).toHaveLength(0);
      // Only the filled field has a bar: a field with no value has nothing to draw.
      expect(subscription.querySelectorAll(".usage-bar")).toHaveLength(1);
    } finally {
      wip.close();
    }

    const page = await open(BOTH);
    try {
      const prepaid = cardOf(page, "deepseek");
      const text = prepaid.textContent ?? "";
      expect(text).toContain("WIP");
      expect(text).toContain("Not available (HTTP 429)");

      // A provider with no five-hour window carries no such field, so no row.
      const synthetic = await open({
        generatedAt: 1,
        timezone: "Asia/Tokyo",
        cards: [
          {
            provider: "synthetic",
            name: "synthetic.new",
            shape: "subscription",
            receivedAt: { at: 1, label: "2026-10-25 07:30" },
            fields: {
              weekly: { state: "value", value: { utilization: 57.5, resetsAt: { at: 2, label: "2026-10-31 09:00" } } },
              credits: { state: "wip" },
            },
          },
        ],
      });
      try {
        expect(fieldNames(cardOf(synthetic, "synthetic"))).toEqual(["Weekly limit", "Credits"]);
        expect(synthetic.document.body.textContent).not.toContain("5-hour limit");
      } finally {
        synthetic.close();
      }
    } finally {
      page.close();
    }
  });

  it("names where a prepaid card's numbers come from, and adds the provider's own note", async () => {
    const page = await open(BOTH);
    try {
      const note = cardOf(page, "deepseek").querySelector(".usage-note")?.textContent;
      expect(note).toBe("pi-sec calls only · estimated cost · Peak/off-peak rates applied · holidays ignored");
      // A subscription card carries no prepaid note.
      expect(cardOf(page, "anthropic").querySelector(".usage-note")).toBeNull();

      const windows = cardOf(page, "deepseek").textContent ?? "";
      expect(windows).toContain("12 calls · 21,000 tokens · $0.3700");
      expect(cardOf(page, "deepseek").querySelector(".usage-balance")?.textContent).toBe("$11.25");
    } finally {
      page.close();
    }
  });

  it("measures each daily column against the largest cost, and follows the call count when the month costs nothing", async () => {
    const page = await open(DEEPSEEK);
    try {
      const columns = [...page.document.querySelectorAll<HTMLElement>(".usage-day")];
      expect(columns).toHaveLength(30);
      // The sixth slot costs two dollars, the largest of the month.
      expect(columns[5]?.style.height).toBe("100%");
      expect(columns[6]?.style.height).toBe("0%");
      expect(columns.filter((column) => column.classList.contains("usage-day--recent"))).toHaveLength(7);
      expect(page.document.querySelector(".usage-days-label")).toBeNull();
      expect(columns[0]?.getAttribute("title")).toBe("2026-09-01 00:00 to 2026-09-01 23:59 · $0.00 · 1 calls");
    } finally {
      page.close();
    }

    const byCalls = await open({
      generatedAt: 1,
      timezone: "Asia/Tokyo",
      cards: [
        {
          provider: "deepseek",
          name: "DeepSeek",
          shape: "prepaid",
          receivedAt: null,
          fields: {
            balance: { state: "value", value: { amount: 1, currency: "USD" } },
            day: { state: "wip" },
            week: { state: "wip" },
            month: { state: "wip" },
            daily: { state: "value", value: { slots: dailySlots((index) => ({ calls: index + 1, cost: 0 })) } },
          },
        },
      ],
    });
    try {
      const columns = [...byCalls.document.querySelectorAll<HTMLElement>(".usage-day")];
      expect(columns[29]?.style.height).toBe("100%");
      expect(columns[14]?.style.height).toBe("50%");
      expect(byCalls.document.querySelector(".usage-days-label")?.textContent).toBe("by calls");
    } finally {
      byCalls.close();
    }

    const noColumns = await open({
      generatedAt: 1,
      timezone: "Asia/Tokyo",
      cards: [
        {
          provider: "deepseek",
          name: "DeepSeek",
          shape: "prepaid",
          receivedAt: null,
          fields: {
            balance: { state: "wip" },
            day: { state: "wip" },
            week: { state: "wip" },
            month: { state: "wip" },
            daily: { state: "wip" },
          },
        },
      ],
    });
    try {
      expect(noColumns.document.querySelectorAll(".usage-day")).toHaveLength(0);
    } finally {
      noColumns.close();
    }
  });

  it("says how long a value is held, in the server's own label", async () => {
    const held = (hold: unknown, receivedAt: unknown) => ({
      generatedAt: 1,
      timezone: "Asia/Tokyo",
      cards: [{ ...ANTHROPIC.cards[0]!, hold, receivedAt }],
    });

    const limited = await open(held({ kind: "rate_limited", until: { at: 3, label: "2026-10-25 08:05" } }, null));
    try {
      expect(limited.document.querySelector(".usage-hold")?.textContent).toBe("rate limited until 08:05");
    } finally {
      limited.close();
    }

    const kept = await open(
      held({ kind: "kept", nextAt: { at: 4, label: "2026-10-25 08:10" } }, { at: 1, label: "2026-10-25 07:30" }),
    );
    try {
      expect(kept.document.querySelector(".usage-hold")?.textContent).toBe(
        "kept value from 07:30 · next refresh after 08:10",
      );
    } finally {
      kept.close();
    }

    const none = await open(ANTHROPIC);
    try {
      expect(none.document.querySelector(".usage-hold")).toBeNull();
    } finally {
      none.close();
    }
  });
});

describe("the answer the page is served with", () => {
  /** A card whose provider value the server had not received when it built the page. */
  function awaitingAnswer(): unknown {
    const anthropic = {
      ...ANTHROPIC.cards[0]!,
      receivedAt: null,
      fields: {
        fiveHour: { state: "reading" },
        weekly: { state: "reading" },
        credits: { state: "reading" },
      },
    };
    return { generatedAt: 1, timezone: "Asia/Tokyo", cards: [anthropic, DEEPSEEK.cards[0]!] };
  }

  it("draws the block with no request at all", async () => {
    const page = await loadUiPage("usage", { firstPaint: BOTH });
    try {
      // The page holds every value it would have asked for, so it asks nothing.
      expect(page.fetchCalls.filter((call) => call.path === "/api/usage")).toEqual([]);
      expect(page.document.querySelectorAll("#usage-cards article.usage-card")).toHaveLength(2);
      const anthropic = cardOf(page, "anthropic");
      expect(anthropic.querySelector(".usage-card-name")?.textContent).toBe("Anthropic");
      expect(bars(anthropic)[0]?.width).toBe("28%");
    } finally {
      page.close();
    }
  });

  it("asks for the rest when a provider value is still reading, and draws it in place", async () => {
    const page = await loadUiPage("usage", { firstPaint: awaitingAnswer(), fetch: { "/api/usage": { body: BOTH } } });
    try {
      const reads = page.fetchCalls.filter((call) => call.path === "/api/usage");
      expect(reads).toHaveLength(1);
      // The block drew the card the request then filled: one card, not two.
      expect(page.document.querySelectorAll('#usage-cards article.usage-card[data-provider="anthropic"]')).toHaveLength(1);
      expect(cardOf(page, "anthropic").querySelector(".usage-line.usage-reading")).toBeNull();
      expect(bars(cardOf(page, "anthropic"))[0]?.width).toBe("28%");
    } finally {
      page.close();
    }
  });

  it("says Reading… for a value that did not arrive, and keeps pi-sec's own numbers", async () => {
    const page = await loadUiPage("usage", { firstPaint: awaitingAnswer(), fetch: { "/api/usage": { status: 500, body: {} } } });
    try {
      const anthropic = cardOf(page, "anthropic");
      const reading = [...anthropic.querySelectorAll(".usage-line.usage-reading")].map((line) => line.textContent);
      expect(reading).toEqual(["Reading…", "Reading…", "Reading…"]);
      // The failure is stated once, above the cards, and the daily columns of the
      // other card are the ledger's, which the block already carried.
      const deepseek = cardOf(page, "deepseek");
      expect(deepseek.querySelectorAll(".usage-day")).toHaveLength(30);
      expect(page.document.querySelector("#usage-status")?.textContent).toContain("Could not read usage");
    } finally {
      page.close();
    }
  });

  it("asks the server when the page carries no block, or one this build cannot read", async () => {
    for (const firstPaint of [undefined, "not an answer", { cards: "no" }]) {
      const page = await loadUiPage("usage", { ...(firstPaint === undefined ? {} : { firstPaint }), fetch: { "/api/usage": { body: BOTH } } });
      try {
        expect(page.fetchCalls.filter((call) => call.path === "/api/usage")).toHaveLength(1);
        expect(page.document.querySelectorAll("#usage-cards article.usage-card")).toHaveLength(2);
      } finally {
        page.close();
      }
    }
  });

  it("still asks the server when the reader presses reload", async () => {
    const page = await loadUiPage("usage", { firstPaint: BOTH, fetch: { "/api/usage": { body: BOTH } } });
    try {
      expect(page.fetchCalls.filter((call) => call.path === "/api/usage")).toEqual([]);
      (page.document.querySelector("#reload-usage") as HTMLButtonElement).click();
      await settle();
      expect(page.fetchCalls.filter((call) => call.path === "/api/usage")).toHaveLength(1);
    } finally {
      page.close();
    }
  });
});

describe("the two controls of the usage page", () => {
  /** The answer a refresh of Anthropic gives: one number moved over the top. */
  const REFRESHED = {
    generatedAt: 2,
    timezone: "Asia/Tokyo",
    card: {
      provider: "anthropic",
      name: "Anthropic",
      shape: "subscription",
      receivedAt: { at: 2, label: "2026-10-25 07:41" },
      fields: {
        fiveHour: { state: "value", value: { utilization: 91, resetsAt: null } },
        weekly: { state: "value", value: { utilization: 72, resetsAt: null } },
        credits: { state: "wip" },
      },
    },
  };

  it("gives every card one button that names its own card", async () => {
    const page = await open(BOTH);
    try {
      for (const [provider, name] of [
        ["anthropic", "Anthropic"],
        ["deepseek", "DeepSeek"],
      ] as const) {
        const buttons = cardOf(page, provider).querySelectorAll(".usage-card-refresh");
        expect(buttons).toHaveLength(1);
        const button = buttons[0] as HTMLButtonElement;
        expect(button.getAttribute("aria-label")).toBe(`Refresh ${name}`);
        expect(button.getAttribute("type")).toBe("button");
        expect(button.textContent).toBe("↻");
        expect(button.disabled).toBe(false);
      }
    } finally {
      page.close();
    }
  });

  it("posts one provider, disables the button while it runs, and redraws that card in place", async () => {
    let release: (() => void) | null = null;
    const page = await open(BOTH, {
      fetch: {
        "/api/usage/refresh": () =>
          new Promise((resolve) => {
            release = () => resolve({ body: REFRESHED });
          }),
      },
    });
    try {
      const anthropic = cardOf(page, "anthropic");
      const deepseek = cardOf(page, "deepseek");
      const button = anthropic.querySelector(".usage-card-refresh") as HTMLButtonElement;
      button.click();
      await settle();

      expect(button.disabled).toBe(true);
      const posts = page.fetchCalls.filter((call) => call.path === "/api/usage/refresh");
      expect(posts).toHaveLength(1);
      expect(posts[0]?.method).toBe("POST");
      expect(posts[0]?.body).toBe(JSON.stringify({ provider: "anthropic" }));
      expect(posts[0]?.headers["Content-Type"]).toBe("application/json");

      release!();
      await settle();

      // The card is the same element, redrawn with the new value, and its
      // neighbour was never touched.
      expect(cardOf(page, "anthropic")).toBe(anthropic);
      expect(anthropic.textContent).toContain("91%");
      expect(anthropic.textContent).toContain("value received 2026-10-25 07:41");
      expect(bars(anthropic)[0]).toEqual({ level: "danger", width: "91%" });
      expect(cardOf(page, "deepseek")).toBe(deepseek);
      expect(page.document.querySelectorAll(".usage-card")).toHaveLength(2);
      expect(button.disabled).toBe(false);
    } finally {
      page.close();
    }
  });

  it("comes back and says what happened when a refresh fails, and keeps the values", async () => {
    const page = await open(BOTH, {
      fetch: {
        "/api/usage/refresh": { status: 429, body: { error: { code: "rate_limited", message: "slow down" } } },
      },
    });
    try {
      const anthropic = cardOf(page, "anthropic");
      const button = anthropic.querySelector(".usage-card-refresh") as HTMLButtonElement;
      button.click();
      await settle();

      expect(button.disabled).toBe(false);
      expect(anthropic.querySelector(".usage-card-error")?.textContent).toBe("Could not refresh (HTTP 429).");
      expect(anthropic.textContent).toContain("28%");
      expect(cardOf(page, "anthropic")).toBe(anthropic);

      // One line, not two: a second failure replaces the first.
      button.click();
      await settle();
      expect(anthropic.querySelectorAll(".usage-card-error")).toHaveLength(1);
    } finally {
      page.close();
    }
  });

  it("`↻ reload` reads the whole page again and keeps the cards it already drew", async () => {
    const page = await open(BOTH);
    try {
      const reload = page.document.getElementById("reload-usage") as HTMLButtonElement;
      expect(reload.textContent).toBe("↻ reload");
      const anthropic = cardOf(page, "anthropic");

      page.respond("/api/usage", { body: { ...BOTH, generatedAt: 2 } });
      reload.click();
      await settle();

      expect(page.fetchCalls.map((call) => call.path)).toEqual(["/api/usage", "/api/usage"]);
      expect(cardOf(page, "anthropic")).toBe(anthropic);
      expect(reload.disabled).toBe(false);
    } finally {
      page.close();
    }
  });

  it("says why a whole-page read failed, and shows one notice", async () => {
    const page = await open(BOTH);
    try {
      page.respond("/api/usage", { status: 500, body: { error: { code: "internal", message: "boom" } } });
      (page.document.getElementById("reload-usage") as HTMLButtonElement).click();
      await settle();

      const status = page.document.getElementById("usage-status");
      expect(status?.textContent).toBe("Could not read usage (HTTP 500).");
      expect(status?.className).toBe("usage-status");
      const toast = page.document.getElementById("usage-toast");
      expect(toast?.textContent).toBe("Could not read usage.");
      expect(toast?.className).toBe("toast");
      // The values that did arrive stay where they are.
      expect(cardOf(page, "anthropic").textContent).toContain("28%");
    } finally {
      page.close();
    }
  });

  it("cycles the theme from the header button and opens no event stream", async () => {
    const page = await open(BOTH);
    try {
      const toggle = page.document.getElementById("theme-toggle") as HTMLButtonElement;
      expect(page.document.querySelectorAll("#theme-toggle")).toHaveLength(1);
      expect(toggle.textContent).toBe("◐ auto");
      expect(page.document.documentElement.dataset.theme).toBe("auto");

      toggle.click();
      await settle();
      expect(page.document.documentElement.dataset.theme).toBe("light");
      expect(toggle.textContent).toBe("◐ light");
      expect(page.window.localStorage.getItem("pi-sec-theme")).toBe("light");

      toggle.click();
      await settle();
      expect(page.document.documentElement.dataset.theme).toBe("dark");
      // The page reads the usage once at load and never polls, and it opens no
      // stream. The two presses are saves of the shared theme, the only other calls.
      expect(page.fetchCalls.filter((call) => call.path === "/api/usage")).toHaveLength(1);
      expect(page.fetchCalls.filter((call) => call.method === "PATCH")).toHaveLength(2);
      expect(page.streams()).toEqual([]);
    } finally {
      page.close();
    }
  });

  it("leaves the extension slot where the server drew it", async () => {
    const page = await open(BOTH);
    try {
      const slot = page.document.querySelector('[data-ui-slot="usage.cards"]');
      expect(slot).not.toBeNull();
      page.respond("/api/usage", { body: { ...BOTH, generatedAt: 3 } });
      (page.document.getElementById("reload-usage") as HTMLButtonElement).click();
      await settle();
      expect(page.document.querySelector('[data-ui-slot="usage.cards"]')).toBe(slot);
      // The slot is below the cards, as the shell draws it.
      const cards = page.document.getElementById("usage-cards");
      expect(cards?.compareDocumentPosition(slot!) & page.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      page.close();
    }
  });
});

/* ------------------------------------------------ the same tree as the old page */

/** One element as this comparison reads it: tag, attributes, text, children. */
interface Tree {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
  readonly children: readonly Tree[];
}

/** The element's own text, without its children's. */
function ownText(element: Element): string {
  let text = "";
  for (const node of element.childNodes) {
    if (node.nodeType === 3) text += node.textContent ?? "";
  }
  return text;
}

/**
 * One element as a comparable tree.
 *
 * The `style` attribute is read through the CSSOM in both pages, so it is compared
 * as its cssText: jsdom reflects a property write into the attribute, and the two
 * pages may write the same length in a different attribute spelling.
 */
function treeOf(element: Element): Tree {
  const attrs: Record<string, string> = {};
  for (const attribute of element.attributes) {
    attrs[attribute.name] =
      attribute.name === "style" ? (element as HTMLElement).style.cssText : attribute.value;
  }
  return {
    tag: element.tagName.toLowerCase(),
    attrs,
    text: ownText(element),
    children: [...element.children].filter((child) => child.tagName.toLowerCase() !== "script").map(treeOf),
  };
}

/**
 * The body's tree, with the shell's own whitespace left out.
 *
 * The fixture was printed from the shell as it was before the switch commit, and
 * that commit replaced five `<script>` tags with one; the whitespace between them
 * is what the body's own text holds. Every visible sentence of this page is in an
 * element, so a body that carries text of its own is a page drawing outside its
 * elements, and the check says so rather than passing on a stripped value.
 */
function bodyTree(document: Document): Tree {
  const tree = treeOf(document.body);
  expect(tree.text.trim(), "the body carries text of its own").toBe("");
  return { ...tree, text: "" };
}

/**
 * The tree the hand-written page drew, read from the file it printed.
 *
 * The document is kept alive beside the element: `treeOf` reads a style attribute
 * through the CSSOM, which belongs to the document the element came from.
 */
async function oldTree(name: string): Promise<{ readonly document: Document; readonly close: () => void }> {
  const html = await readFile(join(root, "test/ui/fixtures/old-dom", `${name}.html`), "utf8");
  const dom = new JSDOM(html, { url: "http://localhost/usage" });
  return { document: dom.window.document, close: () => dom.window.close() };
}

describe("the page's structure", () => {
  it("draws the same element tree, ids and classes the hand-written page drew", async () => {
    const old = await oldTree("usage-two-cards");
    const page = await open(BOTH);
    try {
      const expected = bodyTree(old.document);
      const drawn = bodyTree(page.document);
      // The comparison only means something on a tree that holds the page.
      expect(JSON.stringify(expected)).toContain('"id":"usage-cards"');
      expect(JSON.stringify(expected)).toContain("usage-card-refresh");
      expect(drawn).toEqual(expected);
    } finally {
      old.close();
      page.close();
    }
  });

  it("draws the same tree for an empty answer and for a held value", async () => {
    const empty = { generatedAt: 1, timezone: "Asia/Tokyo", cards: [] };
    const oldEmpty = await oldTree("usage-empty");
    const newEmpty = await open(empty);
    try {
      expect(bodyTree(newEmpty.document)).toEqual(bodyTree(oldEmpty.document));
    } finally {
      oldEmpty.close();
      newEmpty.close();
    }

    const held = {
      generatedAt: 1,
      timezone: "Asia/Tokyo",
      cards: [
        {
          ...ANTHROPIC.cards[0]!,
          hold: { kind: "kept", nextAt: { at: 4, label: "2026-10-25 08:10" } },
        },
      ],
    };
    const oldHeld = await oldTree("usage-held");
    const newHeld = await open(held);
    try {
      expect(bodyTree(newHeld.document)).toEqual(bodyTree(oldHeld.document));
    } finally {
      oldHeld.close();
      newHeld.close();
    }
  });

  it("keeps the billing link and the console link the old page drew", async () => {
    const page = await open(BOTH);
    try {
      const console_ = page.document.querySelector(`a[href="${BILLING_URL}"]`);
      expect(console_?.textContent).toBe("Console billing");
      expect(console_?.getAttribute("target")).toBe("_blank");
      expect(console_?.getAttribute("rel")).toBe("noreferrer noopener");
      expect(page.document.querySelector(`a[href="${SYNTHETIC_BILLING_URL}"]`)).toBeNull();
    } finally {
      page.close();
    }
  });
});
