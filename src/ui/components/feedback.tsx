/**
 * The one bar at the foot of a report: feedback in the field, and the button that
 * confirms the revision on screen.
 *
 * This is the hand-written feedback module (removed in this commit) as a
 * component, and the reason it is one place
 * has not changed: the same control appears on two surfaces — the report viewer's
 * bottom bar and the chat's report panel — and the failure that matters is not
 * "one of them looks wrong" but "the two disagree about what a press does".
 *
 * What it draws is a `form#feedback-form` with a `textarea#feedback-body` and its
 * buttons, then a `p#feedback-hint`. Every id, class and attribute is the one the
 * stylesheet and the tests already name. A plan has one button, `#feedback-submit`,
 * which approves while the field is empty and sends feedback once there is text. A
 * result report has two: `#feedback-done` closes the result, and `#feedback-submit`
 * sends what is in the field as feedback. The two sit in one row of their own,
 * `div.report-feedback-buttons`, so the stylesheet can put Done and Feedback on
 * a line under the field wherever the field takes the whole width. The row and
 * the hint are drawn as siblings of the form, so a caller can put the bar inside
 * any container it has.
 *
 * What it knows is the one report and revision it is pointed at (`target`), and
 * nothing about the page: the address, the route and which screen this is belong
 * to the caller. `via` is the surface a press is recorded on (`viewer` or
 * `panel`), because the server records it on the approval and refuses any other
 * value.
 *
 * What the reader typed is the component's own state. A target that changes
 * because the page read the report again — a new revision, a recorded approval —
 * leaves the field alone: only another report loads another draft. That is the
 * rule the viewer's reset test holds. While a press is sent the field is
 * read-only, so what a success empties is exactly what was sent, and only the
 * field of the report that was sent.
 *
 * A refusal is answered from the same place. The server's `code` says what the
 * screen got wrong, and the body it wrote beside the code says what to correct it
 * with: the newest revision a stale press missed, or the approval an
 * `already_approved` press is about. The hand-written module read those out of the
 * body its page's wrapper handed it; this one reads the same body from the
 * {@link ApiError} that carries it.
 *
 * A write the browser refuses is said once, by the draft store itself
 * (`src/ui/state/drafts.ts`), so this component stays quiet about it and only
 * keeps the text in the field.
 */
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { ApiError, request, type RequestOptions } from "../api/request.ts";
import { clearDraft, readDraft, writeDraft } from "../state/drafts.ts";
import { showError } from "../state/toast.ts";
import { relativeTime } from "./relative-time.ts";

/** The server's record for one approved revision, as far as the bar reads it. */
export interface FeedbackApproval {
  /** Epoch milliseconds; absent when the answer carried an approval without one. */
  readonly at?: number;
  readonly via?: string;
  readonly sha256?: string;
  /** `done` when the user pressed Done rather than Approve. */
  readonly button?: "done";
}

/**
 * One report and one revision the bar is pointed at.
 *
 * `kind` decides what the bar draws: a plan has the one button that approves or
 * sends feedback, a result report has Done and Feedback from the start, and a
 * briefing has Feedback alone, because it never asks for an approval.
 */
export interface FeedbackTarget {
  readonly id: string;
  /** The revision on screen. The panel passes the newest one. */
  readonly version: number;
  /** The newest revision the server has. */
  readonly latest: number;
  /** Whether the report's job is live, which is what an approval asks for. */
  readonly active: boolean;
  /** The kind of the report; absent or `plan` reads as a plan. */
  readonly kind?: "plan" | "result" | "briefing";
  /** The server's record for this revision, when it carries one. */
  readonly approval?: FeedbackApproval | undefined;
}

/** What a press sent, once the server took it. */
export interface FeedbackSent {
  readonly kind: "approve" | "done" | "feedback";
  readonly reportId: string;
  readonly version: number;
  readonly data: unknown;
}

/** A refusal, or a failure, as the caller shows it. */
export interface FeedbackFailure {
  readonly message: string;
  readonly code?: string | undefined;
}

