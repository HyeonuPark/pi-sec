/**
 * One comment, and the reactions on it, as the pull request page draws them.
 *
 * A comment is the same card in three places: the description at the head of the
 * page (whose author is the pull request's author), a comment or a review
 * summary in the conversation, and a comment inside a review thread. One
 * component draws all three, and the pieces a caller adds (a review's state chip, a
 * different sentence for an empty body) are props rather than a second card.
 *
 * A review is a comment with a state, so a review in the conversation says which
 * state it left the pull request in. `reactions` reads, and reads are always on,
 * so the counts are drawn whether or not the write switch is; the eight buttons
 * that add one are drawn only when a write is allowed, because a reader pressing
 * one of those sends a request to GitHub. The Edit button is a write control in
 * the same way: it is drawn only for a comment this account wrote and may edit.
 */
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import type { GithubPrComment } from "../api/github-pr.ts";
import { MarkdownBody } from "./html.tsx";
import { ago } from "./parts.tsx";

/** The eight reactions GitHub accepts, in the order the picker shows them. */
export const REACTION_CONTENTS: readonly string[] = [
  "THUMBS_UP",
  "THUMBS_DOWN",
  "LAUGH",
  "HOORAY",
  "CONFUSED",
  "HEART",
  "ROCKET",
  "EYES",
];

/** The mark of each of the eight. */
export const REACTION_EMOJI: Readonly<Record<string, string>> = {
  THUMBS_UP: "\u{1F44D}",
  THUMBS_DOWN: "\u{1F44E}",
  LAUGH: "\u{1F604}",
  HOORAY: "\u{1F389}",
  CONFUSED: "\u{1F615}",
  HEART: "\u{2764}\u{FE0F}",
  ROCKET: "\u{1F680}",
  EYES: "\u{1F440}",
};

/** The mark of one reaction, or its content name for one this build does not know. */
export function reactionEmoji(content: string): string {
  return REACTION_EMOJI[content] ?? content;
}

export interface ReactionBarProps {
  /** The comment, review or description the reactions sit on. */
  readonly comment: GithubPrComment;
  /** True when the write switch is on, which is what draws the buttons. */
  readonly writes: boolean;
  /**
   * Press a reaction: `add` is true to add it, false to take it back.
   *
   * The page sends the request and answers when GitHub took it, so the button
   * stays disabled for as long as the round trip lasts.
   */
  readonly onReact: (comment: GithubPrComment, content: string, add: boolean) => Promise<void> | void;
}

/**
 * The reactions on one subject.
 *
 * A count is a pill with the mark and the number, marked `mine` when the reader
 * is one of the people who reacted, and pressing a pill takes the reaction back.
 * The `😀+` button opens the picker, and a choice in the picker adds that
 * reaction. Every press disables its button until the page has read the pull
 * request again, so a second press cannot race the first one.
 */
