/**
 * The decision models card.
 *
 * A judgement model runs outside every conversation, so no provider card counts
 * it: a provider card sums the calls pi-sec made inside a conversation, and a
 * judgement is not one. This card is the place those calls are shown, from the
 * audit trail, where every judgement leaves one line.
 *
 * It is drawn from the same element tree a provider card uses, so it takes its
 * place in the page's one column and the stylesheet's card rules apply to it. What
 * it does not have is a provider: no login badge, no received time, and no refresh
 * button, because there is no provider to ask and the rows are read from a file
 * rather than from a service.
 *
 * The rows name no text a judgement was shown. The audit line holds the name, the
 * provider, the model, the outcome, the tokens and the cost, and this card prints
 * exactly those.
 */
import type { UsageJudges, UsageJudgeRow, UsageJudgeTotals } from "../../shared/wire/usage.ts";
import { cost, count } from "./format.ts";

/** The three windows of a row, in the order the card draws them. */
const WINDOWS: readonly { key: "day" | "week" | "month"; name: string }[] = [
  { key: "day", name: "Last 24 hours" },
  { key: "week", name: "Last 7 days" },
  { key: "month", name: "Last 30 days" },
];

/** The line under the card: what its numbers are, and what they are not. */
export const JUDGES_NOTE = "pi-sec's own judgement calls · not counted in the provider cards";

/** `report-check · openai/gpt-6-luna`, or as much of it as the answer states. */
export function judgeTitle(row: UsageJudgeRow): string {
  const provider = row.provider ?? "";
  const model = row.model ?? "";
  const modelName = provider === "" ? model : model === "" ? provider : `${provider}/${model}`;
  const nothing = "provider not stated";
  return modelName === "" ? `${row.name} · ${nothing}` : `${row.name} · ${modelName}`;
}

/** The sentence of one window: what it cost, and how much of it gave no answer. */
export function windowText(name: string, totals: UsageJudgeTotals | undefined): string {
  const usage = totals ?? { calls: 0, tokens: 0, cost: 0, unanswered: 0 };
  return `${name}: ${count(usage.calls)} calls · ${count(usage.tokens)} tokens · ${cost(usage.cost, "USD")} · ${count(usage.unanswered)} unanswered`;
}

/** One judgement model, with its provider, its model and its three windows. */
export function JudgeRowView({ row }: { row: UsageJudgeRow }) {
  return (
    <div class="usage-field" data-judge={row.name}>
      <span class="usage-field-name">{judgeTitle(row)}</span>
      <div class="usage-field-value">
        {WINDOWS.map((window) => (
          <div class="usage-line" key={window.key}>
            {windowText(window.name, row[window.key])}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The decision models card, or nothing when the answer holds no judgement. */
export function JudgesCard({ judges }: { judges: UsageJudges | undefined }) {
  if (judges === undefined || judges.rows.length === 0) return null;
  return (
    <article class="usage-card usage-judges-card" data-card="judges">
      <header class="usage-card-head">
        <div class="usage-card-title">
          <h2 class="usage-card-name">Decision models</h2>
          <span class="usage-chip">judges</span>
        </div>
      </header>
      <div class="usage-card-body">
        {judges.rows.map((row) => (
          <JudgeRowView key={row.name} row={row} />
        ))}
      </div>
      <p class="usage-note">{JUDGES_NOTE}</p>
    </article>
  );
}
