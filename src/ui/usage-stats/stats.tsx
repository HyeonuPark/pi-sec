/** The stats page body: the pickers, the p50/p90 switch and the three graphs. */
import type { UsageStatsRange, UsageStatsSlot } from "../../shared/wire/usage-stats.ts";
import { USAGE_STATS_RANGES } from "../../shared/wire/usage-stats.ts";
import { timezone } from "../mount.ts";
import {
  answer,
  percentile,
  pickModel,
  pickProvider,
  pickRange,
  range,
  status,
} from "../state/usage-stats.ts";
import { Chart, type Series } from "./chart.tsx";
import { slotLabel } from "./format.ts";

const COLORS = ["#4f7cff", "#2f9e6b", "#c98a1b", "#d64545", "#8a6ad6"];

export function Stats() {
  const data = answer.value;
  const pct = percentile.value;
  const note = status.value;
  return (
    <section id="stats-root" class="stats-root">
      {note === null ? null : <p class="stats-status" id="stats-status">{note}</p>}
      {data === null ? null : (
        <>
          <div class="stats-controls">
            <label>
              Provider{" "}
              <select id="stats-provider" value={data.provider ?? ""} onChange={(e) => pickProvider(e.currentTarget.value)}>
                {data.providers.map((entry) => (
                  <option key={entry.provider} value={entry.provider}>
                    {entry.provider} ({entry.calls})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model{" "}
              <select id="stats-model" value={data.model ?? ""} onChange={(e) => pickModel(e.currentTarget.value)}>
                {(data.providers.find((entry) => entry.provider === data.provider)?.models ?? []).map((entry) => (
                  <option key={entry.model} value={entry.model}>
                    {entry.model} ({entry.calls})
                  </option>
                ))}
              </select>
            </label>
            <label>
              Range{" "}
              <select id="stats-range" value={range.value} onChange={(e) => pickRange(e.currentTarget.value as UsageStatsRange)}>
                {USAGE_STATS_RANGES.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <span class="stats-switch" role="group" aria-label="Percentile">
              {(["p50", "p90"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  class={value === pct ? "button stats-pct active" : "button stats-pct"}
                  data-pct={value}
                  aria-pressed={value === pct}
                  onClick={() => {
                    percentile.value = value;
                  }}
                >
                  {value}
                </button>
              ))}
            </span>
          </div>
          {data.providers.length === 0 || data.provider === null ? (
            <p class="stats-empty" id="stats-empty">No model calls in this range yet.</p>
          ) : (
            <Graphs />
          )}
        </>
      )}
    </section>
  );
}

function Graphs() {
  const data = answer.value;
  if (data === null) return null;
  const pct = percentile.value;
  const zone = data.timezone !== "" ? data.timezone : timezone();
  const labels = data.slots.map((slot) => slotLabel(slot, data.step, zone));
  const bucketLines = (pick: "ttftMs" | "tpotMs"): Series[] =>
    data.buckets.map((bucket, index) => ({
      name: bucket.label,
      color: COLORS[index % COLORS.length] ?? "#888",
      values: data.slots.map((slot) => slot.buckets[index]?.[pick][pct] ?? null),
    }));
  const burstLine = (slot: UsageStatsSlot): string | null =>
    slot.bursts === 0 ? null : `${slot.bursts} ${slot.bursts === 1 ? "call" : "calls"} left out (arrived at once)`;
  return (
    <>
      <p class="stats-note">
        Prompt length groups (tokens): {data.buckets.map((bucket) => bucket.label).join(", ")}. A higher p90 is faster for
        generation speed and slower for time to first token and time per token.
      </p>
      <Chart
        id="stats-speed"
        title="Generation speed, tokens per second after the first token"
        unit="tokens/s"
        slots={data.slots}
        labels={labels}
        series={[{ name: pct, color: COLORS[0] ?? "#888", values: data.slots.map((slot) => slot.speed[pct]) }]}
        extra={burstLine}
      />
      <Chart
        id="stats-ttft"
        title="Time to first token (TTFT) by prompt length"
        unit="ms"
        slots={data.slots}
        labels={labels}
        series={bucketLines("ttftMs")}
      />
      <Chart
        id="stats-tpot"
        title="Time per output token (TPOT) by prompt length"
        unit="ms per token"
        slots={data.slots}
        labels={labels}
        series={bucketLines("tpotMs")}
        extra={burstLine}
      />
      <p class="stats-note" id="stats-bursts">
        A call faster than 1000 tokens per second after the first token arrived all at once. The speed and TPOT graphs
        leave it out, and the TTFT graph keeps it.
      </p>
      <p class="stats-note" id="stats-since">
        All three graphs hold data only from the day this feature was added. A point needs at least 3 calls in its slot.
      </p>
    </>
  );
}
