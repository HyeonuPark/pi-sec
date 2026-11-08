import { readMessage } from "../message-envelope.ts";

/**
 * The approval input: how one press of Approve reaches the conversation.
 *
 * An approval is written twice. The report store keeps the record, on the
 * revision it belongs to (`ReportVersion.approval`). The conversation keeps the
 * input, because that is what starts the root agent's run. The two must say the
 * same thing about the same revision, so the shape of the second is defined here
 * and nowhere else: the route builds it with `approvalInput`, a reader takes it
 * apart with `parseApproval`.
 *
 * The text is one marker line, a blank line, then a sentence. The marker line is
 * the machine-readable half, in the same shape `[pi-sec review]` uses:
 *
 *     [pi-sec approve] report=<slug> v=<n> sha=<sha256> [button=done]
 *
 * The `button=done` field is written only when the user pressed Done, which is the
 * approve button of a result report. Everything else about the input is the same,
 * so a Done reaches the root as an approval that also says how it was pressed.
 *
 * Why the report and the revision go in the body and not in the envelope:
 * `parseReview` (`src/review.ts`) reads an envelope's `report` attribute first,
 * and the viewer's renderer, the transcript reader and `lessons_scan` all read
 * through it. An approval envelope that carried `report=` would be parsed as a
 * review note — an approval would arrive as feedback, and the note would be
 * scanned for lessons as if the operator had written it. So the envelope keeps
 * its own two fields (`via="approval"`, `approval="<reportId>/v<n>"`) and the
 * marker line carries the human-readable half. Both halves name the same
 * revision, and `parseApproval` accepts either one as evidence.
 *
 * Trust: this text is instruction-bearing, exactly as a chat message is. It says
 * the operator approved a revision, so anything that can write it can put an
 * approval in the operator's mouth. `POST /api/reports/:id/approve` is the only
 * producer, and that route has no authentication of its own; the reverse proxy is
 * the only gate. The same rule the feedback route states in `src/review.ts`
 * applies here.
 */

/** First token of an approval's first line. */
export const APPROVAL_MARKER = "[pi-sec approve]";

export interface ApprovalTarget {
  /** The report's slug: the address a person can open. */
  readonly name: string;
  readonly version: number;
  /** The revision's hash, copied from the store. The root compares it before it acts. */
  readonly sha256: string;
  /**
   * Set when the user pressed Done rather than Approve. Done is the approve button
   * of a result report, and the marker line then ends with `button=done`, so the
   * root can tell the two presses apart without reading the sentence.
   */
  readonly button?: "done";
}

/**
 * The input submitted for one approval: a marker line, a blank line, then the
 * note the root agent reads. The envelope goes on around this text, by the route
 * that submits it (`submitEnveloped`).
 */
export function approvalInput(target: ApprovalTarget, text: string): string {
  const button = target.button === "done" ? " button=done" : "";
  return `${APPROVAL_MARKER} report=${target.name} v=${target.version} sha=${target.sha256}${button}\n\n${text}`;
}

/** The request id submitted for one approval: one admission per report revision. */
export function approvalRequestId(reportId: string, version: number): string {
  return `report-approve:${reportId}:${version}`;
}

export interface ParsedApproval {
  /** The report id, when the envelope named it. */
  readonly id?: string;
  /** The report's slug, from the marker line. */
  readonly report: string;
  readonly version: number;
  /** The approved revision's hash, when the marker line carries it. */
  readonly sha256?: string;
  /**
   * `done` when the user pressed Done, which the marker line writes as
   * `button=done`. Absent for a press of Approve.
   */
  readonly button?: "done";
  /** The note the root agent read, without the marker line. */
  readonly text: string;
}

/**
 * Parse an approval entry, or `undefined` when this text is not one.
 *
 * An envelope is read first, and only the one the route writes counts: `via` must
 * be `approval`. That check is the point — a tool result or a fetched page can
 * carry the marker line as data, and a reader that went by the line alone would
 * draw an approval nobody made.
 *
 * Outside an envelope the marker line decides. That is the fallback for an entry
 * written without an envelope, and it is also what a client sees when it holds a
 * body with the label stripped off.
 */
export function parseApproval(content: string): ParsedApproval | undefined {
  const read = readMessage(content);
  if (read !== undefined && read.format === "envelope") {
    if (read.attrs["via"] !== "approval") return undefined;
    const marker = parseMarkerLine(read.body);
    if (marker === undefined) return undefined;
    const id = parseTargetAttribute(read.attrs["approval"]);
    return {
      ...(id !== undefined ? { id } : {}),
      report: marker.report,
      version: marker.version,
      ...(marker.sha256 !== undefined ? { sha256: marker.sha256 } : {}),
      ...(marker.button !== undefined ? { button: marker.button } : {}),
      text: marker.text,
    };
  }
  return parseMarkerLine(content);
}

/**
 * The marker line's reader: the first line, then everything after the blank
 * line. `report=` and `v=` are what make it an approval, so a line without them
 * is not one.
 */
function parseMarkerLine(content: string): ParsedApproval | undefined {
  const newline = content.indexOf("\n");
  const first = (newline === -1 ? content : content.slice(0, newline)).trim();
  if (!first.startsWith(APPROVAL_MARKER)) return undefined;

  let report: string | undefined;
  let version: number | undefined;
  let sha256: string | undefined;
  let button: "done" | undefined;
  for (const field of first.slice(APPROVAL_MARKER.length).trim().split(/\s+/)) {
    const [key, value] = field.split("=");
    if (value === undefined || value === "") continue;
    if (key === "report") report = value;
    if (key === "v" && Number.isInteger(Number(value))) version = Number(value);
    if (key === "sha") sha256 = value;
    if (key === "button" && value === "done") button = "done";
  }
  if (report === undefined || version === undefined) return undefined;

  const rest = (newline === -1 ? "" : content.slice(newline + 1)).replace(/^\n+/, "");
  return {
    report,
    version,
    ...(sha256 !== undefined ? { sha256 } : {}),
    ...(button !== undefined ? { button } : {}),
    text: rest,
  };
}

/** Read the report id out of the envelope's `approval="<reportId>/v<n>"` attribute. */
function parseTargetAttribute(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const match = /^(.+)\/v\d+$/.exec(raw);
  return match?.[1];
}
