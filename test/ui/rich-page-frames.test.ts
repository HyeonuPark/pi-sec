// @vitest-environment jsdom
/** The height listener of rich page frames (C6): clamp, ignore, install once. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installRichPageFrameListener,
  removeRichPageFrameListenerForTest,
  RICH_PAGE_MAX_HEIGHT,
  RICH_PAGE_MIN_HEIGHT,
} from "../../src/ui/components/rich-page-frames.ts";

let frame: HTMLIFrameElement;

beforeEach(() => {
  removeRichPageFrameListenerForTest();
  frame = document.createElement("iframe");
  frame.className = "rich-page-frame";
  frame.style.height = "360px";
  document.body.append(frame);
  installRichPageFrameListener();
});

afterEach(() => {
  document.body.replaceChildren();
  removeRichPageFrameListenerForTest();
});

function post(data: unknown, source: unknown = frame.contentWindow): void {
  window.dispatchEvent(new MessageEvent("message", { data, source: source as MessageEventSource | null }));
}

describe("rich page frame height", () => {
  it("sets the reported height, clamped to 80 through 1200 pixels", () => {
    post({ piSecRichPage: 1, height: 500 });
    expect(frame.style.height).toBe("500px");
    post({ piSecRichPage: 1, height: 10 });
    expect(frame.style.height).toBe(`${RICH_PAGE_MIN_HEIGHT}px`);
    post({ piSecRichPage: 1, height: 5000 });
    expect(frame.style.height).toBe(`${RICH_PAGE_MAX_HEIGHT}px`);
  });

  it("ignores a message from another source, without the marker, or with a bad height", () => {
    post({ piSecRichPage: 1, height: 500 }, window);
    post({ piSecRichPage: 1, height: 500 }, null);
    post({ height: 500 });
    post({ piSecRichPage: 2, height: 500 });
    post({ piSecRichPage: 1, height: "500" });
    post({ piSecRichPage: 1, height: Number.NaN });
    post({ piSecRichPage: 1, height: Number.POSITIVE_INFINITY });
    post("text");
    post(null);
    expect(frame.style.height).toBe("360px");
  });

  it("is installed once", () => {
    removeRichPageFrameListenerForTest();
    const add = vi.spyOn(window, "addEventListener");
    expect(installRichPageFrameListener()).toBe(true);
    expect(installRichPageFrameListener()).toBe(false);
    expect(add.mock.calls.filter((call) => call[0] === "message").length).toBe(1);
    add.mockRestore();
  });
});
