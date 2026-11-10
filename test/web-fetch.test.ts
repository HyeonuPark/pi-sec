import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { ExtensionContext } from "../src/extensions/context.ts";
import { createWebExtension } from "../src/extensions/web.ts";

/**
 * `fetch_url` against a local server: the byte limit, the cancel signal, the time
 * limit and the replay policy. No test here reaches the network.
 */

function fetchTool(options?: { timeoutMs?: number }): ToolRegistration {
  const extension = createWebExtension({} as ExtensionContext, options);
  const tool = extension.tools?.find((item) => item.name === "fetch_url");
  if (tool === undefined) throw new Error("fetch_url is not registered");
  return tool;
}

async function run(tool: ToolRegistration, url: string, ctx = BACKGROUND_CONTEXT) {
  const result = (await tool.execute({ url }, {} as ToolExecutionApi, ctx)) as {
    output: { text: string }[];
    isError?: boolean;
  };
  return { text: result.output.map((part) => part.text).join(""), isError: result.isError === true };
}

describe("fetch_url limits", () => {
  let server: Server | undefined;
  let closed: Promise<void> | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    closed = undefined;
  });

  async function listen(handler: (res: ServerResponse) => void): Promise<string> {
    let markClosed: () => void = () => undefined;
    closed = new Promise<void>((resolve) => (markClosed = resolve));
    server = createServer((_req, res) => {
      res.on("close", markClosed);
      handler(res);
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  }

  it("stops reading an endless body at the byte limit", async () => {
    const url = await listen((res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      const chunk = "x".repeat(50_000);
      const timer = setInterval(() => {
        if (res.destroyed) clearInterval(timer);
        else res.write(chunk);
      }, 1);
    });
    const answer = await run(fetchTool(), url);
    expect(answer.isError).toBe(false);
    expect(answer.text).toContain("[truncated]");
    expect(answer.text.length).toBeLessThan(200_500);
    await closed;
  }, 15_000);

  it("ends when the tool call is cancelled", async () => {
    const url = await listen((res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.flushHeaders();
    });
    const call = withCancel(BACKGROUND_CONTEXT);
    const pending = run(fetchTool(), url, call.context);
    setTimeout(() => call.cancel(new Error("stop")), 100);
    const answer = await pending;
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("cancelled");
  }, 15_000);

  it("ends with an error when the time limit passes", async () => {
    const url = await listen((res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.flushHeaders();
    });
    const answer = await run(fetchTool({ timeoutMs: 200 }), url);
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("fetch_url: no complete answer within");
  }, 15_000);

  it("is not replayed after a restart", () => {
    expect(fetchTool().replay).toBe("unsafe");
  });
});
