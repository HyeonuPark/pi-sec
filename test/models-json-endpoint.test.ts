/**
 * A `models.json` endpoint.
 *
 * `models.json` is how an operator adds an endpoint that already speaks a
 * supported API, without code: a proxy, Ollama, vLLM. The daemon has
 * always passed this file to the model runtime, and nothing proved it. This test
 * stands a real OpenAI-compatible server on 127.0.0.1, names it in a `models.json`
 * in a temporary home, and checks that the model is in the catalog and that one
 * request reaches the server.
 */
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createModels } from "../src/agent/models.ts";
import { buildPaths, ensureLayout, type Paths } from "../src/runtime/paths.ts";

const ANSWER = "hello from the local endpoint";

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly body: string;
}

interface FakeEndpoint {
  readonly port: number;
  readonly requests: RecordedRequest[];
  close(): Promise<void>;
}

/** One OpenAI-compatible endpoint that streams a fixed answer. */
async function fakeEndpoint(): Promise<FakeEndpoint> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response: ServerResponse) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });
      if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunk = (delta: unknown, finish: string | null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-fake",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "fake-local",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      response.write(chunk({ role: "assistant", content: "" }, null));
      response.write(chunk({ content: ANSWER }, null));
      response.write(chunk({}, "stop"));
      response.write("data: [DONE]\n\n");
      response.end();
    });
  });

  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((settle) => {
        server.closeAllConnections();
        server.close(() => settle());
      }),
  };
}

const roots: string[] = [];
let endpoint: FakeEndpoint | undefined;

beforeEach(async () => {
  endpoint = await fakeEndpoint();
});

afterEach(async () => {
  await endpoint?.close();
  endpoint = undefined;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sandbox(): Promise<Paths> {
  const root = await mkdtemp(join(tmpdir(), "pi-sec-models-json-"));
  roots.push(root);
  const paths = buildPaths(join(root, ".pi", "sec"));
  await ensureLayout(paths);
  return paths;
}

/** A `models.json` that names the fake endpoint, the way the installation doc says to. */
function modelsJson(port: number): unknown {
  return {
    providers: {
      "local-fake": {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "fake-local-endpoint-key",
        models: [
          {
            id: "fake-local",
            name: "Fake Local",
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 32_000,
            maxTokens: 1_024,
            reasoning: false,
          },
        ],
      },
    },
  };
}

describe("models.json compatible endpoint", () => {
  it("puts the endpoint's model in the catalog and sends the request to it", async () => {
    const paths = await sandbox();
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.modelsFile, `${JSON.stringify(modelsJson(endpoint!.port), null, 2)}\n`, { mode: 0o600 });

    const models = await createModels({
      authPath: paths.authFile,
      modelsPath: paths.modelsFile,
      secretsDir: paths.secretsDir,
    });
    const model = models.getModel("local-fake", "fake-local");
    expect(model, "the model from models.json is not in the catalog").toBeDefined();
    expect(models.getModels("local-fake").map((entry) => entry.id)).toContain("fake-local");

    const message = await models.completeSimple(model!, {
      messages: [{ role: "user", content: "say hello", timestamp: Date.now() }],
    });
    const text = message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    expect(text).toBe(ANSWER);

    // The request reached the server, and it carried the conversation.
    const sent = endpoint!.requests.filter((request) => request.url === "/v1/chat/completions");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.body).toContain("say hello");
    expect(sent[0]?.body).toContain('"stream":true');
  }, 60_000);

  it("is the fallback source: a home without models.json has no such provider", async () => {
    const paths = await sandbox();
    const models = await createModels({
      authPath: paths.authFile,
      modelsPath: paths.modelsFile,
      secretsDir: paths.secretsDir,
    });
    expect(models.getModel("local-fake", "fake-local")).toBeUndefined();
    expect(endpoint!.requests).toHaveLength(0);
  }, 60_000);
});