/** The request function the bar sends with. The page's own, which carries the mount. */
export type FeedbackSend = <T>(path: string, options?: RequestOptions) => Promise<T>;

export interface FeedbackBarProps {
  /** The report and revision to point at, or `null` before there is one. */
  readonly target: FeedbackTarget | null;
  /** The surface a press is recorded on: `viewer` (the default) or `panel`. */
  readonly via?: "viewer" | "panel";
  /** Where a press goes. Defaults to the shared request function. */
  readonly send?: FeedbackSend;
  /** Called after the server took a press. */
  readonly onSent?: (sent: FeedbackSent) => void;
  /** Called with the sentence to show when a press failed. Defaults to the page's notice. */
  readonly onError?: (failure: FeedbackFailure) => void;
}

/**
 * The target as the bar judges it, which a refusal may correct. The correction is
 * where the newest revision the server named is kept: the bar then aims at that
 * revision while an older one is on screen, and that is what holds Approve off.
 */
interface Aim extends FeedbackTarget {
  /**
   * Whether the newest revision came from a refusal. The old bar answered a
   * refusal in its one sentence, and named the revision only where its own read
   * had already said which one is the newest, so this one does the same.
   */
  readonly latestFromRefusal?: true;
}

/** What the bar holds besides its props: the field, the wait and the last refusal. */
interface BarState {
  /** The target as the bar judges it, corrected by a refusal. */
  readonly aim: Aim | null;
  /** The server said this revision cannot be approved, and why. */
  readonly refusal: string;
  readonly busy: boolean;
  /** The field's text. It lives here, so a re-render never takes it away. */
  readonly text: string;
}

/** The storage key of one report's unsent text. The revision is not part of it. */
function draftKey(id: string): string {
  return `feedback:${id}`;
}

/** The tallest the field grows to on its own, which is the `max-height` it is given. */
const MAX_FIELD_HEIGHT = 128;

/**
 * One row until the text outgrows it, which is what the old bar did on every
 * keystroke and once when a draft was restored.
 *
 * A field inside a hidden container measures nothing: `scrollHeight` is 0, and a
 * box drawn at `height: 0px` is still as tall as its own padding, so the one row
 * the reader needs is cut to a sliver. Nothing is written in that case; the bar is
 * measured again on the render that shows it.
 */
function measureField(field: HTMLTextAreaElement): void {
  if (field.getClientRects().length === 0) return;
  field.style.height = "auto";
  field.style.height = `${Math.min(field.scrollHeight, MAX_FIELD_HEIGHT)}px`;
}

/** Why Approve is off when the revision on screen is not the newest. */
const STALE = "Only the newest revision can be approved.";

/** Why Approve is off when the report's job is no longer live. */
const FINISHED = "This report's job has finished, so it cannot be approved.";

/**
 * What a result report's bar says when it has nothing else to say.
 *
 * One sentence per button, in the order they sit: what Done does, what text with
 * Done does, and what Feedback does. It is the same sentence on every result
 * report, so the bar marks it as the explanation and the stylesheet hides it at
 * every width: the button labels already carry it (`docs/ui.md`). The line keeps
 * the text so a screen that hides it still has the sentence in the page.
 */
const RESULT_HINT = "Done closes this result. Text with Done asks for follow-up work. Feedback asks for more in this report.";

/**
 * What a briefing report's bar says, and the whole of what it offers.
 *
 * A briefing asks for no approval, so there is nothing to explain about a button
 * that is not there: the line says where the one button goes instead.
 */
const BRIEFING_HINT = "A briefing needs no approval. Feedback goes to the root.";

/**
 * The same sentence, with the revision the caller's own read says is the newest.
 * The old bar named it there, and a refusal is still answered in the one sentence.
 */
function staleHint(latest: number): string {
  return `${STALE} The newest is v${latest}.`;
}

