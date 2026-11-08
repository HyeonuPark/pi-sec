/**
 * The page's one way to find out where it is mounted, and the one way to put a
 * component on it.
 *
 * `src/web/base.js` is a classic script that runs before every page bundle. It
 * installs `window.piSecMount`, which reads the mount prefix the server stamped
 * into `<meta name="pi-sec-base">` and, when that is missing, infers it from the
 * page's own path. This module wraps it with types, so page code cannot build a
 * URL without the mount and cannot call it with a relative route.
 *
 * The `<meta>` values the server stamps into every page are read here too: the
 * mount prefix, the harness time zone, and the registered name. The server
 * stamps them rather than writing an inline script, because the pages are served
 * under a CSP that forbids one (`src/server/static.ts`).
 */
import { h, render, type ComponentType, type ContainerNode, type VNode } from "preact";

/** What `src/web/base.js` installs on `window`, as this module uses it. */
export interface PiSecMountBridge {
  resolve(doc?: Document): { readonly base: string; readonly known: boolean; readonly inferred: boolean };
  at(base: string, route: string): string;
  join(base: string, route: string): string;
  usable(value: string): boolean;
  trim(value: string): string;
}

declare global {
  interface Window {
    piSecMount?: PiSecMountBridge;
  }
}

/** Where this page is mounted, and whether that is known or a guess. */
export interface MountInfo {
  /** The prefix every route starts with; empty when the app is at the root. */
  readonly base: string;
  /**
   * False when the page carried no stamp and its path names no page, so every
   * URL built from `base` would be a guess. The page says so instead.
   */
  readonly known: boolean;
}

/** The `<meta>` name the server stamps a value into. */
const BASE_META = 'meta[name="pi-sec-base"]';
const TIMEZONE_META = 'meta[name="pi-sec-timezone"]';
const NAME_META = 'meta[name="pi-sec-name"]';

/** One `<meta>` value, trimmed; empty when the page has no such element. */
function metaValue(name: string): string {
  if (typeof document === "undefined") return "";
  const element = document.querySelector(`meta[name="${name}"]`);
  return (element?.getAttribute("content") ?? "").trim();
}

/**
 * Where this page is mounted.
 *
 * The bridge decides when it is there, because it is the copy the server stamps
 * and the fallback it infers from the path. Without it (a page that did not load
 * `base.js`, as in a unit test) the stamp alone answers, and an empty stamp means
 * the mount is unknown rather than empty.
 */
export function resolveMount(): MountInfo {
  const bridge = typeof window === "undefined" ? undefined : window.piSecMount;
  if (bridge !== undefined) {
    const resolved = bridge.resolve();
    return { base: resolved.base, known: resolved.known };
  }
  const stamped = metaValue("pi-sec-base");
  if (stamped !== "") return { base: stamped, known: true };
  return { base: "", known: typeof document === "undefined" };
}

/** The mount resolved once, on first use: one page does not move while it is open. */
let cachedMount: MountInfo | undefined;

/** The mount of this page. */
export function mount(): MountInfo {
  cachedMount ??= resolveMount();
  return cachedMount;
}

/**
 * A route under the mount: `at("/api/jobs")` is `/sec/api/jobs` behind a proxy
 * that serves the app at `/sec`.
 *
 * The route must be absolute. A relative one would silently resolve against
 * whatever page happens to be open, which is the bug `base.js` exists to stop.
 */
export function at(route: string): string {
  if (typeof route !== "string" || route.charAt(0) !== "/") {
    throw new Error(`a route must be absolute, got ${JSON.stringify(route)}`);
  }
  return `${mount().base}${route}`;
}

/** The harness time zone the server stamped into the page, as an IANA name. */
export function timezone(): string {
  return metaValue("pi-sec-timezone");
}

/**
 * The registered name, which is what the root conversation is called.
 *
 * An empty string means no name is registered: the page then shows its own
 * default, the name of the install.
 */
export function installName(): string {
  return metaValue("pi-sec-name");
}

