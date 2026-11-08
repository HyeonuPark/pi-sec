import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config/schema.ts";
import { defaultWebDir, startServer, type StartedServer } from "../src/server/server.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

// Everything here writes into the harness home, whose `secrets` directory is
// created by `createTestHarness`. The operator's own store is never touched:
// the route reads `runtime.paths.secretsDir`, and that path is the temporary one
// the harness built for this test.

interface Fixture {
  readonly h: TestHarness;
  readonly origin: string;
  readonly started: StartedServer;
  readonly secretsDir: string;
}

let open: Fixture | undefined;

afterEach(async () => {
  await open?.started.close();
  await open?.h.close();
  open = undefined;
});

async function boot(): Promise<Fixture> {
  const h = await createTestHarness({
    config: { server: { ...defaultConfig().server, port: 0 } },
  });
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: h.runtime,
    bus: h.events,
    sse,
    streams: new StreamHub({ runtime: h.runtime, bus: h.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir: defaultWebDir(),
    adminState: { restart: h.runtime.restart, notes: new AdminNotes() },
  };
  const started = await startServer(deps, { webDir: defaultWebDir() });
  const fixture: Fixture = { h, origin: started.origin, started, secretsDir: h.paths.secretsDir };
  open = fixture;
  return fixture;
}

const ROUTE = "/api/admin/secrets/write";

/** POST a JSON-shaped body, or a raw string with the content type given. */
async function post(
  origin: string,
  path: string,
  body: unknown,
  contentType = "application/json",
): Promise<Response> {
  return await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Refusal = { error: { code: string; message: string } };

async function refusal(response: Response): Promise<Refusal["error"]> {
  const payload = (await response.json()) as Refusal;
  return payload.error;
}

/** Every file under `root`, so a check can name what it read. */
async function filesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(path);
    }
  };
  await walk(root);
  return out;
}

describe("secret write route: names", () => {
  it("refuses six unsafe names and creates no file for any of them", async () => {
    const f = await boot();
    // One case per rule: a path separator, `..`, a leading dot, the reserved
    // bundle name, a control character, and one character past the length cap.
    const refused: Array<[string, string]> = [
      ["path separator", "pass/word"],
      ["parent directory", ".."],
      ["leading dot", ".hidden"],
      ["reserved env", "env"],
      ["control character", "bad\u0007name"],
      ["over 64 characters", "a".repeat(65)],
    ];
    const messages = new Set<string>();
    for (const [label, name] of refused) {
      const response = await post(f.origin, ROUTE, { name, text: "value\n" });
      expect(response.status, label).toBe(400);
      const error = await refusal(response);
      expect(error.code, label).toBe("invalid_name");
      // One fixed sentence for every refused name: the answer names the rule and
      // never the name or the text that was sent.
      messages.add(error.message);
      expect(error.message, label).not.toContain("value");
    }
    expect(messages.size).toBe(1);
    // Nothing was created, and no temporary file was left behind by a refusal.
    expect(await readdir(f.secretsDir)).toEqual([]);
  });

  it("accepts a 64-character name, so the cap is a boundary and not a blanket refusal", async () => {
    const f = await boot();
    const name = "b".repeat(64);
    const response = await post(f.origin, ROUTE, { name, text: "value\n" });
    expect(response.status).toBe(200);
    expect(await readdir(f.secretsDir)).toEqual([name]);
  });

  it("refuses a name with a trailing dot", async () => {
    const f = await boot();
    const response = await post(f.origin, ROUTE, { name: "token.", text: "value\n" });
    expect(response.status).toBe(400);
    expect((await refusal(response)).code).toBe("invalid_name");
    expect(await readdir(f.secretsDir)).toEqual([]);
  });
});

describe("secret write route: one write", () => {
  it("writes the file 0600 in a 0700 directory and answers with name and size", async () => {
    const f = await boot();
    const text = "ghp_uploaded_value_0001\n";
    const response = await post(f.origin, ROUTE, { name: "gh_token", text });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, name: "gh_token", bytes: Buffer.byteLength(text) });

    const file = join(f.secretsDir, "gh_token");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(f.secretsDir)).mode & 0o777).toBe(0o700);
    expect(await readFile(file, "utf8")).toBe(text);
    // The registry is the reader that matters: the name has to be listed by the
    // same registry the reload used, before the response was written.
    expect(f.h.runtime.secrets.names()).toContain("gh_token");
    // No temporary file survives a successful write.
    expect(await readdir(f.secretsDir)).toEqual(["gh_token"]);
  });

  it("refuses a second write of the same name and leaves the first bytes alone", async () => {
    const f = await boot();
    const file = join(f.secretsDir, "gh_token");
    const first = "first-value\n";
    expect((await post(f.origin, ROUTE, { name: "gh_token", text: first })).status).toBe(200);
    const before = await readFile(file);

    const second = await post(f.origin, ROUTE, { name: "gh_token", text: "second-value\n" });
    expect(second.status).toBe(409);
    expect((await refusal(second)).code).toBe("name_exists");
    expect(await readFile(file)).toEqual(before);
    expect(await readdir(f.secretsDir)).toEqual(["gh_token"]);
  });

  it("removes an upload temporary older than an hour and keeps a fresh one", async () => {
    const f = await boot();
    const stale = join(f.secretsDir, ".upload-00000000000000000000000000");
    const fresh = join(f.secretsDir, ".upload-00000000000000000000000001");
    await writeFile(stale, "left behind\n", { mode: 0o600 });
    await writeFile(fresh, "still running\n", { mode: 0o600 });
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, twoHoursAgo, twoHoursAgo);

    expect((await post(f.origin, ROUTE, { name: "gh_token", text: "value\n" })).status).toBe(200);
    const names = (await readdir(f.secretsDir)).sort();
    expect(names).toEqual([".upload-00000000000000000000000001", "gh_token"]);
  });
});

