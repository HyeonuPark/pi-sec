/**
 * The usage page's entry module.
 *
 * The shell (`src/web/usage.html`) already draws the page's frame: the header with
 * its reload button and its theme button, the status line, the empty card region,
 * the extension slot and the notice. This module takes each of those elements over
 * in place (`mountAt`), so the page's structure, its ids and its classes stay the
 * ones `usage.css` styles, and the extension slot below the cards is never touched.
 *
 * Nothing here opens an event stream: the page draws the answer the server wrote
 * into it, asks `GET /api/usage` only for a provider value that answer could not
 * carry, and reads again only when the reader presses a control.
 */
import type { VNode } from "preact";
import { mountAt } from "../mount.ts";
import { ThemeToggle } from "../components/theme-toggle.tsx";
import { Toast } from "../components/toast.tsx";
import { Cards } from "../usage/cards.tsx";
import { ReloadButton } from "../usage/reload.tsx";
import { StatusLine } from "../usage/status.tsx";
import { drawFirstPaint, loadUsage } from "../state/usage.ts";

/** Put a component where the shell already drew its element. */
function take(selector: string, vnode: VNode): void {
  const element = document.querySelector(selector);
  if (element === null) return;
  mountAt(element, vnode);
}

const cardsRoot = document.querySelector("#usage-cards");
if (cardsRoot === null) throw new Error("the usage page has no element matching #usage-cards");

take("#reload-usage", <ReloadButton />);
take("#theme-toggle", <ThemeToggle />);
take("#usage-status", <StatusLine />);
take("#usage-toast", <Toast id="usage-toast" />);
mountAt(cardsRoot, <Cards />);

// The page carries what the server already holds, so the cards are drawn before
// any request. Only a provider value the answer marks `reading` is still asked for.
if (!drawFirstPaint()) void loadUsage();
