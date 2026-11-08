/**
 * Awaiting you: one card per open question.
 *
 * The card is the old page's card, element for element: the question, its age,
 * one button per option, and an `Other…` field with its own `Send`. The field is
 * not bound to any value, so a read, an event about another question, or the
 * minute that moves an age leaves whatever is typed, its caret and its focus
 * where they are: Preact keeps the card's element because the list is keyed by
 * the question's key, and it never writes an input it did not write before.
 */
import type { TargetedKeyboardEvent } from "preact";
import type { UserQuery } from "../../../shared/wire/queries.ts";
import { answerQuery, queries, queriesClock, queryAge, sendOtherAnswer } from "../../state/queries.ts";

/** Read the field beside the Send button and send what is in it, if anything. */
function sendTyped(button: HTMLButtonElement | null, key: string): void {
  const input = button?.parentElement?.querySelector("input");
  const text = input?.value.trim() ?? "";
  if (text !== "") void sendOtherAnswer(key, text);
}

/** The `Enter` rule the composer uses, on a one-line field. */
function onOtherKeyDown(event: TargetedKeyboardEvent<HTMLInputElement>, key: string): void {
  if (event.key !== "Enter") return;
  // An Enter pressed while an input method composes (Korean, Japanese, Chinese)
  // commits the composition, and some browsers then fire a second Enter keydown
  // for the same press. `isComposing` and keyCode 229 mark the composing one.
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  // A held key fires `repeat` keydowns. They send nothing.
  if (event.repeat) return;
  const text = event.currentTarget.value.trim();
  if (text !== "") void sendOtherAnswer(key, text);
}

/** One question's card. */
function QueryCard({ query }: { query: UserQuery }) {
  const age = queryAge(query.createdAt, queriesClock.value);
  return (
    <div class="query" data-key={query.key}>
      <div class="inbox-title">{query.question}</div>
      {age === "" ? null : <div class="query-age">{age}</div>}
      <div class="query-options">
        {query.options.map((option, index) => (
          <button class="button" data-choice={index} onClick={() => void answerQuery(query.key, { choice: index })}>
            {option}
          </button>
        ))}
      </div>
      <div class="other-input">
        <input type="text" placeholder="Other…" onKeyDown={(event) => onOtherKeyDown(event, query.key)} />
        <button class="button" data-other="" onClick={(event) => sendTyped(event.currentTarget, query.key)}>
          Send
        </button>
      </div>
    </div>
  );
}

/** The panel the shell carries as `#queries`. */
export function QueriesPanel() {
  const list = queries.value;
  return (
    <div id="queries" class="queries">
      {list.length === 0 ? (
        <p class="inbox-body">Nothing pending.</p>
      ) : (
        list.map((query) => <QueryCard key={query.key} query={query} />)
      )}
    </div>
  );
}
