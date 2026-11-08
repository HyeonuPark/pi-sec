/**
 * The sidebar beside a pull request: the facts, the labels, the CI jobs, and the
 * two links out of the page.
 *
 * It is one box, row for row: the number, the size of the
 * diff and how many files it touches, the head branch, the labels in their own
 * colours, one row per CI job with a link to its details, and the way to the
 * diff page and back to the list. The CI rollup state is in the head of its own
 * section, beside the words, because that is where a reader looks for whether the
 * pull request can be merged at all.
 *
 * A job whose status is unknown still gets a row and a dot: a job that reported
 * nothing is a job that has not passed, and hiding it would make the head commit
 * look tested when it is not.
 */
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import type { GithubPrCheck, GithubPrCommit, GithubPrDetail } from "../api/github-pr.ts";
import { CiIcon, CheckIcon, LabelChips, ago } from "./parts.tsx";
import { commitUrl, diffUrl, listUrl } from "./urls.ts";

/** How a row says there is nothing to show, without an empty value. */
const NONE = "None";

/** One CI job: its mark, its name, and its details link when it has one. */
function CheckRow({ check }: { readonly check: GithubPrCheck }) {
  return (
    <div class="check-row">
      <CheckIcon status={check.status} />
      <span class="check-name" title={check.name}>
        {check.name}
      </span>
      {check.url === null || check.url === "" ? null : (
        <a href={check.url} target="_blank" rel="noopener noreferrer">
          details
        </a>
      )}
    </div>
  );
}

/**
 * A sidebar section whose heading is a button that hides and shows the body.
 *
 * The fold is a signal of the page only: both panels start open, and leaving the
 * page forgets the fold. `mark` stays in the heading while the body is hidden, so
 * a reader still sees the CI state with the rows folded.
 */
function FoldPanel(props: {
  readonly id: string;
  readonly title: string;
  readonly mark?: ComponentChildren;
  readonly children: ComponentChildren;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div class="side-section">
      <h4>
        <button
          class="side-fold"
          type="button"
          aria-expanded={open}
          aria-controls={props.id}
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? "\u25be" : "\u25b8"} {props.title}
        </button>{" "}
        {props.mark}
      </h4>
      <div id={props.id} class={open ? "side-fold-body" : "side-fold-body hidden"}>
        {props.children}
      </div>
    </div>
  );
}

/** One commit: its short id, its first line, its author and its age. */
function CommitRow({ repo, number, commit }: { readonly repo: string; readonly number: number; readonly commit: GithubPrCommit }) {
  const when = ago(commit.committedDate);
  return (
    <a class="commit-row" href={commitUrl(repo, number, commit.oid)} target="_blank" rel="noopener noreferrer">
      <span class="commit-oid">{commit.abbreviatedOid}</span>
      <span class="commit-headline" title={commit.headline}>
        {commit.headline}
      </span>
      <span class="commit-meta" title={commit.committedDate}>
        {commit.author ?? "unknown"}
        {when === "" ? "" : ` \u00b7 ${when}`}
      </span>
    </a>
  );
}

/** The Commits panel: the newest commits, and a line when GitHub has more. */
function CommitsPanel({ pr }: { readonly pr: GithubPrDetail }) {
  const commits = pr.commits;
  const total = pr.totalCommits ?? commits?.length ?? 0;
  return (
    <FoldPanel id="side-commits" title={commits === undefined ? "Commits" : `Commits (${total})`}>
      {commits === undefined ? (
        <div class="side-row">
          <span class="k">Loading commits…</span>
        </div>
      ) : commits.length === 0 ? (
        <div class="side-row">
          <span class="k">No commits</span>
        </div>
      ) : (
        <div class="side-list">
          {commits.map((commit) => (
            <CommitRow key={commit.oid} repo={pr.repo} number={pr.number} commit={commit} />
          ))}
        </div>
      )}
      {commits !== undefined && total > commits.length ? (
        <div class="side-row commit-more">
          <span class="k">{`Showing the newest ${commits.length} of ${total} commits`}</span>{" "}
          <a href={`${pr.url}/commits`} target="_blank" rel="noopener noreferrer">
            all on GitHub
          </a>
        </div>
      ) : null}
    </FoldPanel>
  );
}

export interface SideBarProps {
  readonly pr: GithubPrDetail;
}

/** The sidebar of one pull request. */
export function SideBar({ pr }: SideBarProps) {
  const files = pr.changedFiles === 1 ? "1 file" : `${pr.changedFiles} files`;
  return (
    <div class="dash-side">
      <div class="side-box">
        <div class="side-section">
          <h4>Pull request</h4>
          <div class="side-row">
            <span class="k">Number</span>
            <span>{`#${pr.number}`}</span>
          </div>
          <div class="side-row">
            <span class="k">Diff</span>
            <span>
              <span class="diff-stat-add">{`+${pr.additions}`}</span>{" "}
              <span class="diff-stat-del">{`\u2212${pr.deletions}`}</span>
              {` \u00b7 ${files}`}
            </span>
          </div>
          <div class="side-row">
            <span class="k">Branch</span>
            <span title={pr.headRefName}>{pr.headRefName}</span>
          </div>
          <div class="side-row">
            <span class="k">Base</span>
            <span title={pr.baseRefName}>{pr.baseRefName}</span>
          </div>
        </div>
        <div class="side-section">
          <h4>Labels</h4>
          {pr.labels.length === 0 ? (
            <div class="side-row">
              <span class="k">{NONE}</span>
            </div>
          ) : (
            <LabelChips labels={pr.labels} />
          )}
        </div>
        <FoldPanel id="side-ci" title="CI status" mark={<CiIcon state={pr.ciState} />}>
          {pr.checks.length === 0 ? (
            <div class="side-row">
              <span class="k">No CI jobs</span>
            </div>
          ) : (
            <div class="side-list">
              {pr.checks.map((check) => (
                <CheckRow key={check.name} check={check} />
              ))}
            </div>
          )}
        </FoldPanel>
        <CommitsPanel pr={pr} />
        <div class="side-section">
          <a class="diff-link-btn" href={diffUrl(pr.repo, pr.number)}>
            View diff →
          </a>
          <a class="diff-link-btn side-second-link" href={listUrl()}>
            ☰ PR list
          </a>
        </div>
      </div>
    </div>
  );
}
