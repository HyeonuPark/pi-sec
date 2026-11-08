/**
 * The three panels of the page's one left-hand slot, and the one call that puts
 * them in the page.
 *
 * The report panel, the text snippet panel and the model login panel are three
 * `<aside>` elements the shell already wrote, in the same grid cell. Each is
 * mounted in place with `mountAt`, so the element keeps its parent, its place and
 * its siblings, and the stylesheet's selectors keep finding it; the sheet shows
 * one of the three from a flag on `<body>`, which this file writes from the state
 * that decides it.
 *
 * Nothing is opened here. A press opens a panel through
 * `src/ui/state/panels.ts` (or the snippet and login modules that take the slot
 * from it), and this file only draws what that state says.
 */
import { effect } from "@preact/signals";
import { h, type ComponentType } from "preact";
import { mountAt } from "../../mount.ts";
import { applyBodyFlags } from "../../state/panels.ts";
import { LoginPanel } from "./LoginPanel.tsx";
import { ReportPanel } from "./ReportPanel.tsx";
import { SnippetPanel } from "./SnippetPanel.tsx";

/** What {@link mountChatPanels} answers: the way to take the parts out again. */
export interface ChatPanelsHandle {
  /** Take every panel out of the page and leave nothing behind in its place. */
  unmount(): void;
}

/** One element of the shell and the component that draws it. */
const PARTS: readonly (readonly [string, ComponentType])[] = [
  ["#report-pane", ReportPanel],
  ["#snippet-pane", SnippetPanel],
  ["#login-pane", LoginPanel],
];

/**
 * Draw the three panels into the shell, in place.
 *
 * The `<body>` flags are written from the state, so the stylesheet and the panel
 * cannot disagree about which one is up: one effect reads the two signals that
 * decide it and writes the four flags they name.
 */
export function mountChatPanels(doc: Document = document): ChatPanelsHandle {
  const offs: (() => void)[] = [];
  for (const [selector, Component] of PARTS) {
    const element = doc.querySelector(selector);
    // A document that is not this page's shell has no such element, and a page
    // that has none draws what it can: the parts that are elsewhere skip what is
    // missing for the same reason.
    if (element === null) continue;
    offs.push(mountAt(element, h(Component, {})));
  }
  const offFlags = effect(() => applyBodyFlags(doc));
  return {
    unmount() {
      offFlags();
      for (const off of offs.reverse()) off();
    },
  };
}
