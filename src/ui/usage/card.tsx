/**
 * One provider card.
 *
 * The element tree is the one the hand-written usage page drew (removed in this
 * commit), class for class and id for id, because `usage.css` styles exactly that
 * tree. What changed is how it is
 * drawn: the card is a component of its own, keyed by the provider the server
 * named, so a refresh of one provider redraws that card and leaves every other
 * card's elements where they are. The refresh button is the same element before
 * and after the answer, so a reader who pressed it keeps the focus on it.
 *
 * A field the answer does not hold is a field this card does not have, such as the
 * five-hour window of a provider without one: the page draws the fields the answer
 * holds and names no provider.
 */
import type { UsageCard } from "../../shared/wire/usage.ts";
import { cardErrors, refreshing, refreshCard } from "../state/usage.ts";
import { FIELDS, PREPAID_NOTE, FieldRow, FieldValue } from "./values.tsx";
import { hhmm } from "./format.ts";

/** What a card says while the server holds a value back, or an empty string. */
export function holdText(card: UsageCard): string {
  const hold = card.hold;
  if (hold === undefined || hold === null) return "";
  if (hold.kind === "rate_limited") return `rate limited until ${hhmm(hold.until)}`;
  const kept = card.receivedAt ? `kept value from ${hhmm(card.receivedAt)} · ` : "";
  return `${kept}next refresh after ${hhmm(hold.nextAt)}`;
}

/** The line under a card: the shape's own note, then the provider's. */
export function noteText(card: UsageCard): string {
  const note = card.shape === "prepaid" ? PREPAID_NOTE : "";
  if (card.note === undefined || card.note === "") return note;
  return note === "" ? card.note : `${note} · ${card.note}`;
}

/** The one provider card, with its fields and its own refresh button. */
export function Card({ card }: { card: UsageCard }) {
  const name = card.name || card.provider;
  const shape = card.shape === "subscription" ? "subscription" : "prepaid";
  const asking = refreshing.value.has(card.provider);
  const failure = cardErrors.value[card.provider];
  const held = holdText(card);
  const note = noteText(card);

  /**
   * Ask for this card again.
   *
   * The button is disabled while the request runs, and a browser takes the focus
   * off a button it disables. Whoever pressed it gets it back when it returns, as
   * long as nothing else took it in the meantime: that is what keeps the reader's
   * place across a refresh.
   */
  const onRefresh = (event: Event): void => {
    const button = event.currentTarget as HTMLButtonElement;
    const document_ = button.ownerDocument;
    const hadFocus = document_.activeElement === button;
    void refreshCard(card.provider).then(() => {
      const active = document_.activeElement;
      if (hadFocus && (active === null || active === document_.body)) button.focus();
    });
  };

  return (
    <article class="usage-card" data-provider={card.provider}>
      <header class="usage-card-head">
        <div class="usage-card-title">
          <h2 class="usage-card-name">{name}</h2>
          <span class="usage-chip">{shape}</span>
        </div>
        <div class="usage-card-meta">
          <span class="usage-received">
            {card.receivedAt ? `value received ${card.receivedAt.label}` : "no value received yet"}
          </span>
          <button
            class="usage-card-refresh"
            type="button"
            aria-label={`Refresh ${name}`}
            disabled={asking}
            onClick={onRefresh}
          >
            ↻
          </button>
        </div>
      </header>
      <div class="usage-card-body">
        {held === "" ? null : <p class="usage-hold">{held}</p>}
        {FIELDS[shape].map((field) =>
          Object.prototype.hasOwnProperty.call(card.fields, field.key) ? (
            <FieldRow key={field.key} name={field.name}>
              <FieldValue fieldKey={field.key} field={card.fields[field.key]!} />
            </FieldRow>
          ) : null,
        )}
      </div>
      {note === "" ? null : <p class="usage-note">{note}</p>}
      {failure === undefined ? null : <p class="usage-card-error">{failure}</p>}
    </article>
  );
}
