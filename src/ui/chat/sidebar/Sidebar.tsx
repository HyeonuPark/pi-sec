/**
 * The sidebar's own two parts: the drawer, and the Pages row in the footer.
 *
 * The work panel is a column on a wide screen and a drawer over the transcript on
 * a narrow one. Which of the two it is, is the stylesheet's business; what this
 * file owns is the state the stylesheet reads — `body[data-sidebar]` — the two
 * controls that move it (the header's button and the scrim), and the rule that a
 * mode starts the way that mode reads: out on a wide screen, closed on a narrow
 * one, and back to that default whenever the width crosses the breakpoint.
 *
 * The Pages row is one dropdown with the three pages beside the chat page. Each
 * link carries the mount the page was served at, because behind a path-prefix
 * proxy the browser's own URL says nothing about it, and each opens in a new tab,
 * because following one in place would throw the draft away.
 *
 * The row draws three links itself and then the links the enabled extensions
 * declare, which the server plants in the page as the `pages-links` data block.
 * A page served by a server whose extensions declare none, or one that cannot be
 * read, draws the three and nothing else. Each time the menu opens, it reads the
 * list again from `GET /api/ui/page-links`, so a page that a runtime extension
 * added after the page loaded appears without a reload.
 */
import { h, type ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { request } from "../../api/request.ts";
import { at, mountAt } from "../../mount.ts";
import { afterTheTask, isNarrow, setSidebar, sidebarIsOpen, sidebarMoved, watchWidth } from "../../state/panels.ts";

/** One entry of the menu: the menu text and the route under the mount. */
export interface PageLink {
  readonly label: string;
  readonly path: string;
}

/** The companion pages, in the order the menu shows them. */
export const PAGE_LINKS: readonly PageLink[] = [
  { label: "Reports", path: "/report" },
  { label: "Usage", path: "/usage" },
  { label: "Chats", path: "/chats" },
];

/** The id of the data block the enabled extensions' page links arrive in. */
export const PAGE_LINKS_BLOCK_ID = "pages-links";

/**
 * The page links the server planted in this page, after the row's own three.
 *
 * The block is data, so it is read here rather than run. A page with no block, a
 * block that is not JSON, and a value that is not an array of links all answer
 * an empty list: the menu keeps the three links it always had instead of failing
 * to draw. Every entry is checked again, because this list decides whether the
 * menu draws a link and a server older than this code may have written another
 * shape.
 */
export function extensionPageLinks(doc: Document = document): PageLink[] {
  const element = doc.getElementById(PAGE_LINKS_BLOCK_ID);
  if (element === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(element.textContent ?? "");
  } catch {
    return [];
  }
  return readPageLinks(parsed);
}

/** The valid links of a parsed value: every entry is checked, the rest are dropped. */
function readPageLinks(parsed: unknown): PageLink[] {
  if (!Array.isArray(parsed)) return [];
  const links: PageLink[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) continue;
    const label = (entry as { label?: unknown }).label;
    const path = (entry as { path?: unknown }).path;
    if (typeof label !== "string" || label.trim() === "") continue;
    if (typeof path !== "string" || !path.startsWith("/")) continue;
    links.push({ label, path });
  }
  return links;
}

/** The route that answers the current extension links, read each time the menu opens. */
export const PAGE_LINKS_ROUTE = "/api/ui/page-links";

/**
 * The current extension links from the server, or `undefined` when the read
 * fails. The caller then keeps the list it has: the menu never gets emptier
 * because a request failed.
 */
export async function fetchExtensionPageLinks(): Promise<PageLink[] | undefined> {
  try {
    const parsed = await request<unknown>(PAGE_LINKS_ROUTE);
    return Array.isArray(parsed) ? readPageLinks(parsed) : undefined;
  } catch {
    return undefined;
  }
}

/** The row's wrapper: the button and its menu share one positioning box. */
const ROW = ".sidebar-more";

/** The header's button: the one control that opens and closes the drawer. */
export function SidebarToggle() {
  const open = sidebarIsOpen();
  // Until something moves the drawer, the button says what it does and not which
  // way it would go; that is the text the shell wrote.
  const label = sidebarMoved.value
    ? open
      ? "Hide the work panel"
      : "Show the work panel"
    : "Toggle the work panel";
  return (
    <button
      id="sidebar-toggle"
      class="icon-button"
      type="button"
      aria-label={label}
      aria-expanded={open ? "true" : "false"}
      aria-controls="sidebar"
      onClick={() => setSidebar(!open)}
    >
      ☰
    </button>
  );
}

