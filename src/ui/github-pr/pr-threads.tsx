/**
 * One review thread: where it sits, the lines it was written on, and what was
 * said in it.
 *
 * A thread belongs to a file and a line range, and the code it was written on
 * arrives with it as the hunk GitHub kept, so the card can show the lines without
 * reading the diff page's answer. The hunk is a small table with three kinds of
 * row: the `@@` header, a removed line, an added line, and a line that stayed.
 * The `+` and `-` marks sit in a cell of their own, so dragging across the code
 * copies the code and not the marks.
 *
 * A file thread (a comment on a whole file) has no lines: GitHub sends line 1 and
 * an empty hunk with it. Its card shows the path alone, a "File comment" flag,
 * and a note in the place of the code table.
 *
 * A resolved thread is drawn folded, with one button that says how many comments
 * are inside and opens them. A thread the page was opened at (the address carries
 * `#thread-<id>`) is opened by the page rather than by the card, and the card
 * says so with the `thread-target` class so the stylesheet can outline it.
 *
 * The reply box and the "Resolve conversation" button are drawn only when the
 * write switch is on: each would send a request to GitHub, so each is a write
 * control, and this dashboard draws none while the switch is off. The resolve
 * button also needs an unresolved thread that GitHub lets this account resolve.
 * The Edit button of a comment in the thread is a write control too, drawn only
 * for a comment this account wrote and may edit.
 */
import { useRef, useState } from "preact/hooks";
import { isFileThread, type GithubPrComment, type GithubPrThread } from "../api/github-pr.ts";
import { MarkdownBody } from "./html.tsx";
import { canEdit, EditBox, ReactionBar, type EditBoxProps } from "./pr-comments.tsx";
import { ago } from "./parts.tsx";

/**
 * The line range a thread is written on, as one string, or an empty one.
 *
 * A thread that moved with the file states its new lines, and one whose lines are
 * gone states the lines they were on when it was written. A range from the first
 * line to the last is written with an en dash, and a single line as one number.
 * The span is the answer to "where on this file", so it is here rather than on the
 * card: the diff page marks the same lines and asks the same question.
 */
export function threadSpan(thread: {
  readonly line: number | null;
  readonly startLine: number | null;
  readonly originalLine: number | null;
  readonly originalStartLine: number | null;
}): string {
  const end = thread.line ?? thread.originalLine;
  const start = thread.line !== null ? thread.startLine : thread.originalStartLine;
  if (end === null) return "";
  if (start !== null && start !== end) return `${start}–${end}`;
  return `${end}`;
}

/** One row of a hunk, as the line's own kind names it. */
interface HunkRow {
  /** The class of the row: added, removed, or the `@@` header. */
  readonly cls: string;
  /** The `+` or `-` mark, or an empty cell. */
  readonly sign: string;
  /** The line without its mark. */
  readonly text: string;
}

/** The rows of one hunk, in order. */
export function hunkRows(diffHunk: string): HunkRow[] {
  return diffHunk.split("\n").map((line) => {
    if (line.startsWith("@@")) return { cls: "l-hunk", sign: "", text: line };
    if (line.startsWith("+")) return { cls: "l-add", sign: "+", text: line.slice(1) };
    if (line.startsWith("-")) return { cls: "l-del", sign: "-", text: line.slice(1) };
    if (line.startsWith(" ")) return { cls: "", sign: "", text: line.slice(1) };
    return { cls: "", sign: "", text: line };
  });
}

/**
 * The hunk a thread was written on, as a small table.
 *
 * The text is drawn as text and not as markdown: it is a file's own lines, and a
 * line that starts with `#` is a comment in one language and a heading in
 * markdown.
 */
