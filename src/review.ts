import { readMessage } from "./message-envelope.ts";

/**
 * How a note written in the report viewer reaches the agent.
 *
 * A review is pushed into the conversation **like user input**, because that is
 * the only admission that starts a run: a passive entry write would sit in the
 * transcript until something else woke the agent, which is the opposite of what
 * the operator asked for. The durable layer therefore stores it as an ordinary
 * `pi.user` entry — there is no second input type — and the category is carried
 * in the content, on one marker line, so the two sides that care can agree on it:
 *
 *   - the UI renders that entry as a review card instead of a user message, so a
 *     note from the viewer is never mistaken for something the operator typed;
 *   - the agent sees, on its first line, that the text came from a report and
 *     which report.
 *
 * A note written now travels in an envelope with `src="operator"`, and the
 * envelope's body is still the marker line (`src/message-envelope.ts` owns the
 * envelope and its escaping rules). `parseReview` reads both forms.
 *
 * Trust: this content is *instruction-bearing* — the same as a chat message. The
 * route that accepts it (`POST /api/reports/:id/feedback`) has no authentication
 * of its own; the reverse proxy is the only gate. Anything that can write a
 * report note can therefore put words in the operator's mouth, so exposing the
 * report routes without that gate is not the same decision as exposing the chat.
 */

/** First token of a review's first line. The UI matches this exactly. */
export const REVIEW_MARKER = "[pi-sec review]";

export interface ReviewTarget {
  readonly name: string;
  readonly version?: number;
}

/**
 * The input submitted for one review note, in the older form: a marker line, a
 * blank line, then the note itself.
 *
 * The marker line stays the label for a stored transcript, for the lesson
 * scanner, and for `readMessage`, which maps it to `operator` with
 * `via="review"`. The envelope is put on around this text by the route that
 * submits the note.
 */
export function reviewInput(target: ReviewTarget, text: string): string {
  const version = target.version === undefined ? "" : ` v=${target.version}`;
  return `${REVIEW_MARKER} report=${target.name}${version}\n\n${text}`;
}

export interface ParsedReview {
  readonly report: string;
  readonly version: number | undefined;
  readonly text: string;
}

/**
 * Parse `reviewInput`, or `undefined` when this is not a review entry.
 *
 * Both stored forms are read. An envelope is read through `readMessage` for its
 * boundaries and its body; the report and the version come from the envelope's
 * attributes when it has them, and otherwise from the marker line the body still
 * carries. The older form, a bare marker line, is read by `parseLegacyReview`
 * below.
 */
export function parseReview(content: string): ParsedReview | undefined {
  const read = readMessage(content);
  if (read !== undefined && read.format === "envelope") {
    const report = read.attrs["report"];
    if (report !== undefined && report !== "") {
      return { report, version: versionOf(read.attrs["version"] ?? read.attrs["v"]), text: read.body };
    }
    // An envelope whose body is the older marker line: the writer labelled the
    // source but left the report name where the marker put it. Only operator
    // input can be a review, so any other source answers no.
    if (read.source !== "operator" && read.attrs["via"] !== "review") return undefined;
    return parseLegacyReview(read.body);
  }
  return parseLegacyReview(content);
}

/** A version attribute, when it holds a whole number. */
function versionOf(raw: string | undefined): number | undefined {
  return raw !== undefined && Number.isInteger(Number(raw)) ? Number(raw) : undefined;
}

/**
 * The older form's reader: the marker line's reader. Kept for text written
 * before the envelope.
 */
function parseLegacyReview(content: string): ParsedReview | undefined {
  const newline = content.indexOf("\n");
  const first = (newline === -1 ? content : content.slice(0, newline)).trim();
  if (!first.startsWith(REVIEW_MARKER)) return undefined;

  const rest = (newline === -1 ? "" : content.slice(newline + 1)).replace(/^\n+/, "");
  let report: string | undefined;
  let version: number | undefined;
  for (const field of first.slice(REVIEW_MARKER.length).trim().split(/\s+/)) {
    const [key, value] = field.split("=");
    if (key === "report" && value !== undefined && value !== "") report = value;
    if (key === "v" && value !== undefined && Number.isInteger(Number(value))) version = Number(value);
  }
  if (report === undefined) return undefined;
  return { report, version, text: rest };
}

/** The request id submitted for one review note: one admission per stored note. */
export function reviewRequestId(entryId: string): string {
  return `report-feedback:${entryId}`;
}
