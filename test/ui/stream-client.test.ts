/**
 * The stream client's rules, one at a time, on a fake clock.
 *
 * These are the rules the hand-written page follows today, so a page written
 * against this client behaves the way the current one does: a stream the server
 * closed is opened again after 1 s, doubling to 30 s; nothing is opened while
 * the page is hidden; a return from 30 s or more away, `pageshow` with
 * `persisted` and `online` each open a new one; and a page hidden for a minute
 * gives its stream up.
 */
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource } from "./harness.ts";
import {
  HIDDEN_CLOSE_MS,
  REOPEN_FIRST_MS,
  REOPEN_MAX_MS,
  RETURN_REOPEN_MS,
  StreamClient,
  type StreamEvent,
} from "../../src/ui/streams/client.ts";

/** The stream the client holds now. */
function stream(index = -1): FakeEventSource {
  const source = FakeEventSource.instances.at(index);
  if (source === undefined) throw new Error(`there is no stream at ${index}`);
  return source;
}

/**
 * The page the client watches. A JSDOM instance rather than the test
 * environment's own document: this file imports the harness, which imports
 * esbuild, and esbuild refuses to load in the jsdom environment's realm (its
 * typed arrays are the window's, not Node's). The client reads `document`,
 * `window` and `Event` from the global scope, so the test puts this page's
 * objects there instead.
 */
let dom: JSDOM;

/** Fire `pageshow`, which jsdom has no `PageTransitionEvent` for. */
function pageShow(persisted: boolean): void {
  const event = new dom.window.Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  dom.window.dispatchEvent(event);
}

/** Set the page's visibility the way the browser reports it. */
function setVisibility(state: "hidden" | "visible"): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new dom.window.Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T00:00:00+09:00"));
  FakeEventSource.instances = [];
  dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost/basic-chat",
    pretendToBeVisual: true,
  });
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("Event", dom.window.Event);
  vi.stubGlobal("EventSource", FakeEventSource);
  Object.defineProperty(dom.window.document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dom.window.close();
});

describe("StreamClient", () => {
  it("opens one stream, at the route's path", () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();
    expect(FakeEventSource.instances.map((source) => source.url)).toEqual(["/api/jobs/events"]);
    client.stop();
  });

  it("opens a stream the server closed again after one second", async () => {
    const client = new StreamClient({ path: "/basic-chat/events" });
    client.start();
    stream().fail();

    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(stream(0).closed).toBe(true);
    client.stop();
  });

  it("doubles the wait per failed attempt, up to thirty seconds", async () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();

    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      const before = FakeEventSource.instances.length;
      stream().fail();
      let waited = 0;
      while (FakeEventSource.instances.length === before) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
        if (waited > REOPEN_MAX_MS + 1000) throw new Error("the reopen never came");
      }
      waits.push(waited);
    }

    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    client.stop();
  });

  it("starts the wait again from one second after a stream opens", async () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();

    stream().fail();
    await vi.advanceTimersByTimeAsync(1000);
    stream().fail();
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeEventSource.instances).toHaveLength(3);

    // The second reopen opened; a failure after an open is the first failure again.
    stream().open();
    stream().fail();
    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS);
    expect(FakeEventSource.instances).toHaveLength(4);
    client.stop();
  });

  it("leaves a stream that is only reconnecting to the browser", async () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();
    // readyState `CONNECTING`: the browser is already retrying it.
    stream().fail({ closed: false });

    await vi.advanceTimersByTimeAsync(REOPEN_MAX_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1);
    client.stop();
  });

  it("opens nothing while the page is hidden, and opens on the return", async () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();
    setVisibility("hidden");
    stream().fail();

    await vi.advanceTimersByTimeAsync(REOPEN_FIRST_MS * 4);
    expect(FakeEventSource.instances).toHaveLength(1);

    setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(2);
    client.stop();
  });

  it("opens a new stream when the page comes back from thirty seconds away", async () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(RETURN_REOPEN_MS);
    expect(stream().closed).toBe(false);

    setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(2);
    client.stop();
  });

  it("keeps the stream when the page was away for less than thirty seconds", async () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(RETURN_REOPEN_MS - 1000);
    setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(1);
    client.stop();
  });

  it("gives the stream up when the page stayed hidden for a minute", async () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(HIDDEN_CLOSE_MS);
    expect(stream().closed).toBe(true);
    expect(client.connected).toBe(false);

    setVisibility("visible");
    expect(FakeEventSource.instances).toHaveLength(2);
    client.stop();
  });

  it("opens a new stream for pageshow with persisted, and not for the first show", () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();

    pageShow(false);
    expect(FakeEventSource.instances).toHaveLength(1);

    pageShow(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    client.stop();
  });

  it("opens a new stream when the network comes back", () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();

    dom.window.dispatchEvent(new dom.window.Event("online"));
    expect(FakeEventSource.instances).toHaveLength(2);
    client.stop();
  });

  it("hands a frame only to the listeners registered for its name", () => {
    const client = new StreamClient({ path: "/basic-chat/events" });
    const snapshots: StreamEvent[] = [];
    const jobs: StreamEvent[] = [];
    client.on("snapshot", (event) => snapshots.push(event));
    client.on("job_created", (event) => jobs.push(event));
    client.start();

    stream().emit("snapshot", { type: "snapshot", apiVersion: 1 });
    stream().emit("job_created", { id: "j-1" });
    stream().emit("inbox_item", { id: "i-1" });
    stream().emit("snapshot", { type: "snapshot", apiVersion: 1 });

    expect(snapshots).toHaveLength(2);
    expect(jobs).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ name: "snapshot", snapshot: true, snapshotCount: 1 });
    expect(snapshots[1]).toMatchObject({ name: "snapshot", snapshot: true, snapshotCount: 2 });
    expect(jobs[0]).toMatchObject({ name: "job_created", snapshot: false, snapshotCount: 1 });
    expect(jobs[0]?.data).toEqual({ id: "j-1" });
    client.stop();
  });

  it("stops delivering frames from a stream it replaced", async () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    const seen: StreamEvent[] = [];
    client.on("snapshot", (event) => seen.push(event));
    client.start();

    const first = stream();
    dom.window.dispatchEvent(new dom.window.Event("online"));
    first.emit("snapshot", { type: "snapshot", apiVersion: 1 });
    expect(seen).toHaveLength(0);

    stream().emit("snapshot", { type: "snapshot", apiVersion: 1 });
    expect(seen).toHaveLength(1);
    client.stop();
  });

  it("reports the connection coming and going", async () => {
    const states: boolean[] = [];
    const client = new StreamClient({ path: "/api/jobs/events", onStateChange: (connected) => states.push(connected) });
    client.start();
    stream().open();
    stream().fail();
    expect(states).toEqual([true, false]);
    client.stop();
  });

  it("closes the stream and drops every wait when the page gives it up", async () => {
    const client = new StreamClient({ path: "/api/jobs/events" });
    client.start();
    stream().fail();
    client.stop();

    expect(stream().closed).toBe(true);
    await vi.advanceTimersByTimeAsync(REOPEN_MAX_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