export function HunkTable({ diffHunk }: { readonly diffHunk: string | null }) {
  if (diffHunk === null || diffHunk === "") return null;
  return (
    <div class="hunk-wrap">
      <table class="hunk-table">
        <tbody>
          {hunkRows(diffHunk).map((row, index) => (
            <tr key={index} class={row.cls}>
              <td class="sign">{row.sign}</td>
              <td>{row.text === "" ? "\u00a0" : row.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface ReplyBoxProps {
  /** What the box's button says. */
  readonly label: string;
  /** The placeholder in the box. */
  readonly placeholder: string;
  /** Send the words; the page answers when GitHub took them. */
  readonly onSend: (body: string) => Promise<boolean> | boolean;
}

/**
 * A box that writes one comment.
 *
 * The button is disabled while the request is in flight and says `Sending…`, so a
 * second press cannot send the same comment twice. An empty box sends nothing:
 * GitHub refuses an empty comment, and the page would only show that refusal.
 */
export function ReplyBox({ label, placeholder, onSend }: ReplyBoxProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const send = (): void => {
    const body = text.trim();
    if (body === "" || sending) return;
    setSending(true);
    const done = (ok: boolean): void => {
      setSending(false);
      if (ok) setText("");
    };
    try {
      void Promise.resolve(onSend(body)).then(done, () => {
        done(false);
      });
    } catch {
      done(false);
    }
  };
  return (
    <div class="reply-box">
      <textarea
        placeholder={placeholder}
        value={text}
        aria-label={placeholder}
        onInput={(event) => {
          setText((event.target as HTMLTextAreaElement).value);
        }}
      />
      <div class="reply-actions">
        <button class="btn btn-primary reply-btn" type="button" disabled={sending} onClick={send}>
          {sending ? "Sending…" : label}
        </button>
      </div>
    </div>
  );
}

export interface ThreadCardProps {
  readonly thread: GithubPrThread;
  /** True when the write switch is on, which is what draws the reply box. */
  readonly writes: boolean;
  /** Whether the thread starts folded: a resolved thread does, unless it is the one the page was opened at. */
  readonly open: boolean;
  /** Whether this is the thread the address names. */
  readonly targeted: boolean;
  /** Press a reaction on one of the thread's comments. */
  readonly onReact: (comment: GithubPrComment, content: string, add: boolean) => Promise<void> | void;
  /** Answer the thread. */
  readonly onReply: (thread: GithubPrThread, body: string) => Promise<boolean> | boolean;
  /** Resolve the thread; the page answers when GitHub did. */
  readonly onResolve?: (thread: GithubPrThread) => Promise<boolean> | boolean;
  /** Save an edited comment of the thread. Given only when the page lets comments be edited. */
  readonly onEdit?: (comment: GithubPrComment, text: string, base: string) => ReturnType<EditBoxProps["onSave"]>;
}

interface ThreadCommentProps {
  readonly comment: GithubPrComment;
  readonly writes: boolean;
  readonly onReact: ThreadCardProps["onReact"];
  readonly onEdit: ThreadCardProps["onEdit"];
}

/** One comment of a thread, with its Edit button and edit box. */
function ThreadComment({ comment, writes, onReact, onEdit }: ThreadCommentProps) {
  const [editing, setEditing] = useState(false);
  return (
    <div class="thread-comment">
      <div class="meta">
        <span class="author">{comment.author ?? "ghost"}</span>
        {ago(comment.createdAt) === "" ? null : ` · ${ago(comment.createdAt)}`}
        {writes && onEdit !== undefined && canEdit(comment) && !editing ? (
          <button
            class="btn edit-btn"
            type="button"
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit
          </button>
        ) : null}
      </div>
      {/* A thread comment's body carries no class of its own, as in the
          original: the stylesheet colours `.thread-comment pre` and
          `.thread-comment .meta`, and a `.comment-body` here would add
          the padding of a comment card inside the card. */}
      {editing && onEdit !== undefined ? (
        <EditBox
          base={comment.body ?? ""}
          onSave={(text, base) => onEdit(comment, text, base)}
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : (
        <MarkdownBody source={comment.body} />
      )}
      <ReactionBar comment={comment} writes={writes} onReact={onReact} />
    </div>
  );
}

/**
 * The "Resolve conversation" button.
 *
 * It is disabled while the request is in flight and says `Resolving…`, so a
 * second press sends nothing. A refusal leaves the button where it was.
 */
export function ResolveButton({ onResolve }: { readonly onResolve: () => Promise<boolean> | boolean }) {
  const [busy, setBusy] = useState(false);
  // A ref as well as the state: two presses before the next render both see the
  // state as idle, and only the ref stops the second one.
  const inFlight = useRef(false);
  const press = (): void => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const done = (): void => {
      inFlight.current = false;
      setBusy(false);
    };
    try {
      void Promise.resolve(onResolve()).then(done, done);
    } catch {
      done();
    }
  };
  return (
    <div class="resolve-row">
      <button class="btn resolve-btn" type="button" disabled={busy} onClick={press}>
        {busy ? "Resolving…" : "Resolve conversation"}
      </button>
    </div>
  );
}

/**
 * One review thread.
 *
 * The fold is the card's own state, because it is a thing the reader does and not
 * a thing the address says: `open` is only the value it starts at.
 */
export function ThreadCard({ thread, writes, open, targeted, onReact, onReply, onResolve, onEdit }: ThreadCardProps) {
  const [shown, setShown] = useState(open);
  const file = isFileThread(thread);
  const span = file ? "" : threadSpan(thread);
  const count = thread.comments.length;
  const comments = count === 1 ? "1 comment" : `${count} comments`;
  const classes = ["thread-card"];
  if (targeted) classes.push("thread-target");
  return (
    <div class={classes.join(" ")} id={`thread-${thread.id}`}>
      <div class="thread-path">
        <span class="thread-file">{span === "" ? thread.path : `${thread.path}:${span}`}</span>
        <span class="thread-flags">
          {file ? <span class="flag flag-file">File comment</span> : null}
          {thread.isResolved ? <span class="flag flag-resolved">Resolved</span> : null}
          {thread.isOutdated ? <span class="flag flag-outdated">Outdated</span> : null}
        </span>
      </div>
      {thread.isResolved ? (
        <button
          class="thread-toggle"
          type="button"
          aria-expanded={shown}
          onClick={() => {
            setShown(!shown);
          }}
        >
          {shown ? `▾ Hide resolved thread (${comments})` : `▸ Show resolved thread (${comments})`}
        </button>
      ) : null}
      <div class={shown ? "thread-inner" : "thread-inner hidden"}>
        {file ? (
          <div class="thread-file-note">This comment is on the whole file, so no lines are shown.</div>
        ) : (
          <HunkTable diffHunk={thread.diffHunk} />
        )}
        <div class="thread-comments">
          {thread.comments.map((comment) => (
            <ThreadComment key={comment.id} comment={comment} writes={writes} onReact={onReact} onEdit={onEdit} />
          ))}
        </div>
        {writes ? (
          <ReplyBox
            label="Reply"
            placeholder="Reply to this thread…"
            onSend={(body) => onReply(thread, body)}
          />
        ) : null}
        {writes && !thread.isResolved && thread.viewerCanResolve === true && onResolve !== undefined ? (
          <ResolveButton onResolve={() => onResolve(thread)} />
        ) : null}
      </div>
    </div>
  );
}
