/**
 * The small pieces more than one dashboard page draws.
 *
 * They are here rather than in `src/ui/components/` because they know this
 * dashboard's payloads and its stylesheet, and because the chat, report and usage
 * pages must not grow a second palette: `github-pr.css` is the only stylesheet
 * these three pages load.
 */
import { relativeTime } from "../components/relative-time.ts";
import type { GithubPrLabel } from "../api/github-pr.ts";

/**
 * How long ago a GitHub timestamp was, in the words pi-sec's other pages use.
 *
 * GitHub states a moment as an ISO string. A string this build cannot read
 * answers an empty string, so the caller prints its own sentence without a time
 * rather than `NaN`.
 */
export function ago(iso: string | null | undefined): string {
  if (typeof iso !== "string" || iso === "") return "";
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return "";
  return relativeTime(at);
}

/** The hex value `#rrggbb` of a label colour, or GitHub's default grey. */
function labelColor(color: string | undefined): string {
  const value = String(color ?? "").trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toLowerCase()}` : "#d1d9e0";
}

/**
 * Whether a label's own colour is light enough for dark text on it.
 *
 * The weights are the ones for a perceived brightness, so a bright yellow reads
 * with dark letters and a deep blue with white ones. The original decided this in
 * the same place and by the same numbers.
 */
function usesDarkText(hex: string): boolean {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 150;
}

/**
 * One label chip, in the label's own colour.
 *
 * The colour arrives as a Preact style object and not as a `style` attribute in
 * the markup, because the pages are served under `style-src 'self'`: a style
 * attribute is refused there, and a property set through the CSSOM is what the
 * browser accepts. That is the one place this dashboard departs from the original
 * markup, and it is why a chip is a component rather than a string.
 */
export function LabelChip({ label }: { readonly label: GithubPrLabel }) {
  const background = labelColor(label.color);
  return (
    <span class="label-chip" style={{ backgroundColor: background, color: usesDarkText(background) ? "#1f2328" : "#ffffff" }}>
      {label.name}
    </span>
  );
}

/** Every label of one pull request, in the order GitHub listed them. */
export function LabelChips({ labels }: { readonly labels: readonly GithubPrLabel[] }) {
  if (labels.length === 0) return null;
  return (
    <>
      {labels.map((label) => (
        <LabelChip key={label.name} label={label} />
      ))}
    </>
  );
}

/** The mark, word and colour of one CI rollup state, or `undefined` for none. */
const CI_ICONS: Readonly<Record<string, { readonly glyph: string; readonly cls: string; readonly title: string }>> = {
  SUCCESS: { glyph: "✓", cls: "ci-ok", title: "CI passed" },
  FAILURE: { glyph: "✕", cls: "ci-fail", title: "CI failed" },
  ERROR: { glyph: "✕", cls: "ci-fail", title: "CI error" },
  PENDING: { glyph: "●", cls: "ci-pending", title: "CI running" },
  EXPECTED: { glyph: "●", cls: "ci-pending", title: "CI expected" },
};

/**
 * The head commit's CI state as one mark.
 *
 * A state this build does not know is printed as its own word, which is what the
 * original did: an unknown state is still information, and dropping it would make
 * a pull request look untested.
 */
export function CiIcon({ state }: { readonly state: string | null | undefined }) {
  if (state === null || state === undefined || state === "") return null;
  const known = CI_ICONS[state];
  if (known === undefined) return <span class="ci-pending">{state}</span>;
  return (
    <span class={known.cls} title={known.title}>
      {known.glyph}
    </span>
  );
}

/** The mark and colour of one CI job's own status, which is a finer state. */
const CHECK_ICONS: Readonly<Record<string, string>> = {
  SUCCESS: "ci-ok",
  NEUTRAL: "ci-ok",
  SKIPPED: "ci-ok",
  FAILURE: "ci-fail",
  ERROR: "ci-fail",
  TIMED_OUT: "ci-fail",
  CANCELLED: "ci-fail",
  ACTION_REQUIRED: "ci-fail",
  STARTUP_FAILURE: "ci-fail",
};

/** One CI job's status as a mark: a tick, a cross, or the running dot. */
export function CheckIcon({ status }: { readonly status: string | null | undefined }) {
  const key = String(status ?? "").toUpperCase();
  const cls = CHECK_ICONS[key];
  if (cls === "ci-ok") return <span class="ci-ok">✓</span>;
  if (cls === "ci-fail") return <span class="ci-fail">✕</span>;
  return <span class="ci-pending">●</span>;
}