describe("secret write route: the text stays out of every other file", () => {
  it("does not put the text in the response, the log, or any file but the secret", async () => {
    const f = await boot();
    const marker = "MARKER-never-echoed-8f3a2c71";
    const text = `${marker}\n`;

    const response = await post(f.origin, ROUTE, { name: "gh_token", text });
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).not.toContain(marker);

    // Wait for the access-log row for this request, so the log is known to have
    // been written before it is searched. Without that, an absent marker could
    // just mean an empty file.
    const deadline = Date.now() + 5000;
    let log = "";
    while (Date.now() < deadline) {
      log = await readFile(f.h.paths.appLog, "utf8").catch(() => "");
      if (log.includes(ROUTE)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(log).toContain(ROUTE);
    expect(log).not.toContain(marker);

    // The audit row names the event without the value or a hash of it.
    const audit = await readFile(f.h.paths.auditLog, "utf8").catch(() => "");
    expect(audit).toContain('"type":"secret.write"');
    expect(audit).not.toContain(marker);

    // Nothing else the harness wrote carries it either. The secret file itself is
    // the one place the value belongs, so it is the one file left out.
    const secretFile = join(f.secretsDir, "gh_token");
    const needle = Buffer.from(marker);
    for (const path of await filesUnder(f.h.paths.home)) {
      if (path === secretFile) continue;
      const bytes = await readFile(path);
      expect(bytes.includes(needle), path).toBe(false);
    }
  });
});

describe("secret write route: refusals at the edge", () => {
  it("refuses a non-JSON content type with 415 and writes nothing", async () => {
    const f = await boot();
    const response = await post(f.origin, ROUTE, "name=gh_token&text=value", "text/plain");
    expect(response.status).toBe(415);
    expect((await refusal(response)).code).toBe("json_required");
    expect(await readdir(f.secretsDir)).toEqual([]);
  });

  it("refuses an empty text with 400 and writes nothing", async () => {
    const f = await boot();
    // Whitespace alone is refused too: the registry has no minimum length, so a
    // value of "\n" would be redacted out of every line the agent reads.
    for (const text of ["", "\n", "   \n"]) {
      const response = await post(f.origin, ROUTE, { name: "gh_token", text });
      expect(response.status).toBe(400);
      expect((await refusal(response)).code).toBe("empty_secret");
    }
    // A field that is not a string has no text to write, and gets the same code
    // rather than opening a second one.
    const number = await post(f.origin, ROUTE, { name: "gh_token", text: 42 });
    expect(number.status).toBe(400);
    expect((await refusal(number)).code).toBe("empty_secret");
    expect(await readdir(f.secretsDir)).toEqual([]);
  });

  it("refuses a body over the server cap with 413 and writes nothing", async () => {
    const f = await boot();
    const cap = f.h.config.server.maxBodyBytes;
    const body = JSON.stringify({ name: "big", text: "a".repeat(cap) });
    expect(Buffer.byteLength(body)).toBeGreaterThan(cap);
    const response = await post(f.origin, ROUTE, body).catch((error: unknown) => error);
    expect(response, "an oversized body must not be accepted silently").toBeInstanceOf(Response);
    expect((response as Response).status).toBe(413);
    expect(await readdir(f.secretsDir)).toEqual([]);
  }, 30_000);

  it("answers one path, not a family of them", async () => {
    const f = await boot();
    // A deeper path is a different route and is not served.
    const nested = await post(f.origin, `${ROUTE}/extra`, { name: "gh_token", text: "value\n" });
    expect(nested.status).toBe(404);
    // A different method on the same path is not served either.
    const read = await fetch(`${f.origin}${ROUTE}`);
    expect(read.status).toBe(404);
    // The shared router drops empty segments, so a trailing slash reaches the
    // same handler. That is one route seen twice, not an alias: every route in
    // the daemon behaves that way.
    expect((await post(f.origin, `${ROUTE}/`, { name: "gh_token", text: "value\n" })).status).toBe(200);
    expect(await readdir(f.secretsDir)).toEqual(["gh_token"]);
  });
});
