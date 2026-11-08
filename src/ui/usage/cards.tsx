/**
 * The region the provider cards are drawn in, and the decision models card below
 * them.
 *
 * It is the `#usage-cards` section the shell already carries, taken over in place
 * by `mountAt`, so the element around the cards and the extension slot below them
 * keep their place in the page. Each card is keyed by the provider id the server
 * gave it: a whole-page reload matches the incoming list to the drawn one by that
 * id, so a card that did not change is the same component with the same elements.
 *
 * The decision models card is not keyed by a provider id: it is one card, drawn
 * after the provider cards, and a refresh of one provider leaves it alone.
 */
import { cards, judges } from "../state/usage.ts";
import { Card } from "./card.tsx";
import { JudgesCard } from "./judges.tsx";

/** The provider cards, in the order the server answered them, and the judges card. */
export function Cards() {
  return (
    <section id="usage-cards" class="usage-cards" aria-live="polite">
      {cards.value.map((card) => (
        <Card key={card.provider} card={card} />
      ))}
      <JudgesCard judges={judges.value ?? undefined} />
    </section>
  );
}
