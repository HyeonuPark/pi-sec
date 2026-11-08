/**
 * The usage page's state: the cards the server answered, the line above them, and
 * the two controls that ask the server again.
 *
 * Three rules live here, because the page's first requirement is that a server
 * answer never resets what the reader did:
 *
 * 1. A whole-page reload matches the incoming cards to the current ones by the
 *    server's provider id (`reconcileById`), so a card that did not change keeps
 *    its object and its element. The page around the cards is never redrawn from
 *    scratch.
 * 2. A per-card refresh replaces that one card in the list and nothing else. The
 *    other cards are the same objects they were, so no element of theirs moves.
 * 3. The page's own state — which card is asking, which card failed, the status
 *    line — is kept apart from the answer, so a failure leaves the values that
 *    did arrive in place, exactly as the old page did.
 *
 * The timeout of the notice belongs to `state/toast.ts`; this module only asks for
 * the 6 s the usage page always used.
 *
 * The page is served with an answer already in it: the server writes the values it
 * holds and pi-sec's own windows into a JSON data block, so the cards draw with the
 * page instead of after a request. `drawFirstPaint()` reads that block and draws it,
 * and a field the server marked `reading` is the one reason to ask
 * `GET /api/usage` anyway. The reload button keeps asking the server, because a
 * reader who pressed it wants a value newer than the one the page was served with.
 */
import { signal } from "@preact/signals";
import { ApiError, request } from "../api/request.ts";
import type { UsageAnswer, UsageCard, UsageJudges, UsageRefreshAnswer } from "../../shared/wire/usage.ts";
import { reconcileById } from "./keyed.ts";
import { showToast } from "./toast.ts";

/** The cards, in the order the server answered them. */
export const cards = signal<readonly UsageCard[]>([]);

/**
 * The judgement models card, or null when the answer holds none.
 *
 * It is not a provider card and has no provider id: no request can refresh one
 * judgement row, and the rows come from the audit trail rather than from a
 * service. So it is kept apart from `cards`, and a whole-page read replaces it.
 */
export const judges = signal<UsageJudges | null>(null);

/**
 * The line above the cards: why the page is empty, or why the last read failed,
 * and null while there is nothing to say.
 */
export const status = signal<string | null>("Reading usage…");

/** True while the whole page is being read again, which disables `↻ reload`. */
export const reloading = signal(false);

/** The providers whose own refresh is running, which disables their button. */
export const refreshing = signal<ReadonlySet<string>>(new Set<string>());

/**
 * The one line a card carries after its refresh failed, by provider id. A
 * successful refresh of that card drops it, and so does a whole-page read, which
 * draws every card from the answer again.
 */
export const cardErrors = signal<Readonly<Record<string, string>>>({});

/** The wait of the usage page's notice, which has always been shorter than the rest. */
export const USAGE_TOAST_MS = 6000;

/** The id of the data block the server writes the held answer into. */
export const FIRST_PAINT_ID = "usage-first";

/** Why a request failed, in the words the page prints inside its parentheses. */
export function reasonOf(error: unknown): string {
  if (error instanceof ApiError) return `HTTP ${error.status}`;
  if (error instanceof Error && error.message !== "") return error.message;
  return "request failed";
}

/** The same record without one key. */
function without(errors: Readonly<Record<string, string>>, provider: string): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(errors)) {
    if (key !== provider) next[key] = value;
  }
  return next;
}

/** Draw a whole answer: the cards by id, the status line, and no card failures. */
function applyAnswer(answer: UsageAnswer): void {
  const incoming = Array.isArray(answer?.cards) ? answer.cards : [];
  cards.value = reconcileById(cards.value, incoming, (card) => card.provider);
  const decisions = answer?.judges;
  judges.value = decisions !== undefined && decisions !== null && Array.isArray(decisions.rows) ? decisions : null;
  cardErrors.value = {};
  // A page with no provider login but with judgement rows still has something to
  // show, so the empty-page line is about the two of them together.
  const nothingToDraw = incoming.length === 0 && judges.value === null;
  status.value = nothingToDraw ? "No model provider has a login yet." : null;
}

/**
 * The answer the page was served with, or null when it carries none this build
 * reads.
 *
 * The block is JSON data, not code: the browser never runs it, so the page's own
 * policy has nothing to refuse. A block that is missing, is not an object, or holds
 * no card list is no answer, and the page asks the server as it always did.
 */
export function firstPaintAnswer(): UsageAnswer | null {
  const element = document.getElementById(FIRST_PAINT_ID);
  if (element === null || element.tagName !== "SCRIPT") return null;
  try {
    const parsed: unknown = JSON.parse(element.textContent ?? "");
    if (typeof parsed !== "object" || parsed === null) return null;
    const answer = parsed as UsageAnswer;
    if (!Array.isArray(answer.cards)) return null;
    return answer;
  } catch {
    return null;
  }
}

/** Whether a card holds a provider value that has not arrived: the server wrote `reading`. */
export function awaitsValue(card: UsageCard): boolean {
  for (const field of Object.values(card.fields ?? {})) {
    if (field?.state === "reading") return true;
  }
  return false;
}

/**
 * Draw the answer the page was served with.
 *
 * It answers whether every card is complete. True means no request is needed: the
 * page already holds what it would have asked for. False means at least one
 * provider has a reader and no value yet, so the caller asks `GET /api/usage`, or
 * the block was missing or unreadable and the page is drawn the old way.
 */
export function drawFirstPaint(): boolean {
  const answer = firstPaintAnswer();
  if (answer === null) return false;
  applyAnswer(answer);
  return !answer.cards.some(awaitsValue);
}

/**
 * Read the whole page again.
 *
 * A failure leaves the cards that are drawn where they are, writes why in the
 * status line, and shows one notice — the same three things the old page did.
 */
export async function loadUsage(): Promise<void> {
  reloading.value = true;
  try {
    const answer = await request<UsageAnswer>("/api/usage");
    applyAnswer(answer);
  } catch (error) {
    status.value = `Could not read usage (${reasonOf(error)}).`;
    showToast("Could not read usage.", { durationMs: USAGE_TOAST_MS });
  } finally {
    reloading.value = false;
  }
}

/**
 * Ask the server for one provider's value again, and draw that one card from the
 * answer.
 *
 * A failure leaves the card's values as they are, puts the button back, and adds
 * one line to that card. A second failure replaces that line rather than adding
 * another.
 */
export async function refreshCard(provider: string): Promise<void> {
  if (refreshing.value.has(provider)) return;
  const asking = new Set(refreshing.value);
  asking.add(provider);
  refreshing.value = asking;
  cardErrors.value = without(cardErrors.value, provider);
  try {
    const answer = await request<UsageRefreshAnswer>("/api/usage/refresh", {
      method: "POST",
      body: JSON.stringify({ provider }),
    });
    if (answer === undefined || answer.card === undefined || answer.card === null) {
      throw new Error("the answer holds no card");
    }
    const next = cards.value.map((card) => (card.provider === provider ? answer.card : card));
    cards.value = reconcileById(cards.value, next, (card) => card.provider);
  } catch (error) {
    cardErrors.value = { ...cardErrors.value, [provider]: `Could not refresh (${reasonOf(error)}).` };
  } finally {
    const remaining = new Set(refreshing.value);
    remaining.delete(provider);
    refreshing.value = remaining;
  }
}
