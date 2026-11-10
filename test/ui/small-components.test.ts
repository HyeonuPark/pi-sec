/**
 * The small page components: the draft store, the theme control, the notice,
 * the mount on one element, and the request function.
 *
 * Merged from the small files named by the describe blocks below, so one child
 * process loads the application's module graph once for all of them instead of
 * once per file. Every test, hook and helper is the one its own file carried.
 *
 * `test/ui/common-markdown.test.ts` stays a file of its own: it calls
 * `vi.doMock` and `vi.resetModules`, which change the module registry for the rest
 * of the file.
 */

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, beforeAll } from "vitest";
import { DRAFT_PREFIX, DRAFT_REFUSED_NOTICE, clearDraft, draftStorageKey, pruneDrafts, readDraft, writeDraft } from "../../src/ui/state/drafts.ts";
import { hideToast, toast, TOAST_ERROR_MS, TOAST_INFO_MS, showError, showToast } from "../../src/ui/state/toast.ts";
import { h, render, Component, type ComponentChildren } from "preact";
import { THEME_KEY, THEME_ORDER, applyTheme, carryStoredTheme, cycleTheme, documentTheme, initTheme, nextTheme, readStoredTheme, theme, themeLabel } from "../../src/ui/state/theme.ts";
import * as preferences from "../../src/ui/state/preferences.ts";
import { ThemeToggle } from "../../src/ui/components/theme-toggle.tsx";
import { Toast } from "../../src/ui/components/toast.tsx";
import { mountAt } from "../../src/ui/mount.ts";

// The theme code saves and reads the shared state through the preferences module.
// These tests are about the control, and a real save would resolve the mount on
// first use, which the request tests below set up for themselves. So the calls
// that reach the network are replaced here, and the tests that need them read what
// they were asked.
vi.mock("../../src/ui/state/preferences.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/ui/state/preferences.ts")>();
  return {
    ...original,
    savePreferenceIntent: vi.fn(async () => {}),
    readPreferences: vi.fn(async () => undefined),
    sendPreferences: vi.fn(async () => undefined),
  };
});