/** The server's code for a refusal, from either error shape a caller may throw. */
function codeOf(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.code;
  const read = (error as { code?: unknown } | null)?.code;
  return typeof read === "string" ? read : undefined;
}

/** The sentence a failure is shown with. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

/**
 * The body of a refusal, from either request wrapper a caller may hand in: the
 * shared one keeps it on the error, and a page's own may leave it under `data`.
 * `undefined` when the failure carried none, which is the case for a failure that
 * is not a refusal at all.
 */
function refusalBodyOf(error: unknown): unknown {
  if (error instanceof ApiError) return error.body;
  return (error as { data?: unknown } | null)?.data;
}

/**
 * The approval record for one revision, read out of whatever the server answered:
 * the record itself, the revision entry, or a whole report view. `undefined` when
 * none of those carries one — the caller must then not draw an approval, which is
 * the only safe reading of an absent field.
 */
function readApproval(data: unknown, version: number): FeedbackApproval | undefined {
  if (data === undefined || data === null) return undefined;
  const answer = data as { versions?: unknown; approval?: unknown; at?: unknown; via?: unknown; sha256?: unknown };
  if (Array.isArray(answer.versions)) {
    const entry = answer.versions.find((each) => Number((each as { n?: unknown }).n) === Number(version));
    return (entry as { approval?: FeedbackApproval } | undefined)?.approval;
  }
  if (answer.approval !== undefined) return answer.approval as FeedbackApproval;
  if (typeof answer.at === "number") {
    const button = (answer as { button?: unknown }).button;
    return {
      at: answer.at,
      via: typeof answer.via === "string" ? answer.via : undefined,
      sha256: typeof answer.sha256 === "string" ? answer.sha256 : undefined,
      ...(button === "done" ? { button: "done" as const } : {}),
    };
  }
  return undefined;
}

/**
 * The two-state bar.
 *
 * The form and the hint are the two elements the container holds, in that order,
 * so a container that drew the old module's markup is drawn the same way again.
 */
