/**
 * Shared set-up for the extension page tests: a harness with a temporary
 * extensions directory, helpers that write a runtime extension into it, and a
 * server on port 0. Nothing here touches the real extensions directory.
 */
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, type Config } from "../src/config/schema.ts";
import { AdminNotes } from "../src/runtime/notes.ts";
import type { AppDeps } from "../src/server/deps.ts";
import { defaultWebDir, startServer, type ServerOptions, type StartedServer } from "../src/server/server.ts";
import { SseHub } from "../src/server/sse.ts";
import { StreamHub } from "../src/server/streams.ts";
import { createTestHarness, type TestHarness } from "./helpers.ts";

/** The example extension, which the loader, route and browser tests load. */
export const HOST_STATUS_DIR = fileURLToPath(new URL("./fixtures/extensions/host-status", import.meta.url));

/** The source of a minimal extension that exports `pages`. `body` is the text after the header. */
export function pagesExtension(name: string, body: string): string {
  return `export const name = ${JSON.stringify(name)};\nexport function create() { return { name: ${JSON.stringify(name)} }; }\n${body}\n`;
}

/** Write one extension directory: its `index.js` and any files, relative to the directory. */
export async function writeExtension(
  harness: TestHarness,
  name: string,
  source: string,
  files: Readonly<Record<string, string>> = {},
): Promise<string> {
  const dir = join(harness.paths.extensionsDir, name);
  await mkdir(join(dir, "ui"), { recursive: true });
  await writeFile(join(dir, "index.js"), source);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(join(dir, file, ".."), { recursive: true });
    await writeFile(join(dir, file), text);
  }
  return dir;
}

/** Copy the example into the temporary extensions directory. */
export async function installHostStatus(harness: TestHarness): Promise<string> {
  const dir = join(harness.paths.extensionsDir, "host-status");
  await cp(HOST_STATUS_DIR, dir, { recursive: true });
  return dir;
}

export async function removeExtension(harness: TestHarness, name: string): Promise<void> {
  await rm(join(harness.paths.extensionsDir, name), { recursive: true, force: true });
}

export interface BootedPages {
  readonly harness: TestHarness;
  readonly origin: string;
  readonly started: StartedServer;
  close(): Promise<void>;
}

export interface BootOptions {
  readonly config?: Partial<Config>;
  readonly server?: ServerOptions;
}

/** A harness with no extension loaded yet, and a server on port 0. */
export async function bootServer(options: BootOptions = {}): Promise<BootedPages> {
  const harness = await createTestHarness({
    config: {
      ...(options.config ?? {}),
      server: { ...defaultConfig().server, ...(options.config?.server ?? {}), port: 0 },
    },
  });
  const webDir = options.server?.webDir ?? defaultWebDir();
  const sse = new SseHub({ heartbeatMs: 15000, queueBytes: 1_000_000, bufferMs: 60000 });
  const deps: AppDeps = {
    runtime: harness.runtime,
    bus: harness.events,
    sse,
    streams: new StreamHub({ runtime: harness.runtime, bus: harness.events, sse }),
    startedAt: Date.now(),
    version: "test",
    webDir,
    adminState: { restart: harness.runtime.restart, notes: new AdminNotes() },
  };
  const started = await startServer(deps, { ...(options.server ?? {}), webDir });
  return {
    harness,
    origin: started.origin,
    started,
    async close() {
      await started.close();
      await harness.close();
    },
  };
}