export function ReactionBar({ comment, writes, onReact }: ReactionBarProps) {
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const list = comment.reactions ?? [];
  if (comment.id === undefined || comment.id === "") return null;

  const press = (content: string, add: boolean): void => {
    setBusy(true);
    const done = (): void => {
      setBusy(false);
    };
    try {
      // The page reads the pull request again and redraws; a press that failed
      // leaves the button usable, which is what a second attempt needs.
      void Promise.resolve(onReact(comment, content, add)).then(done, done);
    } catch {
      done();
    }
  };

  return (
    <div class="reaction-bar">
      {list.map((reaction) =>
        writes ? (
          <button
            key={reaction.content}
            type="button"
            class={reaction.mine ? "reaction-pill mine" : "reaction-pill"}
            title={reaction.mine ? "Remove your reaction" : "Add your reaction"}
            disabled={busy}
            onClick={() => {
              press(reaction.content, !reaction.mine);
            }}
          >
            {`${reactionEmoji(reaction.content)} ${reaction.count}`}
          </button>
        ) : (
          <span
            key={reaction.content}
            class={reaction.mine ? "reaction-pill mine" : "reaction-pill"}
            title={reaction.mine ? "You reacted" : undefined}
          >
            {`${reactionEmoji(reaction.content)} ${reaction.count}`}
          </span>
        ),
      )}
      {writes ? (
        <>
          <button
            type="button"
            class="reaction-add"
            title="Add reaction"
            aria-label="Add reaction"
            aria-expanded={picker}
            onClick={() => {
              setPicker(!picker);
            }}
          >
            {"\u{1F600}+"}
          </button>
          <span class={picker ? "reaction-picker" : "reaction-picker hidden"}>
            {REACTION_CONTENTS.map((content) => {
              const mine = list.some((reaction) => reaction.content === content && reaction.mine);
              return (
                <button
                  key={content}
                  type="button"
                  class={mine ? "reaction-choice mine" : "reaction-choice"}
                  title={mine ? "Remove your reaction" : "Add this reaction"}
                  disabled={busy}
                  onClick={() => {
                    press(content, !mine);
                  }}
                >
                  {reactionEmoji(content)}
                </button>
              );
            })}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** Whether a comment gets an Edit button: the account wrote it and GitHub lets it edit. */
export function canEdit(comment: GithubPrComment): boolean {
  return comment.viewerCanUpdate === true && comment.viewerDidAuthor === true;
}

/** A browser text box reports every line end as `\n`, so the base text is read the same way. */
function lineEnds(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export interface EditBoxProps {
  /** The text the page drew when Edit was pressed, as the payload carried it. */
  readonly base: string;
  /** Send the new text; the page answers true when GitHub took it. */
  readonly onSave: (text: string, base: string) => Promise<boolean> | boolean;
  /** Close the box. It is called after a good save, and by Cancel. */
  readonly onClose: () => void;
}

/**
 * A text box that edits one text in place: the raw markdown, Save and Cancel.
 *
 * Cancel and a Save of unchanged text close the box and send nothing. Save is
 * disabled while the request is in flight and says `Saving…`, with a ref as well
 * as the state so two quick presses send one request. A failed save leaves the box
 * open with the typed text, because the strip under the bar already says why.
 */
export function EditBox({ base, onSave, onClose }: EditBoxProps) {
  const [text, setText] = useState(lineEnds(base));
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const save = (): void => {
    if (inFlight.current) return;
    if (text === lineEnds(base)) {
      onClose();
      return;
    }
    inFlight.current = true;
    setSaving(true);
    const done = (ok: boolean): void => {
      inFlight.current = false;
      setSaving(false);
      if (ok) onClose();
    };
    try {
      void Promise.resolve(onSave(text, base)).then(done, () => {
        done(false);
      });
    } catch {
      done(false);
    }
  };
  return (
    <div class="edit-box">
      <textarea
        value={text}
        aria-label="Edit text"
        onInput={(event) => {
          setText((event.target as HTMLTextAreaElement).value);
        }}
      />
      <div class="edit-actions">
        <button class="btn" type="button" disabled={saving} onClick={onClose}>
          Cancel
        </button>
        <button class="btn btn-primary edit-save" type="button" disabled={saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

export interface CommentCardProps {
  readonly comment: GithubPrComment;
  /** True when the write switch is on. */
  readonly writes: boolean;
  readonly onReact: ReactionBarProps["onReact"];
  /** What the header says after the time: a review's state chip. */
  readonly extra?: ComponentChildren;
  /** The sentence a body with no words says. */
  readonly empty?: string;
  /**
   * Save an edited text. Given only when the page lets this card be edited, which
   * is what draws the Edit button.
   */
  readonly onEdit?: EditBoxProps["onSave"];
}

/**
 * One comment card: who said it and when, what they said, and its reactions.
 *
 * The body is markdown, drawn by {@link MarkdownBody} with the `comment-body`
 * class, because that is the element the dashboard's stylesheet colours.
 */
export function CommentCard({ comment, writes, onReact, extra, empty, onEdit }: CommentCardProps) {
  const when = ago(comment.createdAt);
  const [editing, setEditing] = useState(false);
  return (
    <div class="comment-card">
      <div class="comment-header">
        <span class="author">{comment.author ?? "ghost"}</span>
        <span>{when === "" ? "commented" : `commented ${when}`}</span>
        {extra}
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
      {editing && onEdit !== undefined ? (
        <EditBox
          base={comment.body ?? ""}
          onSave={onEdit}
          onClose={() => {
            setEditing(false);
          }}
        />
      ) : (
        <MarkdownBody source={comment.body} class="comment-body" empty={empty} />
      )}
      <ReactionBar comment={comment} writes={writes} onReact={onReact} />
    </div>
  );
}
