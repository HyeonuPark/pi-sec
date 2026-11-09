/**
 * Images and page frames of the chat that load only near the visible part.
 *
 * The chat draws every row of the loaded sessions, and a row far from view is
 * skipped for layout and paint (`content-visibility: auto`), but an `<img>` or an
 * `<iframe>` in it still loads, and a page frame still runs its script. So the
 * chat marks such an element with `data-defer-src` and no `src`, and this module
 * sets the address when the element comes near the visible part.
 *
 * Two `IntersectionObserver`s watch with the transcript pane as the root. The
 * margin is a share of the pane height, so the distances follow the window:
 *
 * - load: an element within `DEFER_LOAD_MARGIN` of the visible part gets its `src`;
 * - unload: a page frame beyond `DEFER_UNLOAD_MARGIN` goes back to `about:blank`.
 *   It keeps its box height, which the frame listener set. Whatever the reader did
 *   inside the page starts over when it loads again.
 *
 * A picture is never unloaded: its bytes are cheap, and unloading would flash an
 * empty box on the way back. Without `IntersectionObserver` every address is set
 * at once, which is how the report viewer behaves.
 */

/** Load an element this far from the visible part: one pane height. */
export const DEFER_LOAD_MARGIN = "100% 0px";

/** Unload a page frame this far from the visible part: three pane heights. */
export const DEFER_UNLOAD_MARGIN = "300% 0px";

/** The attribute that holds the address while the element is not loaded. */
export const DEFER_ATTRIBUTE = "data-defer-src";

/** The class a picture of unknown size carries until it has loaded: a 160 pixel box. */
export const DEFER_PENDING_CLASS = "defer-media-pending";

export type DeferredElement = HTMLImageElement | HTMLIFrameElement;

const registered = new Set<DeferredElement>();
let loadObserver: IntersectionObserver | null = null;
let unloadObserver: IntersectionObserver | null = null;

function observerAvailable(): boolean {
  return typeof IntersectionObserver === "function";
}

function isFrame(element: DeferredElement): element is HTMLIFrameElement {
  return element.tagName === "IFRAME";
}

function settle(element: DeferredElement): void {
  element.classList.remove(DEFER_PENDING_CLASS);
}

/** Give the element its address. A frame that was unloaded gets it again. */
function load(element: DeferredElement): void {
  const address = element.getAttribute(DEFER_ATTRIBUTE);
  if (address === null || address === "") return;
  if (isFrame(element)) {
    if (element.dataset["deferState"] === "loaded") return;
    element.dataset["deferState"] = "loaded";
    element.src = address;
    return;
  }
  if (element.dataset["deferState"] === "loaded") return;
  element.dataset["deferState"] = "loaded";
  element.src = address;
  loadObserver?.unobserve(element);
}

function unload(element: HTMLIFrameElement): void {
  if (element.dataset["deferState"] !== "loaded") return;
  element.dataset["deferState"] = "unloaded";
  element.src = "about:blank";
}

/** Start watching with the pane as the root. Elements registered earlier are watched now. */
export function startDeferredMedia(pane: HTMLElement): void {
  stopDeferredMedia();
  if (!observerAvailable()) {
    for (const element of registered) load(element);
    return;
  }
  loadObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) load(entry.target as DeferredElement);
      }
    },
    { root: pane, rootMargin: DEFER_LOAD_MARGIN },
  );
  unloadObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting && isFrame(entry.target as DeferredElement)) unload(entry.target as HTMLIFrameElement);
      }
    },
    { root: pane, rootMargin: DEFER_UNLOAD_MARGIN },
  );
  for (const element of registered) watch(element);
}

/** Stop watching. The pane went away. */
export function stopDeferredMedia(): void {
  loadObserver?.disconnect();
  unloadObserver?.disconnect();
  loadObserver = null;
  unloadObserver = null;
}

function watch(element: DeferredElement): void {
  loadObserver?.observe(element);
  if (isFrame(element)) unloadObserver?.observe(element);
}

function onPictureLoaded(this: HTMLImageElement): void {
  settle(this);
}

/**
 * Register one element that carries `data-defer-src`.
 *
 * The pane may not exist yet: a row draws before the page watches its pane, so the
 * element waits in the set until `startDeferredMedia` runs.
 */
export function registerDeferredMedia(element: DeferredElement): void {
  if (registered.has(element)) return;
  registered.add(element);
  if (!isFrame(element)) {
    element.addEventListener("load", onPictureLoaded);
    element.addEventListener("error", onPictureLoaded);
  }
  if (!observerAvailable()) {
    load(element);
    return;
  }
  watch(element);
}

/** Forget one element: its row was redrawn or removed. */
export function unregisterDeferredMedia(element: DeferredElement): void {
  if (!registered.delete(element)) return;
  loadObserver?.unobserve(element);
  unloadObserver?.unobserve(element);
  if (!isFrame(element)) {
    element.removeEventListener("load", onPictureLoaded);
    element.removeEventListener("error", onPictureLoaded);
  }
}

/** Every element with an address to defer inside one root. */
export function deferredElementsIn(root: Element): DeferredElement[] {
  return Array.from(root.querySelectorAll<DeferredElement>(`img[${DEFER_ATTRIBUTE}], iframe[${DEFER_ATTRIBUTE}]`));
}

/** What a test reads: how many elements wait for the observers. */
export function deferredMediaCountForTest(): number {
  return registered.size;
}

/** Forget every element and stop the observers. Only a test needs this. */
export function resetDeferredMediaForTest(): void {
  stopDeferredMedia();
  registered.clear();
}