/** The sheet over the transcript: a press anywhere on it puts the drawer away. */
export function SidebarScrim() {
  return <div id="sidebar-scrim" class="scrim" onClick={() => setSidebar(false)}></div>;
}

/**
 * The Pages row: one button, and the menu it opens upward.
 *
 * The menu is built here rather than written into the shell, because the mount
 * prefix is only known once the page is in the browser (`base.js` resolves it).
 * A press anywhere outside the row closes it, so does `Esc`, and so does a press
 * on one of its links. The last of the three closes one task after the press, the
 * way the report panel's `Open page` does: the browser takes the link's address in
 * the task the press runs in, so nothing this row draws afterwards can stand
 * between the reader and the tab they asked for.
 */
export function PagesRow() {
  const [open, setOpen] = useState(false);
  // Starts from the block the server wrote into the page. Each time the menu
  // opens, the list is read again from the server, so a page an extension added
  // after this page loaded appears without a reload. A failed read keeps the list.
  const [links, setLinks] = useState<readonly PageLink[]>(() => [...PAGE_LINKS, ...extensionPageLinks()]);
  // Each read takes a number. An answer replaces the list only while its number is
  // the newest, so an older read that ends last never puts an older list back.
  const newest = useRef(0);
  const refreshLinks = (): void => {
    const mine = ++newest.current;
    void fetchExtensionPageLinks().then((fresh) => {
      if (mine === newest.current && fresh !== undefined) setLinks([...PAGE_LINKS, ...fresh]);
    });
  };
  // A press on a link is a press that leaves, so the row puts itself away. The
  // close waits one task, so the browser has taken the link's address before the
  // menu's class changes. A middle-button press (`auxclick`, button 1) is the same
  // press to the reader; the right button is the browser's own menu, which the
  // page cannot see.
  const closeAfterPress = (event: MouseEvent): void => {
    if (event.type === "auxclick" && event.button !== 1) return;
    afterTheTask(() => setOpen(false));
  };
  useEffect(() => {
    const view = window;
    const onClick = (event: Event): void => {
      const target = event.target as Element | null;
      if (target !== null && typeof target.closest === "function" && target.closest(ROW) !== null) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    view.document.addEventListener("click", onClick);
    view.document.addEventListener("keydown", onKeyDown as EventListener);
    return () => {
      view.document.removeEventListener("click", onClick);
      view.document.removeEventListener("keydown", onKeyDown as EventListener);
    };
  }, []);
  return (
    <div class="sidebar-more">
      <button
        id="pages-toggle"
        class="button"
        type="button"
        aria-expanded={open ? "true" : "false"}
        aria-controls="pages-menu"
        aria-haspopup="menu"
        onClick={() => {
          setOpen(!open);
          if (!open) refreshLinks();
        }}
      >
        ↗ Open
      </button>
      <div id="pages-menu" class={open ? "sidebar-menu open" : "sidebar-menu"} role="menu" aria-label="Pages">
        {links.map((link) => (
          <a
            key={link.path}
            class="button"
            role="menuitem"
            href={at(link.path)}
            target="_blank"
            rel="noopener"
            onClick={closeAfterPress}
            onAuxClick={closeAfterPress}
          >
            {link.label}
          </a>
        ))}
      </div>
    </div>
  );
}

/** What {@link mountChatSidebar} answers: the way to take the parts out again. */
export interface ChatSidebarHandle {
  unmount(): void;
}

/** One element of the shell and the component that draws it. */
const PARTS: readonly (readonly [string, ComponentType])[] = [
  ["#sidebar-toggle", SidebarToggle],
  ["#sidebar-scrim", SidebarScrim],
  [".sidebar-more", PagesRow],
];

/**
 * Draw the drawer's two controls and the Pages row, and follow the width.
 *
 * The width is read as the parts go in: a narrow page starts with the drawer
 * closed, because a closed drawer is what a phone shows a transcript through.
 */
export function mountChatSidebar(doc: Document = document): ChatSidebarHandle {
  const offs: (() => void)[] = [];
  for (const [selector, Component] of PARTS) {
    const element = doc.querySelector(selector);
    if (element === null) continue;
    offs.push(mountAt(element, h(Component, {})));
  }
  // Crossing the breakpoint returns to the default of the mode entered: a column
  // that is out, a drawer that is away.
  const offWidth = watchWidth((narrow) => setSidebar(!narrow));
  // A narrow page starts with the drawer closed; a wide one starts as it stands in
  // the shell, in flow and out, and nothing has moved it yet.
  if (isNarrow()) setSidebar(false);
  return {
    unmount() {
      offWidth();
      for (const off of offs.reverse()) off();
    },
  };
}
