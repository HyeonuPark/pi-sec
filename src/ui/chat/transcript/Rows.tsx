/**
 * One row of the transcript, drawn from the value the state module built.
 *
 * Every row's root element carries `data-row-key`, which is the key the state
 * module matched it by, and every folded card carries `data-group-key`, which is
 * what the operator's own open state is remembered under. A row that did not
 * change between draws is handed the same props, so Preact leaves the element, the
 * text selection inside it and the focus on it alone.
 *
 * The markdown of a bubble goes through the shared `Markdown` component, which
 * draws only when its text changes.
 */
import { useLayoutEffect } from "preact/hooks";
import { Markdown } from "../../components/markdown.tsx";
import { mount } from "../../mount.ts";
import {
  attachmentInfo,
  followingTail,
  isGroupOpen,
  loadEarlier,
  setGroupOpen,
  transcriptPane,
  type RunItemRow,
  type TranscriptRow,
} from "../../state/transcript.ts";
import { toolOutputs } from "../../state/run.ts";
import type { AttachmentDescriptor } from "../../../shared/wire/conversation.ts";

/**
 * The flag a row carries when the page drew it from a `Load previous session`
 * press rather than from the model's own context.
 *
 * The transcript is one live region, so a press that brings hundreds of rows at
 * once would be read out in full. A row that carries this flag is not announced:
 * the press changed what the reader is looking at, and it must not also speak.
 */
function liveOff(earlier: boolean | undefined): { readonly "aria-live": "off" } | undefined {
  return earlier === true ? { "aria-live": "off" } : undefined;
}

/** The address of one attachment, under the mount, or its download form. */
function attachmentUrl(id: string, suffix = ""): string {
  return `${mount().base}/api/attachments/${encodeURIComponent(id)}${suffix}`;
}

/** Bytes the way a chip says them: 1200 is "1.2 KB", not "1172 B". */
function formatBytes(bytes: number | undefined): string {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return "";
  if (value < 1000) return `${value} B`;
  const units = ["KB", "MB", "GB"];
  let scaled = value / 1000;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}

/**
 * One attachment a sent message names.
 *
 * A message carries ids only, so a picture draws when this page knows the id is an
 * image. Anything the page did not upload itself has no name and no MIME to print,
 * so it draws as a chip that names its id and still downloads: guessing an image
 * there would draw a broken picture where a file is.
 */
function AttachmentReference({ id, info }: { readonly id: string; readonly info: AttachmentDescriptor | undefined }) {
  const mime = info?.mime ?? "";
  if (mime.startsWith("image/")) {
    return (
      <a class="message-image" href={attachmentUrl(id)} target="_blank" rel="noopener noreferrer">
        <img
          src={attachmentUrl(id)}
          alt={info?.name ?? id}
          width={info?.w === undefined ? undefined : Number(info.w)}
          height={info?.h === undefined ? undefined : Number(info.h)}
          loading="lazy"
        />
      </a>
    );
  }
  const meta = [mime, info?.bytes === undefined ? "" : formatBytes(info.bytes)].filter((part) => part !== "").join(" · ");
  return (
    <a class="message-file" href={attachmentUrl(id, "/download")} target="_blank" rel="noopener noreferrer">
      <span class="message-file-name">{info?.name ?? id}</span>
      {meta === "" ? null : <span class="message-file-meta">{meta}</span>}
    </a>
  );
}

/** The files a message carries, below its text. Nothing is drawn for a message without any. */
function MessageAttachments({ ids }: { readonly ids: readonly string[] }) {
  const known = attachmentInfo.value;
  if (ids.length === 0) return null;
  return (
    <div class="message-attachments">
      {ids.map((id) => (
        <AttachmentReference key={id} id={id} info={known.get(id)} />
      ))}
    </div>
  );
}

/**
 * One panel of a folded stretch: a tool call, or a message that is not the
 * operator's.
 *
 * A live tool panel carries its call id, so its output can be written into this
 * panel without rebuilding the row around it: the output is read from the run state
 * here, and only this element re-renders when it grows.
 */
function RunItem({ item }: { readonly item: RunItemRow }) {
  if (item.kind === "message") {
    const meta = item.labels.length === 0 ? "" : ` · ${item.labels.join(", ")}`;
    return (
      <div class="message-item">
        <div class="message-item-name">
          {item.source}
          {meta}
        </div>
        <pre>{item.body}</pre>
      </div>
    );
  }
  // Only a call still in flight carries its id: a committed call's output never
  // changes again, and the id would let a rewrite find a panel that cannot move.
  const live = item.live === true ? (item.callId ?? null) : null;
  const text = live === null ? item.text : (toolOutputs.value.get(live) ?? "");
  // A panel that grew after its draw follows the tail, exactly as a full draw
  // does, when the reader was already there. A reader scrolled up keeps their place.
  useLayoutEffect(() => {
    if (live === null) return;
    if (!followingTail()) return;
    const pane = transcriptPane();
    if (pane !== null) pane.scrollTop = pane.scrollHeight;
  });
  return (
    <div class="tool-item" data-tool-call-id={live ?? undefined}>
      <div class="tool-item-name">{item.name}</div>
      <pre>{text}</pre>
    </div>
  );
}