describe("common-drafts.test.ts", () => {
  /**
   * The draft store: the unsent text of the composer and of the feedback field.
   *
   * Every assertion here came from `test/drafts-web.test.ts`, which drove two real
   * pages to see where a stored text comes back. The rules are the ones that file
   * pins, checked here against the store itself so a page test can be about the
   * page:
   *
   * - the key shape is `pi-sec:drafts:<mount>:<box>`, written out in full, because
   *   a text typed before the rewrite must be read after it;
   * - the mount a page is served from is part of the key, so two installs behind
   *   different prefixes never read each other's text;
   * - whitespace is not a draft, a send that went through clears one, a refused
   *   write keeps the text in the field and says so once;
   * - an entry nobody touched for 14 days is dropped, and so is one that cannot be
   *   read at all.
   */

  /** The stored entry of one key, as the store wrote it. */
  function stored(key: string): { text: string; at: number } | null {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as { text: string; at: number });
  }

  /** Put the mount stamp a served page carries into the test document. */
  function stampMount(base: string): void {
    const meta = document.createElement("meta");
    meta.name = "pi-sec-base";
    meta.content = base;
    document.head.append(meta);
  }

  function clearMount(): void {
    for (const meta of document.querySelectorAll('meta[name="pi-sec-base"]')) meta.remove();
  }

  beforeEach(() => {
    window.localStorage.clear();
    clearMount();
    hideToast();
    toast.value = { text: "", kind: "error", visible: false };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    hideToast();
    clearMount();
  });

  describe("the draft store", () => {
    it("keeps a text under the key shape the old pages wrote", () => {
      expect(writeDraft("composer:root", "a note for the root")).toBe(true);

      // Written out rather than composed, so a change to the shape is visible here.
      expect(window.localStorage.getItem("pi-sec:drafts::composer:root")).not.toBeNull();
      expect(draftStorageKey("composer:root")).toBe("pi-sec:drafts::composer:root");
      expect(stored("pi-sec:drafts::composer:root")?.text).toBe("a note for the root");
      expect(readDraft("composer:root")).toBe("a note for the root");
    });

    it("keeps one entry per box, so two conversations never share a text", () => {
      writeDraft("composer:root", "for the root");
      writeDraft("composer:chat:7", "for chat 7");
      writeDraft("feedback:r1", "about report one");

      expect(readDraft("composer:root")).toBe("for the root");
      expect(readDraft("composer:chat:7")).toBe("for chat 7");
      expect(readDraft("feedback:r1")).toBe("about report one");
      // A report's key does not name the revision.
      expect(readDraft("feedback:r2")).toBe("");
    });

    it("files a draft under the mount the page is served from", () => {
      stampMount("/sec");
      writeDraft("composer:root", "behind a prefix");
      expect(window.localStorage.getItem("pi-sec:drafts:/sec:composer:root")).not.toBeNull();
      expect(readDraft("composer:root")).toBe("behind a prefix");

      // An install at the root reads nothing of it.
      clearMount();
      expect(readDraft("composer:root")).toBe("");
    });

    it("keeps nothing for whitespace, and removes what was there", () => {
      writeDraft("composer:root", "text");
      expect(writeDraft("composer:root", "   \n\t ")).toBe(true);

      expect(window.localStorage.getItem("pi-sec:drafts::composer:root")).toBeNull();
      expect(readDraft("composer:root")).toBe("");
    });

    it("forgets a text when it is cleared", () => {
      writeDraft("feedback:r1", "send this");
      clearDraft("feedback:r1");

      expect(readDraft("feedback:r1")).toBe("");
      expect(window.localStorage.getItem("pi-sec:drafts::feedback:r1")).toBeNull();
    });

    it("answers an empty text for a key nobody wrote, and for one that cannot be read", () => {
      expect(readDraft("composer:root")).toBe("");
      window.localStorage.setItem("pi-sec:drafts::composer:root", "{not json");
      expect(readDraft("composer:root")).toBe("");
      window.localStorage.setItem("pi-sec:drafts::composer:root", JSON.stringify({ text: 4, at: 1 }));
      expect(readDraft("composer:root")).toBe("");
    });
  });

  describe("the 14 day expiry", () => {
    it("drops what nobody came back for, and keeps what is newer", () => {
      const day = 24 * 60 * 60 * 1000;
      const now = Date.now();
      window.localStorage.setItem("pi-sec:drafts::composer:root", JSON.stringify({ text: "old", at: now - 15 * day }));
      window.localStorage.setItem("pi-sec:drafts::composer:chat:7", JSON.stringify({ text: "fresh", at: now - day }));

      expect(pruneDrafts()).toBe(1);

      expect(window.localStorage.getItem("pi-sec:drafts::composer:root")).toBeNull();
      expect(readDraft("composer:chat:7")).toBe("fresh");
    });

    it("drops an entry it cannot read, and one that says no time", () => {
      window.localStorage.setItem("pi-sec:drafts::composer:root", "{not json");
      window.localStorage.setItem("pi-sec:drafts::feedback:r1", JSON.stringify({ text: "no time" }));
      window.localStorage.setItem("pi-sec:drafts::feedback:r2", JSON.stringify({ text: "kept", at: Date.now() }));

      expect(pruneDrafts()).toBe(2);
      expect(readDraft("feedback:r2")).toBe("kept");
    });

    it("reads only the keys this app writes", () => {
      window.localStorage.setItem("pi-sec-theme", "dark");
      window.localStorage.setItem("something-else", "{not json");
      window.localStorage.setItem(`${DRAFT_PREFIX}:composer:root`, JSON.stringify({ text: "newer", at: Date.now() }));

      expect(pruneDrafts()).toBe(0);
      expect(window.localStorage.getItem("pi-sec-theme")).toBe("dark");
      expect(window.localStorage.getItem("something-else")).toBe("{not json");
    });
  });

  describe("a browser store that refuses", () => {
    it("keeps the text out of the store, answers false, and says so once", () => {
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError: the store is full");
      });

      expect(writeDraft("composer:root", "one")).toBe(false);
      expect(setItem).toHaveBeenCalled();
      expect(toast.value.visible).toBe(true);
      expect(toast.value.kind).toBe("info");
      expect(toast.value.text).toBe(DRAFT_REFUSED_NOTICE);

      // A store that refuses every write must not put a notice on every keystroke.
      hideToast();
      expect(writeDraft("composer:root", "one two")).toBe(false);
      expect(toast.value.visible).toBe(false);
    });

    it("answers an empty text when it refuses to be read", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("SecurityError: the store is withheld");
      });
      expect(readDraft("composer:root")).toBe("");
    });

    it("does nothing, quietly, when the store cannot be reached at all", () => {
      const original = Object.getOwnPropertyDescriptor(window, "localStorage");
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw new Error("SecurityError: the store is withheld");
        },
      });
      try {
        expect(readDraft("composer:root")).toBe("");
        expect(writeDraft("composer:root", "text")).toBe(false);
        expect(() => clearDraft("composer:root")).not.toThrow();
        expect(pruneDrafts()).toBe(0);
        // A store that cannot be reached is not a store that refused a write.
        expect(toast.value.visible).toBe(false);
      } finally {
        if (original !== undefined) Object.defineProperty(window, "localStorage", original);
      }
    });
  });
});

