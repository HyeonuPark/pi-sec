import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { defaultWebDir, startServer, type ServerOptions, type StartedServer } from "../src/server/server.ts";
import { json } from "../src/server/router.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { BUNDLED_EXTENSIONS, type BundledExtension, type ExtensionRouteContext } from "../src/extensions/index.ts";
import { fakeGhFixture } from "./github-pr/fake-gh-helpers.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/**
 * Web routes that a bundled extension registers.
 *
 * The server answers the paths it names itself and then calls the `routes`
 * function of every enabled catalog entry, in catalog order. Four things follow
 * from that order and are checked here:
 *
 *   1. A route of an enabled extension answers, and a route of a disabled one
 *      does not exist: `404`, the same answer any unknown path gets.
 *   2. A path the server names itself answers with the server's handler, not
 *      with an extension's handler of the same path.
 *   3. The cleanup the function returns runs once, when the server closes.
 *   4. The entry of `ServerOptions.extensionRoutes` that carries the extension's
 *      own name reaches the function, and `undefined` reaches it when the caller
 *      passes none.
 *
 * The extension that fills the device (`github-pr`) boots here too, so one case
 * below turns on the shipped entry itself. That case passes the extension's own
 * options, the fake `gh` and a temporary repository root, because a boot without
 * them would run the real `gh` against the real pi-sec home. Every other case
 * uses a catalog of its own: `ServerOptions.catalog` exists for that, a fake
 * entry answers a path, and the enabled list decides whether it is called exactly
 * as it decides for the shipped catalog.
 */

/** The name of the fake catalog entry, enabled per test. */
const FAKE = "routes-fixture";

/** The fake `gh` itself, for the wrapper below. */
const FAKE_GH = fileURLToPath(new URL("fixtures/github-pr/fake-gh.mjs", import.meta.url));

/** A timer queue that never fires: only the boot cycle of the list poll runs. */
const NEVER_FIRE = {
  set: (): unknown => Symbol("never"),
  clear: (): void => {
    /* nothing is ever scheduled */
  },
};

interface FixtureState {
  /** What the route function saw, in the order it saw it. */
  readonly seen: unknown[];
  cleanups: number;
}

function fixtureCatalog(state: FixtureState): BundledExtension[] {
  const routes = (context: ExtensionRouteContext): (() => void) => {
    state.seen.push(context.options);
    context.router.get("/routes-fixture/ping", ({ res }) => {
      json(res, 200, { from: "fixture" });
    });
    // The same path the server registers itself, to prove the fixed routes are
    // matched first: the router keeps insertion order and returns the first hit.
    context.router.get("/healthz", ({ res }) => {
      json(res, 200, { from: "fixture" });
    });
    return () => {
      state.cleanups += 1;
    };
  };
  return [
    {
      name: FAKE,
      // Never installed: the server reads `routes` only. The factory throws so a
      // stray install of this fixture is a failure and not a silent no-op.
      create: () => {
        throw new Error("the fixture catalog entry is never installed");
      },
      phase: "app",
      routes,
    },
  ];
}

