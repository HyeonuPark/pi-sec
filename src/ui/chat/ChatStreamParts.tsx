/**
 * The parts of the chat page this branch owns, and the one call that puts them in
 * the page.
 *
 * The chat page is assembled by the panel branch (`src/ui/pages/chat.tsx`), and the
 * shell it draws into is `src/web/index.html`: a header with a pill, a ring, a model
 * pill, five banners, a title and a mark; the transcript and its compaction line; the
 * notice under the composer. Each of those is an element the shell already wrote, so
 * each component is mounted in place of its element with `mountAt`, and the element
 * keeps its parent, its place and its siblings.
 *
 * The composer is not this branch's, so it is not mounted here. What this branch
 * owns of it is one class: an archived or unknown chat loses the composer, and that
 * is the whole of the notice's job besides its line.
 */
import { effect } from "@preact/signals";
import { h, type ComponentType } from "preact";
import { mountAt } from "../mount.ts";
import { chat, chatBlocked, chatName } from "../state/conversation.ts";
import { unwatchPane, setTranscriptElement, watchPane } from "../state/transcript.ts";
import { ActivityRing, ConnectionPill, ModelPill } from "./connection/Connection.tsx";
import { ConfigBanner, CredentialBanner, MountBanner, RestartBanner, UsageBanner } from "./header/Banners.tsx";
import { ChatMark, ChatNotice, ChatTitle } from "./header/ChatTitle.tsx";
import { SetupCard } from "./setup/SetupCard.tsx";
import { CompactionStatus, Transcript } from "./transcript/Transcript.tsx";

/** What {@link mountChatStream} answers: the way to take the parts out again. */
export interface ChatStreamHandle {
  /** Take every part out of the page and leave nothing behind in its place. */
  unmount(): void;
}

/** One element of the shell and the component that draws it. */
const PARTS: readonly (readonly [string, ComponentType])[] = [
  ["#connection", ConnectionPill],
  ["#activity", ActivityRing],
  ["#model", ModelPill],
  ["#chat-mark", ChatMark],
  ["#chat-title", ChatTitle],
  ["#restart-banner", RestartBanner],
  ["#config-banner", ConfigBanner],
  ["#mount-banner", MountBanner],
  ["#credential-banner", CredentialBanner],
  ["#usage-banner", UsageBanner],
  ["#setup-card", SetupCard],
  ["#transcript", Transcript],
  ["#compaction-status", CompactionStatus],
  ["#chat-notice", ChatNotice],
];

/**
 * Draw the header and the transcript into the shell, in place.
 *
 * The transcript element is handed to the state module before the components are
 * drawn, because the draw itself asks where it is: the pane it scrolls in, and the
 * observer that follows a row which grows after it was drawn.
 */
export function mountChatStream(doc: Document = document): ChatStreamHandle {
  setTranscriptElement(doc.querySelector("#transcript"));
  const offs: (() => void)[] = [];
  for (const [selector, Component] of PARTS) {
    const element = doc.querySelector(selector);
    if (element === null) continue;
    offs.push(mountAt(element, h(Component, {})));
  }
  // The pane is watched from here as well as from the transcript's own effect: the
  // observer has to be made after the elements exist, and this is the moment they
  // do. The effect is the page's own fallback for a transcript drawn later.
  watchPane();
  // The browser tab and the body's `data-chat` are what the bar's state also says,
  // and neither is an element a component can be mounted in place of.
  const offDocument = effect(() => {
    const focused = !chat.value.root;
    doc.title = focused ? `${chatName.value} · pi-sec` : "pi-sec";
    doc.body.dataset.chat = focused ? "focused" : "root";
  });
  // The composer belongs to another branch; this branch only says when it has no
  // place on the page, which is a class on the element the shell wrote.
  const offComposer = effect(() => {
    const blocked = chatBlocked.value !== null;
    doc.querySelector("#composer")?.classList.toggle("hidden", blocked);
  });
  return {
    unmount() {
      offComposer();
      offDocument();
      unwatchPane();
      for (const off of offs.reverse()) off();
    },
  };
}