/**
 * Draw `component` into the first element that `selector` matches.
 *
 * The selector is the page's own root, not a region the page redraws: Preact
 * owns everything under it, which is what keeps one unchanged element the same
 * element across an update.
 */
export function mountPage(selector: string, component: ComponentType): void {
  if (typeof document === "undefined") {
    throw new Error(`cannot mount ${selector}: this page has no document`);
  }
  const host = document.querySelector(selector);
  if (host === null) {
    throw new Error(`the page has no element matching ${selector}`);
  }
  render(h(component, {}), host);
}

/**
 * The container `mountAt` hands to `render`: a stand-in for the real parent
 * whose whole child range is the one element being replaced.
 *
 * Preact 11 dropped the third argument of `render` (`replaceNode`), so the only
 * way to put a tree where an element already is, without claiming its siblings,
 * is to look like a container that holds that element and nothing else. A
 * container only has to answer what `render` and the diff read of it: the child
 * range it starts from (`childNodes`, `firstChild`), where new nodes go
 * (`insertBefore`, `appendChild`, `removeChild`), the namespace and document of
 * new nodes, and the rendered tree it keeps on `_children` between renders.
 * Every write is passed to the real parent, so the element keeps its place.
 *
 * `src/render.js` builds the nodes it may reuse from `parentDom.childNodes`, and
 * `src/diff/index.js` reuses the one whose tag matches; that is why the first
 * render keeps the element itself rather than drawing beside it. An update never
 * goes through this object's child range: `src/component.js` re-renders a
 * component against `component._parentDom` and the tree it already drew, so only
 * the element that changed is touched.
 */
interface RootFragment extends ContainerNode {
  /** The tree `render` keeps here, which is how it finds the old one again. */
  _children?: VNode | null;
  readonly namespaceURI: string | null;
  readonly ownerDocument: Document | null;
}

/** A container whose only child is `element`, writing through to `parent`. */
function rootFragment(element: Element, parent: Element | DocumentFragment): RootFragment {
  return {
    nodeType: parent.nodeType,
    parentNode: parent,
    firstChild: element,
    childNodes: [element],
    insertBefore(node: ContainerNode, child: ContainerNode | null): ContainerNode {
      return parent.insertBefore(node as Node, child as Node | null) as ContainerNode;
    },
    appendChild(node: ContainerNode): ContainerNode {
      return parent.appendChild(node as Node) as ContainerNode;
    },
    removeChild(child: ContainerNode): ContainerNode {
      return parent.removeChild(child as Node) as ContainerNode;
    },
    // The element's namespace is the one its place is in, which is what a new
    // node needs; a document fragment carries none of its own.
    namespaceURI: element.namespaceURI,
    ownerDocument: element.ownerDocument,
  };
}

/**
 * Draw `vnode` in place of `element`, and answer the function that takes it
 * away again.
 *
 * This is for the parts of a page the shell already wrote: the theme button, the
 * notice, the usage cards. The element keeps its parent, its place among its
 * siblings, and the siblings themselves keep their identity, so server-rendered
 * neighbours such as the extension slots stay where they are. Everything the
 * component draws lives inside that one place, and an update changes only that.
 *
 * The element must be in the page: an element with no parent has no place to
 * keep, and the caller has asked for the wrong thing.
 *
 * The returned function takes the component out of the page and leaves nothing
 * behind in that place. It is safe to call twice.
 */
export function mountAt(element: Element, vnode: VNode): () => void {
  const parent = element.parentNode;
  // An element or a fragment, never the document: a document is not a place
  // with siblings, and `render` reads a container of that kind differently.
  if (parent === null || (parent.nodeType !== 1 && parent.nodeType !== 11)) {
    throw new Error("cannot mount in place: the element is not in a page");
  }
  const fragment = rootFragment(element, parent as Element | DocumentFragment);
  render(vnode, fragment);
  return () => {
    render(null, fragment);
    delete fragment._children;
  };
}
