/**
 * The composer's parts, and the one call that puts them on the chat page.
 *
 * Three elements of the shell are taken over, each in place: the form
 * (`#composer`, with the tray, the pickers, the field and the three actions
 * inside it), the context bar above it (`#context-bar`), and the context readout
 * in the sidebar footer (`#context-usage`). The shell's element is kept, so the
 * stylesheet's selectors, the ids the page's own tests name, and the class the
 * conversation branch toggles on the form all keep working.
 *
 * The page is assembled one branch at a time (`src/ui/pages/chat.tsx` is another
 * branch's), so this file mounts its parts and nothing else: the stream itself is
 * the conversation branch's, and what this part needs from it is registered here
 * (`onConversationEvent`) rather than opened here.
 *
 * The queue of a Send pressed while the agent is busy (`../state/send-queue.ts`)
 * is watched here, and a `pagehide` clears it.
 *
 * Two things belong to the page and not to a component: the text a reload has to
 * carry (`restoreUiState`, then the browser's own draft), and the two listeners
 * that close the `⋯` menu (`Esc`, and a press anywhere outside the row). Both are
 * added here and taken away again by the handle this returns.
 */
import { h, type ComponentType, type VNode } from "preact";
import { mountAt } from "../mount.ts";
import { restoreComposerDraft, restoreUiState, setComposerMenu } from "../state/composer.ts";
import { CONTEXT_ENTRY_KINDS, refreshContext } from "../state/context.ts";
import { cancelQueuedSend, watchSendQueue } from "../state/send-queue.ts";
import { onConversationEvent } from "../streams/conversation.ts";
import { Composer } from "./composer/Composer.tsx";
import { ContextBar, ContextReadout } from "./context/ContextBar.tsx";

/** What {@link mountChatComposer} answers: the way to take the parts out again. */
export interface ChatComposerHandle {
  /** Take every part out of the page and leave nothing behind in its place. */
  unmount(): void;
}

/** One element of the shell and the component that draws it. */
const PARTS: readonly (readonly [string, ComponentType])[] = [
  ["#context-bar", ContextBar],
  ["#context-usage", ContextReadout],
];

/** The one frame shape this part reads: an entry, for the kind that moves the bar. */
interface EntryFrame {
  readonly entry?: { readonly kind?: unknown } | null;
}

/**
 * Draw the composer, the context bar and the readout into the shell, in place.
 *
 * The text comes back first, so the first paint already holds it: what the UI
 * restart carried across its reload, and then the draft the browser kept. A field
 * the carry filled is not read over by the older draft.
 */
export function mountChatComposer(doc: Document = document): ChatComposerHandle {
  restoreUiState();
  restoreComposerDraft();

  const offs: (() => void)[] = [];
  for (const [selector, Component] of PARTS) {
    const element = doc.querySelector(selector);
    if (element === null) continue;
    offs.push(mountAt(element, h(Component, {})));
  }
  // The form is mounted with the class it arrived with, because that attribute is
  // the conversation branch's: it toggles `hidden` on the element. A class written
  // before this mount is kept rather than rewritten to `composer` alone.
  const form = doc.querySelector("#composer");
  if (form !== null) {
    const formClass = form.getAttribute("class") ?? "composer";
    // `mountAt` speaks of a component with no props; this one is told the class
    // the form arrived with, so the vnode is handed over as the page's own.
    offs.push(mountAt(form, h(Composer, { formClass }) as unknown as VNode));
  }

  // What the context bar follows: the whole state a stream opens with, the end of
  // a run, an answer, and a live entry that heads a context. Nothing else moves
  // the numbers, so nothing else reads them.
  const offStream = [
    onConversationEvent("snapshot", () => void refreshContext()),
    onConversationEvent("run_end", () => void refreshContext()),
    onConversationEvent("message_end", () => void refreshContext()),
    onConversationEvent("entry_appended", (event) => {
      const kind = (event.data as EntryFrame | null)?.entry?.kind;
      if (typeof kind === "string" && CONTEXT_ENTRY_KINDS.has(kind)) void refreshContext();
    }),
  ];
  // The bar is drawn from the last answer, so one read at open fills it before
  // anything is typed.
  void refreshContext();

  const view = doc.defaultView;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") setComposerMenu(false);
  };
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    if (target === null || typeof target.closest !== "function") return;
    if (target.closest(".composer-actions") === null) setComposerMenu(false);
  };
  // A queued message lives in this page's memory. A page the browser restores
  // from its back-forward cache must not send an old queue.
  const onPageHide = () => cancelQueuedSend();
  const stopQueue = watchSendQueue();
  view?.addEventListener("pagehide", onPageHide);
  view?.addEventListener("keydown", onKeyDown as EventListener);
  doc.addEventListener("click", onClick);

  return {
    unmount() {
      stopQueue();
      view?.removeEventListener("pagehide", onPageHide);
      view?.removeEventListener("keydown", onKeyDown as EventListener);
      doc.removeEventListener("click", onClick);
      for (const off of offStream) off();
      for (const off of offs.reverse()) off();
    },
  };
}
