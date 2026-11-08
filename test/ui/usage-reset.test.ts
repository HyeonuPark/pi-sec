/**
 * The usage page's two reset sites: one card's refresh, and the whole page's
 * `↻ reload`.
 *
 * Both are server reads that arrive while the reader is looking at the page, so
 * both must leave everything the reader made alone. The element a card was drawn
 * in stays that element, the button that was pressed keeps (or gets back) the
 * focus, and the page's own scroll position does not move.
 *
 * The focus case has one detail worth a test of its own: a browser takes the focus
 * off a button it disables, and the refresh button is disabled while its request
 * runs. The page gives the focus back when the answer returns, as long as nothing
 * else took it in the meantime. The browser's own blur is what the second test
 * reproduces, because jsdom keeps the focus where a browser would drop it.
 */
import { describe, expect, it } from "vitest";
import { loadUiPage, settle, type UiPageHandle } from "./harness.ts";

/** A subscription card whose 5-hour share the answer states. */
function subscription(utilization: number, received: string) {
  return {
    provider: "anthropic",
    name: "Anthropic",
    shape: "subscription",
    receivedAt: { at: 1, label: received },
    fields: {
      fiveHour: { state: "value", value: { utilization, resetsAt: { at: 2, label: "2026-10-26 20:59" } } },
      weekly: { state: "value", value: { utilization: 72, resetsAt: null } },
      credits: { state: "wip" },
    },
  };
}

/** A prepaid card, so the page has a second card that must not be touched. */
const DEEPSEEK = {
  provider: "deepseek",
  name: "DeepSeek",
  shape: "prepaid",
  receivedAt: { at: 1, label: "2026-10-25 07:30" },
  fields: {
    balance: { state: "value", value: { amount: 11.25, currency: "USD" } },
    day: { state: "value", value: { calls: 12, tokens: 21_000, cost: 0.37 } },
    week: { state: "wip" },
    month: { state: "wip" },
    daily: { state: "wip" },
  },
};

/** The whole answer a page load gets. */
function answer(anthropic: Record<string, unknown>) {
  return { generatedAt: 1, timezone: "Asia/Tokyo", cards: [anthropic, DEEPSEEK] };
}

/** One element, and the things a redraw could take from it. */
function elementOf(page: UiPageHandle, selector: string): HTMLElement {
  const element = page.document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`the page has no element matching ${selector}`);
  return element;
}

describe("one card's refresh", () => {
  it("leaves every other card and the pressed button's focus where they were", async () => {
    let release: (() => void) | null = null;
    const refreshed = { generatedAt: 2, timezone: "Asia/Tokyo", card: subscription(91, "2026-10-25 07:41") };
    const page = await loadUiPage("usage", {
      fetch: {
        "/api/usage": { body: answer(subscription(28, "2026-10-25 07:30")) },
        "/api/usage/refresh": () =>
          new Promise((resolve) => {
            release = () => resolve({ body: refreshed });
          }),
      },
    });
    try {
      const anthropic = elementOf(page, '[data-provider="anthropic"]');
      const deepseek = elementOf(page, '[data-provider="deepseek"]');
      const fill = anthropic.querySelector(".usage-bar-fill") as HTMLElement;
      const button = anthropic.querySelector(".usage-card-refresh") as HTMLButtonElement;
      button.focus();

      const pressed = page.capture('[data-provider="anthropic"] .usage-card-refresh');
      const neighbour = page.capture('[data-provider="deepseek"]');
      button.click();
      await settle();
      release!();
      await settle();

      // The card is redrawn in place: the same article, the same bar, a new length.
      expect(page.expectUntouched(pressed));
      expect(page.expectUntouched(neighbour));
      expect(elementOf(page, '[data-provider="anthropic"]')).toBe(anthropic);
      expect(elementOf(page, '[data-provider="deepseek"]')).toBe(deepseek);
      expect(anthropic.querySelector(".usage-bar-fill")).toBe(fill);
      expect(fill.style.width).toBe("91%");
      expect(anthropic.textContent).toContain("value received 2026-10-25 07:41");
      expect(deepseek.textContent).toContain("$11.25");
    } finally {
      page.close();
    }
  });

  it("gives the pressed button its focus back after the browser drops it", async () => {
    let release: (() => void) | null = null;
    const page = await loadUiPage("usage", {
      fetch: {
        "/api/usage": { body: answer(subscription(28, "2026-10-25 07:30")) },
        "/api/usage/refresh": () =>
          new Promise((resolve) => {
            release = () => resolve({ body: { generatedAt: 2, timezone: "Asia/Tokyo", card: subscription(30, "2026-10-25 07:42") } });
          }),
      },
    });
    try {
      const button = elementOf(page, '[data-provider="anthropic"] .usage-card-refresh') as HTMLButtonElement;
      button.focus();
      expect(page.document.activeElement).toBe(button);

      button.click();
      await settle();
      // A browser takes the focus off a button it disables, and jsdom keeps it, so
      // the test moves the focus away and drops it: that is where a browser ends up.
      const elsewhere = elementOf(page, "#reload-usage") as HTMLButtonElement;
      elsewhere.focus();
      elsewhere.blur();
      expect(page.document.activeElement).toBe(page.document.body);

      release!();
      await settle();

      // The answer came back to a button nobody had focused in the meantime.
      expect(page.document.activeElement).toBe(button);
      expect(button.disabled).toBe(false);
    } finally {
      page.close();
    }
  });
});

