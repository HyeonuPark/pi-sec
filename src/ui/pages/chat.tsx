/**
 * The chat page's entry module: the conversation, assembled.
 *
 * One page serves the root conversation and one focused chat (`?chat=<id>`), and
 * it is built from the parts four branches made, each mounted in place of the
 * element `src/web/index.html` already wrote:
 *
 * - the composer, its attachments, the context bar and the readout
 *   (`chat/ComposerParts.tsx`);
 * - the header, the transcript, the compaction line and the chat notice
 *   (`chat/ChatStreamParts.tsx`);
 * - the four sidebar panels: the questions, the inbox, the notes and the job tree
 *   (`chat/SideParts.tsx`);
 * - the three panels of the left-hand slot: the report, the text snippet and the
 *   model login (`chat/panels/Panels.tsx`);
 * - the drawer's two controls and the Pages row (`chat/sidebar/Sidebar.tsx`).
 *
 * The order below is the order the page needs. The wiring goes in first, because
 * the carry a UI restart left behind is put back while the composer mounts, and
 * the report it names can only be opened once the panel's bridge is registered.
 * The composer goes in before the transcript, because the transcript's own effect
 * toggles the class on the form the composer draws. The page reads nothing until
 * every part is in place, and `openChat` is the read: it opens the one stream and
 * starts what the stream fills.
 *
 * Nothing in this file draws. What each part says about itself is in its own file;
 * this one is the assembly, and the only things it owns are the elements the shell
 * wrote for the page as a whole: the notice and the appearance button.
 */
import type { VNode } from "preact";
import { mountAt } from "../mount.ts";
import { mountChatComposer } from "../chat/ComposerParts.tsx";
import { mountChatStream } from "../chat/ChatStreamParts.tsx";
import { mountChatPanels } from "../chat/panels/Panels.tsx";
import { mountChatSidebar } from "../chat/sidebar/Sidebar.tsx";
import { mountSideParts, startSidePanels, stopSidePanels } from "../chat/SideParts.tsx";
import { mountChatWiring } from "../chat/wiring.ts";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { Toast } from "../components/toast.tsx";
import { openChat } from "../streams/conversation.ts";

/** Take over one element the shell wrote, when the shell has that element. */
function takeOver(selector: string, vnode: VNode<unknown>): void {
  const element = document.querySelector(selector);
  if (element !== null) mountAt(element, vnode as VNode);
}

/**
 * The shell this page draws into: the form the operator types into, and the
 * transcript it answers in. A document without them is not this page (a module
 * imported on its own, a fragment), and a page assembled into it would draw into
 * places that are not there.
 */
function hasShell(): boolean {
  return document.querySelector("#composer") !== null && document.querySelector("#transcript") !== null;
}

/**
 * The parts this page put in the shell, so a test that builds and drops a page
 * many times in one process can put them back.
 */
interface Assembled {
  unmount(): void;
}

/** Put every part of the page in place, and open the one stream. */
function assemble(): Assembled {
  // The one notice and the appearance button belong to the page, not to a part.
  takeOver("#toast", <Toast />);
  takeOver("#theme-toggle", <ThemeToggle />);

  // The wiring first: it is the registration the composer's carry reads.
  const wiring = mountChatWiring(document);

  // The parts, in the order the page needs them.
  const panels = mountChatPanels(document);
  const sidebar = mountChatSidebar(document);
  const composer = mountChatComposer(document);
  const stream = mountChatStream(document);

  // The sidebar's four panels, and the read that fills them. The notes are left
  // to `openChat`, whose header read of `/api/admin/status` carries them too: one
  // screen, one read of that route, which is what the hand-written page did.
  mountSideParts(document);
  void startSidePanels(document, { readNotes: false });

  // The page's one read: the chat's record, then the stream.
  void openChat();

  return {
    unmount() {
      stopSidePanels(document);
      stream.unmount();
      composer.unmount();
      sidebar.unmount();
      panels.unmount();
      wiring.unmount();
    },
  };
}

/**
 * Hand back what this page put in the shell.
 *
 * A page is torn down by the browser, not by a call, so nothing on the page uses
 * this; it exists for the tests, which build and drop a page many times in one
 * process and need the timers and listeners of the last one gone.
 */
export function unmountChatPage(): void {
  assembled?.unmount();
  assembled = undefined;
}

/** The parts of the page that are on the document, when they are. */
let assembled: Assembled | undefined;

if (hasShell()) assembled = assemble();
