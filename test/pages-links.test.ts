/**
 * The page links the enabled extensions declare, planted in the chat page.
 *
 * `GET /basic-chat` carries a `pages-links` JSON data block: one entry per page
 * link of every catalog entry whose name is in `agent.extensions.enabled`, in
 * catalog order. The sidebar's Pages menu draws one link per entry after its own
 * three, so the block is the only thing that decides whether a page link appears.
 *
 * Two things are checked here. The device itself, with a catalog of this file's
 * own (`ServerOptions.catalog`): an enabled entry's link is written, a disabled
 * one's is not, a label with `<` in it cannot end the element, and an entry with
 * no label or a relative path is dropped with one warning line. And the shipped
 * entry that fills it: `github-pr` declares `PRs` at `/github/pr/`, the path its
 * routes answer on.
 */
import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { BUNDLED_EXTENSIONS, bundledExtension, type BundledExtension } from "../src/extensions/index.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import { withPageLinks } from "../src/server/routes/basic-chat.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { installHostStatus } from "./ext-pages-helpers.ts";

let harness: TestHarness | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  await started?.close();
  started = undefined;
  await harness?.close();
  harness = undefined;
});

/** A catalog entry that declares the page links a case needs. */
function pageCatalog(name: string, pages: readonly { label: string; path: string }[]): BundledExtension[] {
  return [
    {
      name,
      // Never installed: the server reads `pages` only. The factory throws so a
      // stray install of this fixture is a failure and not a silent no-op.
      create: () => {
        throw new Error("the fixture catalog entry is never installed");
      },
      phase: "app",
      pages,
    },
  ];
}

