/**
 * The chats list page's entry module.
 *
 * It does what the hand-written chats page did (removed in this commit), in the
 * order that page did it:
 * take over the parts of the shell it draws (the theme button, the notice), put
 * the view in place, and then read the two lists before opening the one light
 * stream the page listens to. Everything after that is the state module working
 * on its own signals.
 *
 * The shell's `← root chat` link is left exactly as the server wrote it: its
 * address is the mount prefix the server stamped, and this page has nothing to
 * add to it.
 */
import type { VNode } from "preact";
import { ChatsView } from "../chats/chats-view.tsx";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { Toast } from "../components/toast.tsx";
import { mount, mountAt, mountPage } from "../mount.ts";
import { installChatsBridge, reload } from "../state/chats.ts";
import { showError } from "../state/toast.ts";
import { startChatsStream } from "../streams/chats.ts";

/** Take over one element the shell wrote, when the shell has that element. */
function takeOver(id: string, vnode: VNode<unknown>): void {
  const element = document.getElementById(id);
  if (element !== null) mountAt(element, vnode as VNode);
}

installChatsBridge();
mountPage("#view", ChatsView);
takeOver("theme-toggle", <ThemeToggle live />);
takeOver("toast", <Toast />);

// The hand-written page reported a page-level failure in its own notice, and so
// does this one: a rejection nobody caught is as visible as a thrown error.
window.addEventListener("error", (event) => showError(event.message));
window.addEventListener("unhandledrejection", (event) => showError(String(event.reason)));

// A page with no mount stamp cannot be read from, and the failure would otherwise
// read as an empty list. The view says what is missing, and nothing is fetched.
if (mount().known) {
  void (async () => {
    // The stream is opened after the first read, so the first snapshot has
    // something to answer. A tab that comes back still reads both lists through
    // the return: the new stream starts with a snapshot, and that reads them.
    await reload();
    startChatsStream();
    // Window focus stays as the fallback for a stream that was down while nobody
    // looked, as it was in the hand-written page.
    window.addEventListener("focus", () => void reload());
  })();
}
