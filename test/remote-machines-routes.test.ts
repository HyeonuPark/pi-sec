import { afterEach, describe, expect, it } from "vitest";
import type { StartedServer } from "../src/server/server.ts";
import { defaultConfig } from "../src/config/schema.ts";
import { createRemoteFixture, type RemoteFixture } from "./remote-helpers.ts";
import { startTestServer } from "./server-helpers.ts";

/**
 * The two routes.
 *
 * The list is read-only and answers with a shape the panel draws. The write route
 * refuses three things before it touches anything: a body that is not JSON, a level
 * that is not one of the three words, and a machine the config does not name. The
 * frame an open page listens for is pinned with the other control events in
 * stream-entries.test.ts.
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
  const seen: Record<string, unknown>[] = [];
  created.events.subscribe((event) => {
    if (event.type === "remote_machine_updated") seen.push(event.data);
  });
  started = await startTestServer(created);
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

  // Each row is one old input: the case it came from, the boot options, the path, the body, the content type,
  // the status, and the error code (null: the old case did not read the code).
  const LEVEL = "/api/remote-machines/box-a/level";
  const THREE_WORDS = "refuses a level that is not one of the three words with 400";
  const REFUSALS: [string, Parameters<typeof boot>[0], string, unknown, string | undefined, number, string | null][] = [
    ["refuses a body that is not JSON with 415", {}, LEVEL, '{"level":"on"}', "text/plain", 415, "json_required"],
    ...["maybe", "", 3, null, undefined].map(
      (level) => [THREE_WORDS, {}, LEVEL, { level }, undefined, 400, "invalid_level"] as const,
    ),
    // A body that is not an object at all is the same refusal.
    [THREE_WORDS, {}, LEVEL, "[]", undefined, 400, null],
    ["refuses a machine the config does not name with 404", {}, "/api/remote-machines/box-z/level", { level: "on" }, undefined, 404, "not_found"],
    ["refuses the same path with 404 while the feature is off", { noFeature: true }, LEVEL, { level: "on" }, undefined, 404, null],
  ];

  it.each(REFUSALS)("%s (row %#)", async (_oldCase, options, path, body, contentType, status, code) => {
    const { origin } = await boot(options);
    const answer = await post(origin, path, body, contentType);
    expect(answer.status).toBe(status);
    if (code !== null) expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(code);
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