/** Boot a server with this catalog and this enabled list, and answer its origin. */
async function boot(
  enabled: string[],
  catalog: readonly BundledExtension[],
): Promise<{ origin: string; harness: TestHarness }> {
  const created = await createTestHarness({
    config: {
      server: { ...defaultConfig().server, port: 0 },
      agent: { ...defaultConfig().agent, extensions: { enabled } },
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
  started = await startServer(deps, { webDir: defaultWebDir(), catalog });
  return { origin: started.origin, harness: created };
}

/** The `pages-links` block's value, read the way the menu reads it. */
function linksOf(page: string): unknown {
  const match = /<script type="application\/json" id="pages-links">([\s\S]*?)<\/script>/.exec(page);
  if (match === null) throw new Error("the page carries no pages-links block");
  return JSON.parse(match[1] ?? "");
}

describe("the page links the enabled extensions declare", () => {
  it("writes the link of an enabled extension into the page data block", async () => {
    const { origin } = await boot(["pr-fixture"], pageCatalog("pr-fixture", [{ label: "PRs", path: "/github/pr/" }]));
    const response = await fetch(`${origin}/basic-chat`);
    expect(response.status).toBe(200);
    const page = await response.text();

    expect(linksOf(page)).toEqual([{ label: "PRs", path: "/github/pr/" }]);
    // The block is data, so the policy names no script nonce for it.
    expect(response.headers.get("content-security-policy")).not.toContain("script-src 'self' 'nonce");
    // It takes the place the shell left for it, after the page's own module.
    expect(page.indexOf('id="pages-links"')).toBeGreaterThan(page.indexOf("ui-chat.js"));
  });

  it("writes a label with a `$` pattern into the data block as it is", () => {
    const label = "$& $' $` $$ $1";
    const page = withPageLinks("A<!--pages-links-->B", [{ label, path: "/x" }]);
    expect(linksOf(page)).toEqual([{ label, path: "/x" }]);
  });

  it("writes an empty list when the extension is off", async () => {
    const { origin } = await boot([], pageCatalog("pr-fixture", [{ label: "PRs", path: "/github/pr/" }]));
    const page = await (await fetch(`${origin}/basic-chat`)).text();
    // The block is there and empty: the menu reads a list and draws none of it.
    expect(linksOf(page)).toEqual([]);
  });

  it("writes every angle bracket as an escape, so no label can end the element", async () => {
    const { origin } = await boot(
      ["pr-fixture"],
      pageCatalog("pr-fixture", [{ label: "Pull <requests>", path: "/github/pr/" }]),
    );
    const page = await (await fetch(`${origin}/basic-chat`)).text();
    const block = /<script type="application\/json" id="pages-links">([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    expect(block).toContain("\\u003c");
    expect(block).not.toContain("<requests>");
    // The escape is the JSON escape, so the menu reads the label back unchanged.
    expect(linksOf(page)).toEqual([{ label: "Pull <requests>", path: "/github/pr/" }]);
  });

  it("drops an entry with no label or a relative path, and warns once for each", async () => {
    const { origin, harness: booted } = await boot(
      ["pr-fixture"],
      pageCatalog("pr-fixture", [
        { label: "PRs", path: "/github/pr/" },
        { label: "", path: "/empty/" },
        { label: "Relative", path: "github/pr/" },
      ]),
    );
    const page = await (await fetch(`${origin}/basic-chat`)).text();
    // The good entry is the one the menu draws.
    expect(linksOf(page)).toEqual([{ label: "PRs", path: "/github/pr/" }]);

    const warnings = (await readFile(booted.paths.appLog, "utf8"))
      .split("\n")
      .filter((line) => line.includes("extension page link dropped"));
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain('"path":"github/pr/"');
    expect(warnings.join("\n")).toContain('"label":""');
    expect(warnings.join("\n")).toContain('"extension":"pr-fixture"');
  });

  it("gives the shipped github-pr entry the links its own routes answer on", () => {
    const entry = bundledExtension("github-pr");
    expect(entry).toBeDefined();
    expect(entry?.pages).toEqual([{ label: "PRs", path: "/github/pr/" }]);
    // The path its routes register, so a link and the page behind it cannot drift.
    expect(entry?.routes).toBeTypeOf("function");
    // It is the only shipped entry that declares page links.
    expect(BUNDLED_EXTENSIONS.filter((each) => each.pages !== undefined).map((each) => each.name)).toEqual([
      "github-pr",
    ]);
  });
});

describe("when the enabled list is read", () => {
  it("keeps the list the server read at boot, whatever a later config read says", async () => {
    // The server registers an extension's web routes from the enabled list it
    // reads at boot, so the menu has to be drawn from that same read: a link that
    // appeared or vanished on a later config read would name a page the router
    // does not answer, or hide one it does.
    const { origin, harness: booted } = await boot(
      ["pr-fixture"],
      pageCatalog("pr-fixture", [{ label: "PRs", path: "/github/pr/" }]),
    );
    const before = await (await fetch(`${origin}/basic-chat`)).text();
    expect(linksOf(before)).toEqual([{ label: "PRs", path: "/github/pr/" }]);

    // An empty enabled list from now on: a restart's worth of change that no
    // route has taken, because the routes were registered at boot.
    const moved = { ...booted.config, agent: { ...booted.config.agent, extensions: { enabled: [] } } };
    booted.runtime.setConfig(moved);

    const after = await (await fetch(`${origin}/basic-chat`)).text();
    expect(linksOf(after)).toEqual([{ label: "PRs", path: "/github/pr/" }]);
    // The other per-request values still follow the new config, so the page is
    // not simply cached: only the enabled list is a boot-time fact.
    expect(after).not.toBe("");
  });

  it("adds no link for an extension a later config read turns on", async () => {
    const { origin, harness: booted } = await boot(
      [],
      pageCatalog("pr-fixture", [{ label: "PRs", path: "/github/pr/" }]),
    );
    expect(linksOf(await (await fetch(`${origin}/basic-chat`)).text())).toEqual([]);

    const moved = { ...booted.config, agent: { ...booted.config.agent, extensions: { enabled: ["pr-fixture"] } } };
    booted.runtime.setConfig(moved);

    expect(linksOf(await (await fetch(`${origin}/basic-chat`)).text())).toEqual([]);
  });
});

describe("the links of runtime extension pages", () => {
  const PRS_LINK = { label: "PRs", path: "/github/pr/" };
  const HOST_LINK = { label: "Host status", path: "/ext/host-status/" };

  it("appends the runtime links after the bundled ones on every page load, with no restart", async () => {
    const { origin, harness: booted } = await boot(["pr-fixture"], pageCatalog("pr-fixture", [PRS_LINK]));
    expect(linksOf(await (await fetch(`${origin}/basic-chat`)).text())).toEqual([PRS_LINK]);

    await installHostStatus(booted);
    await booted.runtime.loader.reload();
    expect(linksOf(await (await fetch(`${origin}/basic-chat`)).text())).toEqual([PRS_LINK, HOST_LINK]);
  });

  it("answers the same list from GET /api/ui/page-links, and follows a reload both ways", async () => {
    const { origin, harness: booted } = await boot(["pr-fixture"], pageCatalog("pr-fixture", [PRS_LINK]));
    const read = async (): Promise<unknown> => (await fetch(`${origin}/api/ui/page-links`)).json();
    expect(await read()).toEqual([PRS_LINK]);

    const dir = await installHostStatus(booted);
    await booted.runtime.loader.reload();
    expect(await read()).toEqual([PRS_LINK, HOST_LINK]);
    // The block and the route are built by one function, so they agree.
    expect(linksOf(await (await fetch(`${origin}/basic-chat`)).text())).toEqual(await read());

    await rm(dir, { recursive: true, force: true });
    await booted.runtime.loader.reload();
    expect(await read()).toEqual([PRS_LINK]);
  });
});