describe("common-theme.test.ts", () => {
  /**
   * The appearance control.
   *
   * All four shells carry the same button and the same stored choice, so the
   * assertions are the ones `test/web-ui.test.ts` made on the chat page (the toggle
   * sits where it did, starts at `auto`, and a press moves on), plus the ones the
   * other three pages' code implied: the mode goes on `<html data-theme>`, the
   * choice is written to `pi-sec-theme`, and a page starts from it.
   *
   * The mode is also read back from the document, as the page code read it, so a
   * press moves on from whatever the page is actually showing.
   */

  /** Let a queued render happen: Preact draws a signal change after the event. */
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  /** Clear what one test left: the store, the attribute, and the signal. */
  function reset(): void {
    window.localStorage.clear();
    delete document.documentElement.dataset.theme;
    theme.value = "auto";
  }

  beforeEach(reset);
  afterEach(() => {
    vi.restoreAllMocks();
    reset();
    document.body.replaceChildren();
  });

  describe("the theme state", () => {
    it("cycles auto, light and dark in that order", () => {
      expect(THEME_ORDER).toEqual(["auto", "light", "dark"]);
      expect(nextTheme("auto")).toBe("light");
      expect(nextTheme("light")).toBe("dark");
      expect(nextTheme("dark")).toBe("auto");
    });

    it("moves on from an unknown mode to auto, as the page code did", () => {
      expect(nextTheme("purple")).toBe("auto");
    });

    it("starts at auto when nothing is stored, and at the stored choice when there is one", () => {
      expect(initTheme()).toBe("auto");
      expect(document.documentElement.dataset.theme).toBe("auto");
      // A browser that never chose a mode must not look like it chose `auto`: the
      // cache is what a later carry to the server reads.
      expect(window.localStorage.getItem(THEME_KEY)).toBeNull();

      window.localStorage.setItem(THEME_KEY, "dark");
      expect(readStoredTheme()).toBe("dark");
      expect(initTheme()).toBe("dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
    });

    it("sends a press to the server as the shared mode, with the mode as its whole intent", () => {
      const save = vi.mocked(preferences.savePreferenceIntent);
      save.mockClear();
      applyTheme("auto");

      cycleTheme();

      expect(save).toHaveBeenCalledTimes(1);
      const intent = save.mock.calls[0]![0];
      // The intent does not depend on the record it is applied to.
      expect(intent({ theme: "dark", uiRevision: 7 })).toEqual({ theme: "light" });
      expect(intent({})).toEqual({ theme: "light" });
    });

    it("starts on the mode the server stamped, and caches it", () => {
      const meta = document.createElement("meta");
      meta.name = "pi-sec-preferences";
      meta.content = JSON.stringify({ theme: "dark", uiRevision: 4 });
      document.head.append(meta);
      preferences.resetPreferencesState();
      try {
        window.localStorage.setItem(THEME_KEY, "light");
        expect(initTheme()).toBe("dark");
        expect(document.documentElement.dataset.theme).toBe("dark");
        expect(window.localStorage.getItem(THEME_KEY)).toBe("dark");
      } finally {
        meta.remove();
        preferences.resetPreferencesState();
      }
    });

    it("adopts a mode from the server without saving it back", () => {
      const save = vi.mocked(preferences.savePreferenceIntent);
      applyTheme("auto");
      save.mockClear();

      preferences.applyPreferences({ theme: "dark", uiRevision: 2 });

      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(theme.value).toBe("dark");
      expect(save).not.toHaveBeenCalled();
      preferences.resetPreferencesState();
    });

    it("carries the browser's own mode to a server that has none, and only then", async () => {
      const send = vi.mocked(preferences.sendPreferences);
      window.localStorage.setItem(THEME_KEY, "dark");
      initTheme();
      send.mockClear();

      await carryStoredTheme("light");
      expect(send).not.toHaveBeenCalled();

      await carryStoredTheme(undefined);
      expect(send).toHaveBeenCalledWith({ theme: "dark", seedOnly: true });
    });

    it("carries nothing when the browser never kept a mode", async () => {
      const send = vi.mocked(preferences.sendPreferences);
      window.localStorage.clear();
      initTheme();
      send.mockClear();

      await carryStoredTheme(undefined);
      expect(send).not.toHaveBeenCalled();
    });

    it("puts a mode on the document, on the signal and in the store", () => {
      applyTheme("light");

      expect(document.documentElement.dataset.theme).toBe("light");
      expect(theme.value).toBe("light");
      expect(window.localStorage.getItem(THEME_KEY)).toBe("light");
      expect(themeLabel("light")).toBe("◐ light");
    });

    it("walks the modes a press at a time and remembers each", () => {
      applyTheme("auto");

      expect(cycleTheme()).toBe("light");
      expect(cycleTheme()).toBe("dark");
      expect(cycleTheme()).toBe("auto");

      expect(window.localStorage.getItem(THEME_KEY)).toBe("auto");
    });

    it("reads the mode off the document, so a page showing dark moves on to auto", () => {
      document.documentElement.dataset.theme = "dark";
      expect(documentTheme()).toBe("dark");
      expect(cycleTheme()).toBe("auto");
      expect(document.documentElement.dataset.theme).toBe("auto");
    });

    it("applies a stored value nobody wrote, as the pages applied it", () => {
      window.localStorage.setItem(THEME_KEY, "purple");
      initTheme();

      expect(document.documentElement.dataset.theme).toBe("purple");
      expect(cycleTheme()).toBe("auto");
    });

    it("still draws the mode when the browser refuses the store", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("SecurityError: the store is withheld");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError: the store is full");
      });

      expect(readStoredTheme()).toBe("auto");
      expect(() => applyTheme("dark")).not.toThrow();
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(theme.value).toBe("dark");
    });
  });

  describe("the theme button", () => {
    /** Draw the component into a page body, as a page would. */
    function toggle(): HTMLButtonElement {
      const host = document.createElement("div");
      document.body.append(host);
      render(h(ThemeToggle, {}), host);
      const button = document.querySelector<HTMLButtonElement>("#theme-toggle");
      if (button === null) throw new Error("the component drew no button");
      return button;
    }

    it("draws the button the shells carry, and starts it at auto", () => {
      const button = toggle();

      expect(button.tagName).toBe("BUTTON");
      expect(button.id).toBe("theme-toggle");
      expect(button.className).toBe("button");
      expect(button.getAttribute("type")).toBe("button");
      expect(button.textContent).toBe("◐ auto");
      expect(document.documentElement.dataset.theme).toBe("auto");
    });

    it("starts from the stored choice", async () => {
      window.localStorage.setItem(THEME_KEY, "dark");
      const button = toggle();
      await tick();

      expect(button.textContent).toBe("◐ dark");
      expect(document.documentElement.dataset.theme).toBe("dark");
    });

    it("moves the mode and its label on a press", async () => {
      const button = toggle();

      button.click();
      expect(document.documentElement.dataset.theme).toBe("light");
      await tick();
      expect(button.textContent).toBe("◐ light");
      // The press redraws the element in place, so a shell button mounted over stays the one on the page.
      expect(document.querySelector("#theme-toggle")).toBe(button);

      button.click();
      expect(document.documentElement.dataset.theme).toBe("dark");
      await tick();
      expect(button.textContent).toBe("◐ dark");

      button.click();
      expect(document.documentElement.dataset.theme).toBe("auto");
      await tick();
      expect(button.textContent).toBe("◐ auto");
      expect(window.localStorage.getItem(THEME_KEY)).toBe("auto");
    });
  });
});

