/**
 * The list page's rows, and the sections they sit in.
 *
 * The shape is the original's, unchanged: one box per section, its title and its
 * count in the box's head, and one row per pull request. A row is an `<a>` and not
 * a button, because every page here has its own address: a reader can open a row
 * in a new tab, copy its link and send it on, and the browser's back button goes
 * back to the list.
 *
 * What a row says, in the original's order: the draft mark, the title, the labels,
 * then one line with the number, the author, the two branches and how long ago it
 * moved, and finally the head commit's CI mark. The repository name is added to
 * that line only when the dashboard watches more than one repository, which is
 * what keeps a single-repository page as short as it was.
 *
 * A section with no row is not hidden: it says so in its own words, because an
 * empty `Mentioned` section is the answer to "does anything wait on me", and a
 * missing box would leave the reader wondering whether the page finished loading.
 */
import type { GithubPrItem, GithubPrSection } from "../api/github-pr.ts";
import { CiIcon, LabelChips, ago } from "./parts.tsx";
import { prUrl } from "./urls.ts";

/** The words of a section that has no row, by the section's own key. */
const EMPTY_SECTIONS: Readonly<Record<string, string>> = {
  mentioned: "No pull requests",
  "need-review": "No pull requests",
  opened: "No pull requests",
  draft: "No pull requests",
  related: "No pull requests",
};

/** What an empty section says. A section this build does not know says the same. */
export function emptySectionText(key: string): string {
  return EMPTY_SECTIONS[key] ?? "No pull requests";
}

/** The draft mark or the open mark that starts a row. */
function RowIcon({ isDraft }: { readonly isDraft: boolean }) {
  return (
    <span class="pr-icon" aria-hidden="true">
      {isDraft ? "◐" : "⊙"}
    </span>
  );
}

/** One pull request's row, as a link to its page. */
export function PrRow({ pr, multiRepo }: { readonly pr: GithubPrItem; readonly multiRepo: boolean }) {
  const updated = ago(pr.updatedAt);
  return (
    <a class="pr-row" href={prUrl(pr.repo, pr.number)}>
      <RowIcon isDraft={pr.isDraft} />
      <div class="pr-main">
        <div class="pr-title">
          {pr.title}
          <LabelChips labels={pr.labels} />
        </div>
        <div class="pr-sub">
          {`#${pr.number} · ${pr.author ?? "?"} · ${pr.headRefName} → ${pr.baseRefName}`}
          {updated === "" ? "" : ` · updated ${updated}`}
          {multiRepo ? ` · ${pr.repo}` : ""}
        </div>
      </div>
      <span class="pr-ci">
        <CiIcon state={pr.ciState} />
      </span>
    </a>
  );
}

/** One section: its head, and its rows or its one sentence. */
export function PrSection({ section, multiRepo }: { readonly section: GithubPrSection; readonly multiRepo: boolean }) {
  return (
    <div class="section">
      <div class="section-header">
        {section.title}
        <span class="section-count">{section.prs.length}</span>
      </div>
      {section.prs.length === 0 ? (
        <div class="section-empty">{emptySectionText(section.key)}</div>
      ) : (
        section.prs.map((pr) => <PrRow key={`${pr.repo}#${pr.number}`} pr={pr} multiRepo={multiRepo} />)
      )}
    </div>
  );
}

/** Every section of one answer, in the order the server wrote them. */
export function PrSections({
  sections,
  repos,
}: {
  readonly sections: readonly GithubPrSection[];
  readonly repos: number;
}) {
  const multiRepo = repos > 1;
  return (
    <div class="pr-list">
      {sections.map((section) => (
        <PrSection key={section.key} section={section} multiRepo={multiRepo} />
      ))}
    </div>
  );
}
