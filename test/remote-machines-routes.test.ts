import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_EVENTS } from "../src/server/streams.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { createRemoteFixture, type RemoteFixture } from "./remote-helpers.ts";

/**
 * The two routes, and the one frame.
 *
 * The list is read-only and answers with a shape the panel draws. The write route
 * refuses three things before it touches anything: a body that is not JSON, a level
 * that is not one of the three words, and a machine the config does not name. The
 * fourth case is the frame an open page listens for, which has to be in the set
 * `src/server/streams.ts` keeps, or the server silently drops it.
 */

let fixture: RemoteFixture | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
  await fixture?.close();
  fixture = undefined;
});

/** Boot a server over a fresh fixture with one machine, and pin its key. */
async function boot(options: Parameters<typeof createRemoteFixture>[0] = {}): Promise<{
  origin: string;
  fixture: RemoteFixture;
  events: { readonly seen: readonly Record<string, unknown>[] };
}> {
  // Port 0 asks the kernel for a free port, so this file can run beside other
  // server tests and beside a daemon on the default port.
  const created = await createRemoteFixture({
    ...options,
    config: { ...options.config, server: { ...defaultConfig().server, port: 0 } },
  });
  fixture = created;
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: created.runtime,
    bus: created.events,
    sse,
    streams: new StreamHub({ runtime: created.runtime, bus: created.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: defaultWebDir(),
    adminState: { restart: created.runtime.restart, notes: new AdminNotes() },
  };
  const seen: Record<string, unknown>[] = [];
  created.events.subscribe((event) => {
    if (event.type === "remote_machine_updated") seen.push(event.data);
  });
  started = await startServer(deps, { webDir: defaultWebDir() });
  return { origin: started.origin, fixture: created, events: { seen } };
}

/** One request with a JSON body, as the panel sends it. */
function post(origin: string, path: string, body: unknown, contentType = "application/json"): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET /api/remote-machines", () => {
  it("lists the machines of the config with their level and their users", async () => {
    const { origin } = await boot();
    const answer = await fetch(`${origin}/api/remote-machines`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as {
      enabled: boolean;
      machines: { id: string; address: string; level: string; users: { name: string }[]; pending: unknown }[];
    };
    expect(body.enabled).toBe(true);
    expect(body.machines).toHaveLength(1);
    expect(body.machines[0]?.id).toBe("box-a");
    expect(body.machines[0]?.address).toBe("192.0.2.10");
    // Every machine starts at off: the level is the operator's decision.
    expect(body.machines[0]?.level).toBe("off");
    expect(body.machines[0]?.users.map((user) => user.name)).toEqual(["alice", "bob"]);
    // The field a later stage fills is present and empty.
    expect(body.machines[0]?.pending).toBeNull();
  });

  it("answers with the feature off and no machine while the key is absent", async () => {
    const { origin } = await boot({ noFeature: true });
    const body = (await (await fetch(`${origin}/api/remote-machines`)).json()) as { enabled: boolean; machines: unknown[] };
    expect(body.enabled).toBe(false);
    expect(body.machines).toEqual([]);
  });
});

describe("POST /api/remote-machines/:id/level", () => {
  it("changes the level and answers with the changed machine", async () => {
    const { origin, fixture: live, events } = await boot();
    await live.pinHostKey();
    const answer = await post(origin, "/api/remote-machines/box-a/level", { level: "restricted" });
    expect(answer.status).toBe(200);
    const machine = (await answer.json()) as { id: string; level: string; users: { state: string }[] };
    expect(machine.id).toBe("box-a");
    expect(machine.level).toBe("restricted");
    // The check runs at once, so the answer already says whether the machine is
    // there rather than leaving the panel to wait an interval.
    expect(machine.users.map((user) => user.state)).toEqual(["reachable", "reachable"]);
    // The list route reads the same store, so the two cannot disagree.
    const listed = (await (await fetch(`${origin}/api/remote-machines`)).json()) as {
      machines: { level: string }[];
    };
    expect(listed.machines[0]?.level).toBe("restricted");
    // And an open page was told to redraw.
    expect(events.seen.length).toBeGreaterThan(0);
  });

  it("refuses a body that is not JSON with 415", async () => {
    const { origin } = await boot();
    const answer = await post(origin, "/api/remote-machines/box-a/level", '{"level":"on"}', "text/plain");
    expect(answer.status).toBe(415);
    const body = (await answer.json()) as { error: { code: string } };
    expect(body.error.code).toBe("json_required");
  });

  it("refuses a level that is not one of the three words with 400", async () => {
    const { origin } = await boot();
    for (const level of ["maybe", "", 3, null, undefined]) {
      const answer = await post(origin, "/api/remote-machines/box-a/level", { level });
      expect(answer.status).toBe(400);
      const body = (await answer.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_level");
    }
    // A body that is not an object at all is the same refusal.
    expect((await post(origin, "/api/remote-machines/box-a/level", "[]")).status).toBe(400);
  });

  it("refuses a machine the config does not name with 404", async () => {
    const { origin } = await boot();
    const answer = await post(origin, "/api/remote-machines/box-z/level", { level: "on" });
    expect(answer.status).toBe(404);
    const body = (await answer.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("refuses the same path with 404 while the feature is off", async () => {
    const { origin } = await boot({ noFeature: true });
    expect((await post(origin, "/api/remote-machines/box-a/level", { level: "on" })).status).toBe(404);
  });

  it("keeps the level when the same one is chosen again, and sends no second event", async () => {
    const { origin, events, fixture: live } = await boot();
    await live.pinHostKey();
    await post(origin, "/api/remote-machines/box-a/level", { level: "on" });
    const after = events.seen.length;
    await post(origin, "/api/remote-machines/box-a/level", { level: "on" });
    expect(events.seen.length).toBe(after);
  });
});

describe("the stream", () => {
  it("carries remote_machine_updated in the control-event set", () => {
    // A frame a page needs but this set omits is dropped by the server and nothing
    // else notices, so the name is pinned here.
    expect(CONTROL_EVENTS.has("remote_machine_updated")).toBe(true);
    // The panel must not refresh on this one: the admin reload route emits it
    // before it replaces the config, so a page listening to it would read the
    // config that is about to go away.
    expect(CONTROL_EVENTS.has("extension_reloaded")).toBe(true);
  });
});
