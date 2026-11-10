import { access } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Conversation } from "@earendil-works/pi-durable";
import { fauxProvider } from "@earendil-works/pi-ai";
import { syncRootRecord } from "../src/agent/root-record.ts";
import { rootContextPath } from "../src/agent/context-file.ts";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { SecAgent } from "../src/documents.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";
import { startTestServer, type TestServer } from "./server-helpers.ts";

/**
 * The read-only side of the root conversation.
 *
 * The chat page's two `GET` routes must write nothing, so the root conversation
 * is prepared during boot instead. These tests hold both halves: what the boot
 * prepares on an empty store, and what the two routes answer when that
 * preparation did not run.
 */

describe("root preparation at boot", () => {
  let harness: TestHarness | undefined;
  let started: TestServer | undefined;

  afterEach(async () => {
    await started?.close();
    started = undefined;
    await harness?.close();
    harness = undefined;
  });

  /** The same wiring `test/server.test.ts` uses: the real routes over a test runtime. */
  async function boot(
    options: Parameters<typeof createTestHarness>[0] = {},
    extra: { reloadConfig?: () => Promise<void> } = {},
  ): Promise<{ origin: string; deps: AppDeps }> {
    harness = await createTestHarness({
      ...options,
      config: {
        ...(options.config ?? {}),
        server: { ...defaultConfig().server, ...(options.config?.server ?? {}), port: 0 },
      },
    });
    started = await startTestServer(harness, { deps: { reloadConfig: extra.reloadConfig } });
    return { origin: started.origin, deps: started.deps };
  }

  function rootConversation(): Promise<Conversation | undefined> {
    return harness!.runtime.harness.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
  }

  it("creates the root conversation, its agent record and its state file before it serves", async () => {
    // Extensions on, as in the daemon: the boot repair that writes the record and
    // the context file is part of what this change has to make work on a fresh
    // store, and it runs as its own pass after the runtime is built.
    await boot({ loadExtensions: true });

    // The conversation is there the moment the runtime returns, which is before
    // the server listens.
    expect(await rootConversation()).toBeDefined();

    const contextPath = rootContextPath(harness!.paths);
    const deadline = Date.now() + 15_000;
    while (!(await exists(contextPath)) && Date.now() < deadline) await delay(25);
    expect(await exists(contextPath)).toBe(true);

    const record = await harness!.runtime.harness.snapshot(SecAgent, String(ROOT_CONVERSATION_ID), BACKGROUND_CONTEXT);
    expect(record?.kind).toBe("root");
    expect(record?.vmodel).toBe(harness!.config.agent.vmodel);
  });

  it("answers 503 root_missing on the two chat GET routes, and creates nothing", async () => {
    const { origin } = await boot({ prepareRoot: false });
    expect(await rootConversation()).toBeUndefined();

    for (const path of ["/basic-chat/events", "/basic-chat/context"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status, path).toBe(503);
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code, path).toBe("root_missing");
      expect(body.error.message).toContain("the root conversation does not exist");
    }

    // The two refused reads left the store as they found it.
    expect(await rootConversation()).toBeUndefined();
  });

  it("answers 200 on every other route the page opens with no root conversation", async () => {
    const { origin } = await boot({ prepareRoot: false });

    for (const path of [
      "/",
      "/basic-chat",
      "/api/preferences",
      "/api/jobs",
      "/api/inbox",
      "/api/user-queries",
      "/api/admin/status",
    ]) {
      const response = await fetch(`${origin}${path}`, { redirect: "manual" });
      // The page itself may redirect to its mount point; what matters is that no
      // page-load route needs the root conversation.
      expect([200, 302], path).toContain(response.status);
    }

    // The job stream is a read like the rest: it opens, it does not create.
    const controller = new AbortController();
    const events = await fetch(`${origin}/api/jobs/events`, { signal: controller.signal });
    expect(events.status).toBe(200);
    controller.abort();

    expect(await rootConversation()).toBeUndefined();
  });

  it("leaves a root whose configuration differs from the config alone on a read", async () => {
    const { origin } = await boot();
    const conversation = await rootConversation();
    expect(conversation).toBeDefined();

    // A root that is out of step with config.json, which the two `GET` routes used
    // to rewrite. Nothing but a write route or a reload may fix it now.
    await conversation!.configure({ thinkingLevel: "high" }, BACKGROUND_CONTEXT);
    const drifted = await conversation!.agent(BACKGROUND_CONTEXT);
    expect(drifted.thinkingLevel).toBe("high");

    expect((await fetch(`${origin}/basic-chat/events`)).status).toBe(200);
    expect((await fetch(`${origin}/basic-chat/context`)).status).toBe(200);

    const after = await conversation!.agent(BACKGROUND_CONTEXT);
    expect(after.thinkingLevel).toBe("high");
    expect(after.model).toEqual(drifted.model);
  });

  it("applies the root vmodel of the new config on a reload", async () => {
    // A second model on a second provider, so the change is a model change and not
    // only a thinking level.
    const alt = fauxProvider({ provider: "faux-alt", models: [{ id: "faux-alt-model" }] });
    let applied = false;
    const { origin } = await boot(
      {},
      {
        reloadConfig: async () => {
          harness!.models.setProvider(alt.provider);
          const current = harness!.runtime.getConfig();
          const next: Config = {
            ...current,
            vmodels: {
              ...current.vmodels,
              alt: { provider: "faux-alt", modelId: "faux-alt-model", thinkingLevel: "low", prompt: "faux" },
            },
            agent: { ...current.agent, vmodel: "alt" },
          };
          harness!.runtime.setConfig(next);
          applied = true;
        },
      },
    );
    const conversation = await rootConversation();
    const before = await conversation!.agent(BACKGROUND_CONTEXT);
    expect(before.model?.provider).toBe("faux");

    const response = await fetch(`${origin}/api/admin/reload`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(applied).toBe(true);

    const after = await conversation!.agent(BACKGROUND_CONTEXT);
    expect(after.model).toEqual({ provider: "faux-alt", modelId: "faux-alt-model" });
    expect(after.thinkingLevel).toBe("low");
  });

  it("updates the root agent record's vmodel and roles on a reload", async () => {
    const alt = fauxProvider({ provider: "faux-alt", models: [{ id: "faux-alt-model" }] });
    const { origin } = await boot(
      {},
      {
        reloadConfig: async () => {
          harness!.models.setProvider(alt.provider);
          const current = harness!.runtime.getConfig();
          harness!.runtime.setConfig({
            ...current,
            vmodels: {
              ...current.vmodels,
              alt: { provider: "faux-alt", modelId: "faux-alt-model", thinkingLevel: "low", prompt: "faux" },
            },
            agent: { ...current.agent, vmodel: "alt", roles: ["worker"] },
          });
        },
      },
    );
    // The boot repair writes this record in the daemon; this test boots without it.
    await syncRootRecord(harness!.runtime.harness, harness!.runtime.getConfig(), BACKGROUND_CONTEXT);
    const key = String(ROOT_CONVERSATION_ID);
    const before = await harness!.runtime.harness.snapshot(SecAgent, key, BACKGROUND_CONTEXT);
    expect(before?.vmodel).toBe("faux");

    expect((await fetch(`${origin}/api/admin/reload`, { method: "POST" })).status).toBe(200);

    const after = await harness!.runtime.harness.snapshot(SecAgent, key, BACKGROUND_CONTEXT);
    expect(after?.vmodel).toBe("alt");
    expect(after?.roles).toEqual(["worker"]);
  });
});

/** Whether a path exists, without throwing when it does not. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
