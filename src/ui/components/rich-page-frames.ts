/**
 * The height of a rich page frame.
 *
 * A page runs in a sandboxed frame with an opaque origin, so the page around it
 * cannot read how tall the content is. The frame route appends a small script that
 * posts `{ piSecRichPage: 1, height }` to the parent. This module installs the one
 * listener that receives it.
 *
 * The message carries no authority: a page can change only the height of its own
 * frame, and only between the two limits below. So the listener needs no token.
 * It finds the sender by comparing `event.source` with the `contentWindow` of each
 * frame this document drew, and it ignores a message that no frame owns.
 */

/** The smallest and the largest height a page can give its frame, in pixels. */
export const RICH_PAGE_MIN_HEIGHT = 80;
export const RICH_PAGE_MAX_HEIGHT = 1200;

/** The class of the frame element the markdown renderer draws. */
export const RICH_PAGE_FRAME_CLASS = "rich-page-frame";

let installed = false;

function onMessage(event: MessageEvent): void {
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) return;
  const message = data as { piSecRichPage?: unknown; height?: unknown };
  if (message.piSecRichPage !== 1) return;
  const height = message.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return;
  const source = event.source;
  if (source === null) return;
  for (const frame of Array.from(document.querySelectorAll<HTMLIFrameElement>(`iframe.${RICH_PAGE_FRAME_CLASS}`))) {
    if (frame.contentWindow !== source) continue;
    const clamped = Math.min(RICH_PAGE_MAX_HEIGHT, Math.max(RICH_PAGE_MIN_HEIGHT, Math.ceil(height)));
    frame.style.height = `${clamped}px`;
    return;
  }
}

/** Install the listener once per document. Returns true on the call that installed it. */
export function installRichPageFrameListener(): boolean {
  if (installed || typeof window === "undefined") return false;
  installed = true;
  window.addEventListener("message", onMessage);
  return true;
}

/** Remove the listener. Only a test needs this. */
export function removeRichPageFrameListenerForTest(): void {
  if (!installed || typeof window === "undefined") return;
  window.removeEventListener("message", onMessage);
  installed = false;
}