describe("common-toast.test.ts", () => {
  /**
   * The one notice.
   *
   * The pages agreed on the element and disagreed on the colour and the wait; these
   * assertions are the ones `test/web-ui.test.ts` made on the chat page's toast (a
   * notice appears, says its text, and hides by a class) and the ones the other
   * three pages' code carried: an error is red and stays 8 s, an info message is
   * accent-coloured and stays 15 s, and the usage page's notice stays 6 s.
   *
   * What a second notice does is checked too: it replaces the text and starts the
   * wait again, so the reader gets the whole wait for the sentence on screen.
   */

  /** Let a queued render happen. */
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  /** Draw the notice into a page body, as a page would. */
  function draw(id?: string): HTMLElement {
    const host = document.createElement("div");
    document.body.append(host);
    render(h(Toast, id === undefined ? {} : { id }), host);
    const element = host.querySelector<HTMLElement>(".toast");
    if (element === null) throw new Error("the component drew no notice");
    return element;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    toast.value = { text: "", kind: "error", visible: false };
    document.body.replaceChildren();
  });

  afterEach(() => {
    hideToast();
    vi.useRealTimers();
  });

  describe("the notice", () => {
    it("shows a failure for 8 s", () => {
      showToast("Could not read the list.");

      expect(toast.value).toEqual({ text: "Could not read the list.", kind: "error", visible: true });
      vi.advanceTimersByTime(TOAST_ERROR_MS - 1);
      expect(toast.value.visible).toBe(true);
      vi.advanceTimersByTime(1);
      expect(toast.value.visible).toBe(false);
      // The text outlives the hide, as the element's text always did.
      expect(toast.value.text).toBe("Could not read the list.");
    });

    it("keeps an info message for 15 s and puts it in the accent colour", () => {
      showToast("Could not save this text in the browser.", { kind: "info" });

      expect(toast.value.kind).toBe("info");
      vi.advanceTimersByTime(TOAST_INFO_MS - 1);
      expect(toast.value.visible).toBe(true);
      vi.advanceTimersByTime(1);
      expect(toast.value.visible).toBe(false);
    });

    it("replaces a notice on screen and starts its wait again", () => {
      showToast("first");
      vi.advanceTimersByTime(7000);

      showToast("second");
      expect(toast.value.text).toBe("second");

      // The first notice's remaining second does not end the second one.
      vi.advanceTimersByTime(TOAST_ERROR_MS - 1);
      expect(toast.value.visible).toBe(true);
      vi.advanceTimersByTime(1);
      expect(toast.value.visible).toBe(false);
    });

    it("takes the wait a caller names, which is what the usage page's 6 s is", () => {
      showToast("Could not read usage.", { durationMs: 6000 });

      vi.advanceTimersByTime(5999);
      expect(toast.value.visible).toBe(true);
      vi.advanceTimersByTime(1);
      expect(toast.value.visible).toBe(false);
    });

    it("hides on request and keeps the text", () => {
      showError("boom");
      hideToast();

      expect(toast.value.visible).toBe(false);
      expect(toast.value.text).toBe("boom");
    });

    it("takes a text that is not a string", () => {
      showToast(undefined as unknown as string);
      expect(toast.value.text).toBe("");
    });
  });

  describe("the notice element", () => {
    it("draws the element the shells carry, hidden at rest", () => {
      const element = draw();

      expect(element.id).toBe("toast");
      expect(element.className).toBe("toast hidden");
      expect(element.getAttribute("role")).toBe("alert");
      expect(element.getAttribute("aria-live")).toBe("assertive");
      expect(element.textContent).toBe("");
    });

    it("shows the text and loses the hidden class", async () => {
      const element = draw();

      showToast("boom");
      await flush();
      expect(element.className).toBe("toast");
      expect(element.textContent).toBe("boom");

      showToast("saved", { kind: "info" });
      await flush();
      expect(element.className).toBe("toast toast-info");
      expect(element.textContent).toBe("saved");
    });

    it("hides again when the wait is over", async () => {
      const element = draw();
      showToast("boom");
      await flush();

      vi.advanceTimersByTime(TOAST_ERROR_MS);
      await flush();

      expect(element.className).toBe("toast hidden");
      expect(element.textContent).toBe("boom");
    });

    it("takes the id a page names, which is what the usage page's notice has", () => {
      const element = draw("usage-toast");
      expect(element.id).toBe("usage-toast");
      // One notice element per page, whatever it is called.
      expect(document.querySelectorAll(".toast")).toHaveLength(1);
    });
  });
});