describe("the whole page's reload", () => {
  it("matches every card by its provider id, so each element stays the same element", async () => {
    const page = await loadUiPage("usage", {
      fetch: { "/api/usage": { body: answer(subscription(28, "2026-10-25 07:30")) } },
    });
    try {
      const anthropic = elementOf(page, '[data-provider="anthropic"]');
      const deepseek = elementOf(page, '[data-provider="deepseek"]');
      const fill = anthropic.querySelector(".usage-bar-fill") as HTMLElement;
      const reload = elementOf(page, "#reload-usage") as HTMLButtonElement;

      reload.focus();
      page.respond("/api/usage", { body: answer(subscription(91, "2026-10-25 07:41")) });
      const pressed = page.capture("#reload-usage");
      reload.click();
      await settle();

      expect(page.expectUntouched(pressed));
      expect(elementOf(page, '[data-provider="anthropic"]')).toBe(anthropic);
      expect(elementOf(page, '[data-provider="deepseek"]')).toBe(deepseek);
      expect(anthropic.querySelector(".usage-bar-fill")).toBe(fill);
      expect(fill.style.width).toBe("91%");
      expect(page.document.querySelectorAll(".usage-card")).toHaveLength(2);
      expect(page.fetchCalls.map((call) => call.path)).toEqual(["/api/usage", "/api/usage"]);
    } finally {
      page.close();
    }
  });

  it("keeps the page's scroll position and the extension slot", async () => {
    const page = await loadUiPage("usage", {
      fetch: { "/api/usage": { body: answer(subscription(28, "2026-10-25 07:30")) } },
    });
    try {
      const scroll = elementOf(page, ".usage-scroll");
      scroll.scrollTop = 120;
      const slot = elementOf(page, '[data-ui-slot="usage.cards"]');
      const scrolled = page.capture(".usage-scroll");
      const slotBefore = page.capture('[data-ui-slot="usage.cards"]');

      page.respond("/api/usage", { body: answer(subscription(29, "2026-10-25 07:45")) });
      elementOf(page, "#reload-usage").click();
      await settle();

      expect(page.expectUntouched(scrolled));
      expect(page.expectUntouched(slotBefore));
      expect(scroll.scrollTop).toBe(120);
      expect(elementOf(page, '[data-ui-slot="usage.cards"]')).toBe(slot);
      expect(page.document.body.textContent).toContain("29%");
    } finally {
      page.close();
    }
  });

  /**
   * The one exception on this page: a card the answer no longer holds is a provider
   * that lost its login or left the catalog, and its element goes with it. Nothing
   * of the reader's lived in that card, and every other card stays where it is.
   */
  it("drops a card the answer no longer holds, and leaves the other cards alone", async () => {
    const page = await loadUiPage("usage", {
      fetch: { "/api/usage": { body: answer(subscription(28, "2026-10-25 07:30")) } },
    });
    try {
      const deepseek = elementOf(page, '[data-provider="deepseek"]');
      const kept = page.capture('[data-provider="deepseek"]');

      page.respond("/api/usage", { body: { generatedAt: 2, timezone: "Asia/Tokyo", cards: [DEEPSEEK] } });
      elementOf(page, "#reload-usage").click();
      await settle();

      expect(page.document.querySelector('[data-provider="anthropic"]')).toBeNull();
      expect(elementOf(page, '[data-provider="deepseek"]')).toBe(deepseek);
      expect(page.expectUntouched(kept));
    } finally {
      page.close();
    }
  });

  it("keeps the drawn cards when the read fails", async () => {
    const page = await loadUiPage("usage", {
      fetch: { "/api/usage": { body: answer(subscription(28, "2026-10-25 07:30")) } },
    });
    try {
      const anthropic = elementOf(page, '[data-provider="anthropic"]');
      const fill = anthropic.querySelector(".usage-bar-fill") as HTMLElement;
      const drawn = page.capture('[data-provider="anthropic"]');

      page.respond("/api/usage", { status: 503, body: { error: { code: "unavailable", message: "down" } } });
      elementOf(page, "#reload-usage").click();
      await settle();

      expect(page.expectUntouched(drawn));
      expect(elementOf(page, '[data-provider="anthropic"]')).toBe(anthropic);
      expect(anthropic.querySelector(".usage-bar-fill")).toBe(fill);
      expect(fill.style.width).toBe("28%");
      expect(page.document.getElementById("usage-status")?.textContent).toBe("Could not read usage (HTTP 503).");
    } finally {
      page.close();
    }
  });
});
