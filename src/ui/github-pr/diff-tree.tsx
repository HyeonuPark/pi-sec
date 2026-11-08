/**
 * The diff page's sidebar: the two ways out of the page, and the changed files as a
 * tree.
 *
 * A file's row carries its status letter and its two line counts, which is the
 * quickest answer to "which of these do I need to read". Pressing a row brings that
 * file to the top of the panes, and the row of the file the reader is looking at is
 * marked, which is the one thing a long diff cannot do without: a reader scrolling
 * the code must be able to see where they are in the tree without reading it.
 *
 * The tree folds a directory when its name is pressed. The original did the same,
 * and a diff of a deep tree is unreadable without it.
 *
 * A file the reader folded down to its header is still a row here: the tree lists the
 * changed files, not the open ones.
 */
import type { GithubPrFile } from "../api/github-pr.ts";
import { filePath, type TreeEntry } from "./diff-model.ts";
import { listUrl, prUrl } from "./urls.ts";

export interface DiffTreeProps {
  readonly repo: string;
  readonly number: number;
  readonly files: readonly GithubPrFile[];
  readonly tree: readonly TreeEntry[];
  /** The file the panes are showing, which is the row that is marked. */
  readonly active: number;
  /** The directories the reader folded, by their path. */
  readonly folded: ReadonlySet<string>;
  readonly onSelect: (index: number) => void;
  readonly onFold: (path: string) => void;
}

/** One file's row: its status, its name, and how much it changed. */
function FileRow({
  file,
  index,
  active,
  onSelect,
}: {
  readonly file: GithubPrFile;
  readonly index: number;
  readonly active: boolean;
  readonly onSelect: (index: number) => void;
}) {
  const name = filePath(file).split("/").pop() ?? "";
  return (
    <div
      class={active ? "tree-file active" : "tree-file"}
      data-idx={String(index)}
      role="link"
      tabIndex={0}
      title={filePath(file)}
      onClick={() => {
        onSelect(index);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect(index);
      }}
    >
      <span class={`fstat fstat-${file.status}`}>{file.status}</span>
      <span class="tree-name">{name}</span>
      <span class="tree-stats">
        <span class="diff-stat-add">{`+${file.additions}`}</span>{" "}
        <span class="diff-stat-del">{`−${file.deletions}`}</span>
      </span>
    </div>
  );
}

/** The file one tree leaf names, or `undefined` when the answer has no such file. */
export function fileAt(files: readonly GithubPrFile[], index: number): GithubPrFile | undefined {
  return files[index];
}

/** What one node of the tree needs besides itself, passed down the recursion. */
interface EntryContext {
  readonly files: readonly GithubPrFile[];
  readonly active: number;
  readonly folded: ReadonlySet<string>;
  readonly onSelect: (index: number) => void;
  readonly onFold: (path: string) => void;
}

/**
 * One node of the tree: a directory, or a file's row.
 *
 * A leaf that names no file of the answer draws nothing. It cannot happen with an
 * answer this build built the tree from, and a page that threw on it would lose
 * every file rather than the one row.
 */
function Entry({ entry, path, context }: { readonly entry: TreeEntry; readonly path: string; readonly context: EntryContext }) {
  if (entry.kind === "dir") return <Directory entry={entry} path={path} context={context} />;
  const file = fileAt(context.files, entry.index);
  if (file === undefined) return null;
  return (
    <FileRow
      file={file}
      index={entry.index}
      active={entry.index === context.active}
      onSelect={context.onSelect}
    />
  );
}

/** One directory and the entries under it. */
function Directory({
  entry,
  path,
  context,
}: {
  readonly entry: Extract<TreeEntry, { kind: "dir" }>;
  readonly path: string;
  readonly context: EntryContext;
}) {
  const here = path === "" ? entry.name : `${path}/${entry.name}`;
  const closed = context.folded.has(here);
  return (
    <div class="tree-node">
      <div
        class="tree-dir"
        role="button"
        tabIndex={0}
        aria-expanded={!closed}
        onClick={() => {
          context.onFold(here);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          context.onFold(here);
        }}
      >
        {`${closed ? "▸" : "▾"} ${entry.name}/`}
      </div>
      <div class={closed ? "tree-children hidden" : "tree-children"}>
        {entry.children.map((child) => (
          <Entry key={child.name} entry={child} path={here} context={context} />
        ))}
      </div>
    </div>
  );
}

/** The sidebar: the ways out of the page, then the changed files. */
export function DiffTree({ repo, number, files, tree, active, folded, onSelect, onFold }: DiffTreeProps) {
  const context: EntryContext = { files, active, folded, onSelect, onFold };
  return (
    <div class="diff-sidebar">
      <div class="side-nav">
        <a class="btn side-nav-btn" href={prUrl(repo, number)}>
          {`← PR #${number}`}
        </a>
        <a class="btn side-nav-btn" href={listUrl()}>
          ☰ PR list
        </a>
      </div>
      <div class="tree">
        {tree.map((entry) => (
          <Entry key={entry.name} entry={entry} path="" context={context} />
        ))}
      </div>
    </div>
  );
}
