/**
 * The drawer a page's sidebar becomes on a narrow screen.
 *
 * A pull request and a diff each put a sidebar beside the content: the facts and
 * the CI jobs on one, the changed files on the other. Below 768 pixels the
 * stylesheet takes that sidebar out of the flow and shows it as a panel over the
 * content, and the only thing the page does is say whether it is open.
 *
 * It says so with one class on `body`, which is what the stylesheet measures. That
 * is why this is here and not in each page: two pages that each kept their own
 * flag would disagree about the class the stylesheet reads, and the button would
 * have to know which page it is on to open the right sidebar.
 */
import { signal } from "@preact/signals";

/** Whether the drawer is open. The class on `body` is this value's only effect. */
export const drawerOpen = signal(false);

/** Draw the drawer's class from the value, which is the one place that changes it. */
function apply(): void {
  if (typeof document === "undefined") return;
  document.body.classList.toggle("sidebar-open", drawerOpen.value);
}

/** Open the drawer, or close it when it is open. */
export function toggleDrawer(): void {
  drawerOpen.value = !drawerOpen.value;
  apply();
}

/** Close the drawer, which a page does after a press inside it moved the reader. */
export function closeDrawer(): void {
  if (!drawerOpen.value) return;
  drawerOpen.value = false;
  apply();
}