describe("mount-at.test.ts", () => {
  /**
   * Taking over one element of a page shell.
   *
   * The shell writes some parts of a page itself: the theme button, the notice,
   * the usage cards. `mountAt` puts a component on one of those elements without
   * moving it, so the markup and the stylesheet stay as they are, and without
   * touching the siblings, so a server-rendered neighbour such as an extension
   * slot keeps its identity.
   *
   * These four tests are the promise: the element keeps its place and its
   * siblings, an update changes that one place and nothing else (the element
   * itself included, because a new button would lose the focus and the listener
   * the page put there), one parent can hold two of them, and the returned
   * function takes the component out and leaves the siblings.
   */

  /** Let queued renders and effects run. */
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };

  /** The shell of a page: a, the place that is taken over, and slot. */
  function shell(): { parent: HTMLElement; a: Element; t: Element; slot: Element } {
    const parent = document.createElement("div");
    const a = document.createElement("span");
    a.id = "a";
    const t = document.createElement("button");
    t.id = "t";
    t.textContent = "old";
    const slot = document.createElement("section");
    slot.id = "slot";
    parent.append(a, t, slot);
    return { parent, a, t, slot };
  }

  /** The children of `parent` as an array, so an assertion reads left to right. */
  function children(parent: Node): Node[] {
    return [...parent.childNodes];
  }

  describe("mountAt", () => {
    it("draws the component where the element was, and keeps the siblings", () => {
      const { parent, a, t, slot } = shell();

      mountAt(t, h("button", { id: "t", class: "button" }, "new"));

      const drawn = parent.querySelector("#t");
      expect(drawn).not.toBeNull();
      expect(drawn?.textContent).toBe("new");
      expect(drawn?.className).toBe("button");
      expect(children(parent)).toEqual([a, drawn, slot]);
      // The shell's element itself is what the component drew into, so the focus,
      // the listener and the stylesheet's selector still find it.
      expect(drawn).toBe(t);
      expect(parent.querySelector("#a")).toBe(a);
      expect(parent.querySelector("#slot")).toBe(slot);
    });

    it("keeps the element and the siblings when a component updates", async () => {
      const { parent, a, t, slot } = shell();
      let press: (count: number) => void = () => {};
      let count = 0;

      class Counter extends Component<Record<string, never>, { count: number }> {
        override state = { count: 0 };

        override render(): ComponentChildren {
          count = this.state.count;
          press = (next: number) => this.setState({ count: next });
          return h("button", { id: "t", class: count === 0 ? "button" : "button busy" }, `n=${count}`);
        }
      }

      mountAt(t, h(Counter, {}));
      const drawn = parent.querySelector("#t");
      expect(drawn?.textContent).toBe("n=0");

      press(1);
      await flush();
      press(2);
      await flush();

      expect(parent.querySelector("#t")).toBe(drawn);
      expect(drawn?.textContent).toBe("n=2");
      expect((drawn as Element).className).toBe("button busy");
      expect(children(parent)).toEqual([a, drawn, slot]);
      expect(parent.querySelector("#a")).toBe(a);
      expect(parent.querySelector("#slot")).toBe(slot);
    });

    it("lets two elements of one parent be taken over without interfering", async () => {
      const { parent, a, t, slot } = shell();
      const m = document.createElement("span");
      m.id = "m";
      parent.insertBefore(m, slot);
      let press: (count: number) => void = () => {};

      class Label extends Component<Record<string, never>, { count: number }> {
        override state = { count: 0 };

        override render(): ComponentChildren {
          press = (next: number) => this.setState({ count: next });
          return h("span", { id: "m", class: "label" }, `m=${this.state.count}`);
        }
      }

      mountAt(t, h("button", { id: "t", class: "button" }, "first"));
      mountAt(m, h(Label, {}));

      const drawnT = parent.querySelector("#t");
      const drawnM = parent.querySelector("#m");
      expect(children(parent)).toEqual([a, drawnT, drawnM, slot]);
      expect(drawnM?.textContent).toBe("m=0");

      press(1);
      await flush();

      expect(parent.querySelector("#t")).toBe(drawnT);
      expect(parent.querySelector("#m")).toBe(drawnM);
      expect(drawnT?.textContent).toBe("first");
      expect(drawnM?.textContent).toBe("m=1");
      expect(children(parent)).toEqual([a, drawnT, drawnM, slot]);
      expect(parent.querySelector("#a")).toBe(a);
      expect(parent.querySelector("#slot")).toBe(slot);
    });

    it("takes the component out and leaves the siblings", () => {
      const { parent, a, t, slot } = shell();

      const stop = mountAt(t, h("button", { id: "t", class: "button" }, "new"));
      expect(children(parent)).toHaveLength(3);

      stop();

      expect(parent.querySelector("#t")).toBeNull();
      expect(children(parent)).toEqual([a, slot]);
      expect(parent.querySelector("#a")).toBe(a);
      expect(parent.querySelector("#slot")).toBe(slot);
      // A second call is a no-op, so a page can clean up in two paths.
      expect(() => stop()).not.toThrow();
      expect(children(parent)).toEqual([a, slot]);
    });
  });
});

