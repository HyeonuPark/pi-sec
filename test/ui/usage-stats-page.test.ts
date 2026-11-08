/**
 * The model speed page, drawn from a fixed answer of `GET /api/usage/stats`.
 */
import { describe, expect, it } from "vitest";
import { loadUiPage, settle } from "./harness.ts";

const pc = (p50: number | null, p90: number | null, count = 5) => ({ p50, p90, count });
const bucketSlot = (v: number | null) => ({ ttftMs: pc(v, v === null ? null : v * 2), tpotMs: pc(v, v === null ? null : v * 3) });
const BUCKETS = ["a", "b", "c", "d", "e"].map((key, i) => ({ key, label: `bucket-${key}`, from: i * 1000, to: i === 4 ? null : (i + 1) * 1000 }));
const HOUR = 3_600_000;

function slot(index: number, value: number | null, bursts = 0) {
  return {
    from: 1_700_000_000_000 + index * HOUR,
    to: 1_700_000_000_000 + (index + 1) * HOUR,
    calls: value === null ? 1 : 9,
    failed: 0,
    bursts,
    speed: pc(value, value === null ? null : value * 2),
    buckets: BUCKETS.map(() => bucketSlot(value)),
  };
}

const ANSWER = {
  generatedAt: 1_700_010_000_000,
  timezone: "Asia/Tokyo",
  provider: "anthropic",
  model: "sonnet",
  range: "7d",
  step: "hour",
  providers: [
    { provider: "anthropic", calls: 40, models: [{ model: "sonnet", calls: 30 }, { model: "haiku", calls: 10 }] },
    { provider: "openai", calls: 5, models: [{ model: "gpt", calls: 5 }] },
  ],
  buckets: BUCKETS,
  slots: [slot(0, 10), slot(1, 20), slot(2, null), slot(3, 30)],
};

async function open(body: unknown = ANSWER) {
  return await loadUiPage("usage-stats", { fetch: { "/api/usage/stats": { body } } });
}

describe("the usage stats page", () => {
  it("draws three SVG graphs, one TTFT and one TPOT line per bucket, and fills the pickers", async () => {
    const page = await open();
    const doc = page.document;
    expect(doc.querySelectorAll("svg.stats-svg")).toHaveLength(3);
    expect(doc.querySelector("#stats-speed .stats-chart-title")?.textContent).toContain(
      "Generation speed, tokens per second after the first token",
    );
    expect(doc.querySelectorAll("#stats-speed g.stats-line")).toHaveLength(1);
    expect(doc.querySelectorAll("#stats-ttft g.stats-line")).toHaveLength(5);
    expect(doc.querySelectorAll("#stats-tpot g.stats-line")).toHaveLength(5);
    const options = (id: string) => [...doc.querySelectorAll(`#${id} option`)].map((o) => (o as HTMLOptionElement).value);
    expect(options("stats-provider")).toEqual(["anthropic", "openai"]);
    expect(options("stats-model")).toEqual(["sonnet", "haiku"]);
    expect(options("stats-range")).toEqual(["24h", "7d", "30d", "90d"]);
    expect((doc.querySelector("#stats-range") as HTMLSelectElement).value).toBe("7d");
    expect(doc.querySelector("#stats-since")?.textContent).toContain("only from the day this feature was added");
    expect(page.fetchCalls.at(0)?.path).toBe("/api/usage/stats");
  });

  it("shows the number of left-out calls in the speed and TPOT hover labels, and the rule note", async () => {
    const page = await open({ ...ANSWER, slots: [slot(0, 10, 4), slot(1, 20, 0)] });
    const doc = page.document;
    const titles = (id: string) => [...doc.querySelectorAll(`#${id} circle title`)].map((t) => t.textContent ?? "");
    const speed = titles("stats-speed");
    expect(speed[0]).toContain("4 calls left out");
    expect(speed[1]).not.toContain("left out");
    const tpot = titles("stats-tpot");
    expect(tpot.filter((t) => t.includes("4 calls left out"))).toHaveLength(5);
    expect(tpot.filter((t) => t.includes("left out"))).toHaveLength(5);
    expect(titles("stats-ttft").some((t) => t.includes("left out"))).toBe(false);
    const note = doc.querySelector("#stats-bursts")?.textContent ?? "";
    expect(note).toContain("1000 tokens per second");
    expect(note).toContain("TTFT");
  });

  it("breaks a line at a null slot and switches between p50 and p90", async () => {
    const page = await open();
    const doc = page.document;
    // Slots 0,1 | gap | 3: one polyline of two points, and a lone point with no line.
    const lines = doc.querySelectorAll("#stats-speed g.stats-line polyline");
    expect(lines).toHaveLength(1);
    expect(doc.querySelectorAll("#stats-speed circle")).toHaveLength(3);
    const first = () => doc.querySelector("#stats-speed circle title")?.textContent ?? "";
    expect(first()).toContain("10.0 tokens/s");
    expect(first()).toContain("9 calls");
    (doc.querySelector('button[data-pct="p90"]') as HTMLButtonElement).click();
    await settle();
    expect(first()).toContain("20.0 tokens/s");
  });

  it("reads again with the picked provider, and drops the model on a provider change", async () => {
    const page = await open();
    const doc = page.document;
    const select = doc.querySelector("#stats-provider") as HTMLSelectElement;
    select.value = "openai";
    select.dispatchEvent(new page.window.Event("change", { bubbles: true }));
    await settle();
    const last = page.fetchCalls.at(-1);
    expect(last?.url).toContain("provider=openai");
    expect(last?.url).not.toContain("model=");
  });

  it("says so when there is no data", async () => {
    const page = await open({ ...ANSWER, provider: null, model: null, providers: [], slots: [] });
    expect(page.document.querySelector("#stats-empty")?.textContent).toContain("No model calls");
    expect(page.document.querySelectorAll("svg.stats-svg")).toHaveLength(0);
  });
});