/** One folded working stretch: its tool calls and its folded messages, in arrival order. */
function RunCard({
  row,
  live,
}: {
  readonly row: Extract<TranscriptRow, { type: "run" }>;
  /** The `aria-live` flag of a row a press brought, when it carries one. */
  readonly live?: { readonly "aria-live": "off" };
}) {
  return (
    <details
      class="tool-card run-group"
      data-group-key={row.groupKey}
      data-row-key={row.key}
      {...live}
      open={isGroupOpen(row.groupKey)}
      onToggle={(event) => setGroupOpen(row.groupKey, (event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>{row.head}</summary>
      <div class="run-group-body">
        {row.items.map((item) => (
          <RunItem key={item.key} item={item} />
        ))}
      </div>
    </details>
  );
}

/** The report a review or an approval is about, as the report page addresses it. */
function reportHref(report: string): string {
  return `${mount().base}/report/${encodeURIComponent(report)}`;
}

/**
 * One row. The element each row draws is the element the shell's CSS is written
 * against, and a row that draws nothing but an empty list is not built at all.
 *
 * `earlier` says the row came from a `Load previous session` press. Such a row
 * is drawn with `aria-live="off"`, which is the one thing that keeps a press of
 * hundreds of rows out of a screen reader's mouth; a row that does not carry it
 * is announced as every row always was.
 */
export function TranscriptRow({ row }: { readonly row: TranscriptRow }) {
  // A row a press brought carries the flag itself, so a row that a press did not
  // bring cannot be marked by accident.
  const live = liveOff(row.earlier);
  switch (row.type) {
    case "load-earlier":
      // The button sits above the session restart line, which is the top of what
      // the page shows. Its description says what a press does, because the label
      // alone does not say that the transcript is about to get much longer. The
      // press is refused while a read is in flight, so a second press cannot ask
      // for the same session twice.
      return (
        <div class="load-earlier" data-row-key={row.key}>
          <button
            type="button"
            class="button load-earlier-button"
            disabled={row.loading}
            aria-busy={row.loading ? "true" : undefined}
            aria-description="Shows the conversation stored before this session, above the transcript. Nothing is sent to the model."
            onClick={() => void loadEarlier()}
          >
            {row.label}
          </button>
        </div>
      );
    case "user":
      return (
        <div class="message user" data-row-key={row.key} {...live}>
          <Markdown text={row.text} />
          <MessageAttachments ids={row.attachments} />
        </div>
      );
    case "assistant":
      return (
        <div class="message assistant" data-row-key={row.key} {...live}>
          <Markdown text={row.text} />
        </div>
      );
    case "review":
      return (
        <div class="message review" data-row-key={row.key} {...live}>
          <div class="review-head">
            feedback · <a href={reportHref(row.review.report)} target="_blank" rel="noopener noreferrer">{row.review.report}</a>
            {row.review.version === "" ? null : ` · v${row.review.version}`}
          </div>
          <Markdown class="review-body" text={row.review.body} />
        </div>
      );
    case "approval": {
      // The report is named by its title when the note carries one, and by its slug
      // otherwise, which is the address the link opens either way. A press of Done
      // reads `Done` rather than `Approved`, and the words the user wrote with it
      // are shown under the line: they are the request, and the card is where the
      // user reads back what they asked for.
      const named =
        /^The (?:operator|user) (?:approved|pressed Done on) revision \d+ of "([^"]+)"/.exec(row.approval.body)?.[1] ??
        row.approval.report;
      const verb = row.approval.button === "done" ? "Done" : "Approved";
      return (
        <div class="message approval" data-row-key={row.key} {...live}>
          <div class="approval-head">
            {verb} · <a href={reportHref(row.approval.report)} target="_blank" rel="noopener noreferrer">{named}</a>
            {row.approval.version === "" ? null : ` · v${row.approval.version}`}
          </div>
          {row.approval.text === "" ? null : <Markdown class="approval-body" text={row.approval.text} />}
        </div>
      );
    }
    case "answer":
      return (
        <div class="message answer" data-row-key={row.key} {...live}>
          <div class="answer-question">{row.answer.question}</div>
          <div class="answer-choice">{row.answer.answer}</div>
        </div>
      );
    case "divider":
      return (
        <div class="divider" data-row-key={row.key} {...live}>
          {row.label}
        </div>
      );
    case "section":
      return (
        <details
          class="message section-note"
          data-group-key={row.groupKey}
          data-row-key={row.key}
          {...live}
          open={isGroupOpen(row.groupKey)}
          onToggle={(event) => setGroupOpen(row.groupKey, (event.currentTarget as HTMLDetailsElement).open)}
        >
          <summary>system prompt section changed: show the new value</summary>
          <Markdown class="section-note-body" text={row.text} />
        </details>
      );
    case "run":
      return <RunCard row={row} live={live} />;
    case "writing":
      return (
        <div
          class={`message assistant writing${row.writing ? "" : " idle"}`}
          data-row-key={row.key}
          aria-hidden={row.writing ? undefined : "true"}
        >
          <span class="writing-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span class="writing-label">writing…</span>
        </div>
      );
    default:
      return null;
  }
}