describe("request.test.ts", () => {
  /**
   * The one request function. The page code trusts it for three things: the mount
   * goes on the path, a JSON answer is read, and a refusal is thrown with the
   * status and the server's code rather than a sentence alone.
   *
   * The mount is stamped into the page's `<meta>` before the module is imported,
   * because the module resolves the mount once and a page does not move.
   */

  type RequestModule = typeof import("../../src/ui/api/request.ts");

  let request: RequestModule["request"];
  let ApiError: RequestModule["ApiError"];

  beforeAll(async () => {
    const meta = document.createElement("meta");
    meta.name = "pi-sec-base";
    meta.content = "/sec";
    document.head.append(meta);
    const module = await import("../../src/ui/api/request.ts");
    request = module.request;
    ApiError = module.ApiError;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A `fetch` that answers the way the server does, and records what it was asked. */
  function stubFetch(answer: { status?: number; text?: string; body?: unknown }) {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      const status = answer.status ?? 200;
      const text = answer.text ?? (answer.body === undefined ? "" : JSON.stringify(answer.body));
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        text: async () => text,
      };
    });
    return seen;
  }

  describe("request", () => {
    it("puts the mount on the path", async () => {
      const seen = stubFetch({ body: { ok: true } });
      await request("/api/jobs");
      expect(seen[0]?.url).toBe("/sec/api/jobs");
    });

    it("reads a JSON answer", async () => {
      stubFetch({ body: { tree: [], archived: [] } });
      await expect(request("/api/jobs")).resolves.toEqual({ tree: [], archived: [] });
    });

    it("answers undefined for an empty body", async () => {
      stubFetch({ status: 204, text: "" });
      await expect(request("/api/jobs/x", { method: "DELETE" })).resolves.toBeUndefined();
    });

    it("sends a JSON content type only when it has a body", async () => {
      const seen = stubFetch({ body: {} });
      await request("/api/jobs", { method: "POST", body: JSON.stringify({ a: 1 }) });
      await request("/api/jobs");
      expect(seen[0]?.init?.headers).toMatchObject({ "Content-Type": "application/json" });
      expect(seen[1]?.init?.headers).not.toHaveProperty("Content-Type");
    });

    it("throws an ApiError that carries the status, the code and the message", async () => {
      stubFetch({
        status: 409,
        body: { error: { code: "agents_working", message: "three agents are working", requestId: "req-1" } },
      });

      const failure = await request("/basic-chat/reset", { method: "POST", body: "{}" }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ApiError);
      const error = failure as InstanceType<RequestModule["ApiError"]>;
      expect(error.status).toBe(409);
      expect(error.code).toBe("agents_working");
      expect(error.message).toBe("three agents are working");
      expect(error.requestId).toBe("req-1");
    });

    it("keeps a refusal's extra facts", async () => {
      stubFetch({
        status: 500,
        body: {
          error: { code: "sync_failed", message: "the assets were not replaced", requestId: "req-2", details: { restored: false } },
        },
      });

      const failure = (await request("/api/admin/ui-restart", { method: "POST", body: "{}" }).catch(
        (error: unknown) => error,
      )) as InstanceType<RequestModule["ApiError"]>;

      expect(failure.details).toEqual({ restored: false });
    });

    it("carries the facts a refusal puts beside its envelope", async () => {
      // An approval refused as stale names the revision that can be approved as a
      // sibling of `error`, not inside it, and the bar corrects the screen from
      // that field. A refusal that dropped it would leave the bar guessing.
      const body = {
        error: { code: "stale_revision", message: "only the newest revision can be approved", requestId: "req-3" },
        latest: 3,
        latestSha256: "c",
      };
      stubFetch({ status: 409, body });

      const failure = (await request("/api/reports/r1/approve", { method: "POST", body: "{}" }).catch(
        (error: unknown) => error,
      )) as InstanceType<RequestModule["ApiError"]>;

      expect(failure.code).toBe("stale_revision");
      expect(failure.body).toEqual(body);
      // Nothing was put under `error.details`, so the narrower field stays empty.
      expect(failure.details).toBeUndefined();
    });

    it("still throws when the refusal is not the shape this app writes", async () => {
      stubFetch({ status: 502, text: "<html>bad gateway</html>" });

      const failure = (await request("/api/jobs").catch((error: unknown) => error)) as InstanceType<
        RequestModule["ApiError"]
      >;

      expect(failure).toBeInstanceOf(ApiError);
      expect(failure.status).toBe(502);
      expect(failure.code).toBe("http_502");
      expect(failure.message).toBe("the server answered 502");
      // There was no refusal body to keep, so there is none to read.
      expect(failure.body).toBeUndefined();
    });

    it("refuses a relative path instead of building a wrong URL", async () => {
      stubFetch({ body: {} });
      await expect(request("api/jobs")).rejects.toThrow("a route must be absolute");
    });
  });
});

describe("format-bytes.ts", () => {
  it("says a size the way a chip does, for every range", async () => {
    const { formatBytes } = await import("../../src/ui/components/format-bytes.ts");
    const table: readonly (readonly [number | undefined, string])[] = [
      [undefined, ""],
      [Number.NaN, ""],
      [-1, ""],
      [0, "0 B"],
      [999, "999 B"],
      [1200, "1.2 KB"],
      [12345, "12 KB"],
      [1_000_000, "1.0 MB"],
      [1_500_000_000, "1.5 GB"],
      // Above a thousand GB the unit stays GB, because there is no larger one.
      [2_000_000_000_000, "2000 GB"],
    ];
    expect(table.map(([bytes]) => formatBytes(bytes))).toEqual(table.map(([, said]) => said));
  });
});