describe("extension web routes", () => {
  let harness: TestHarness | undefined;
  let started: StartedServer | undefined;
  /** Directories this file made for a boot, removed when the case ends. */
  const temporaries: string[] = [];

  async function temporary(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    temporaries.push(dir);
    return dir;
  }

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
    for (const dir of temporaries.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function boot(
    enabled: string[],
    options: ServerOptions = {},
    extra: Partial<Config> = {},
  ): Promise<{ origin: string; deps: AppDeps }> {
    const created = await createTestHarness({
      config: {
        server: { ...defaultConfig().server, port: 0 },
        agent: { ...defaultConfig().agent, extensions: { enabled } },
        ...extra,
      },
    });
    harness = created;
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
    started = await startServer(deps, { webDir: defaultWebDir(), ...options });
    return { origin: started.origin, deps };
  }

  /** Close the running server so the next `boot` starts from a clean harness. */
  async function stop(): Promise<void> {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  }

  it("answers an enabled extension's route and hides a disabled extension's route", async () => {
    const on = { seen: [] as unknown[], cleanups: 0 };
    const { origin } = await boot([FAKE], { catalog: fixtureCatalog(on) });
    // The function ran once, at boot, and the path it registered answers.
    expect(on.seen).toHaveLength(1);
    const answered = await fetch(`${origin}/routes-fixture/ping`);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ from: "fixture" });
    await stop();

    const off = { seen: [] as unknown[], cleanups: 0 };
    const { origin: offOrigin } = await boot([], { catalog: fixtureCatalog(off) });
    // Not called at all, so nothing of this extension exists.
    expect(off.seen).toHaveLength(0);
    const refused = await fetch(`${offOrigin}/routes-fixture/ping`);
    expect(refused.status).toBe(404);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("not_found");
    // And there is nothing to clean up either.
    await started?.close();
    expect(off.cleanups).toBe(0);
    started = undefined;
  }, 30_000);

  it("passes the extension's own options through, and none when the caller passes none", async () => {
    const given = { seen: [] as unknown[], cleanups: 0 };
    const own = { gh: "/tmp/fake-gh", repoRoot: "/tmp/gh-repo", now: 1_700_000_000_000 };
    await boot([FAKE], { catalog: fixtureCatalog(given), extensionRoutes: { [FAKE]: own } });
    // The object arrives whole, under the extension's own name.
    expect(given.seen).toEqual([own]);
    await stop();

    const absent = { seen: [] as unknown[], cleanups: 0 };
    await boot([FAKE], { catalog: fixtureCatalog(absent) });
    // Absent, not `{}`: an extension can tell "the daemon passed nothing" from
    // "a test passed an empty object".
    expect(absent.seen).toEqual([undefined]);
  }, 30_000);

  it("keeps a path the server registers itself ahead of an extension's path", async () => {
    const state = { seen: [] as unknown[], cleanups: 0 };
    const { origin } = await boot([FAKE], { catalog: fixtureCatalog(state) });
    // Both the server and the fixture register `GET /healthz`; the server's own
    // handler answers, which is what "fixed routes come first" means.
    const answer = await fetch(`${origin}/healthz`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { status?: string; from?: string };
    expect(body.status).toBe("ok");
    expect(body.from).toBeUndefined();
  }, 30_000);

  it("calls the cleanup once, when the server closes", async () => {
    const state = { seen: [] as unknown[], cleanups: 0 };
    const { origin } = await boot([FAKE], { catalog: fixtureCatalog(state) });
    expect((await fetch(`${origin}/routes-fixture/ping`)).status).toBe(200);
    expect(state.cleanups).toBe(0);

    await started?.close();
    expect(state.cleanups).toBe(1);
    // A second close is not a second cleanup.
    await started?.close();
    expect(state.cleanups).toBe(1);
    started = undefined;
  }, 30_000);

  it("reports a route function that throws and keeps the server serving", async () => {
    const broken: BundledExtension[] = [
      {
        name: FAKE,
        create: () => {
          throw new Error("never installed");
        },
        phase: "app",
        routes: () => {
          throw new Error("fixture route registration failed");
        },
      },
    ];
    const origin = await boot([FAKE], { catalog: broken });
    // The boot carries on, and the note names the extension that failed.
    expect((await fetch(`${origin.origin}/healthz`)).status).toBe(200);
    expect(origin.deps.adminState.notes.all().map((note) => note.text)).toContain(
      `extension routes failed: ${FAKE}`,
    );
  }, 30_000);

  it("gives the shipped catalog exactly one entry with routes, named github-pr", async () => {
    // The one shipped entry with a `routes` field, and the frame the next
    // branches fill in: the call happens at boot, and what it registers is the
    // extension's own business. This test does not assert what answers under
    // `/github/pr/`, so filling the frame does not rewrite it.
    expect(BUNDLED_EXTENSIONS.filter((extension) => extension.routes !== undefined).map((e) => e.name)).toEqual([
      "github-pr",
    ]);

    // The extension's own options, so the boot reads GitHub through the fake and
    // keeps its bare repositories in a temporary root. Without them this boot
    // would run the real `gh` against the real `<pi-sec home>/gh-repo`.
    const gh = await fakeGhFixture();
    const repoRoot = await temporary("gh-repo-extension-routes-");

    // Enabled, with the key the loader requires while the name is on. The boot
    // succeeds and the rest of the server is unaffected.
    const { origin } = await boot(
      ["github-pr"],
      {
        extensionRoutes: {
          "github-pr": {
            ghPath: gh.clientOptions.ghPath,
            ghEnv: gh.clientOptions.env ?? {},
            repoRoot,
            timers: NEVER_FIRE,
          },
        },
      },
      { githubPr: { writes: false, repos: ["o/r"] } },
    );
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    // The fake answered the boot cycle, which is what proves the options reached
    // the extension: a call the fake logged is a call the real `gh` did not get.
    // The cycle starts at boot and is not awaited, so this waits for its line.
    const deadline = Date.now() + 10_000;
    while ((await gh.calls()).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect((await gh.calls()).length).toBeGreaterThan(0);
    // And nothing was made where the daemon would have made it: the store took
    // the temporary root, so `<pi-sec home>/gh-repo` is still absent.
    expect(existsSync(join(harness!.paths.home, "gh-repo"))).toBe(false);
  }, 30_000);

  it("awaits a cleanup that returns a promise", async () => {
    // The cleanup of an extension may have work to wait for, and `close` must
    // report itself finished only after that work ended. Otherwise a caller that
    // removes what the work writes into races it, which is what broke this file
    // under load: the afterEach removed a temporary root while the store was
    // still making bare repositories in it.
    let released = false;
    const slow: BundledExtension[] = [
      {
        name: FAKE,
        create: () => {
          throw new Error("never installed");
        },
        phase: "app",
        routes: () => async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          released = true;
        },
      },
    ];
    await boot([FAKE], { catalog: slow });
    expect(released).toBe(false);
    await started?.close();
    // Set by the time `close` answered, not a while later.
    expect(released).toBe(true);
    started = undefined;
  }, 30_000);

  it("waits for the work the extension started when the server closes", async () => {
    // The boot cycle of the list poll is not awaited by `boot`: it reconciles the
    // configured repositories, and that writes a bare repository into the
    // repository root over many `gh` calls and `git` runs. A cleanup that only
    // stopped the timer left all of that running past `close`, so a caller that
    // removed the root got `ENOTEMPTY` from `rm -rf`. Here every `gh` call is
    // slow, so the cycle is certain to be under way when the server closes, and
    // the check is that it is over by then: a caller reading the root finds the
    // bare repository, and no call arrives afterwards.
    const gh = await fakeGhFixture();
    const wrapperDir = await temporary("slow-gh-");
    const slowGh = join(wrapperDir, "gh");
    await writeFile(
      slowGh,
      `#!/bin/sh\nsleep 0.2\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`,
      { mode: 0o755 },
    );
    const repoRoot = await temporary("gh-repo-extension-routes-");

    const { origin } = await boot(
      ["github-pr"],
      {
        extensionRoutes: {
          "github-pr": {
            ghPath: slowGh,
            ghEnv: gh.clientOptions.env ?? {},
            repoRoot,
            timers: NEVER_FIRE,
          },
        },
      },
      { githubPr: { writes: false, repos: ["o/r"] } },
    );
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    // Straight to the close, while the cycle waits on the first slow call.
    await started?.close();
    started = undefined;
    const callsAtClose = (await gh.calls()).length;
    const entriesAtClose = await readdir(repoRoot, { recursive: true });
    // The reconcile ran to the end before `close` answered: the network's bare
    // repository is on disk, not still being made.
    expect(entriesAtClose).toContain(join("upstream", "widgets.git", "HEAD"));
    // And nothing of the extension reached `gh` after the close.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect((await gh.calls()).length).toBe(callsAtClose);
  }, 60_000);
});
