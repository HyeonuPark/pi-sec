/**
 * The bar every dashboard page carries.
 *
 * It holds what a reader needs on any of the three pages: the way back to the
 * list, which repositories this dashboard watches and as whom gh is logged in,
 * whether a read is running, and the button that asks GitHub for a fresh list now.
 * On a narrow screen it also holds the button that slides a page's sidebar out as a
 * drawer, which is why that button is part of the bar rather than of a page.
 *
 * Three rules hold here:
 *
 * 1. The button reads GitHub again rather than the server's cache. That is what
 *    `?refresh=1` means, and it is why the button is a control of its own and not
 *    a second way to open the page.
 * 2. `syncing…` appears while a read is in flight, so a slow GitHub round trip
 *    looks like work rather than a dead page.
 * 3. The `☰` button exists only where a page has a sidebar. It toggles one class on
 *    `body`, and the stylesheet decides what that class slides out, so the button
 *    never has to know which page it is on.
 *
 * The component draws the whole `<header>`, tag and class included, because it
 * replaces the header the shell wrote in the same place: the stylesheet's mobile
 * rules measure the drawer from this bar's height, so the element must be the one
 * they name.
 */
import type { GithubPrRepo } from "../api/github-pr.ts";
import { toggleDrawer } from "./sidebar.ts";
import { listUrl } from "./urls.ts";

/** Everything the bar draws, as the page that draws it knows it. */
export interface TopBarProps {
  /** The login gh answers as, or `null` when the server could not read it. */
  readonly viewer: string | null;
  /** The repositories of the operator's list, in its order. */
  readonly repos: readonly GithubPrRepo[];
  /** True while a read is running, which is what `syncing…` says. */
  readonly loading: boolean;
  /** True while a forced refresh runs, which disables the button. */
  readonly forcing: boolean;
  /** Ask GitHub for the list again. */
  readonly onReload: () => void;
  /** Whether this page has a sidebar that the small-screen button opens. */
  readonly sidebar?: boolean;
}

/**
 * The `owner/repo` names and the login, as the bar writes them.
 *
 * A repository list of none says nothing rather than leaving a stray separator,
 * and a viewer the server could not read leaves the `@` off: a page that has not
 * heard from gh must not claim to know who it is.
 */
export function barLabel(viewer: string | null, repos: readonly GithubPrRepo[]): string {
  const names = repos.map((repo) => repo.repo).join(" · ");
  if (viewer === null || viewer === "") return names;
  return names === "" ? `@${viewer}` : `${names} · @${viewer}`;
}

/** The bar. */
export function TopBar({ viewer, repos, loading, forcing, onReload, sidebar = false }: TopBarProps) {
  const label = barLabel(viewer, repos);
  return (
    <header id="topbar" class="topbar">
      <a class="brand" href={listUrl()}>
        Pull requests
      </a>
      <span id="repo-slug" class="repo-slug" title={label}>
        {label}
      </span>
      <span class="spacer" />
      <span id="loading" class={loading ? "loading" : "loading hidden"} aria-live="polite">
        syncing…
      </span>
      <button
        id="reload"
        class="btn"
        type="button"
        title="Fetch the list from GitHub now"
        disabled={forcing}
        onClick={onReload}
      >
        ⟳ Reload
      </button>
      {sidebar ? (
        <button
          id="sidebar-toggle"
          class="btn"
          type="button"
          title="Toggle sidebar"
          aria-label="Toggle sidebar"
          onClick={toggleDrawer}
        >
          ☰
        </button>
      ) : null}
    </header>
  );
}