export function FeedbackBar({ target, via, send, onSent, onError }: FeedbackBarProps) {
  const surface = via === "panel" ? "panel" : "viewer";
  const post = send ?? request;
  const failure = onError ?? (({ message }: FeedbackFailure) => showError(message));
  const [bar, setBar] = useState<BarState>({ aim: null, refusal: "", busy: false, text: "" });
  const field = useRef<HTMLTextAreaElement | null>(null);
  // The callbacks below run after an await, so they read the bar through this,
  // not through the render that started the press. A press is judged against the
  // target it was made for: a target that moved in the meantime is left as it is.
  const live = useRef(bar);
  live.current = bar;
  const pointed = useRef<string | null>(null);

  // Point the bar at what the caller hands it. Another report loads that report's
  // stored text; the same report read again — a new revision, a recorded approval
  // — leaves whatever is in the field where it is.
  useLayoutEffect(() => {
    if (target === null) return;
    const otherReport = pointed.current !== target.id;
    pointed.current = target.id;
    setBar((previous) => ({
      aim: { ...target },
      refusal: "",
      busy: previous.busy,
      text: otherReport ? readDraft(draftKey(target.id)) : previous.text,
    }));
  }, [target]);

  // The field's own height, on the text it holds and on the render that shows the
  // bar. The bar sits in a hidden container until it is pointed at a report, and
  // that pointing render is the one that shows it — which is when the old bar
  // measured the field, so this effect runs on the target as well as on the text.
  useLayoutEffect(() => {
    const element = field.current;
    if (element !== null) measureField(element);
  }, [bar.text, target]);

  const aim = bar.aim;
  const hasText = bar.text.trim() !== "";
  // A result report has two buttons, and the two decide the same way the plan's
  // one does: from the server's record, never from what the screen hopes.
  const isResult = aim !== null && aim.kind === "result";
  // A briefing has the Feedback button alone, so it is drawn from the same branch
  // a plan's single button takes, with its own sentence under it.
  const isBriefing = aim !== null && aim.kind === "briefing";

  function approvable(): boolean {
    return (
      aim !== null &&
      // A briefing has no approval to press: its only press carries text, so an
      // empty field sends nothing at all.
      aim.kind !== "briefing" &&
      !bar.busy &&
      bar.refusal === "" &&
      aim.active === true &&
      aim.approval === undefined &&
      aim.version === aim.latest
    );
  }

  /**
   * The line under the bar, and which of its two kinds it is.
   *
   * `explanation` is the sentence that says what the buttons do. Every other
   * line says something only this report and this revision know: the approval it
   * carries, the reason a press was refused, the newer revision to press, the job
   * that ended. The explanation is hidden at every width and the rest is shown at
   * every width, so the two are told apart here rather than in the stylesheet.
   */
  function hintLine(): { text: string; explanation: boolean } {
    if (aim === null) return { text: "", explanation: false };
    if (aim.approval !== undefined) {
      const at = Number(aim.approval.at);
      // The record says which button was pressed, so the line under the bar says
      // it too: `Done v2 · 5m ago` is a result report's press.
      const verb = aim.approval.button === "done" ? "Done" : "Approved";
      const text = Number.isFinite(at) ? `${verb} v${aim.version} · ${relativeTime(at)}` : `${verb} v${aim.version}`;
      return { text, explanation: false };
    }
    if (bar.refusal !== "") return { text: bar.refusal, explanation: false };
    if (aim.active !== true) return { text: FINISHED, explanation: false };
    if (aim.version !== aim.latest) {
      return { text: aim.latestFromRefusal === true ? STALE : staleHint(aim.latest), explanation: false };
    }
    // Nothing to tell: a result report explains what its two buttons do, a
    // briefing says that it needs no approval, and a plan says nothing, as it
    // always has. The first two are the same sentence on every report of their
    // kind, so both are the explanation and are hidden at every width; a plan's
    // empty line is neither kind.
    if (aim.kind === "result") return { text: RESULT_HINT, explanation: true };
    if (aim.kind === "briefing") return { text: BRIEFING_HINT, explanation: true };
    return { text: "", explanation: false };
  }

  /** Where the button stands, and what a press of it would mean. */
  function buttonState(): { text: string; label: string; className: string; disabled: boolean } {
    if (hasText) {
      // Text in the field means the press sends that text, whatever revision it is
      // about: feedback is allowed on any revision, approval is not.
      return { text: "Feedback", label: "Feedback", className: "button button-feedback", disabled: bar.busy };
    }
    if (aim !== null && aim.approval !== undefined) {
      return { text: "Approved", label: hintLine().text, className: "button button-approve", disabled: true };
    }
    // A briefing is never approved, so its one button is Feedback even with an
    // empty field: there is nothing in the field to send, so it stays off.
    if (aim !== null && aim.kind === "briefing") {
      return { text: "Feedback", label: "Feedback", className: "button button-feedback", disabled: !hasText };
    }
    return { text: "Approve", label: "Approve", className: "button button-approve", disabled: !approvable() };
  }

  /**
   * Where the two buttons of a result report stand.
   *
   * Done takes the field's text when there is one and closes the result when
   * there is not, so it is pressed in either state; the same rule as Approve
   * decides when it may be pressed at all. Feedback is about the text, so it is a
   * send of what is in the field and nothing more.
   */
  function doneState(): { disabled: boolean } {
    return { disabled: !approvable() };
  }

  function feedbackState(): { disabled: boolean } {
    return { disabled: bar.busy || !hasText };
  }

  /**
   * Correct what the bar is aimed at, from the answer to the press that was made
   * for it. A press whose target moved on in the meantime is left alone: the aim
   * on screen is not the one that answer is about.
   */
  function correct(requested: FeedbackTarget, fixed: Aim, refusal = ""): void {
    if (live.current.aim !== requested) return;
    setBar((previous) => ({ ...previous, aim: fixed, refusal }));
  }

  /**
   * The server judges the state, not the screen. When it says no, the screen is
   * corrected from the same answer instead of waiting for a read to disagree with
   * it: the body beside the code names the revision that can be approved, or the
   * approval the screen had not seen yet.
   */
  function fail(requested: FeedbackTarget, error: unknown): void {
    const code = codeOf(error);
    const body = refusalBodyOf(error);
    // What the reader is told, once the screen has been corrected.
    let sentence: string;
    if (code === "stale_revision") {
      const latest = Number((body as { latest?: unknown } | null)?.latest);
      if (Number.isFinite(latest) && latest > requested.version) {
        // The bar takes the revision the server names, and its own rule says the
        // rest: this is not the newest, so Approve stays off. The sentence is the
        // one the old bar showed, which does not name the revision again.
        correct(requested, { ...requested, latest, latestFromRefusal: true });
      } else {
        // An answer that names no later revision still refuses this one, so the
        // reason is said in full rather than read off the revision numbers.
        correct(requested, requested, STALE);
      }
      sentence = STALE;
    } else if (code === "already_approved") {
      // The answer carries the record the screen did not have, so the bar draws
      // what a report read after that approval would draw.
      correct(requested, { ...requested, approval: readApproval(body, requested.version) ?? { at: undefined } });
      sentence = "This revision is already approved.";
    } else if (code === "not_active") {
      // The report's job is finished, so its revisions are not a surface anyone can
      // confirm work on. That is a different thing from an error, and it is said in
      // its own words.
      correct(requested, { ...requested, active: false }, FINISHED);
      sentence = FINISHED;
    } else {
      failure({ message: `Could not approve this revision: ${messageOf(error)}`, code });
      return;
    }
    failure({ message: sentence, code });
  }

  /** Send an approval of the revision on screen. */
  async function approve(requested: FeedbackTarget): Promise<void> {
    try {
      const data = await post<unknown>(`/api/reports/${encodeURIComponent(requested.id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ version: requested.version, via: surface }),
      });
      if (live.current.aim === requested) {
        // The answer may be the record, the revision, or the report. A success with
        // none of those still means this revision is approved, so it is marked with
        // an unknown time rather than left pressable.
        const approval = readApproval(data, requested.version) ?? { at: undefined };
        setBar((previous) => ({ ...previous, aim: { ...requested, approval } }));
      }
      onSent?.({ kind: "approve", reportId: requested.id, version: requested.version, data });
    } catch (error) {
      fail(requested, error);
    }
  }

  /**
   * Send a Done, with the text in the field as the user's request for follow-up
   * work.
   *
   * Done goes to its own route, and the server records the same approval Approve
   * records with the button named on it. The field is emptied once the server took
   * the press, and kept when it refused one: a refused press leaves the reader's
   * words where they are, exactly as a refused feedback does.
   */
  async function finish(requested: FeedbackTarget, text: string): Promise<void> {
    try {
      const data = await post<unknown>(`/api/reports/${encodeURIComponent(requested.id)}/done`, {
        method: "POST",
        body: JSON.stringify({ version: requested.version, via: surface, ...(text === "" ? {} : { text }) }),
      });
      const approval = readApproval(data, requested.version) ?? { at: undefined, button: "done" as const };
      setBar((previous) => {
        // The field could not change during the press, so what it holds is what
        // was sent. It is emptied only while the bar still points at this report.
        if (previous.aim?.id !== requested.id) return previous;
        return { ...previous, aim: previous.aim === requested ? { ...requested, approval } : previous.aim, text: "" };
      });
      if (text !== "") clearDraft(draftKey(requested.id));
      onSent?.({ kind: "done", reportId: requested.id, version: requested.version, data });
    } catch (error) {
      fail(requested, error);
    }
  }

  /** Send the text in the field as feedback about the revision on screen. */
  async function deliver(requested: FeedbackTarget, body: string): Promise<void> {
    try {
      const data = await post<unknown>(`/api/reports/${encodeURIComponent(requested.id)}/feedback`, {
        method: "POST",
        body: JSON.stringify({ body, version: requested.version }),
      });
      // The server took the text, so the draft is done. A refused send keeps both
      // the field and the entry, which is what makes a retry possible.
      clearDraft(draftKey(requested.id));
      // The field was read-only during the press, so its text is what was sent.
      // Another report's field is left alone.
      setBar((previous) => (previous.aim?.id === requested.id ? { ...previous, text: "" } : previous));
      onSent?.({ kind: "feedback", reportId: requested.id, version: requested.version, data });
    } catch (error) {
      failure({ message: `Could not send the feedback: ${messageOf(error)}`, code: codeOf(error) });
    }
  }

  async function submit(event: Event): Promise<void> {
    event.preventDefault();
    const requested = live.current.aim;
    if (requested === null || live.current.busy) return;
    const body = live.current.text.trim();
    if (body === "" && !approvable()) {
      // An empty field asks for an approval, and this revision has none to give.
      // The hint already says why, so the screen is left as it is.
      return;
    }
    setBar((previous) => ({ ...previous, busy: true }));
    try {
      if (body === "") await approve(requested);
      else await deliver(requested, body);
    } finally {
      setBar((previous) => ({ ...previous, busy: false }));
    }
  }

  /**
   * One press of a result report's two buttons.
   *
   * The two are plain buttons rather than a form submit, because the same form
   * cannot say which of two buttons was pressed when the press comes from a script
   * or from a browser that does not report a submitter. One function decides, and
   * the reader's text goes with whichever button asks for it.
   */
  async function press(which: "done" | "feedback"): Promise<void> {
    const requested = live.current.aim;
    if (requested === null || live.current.busy) return;
    const body = live.current.text.trim();
    if (which === "done" ? !approvable() : body === "") return;
    setBar((previous) => ({ ...previous, busy: true }));
    try {
      if (which === "done") await finish(requested, body);
      else await deliver(requested, body);
    } finally {
      setBar((previous) => ({ ...previous, busy: false }));
    }
  }

  const button = buttonState();
  const hint = hintLine();
  return (
    <>
      <form id="feedback-form" class="report-feedback-form" noValidate onSubmit={(event) => void submit(event)}>
        <textarea
          id="feedback-body"
          ref={field}
          rows={1}
          placeholder="Leave feedback for pi-sec…"
          aria-label="Feedback"
          value={bar.text}
          readOnly={bar.busy}
          onInput={(event) => {
            const text = (event.currentTarget as HTMLTextAreaElement).value;
            setBar((previous) => ({ ...previous, text }));
            // Saved on every keystroke, so a reload or a closed tab cannot lose it.
            // A store that refuses says so itself, once.
            const aimed = live.current.aim;
            if (aimed !== null) writeDraft(draftKey(aimed.id), text);
          }}
        />
        {isResult ? (
          <div class="report-feedback-buttons">
            <button
              id="feedback-done"
              type="button"
              class="button button-approve"
              aria-label="Done"
              disabled={doneState().disabled}
              onClick={() => void press("done")}
            >
              Done
            </button>
            <button
              id="feedback-submit"
              type="button"
              class="button button-feedback"
              aria-label="Feedback"
              disabled={feedbackState().disabled}
              onClick={() => void press("feedback")}
            >
              Feedback
            </button>
          </div>
        ) : (
          <button id="feedback-submit" type="submit" class={button.className} aria-label={button.label} disabled={button.disabled}>
            {button.text}
          </button>
        )}
      </form>
      {/*
        `data-hint` names the explanation, and only the explanation. The
        stylesheet hides that one at every width and leaves every other line, so
        the mark is the one thing this element says about its own text. The role
        stays: a refused press is still announced.
      */}
      <p id="feedback-hint" class="feedback-hint" role="status" data-hint={hint.explanation ? "explanation" : undefined}>
        {hint.text}
      </p>
    </>
  );
}
