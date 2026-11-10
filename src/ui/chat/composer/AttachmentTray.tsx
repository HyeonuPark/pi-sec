/**
 * The files waiting above the field, one chip each.
 *
 * A chip states the name, the size and either the progress or the reason it
 * failed, and carries the two controls a chip has: Retry on a failed one, and
 * Remove on all of them. The tray is hidden and empty at rest, so it costs no
 * room until a file is picked.
 *
 * The chips are drawn by key, in the order they were picked, and each is a
 * component of its own: an upload that finishes on one chip changes that chip's
 * text and leaves every other element where it was, including the focus on
 * another chip's Retry.
 */
import type { AttachmentEntry } from "../../state/attachments.ts";
import { attachments, removeAttachment, retryAttachment } from "../../state/attachments.ts";
import { formatBytes } from "../../components/format-bytes.ts";

/** The one line under the name: progress, the reason it failed, or what it is. */
function chipMeta(entry: AttachmentEntry): string {
  if (entry.status === "uploading") return `${formatBytes(entry.bytes)} · uploading…`;
  if (entry.status === "failed") return entry.error === "" ? "upload failed" : entry.error;
  return [entry.mime, formatBytes(entry.bytes)].filter((part) => part !== "").join(" · ");
}

/** One file: its name, its state, and what can be done to it. */
function AttachmentChip({ entry }: { readonly entry: AttachmentEntry }) {
  return (
    <span class={`attachment-chip is-${entry.status}`} title={entry.note === "" ? undefined : entry.note}>
      <span class="attachment-name">{entry.name}</span>
      <span class="attachment-meta">{chipMeta(entry)}</span>
      {entry.status === "failed" ? (
        <button class="attachment-retry" type="button" data-retry={entry.key} onClick={() => retryAttachment(entry.key)}>
          Retry
        </button>
      ) : null}
      <button
        class="attachment-remove"
        type="button"
        data-remove={entry.key}
        aria-label={`Remove ${entry.name}`}
        onClick={() => removeAttachment(entry.key)}
      >
        ✕
      </button>
    </span>
  );
}

/** The tray: hidden and empty until a file is picked. */
export function AttachmentTray() {
  const entries = attachments.value;
  return (
    <div
      id="attachment-tray"
      class={`attachment-tray${entries.length === 0 ? " hidden" : ""}`}
      aria-label="Attachments for the next message"
    >
      {entries.map((entry) => (
        <AttachmentChip key={entry.key} entry={entry} />
      ))}
    </div>
  );
}
