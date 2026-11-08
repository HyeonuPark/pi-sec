import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GhClientOptions } from "../../src/extensions/github-pr/gh.ts";

/**
 * A fake `gh` for the tests of this extension, and of the routes and the pages
 * that are built on it.
 *
 * The response files live in `test/fixtures/github-pr/responses`, which is read
 * only: the counter that picks the next queued answer and the log of received
 * calls both live in a temporary directory, so a test run leaves the repository
 * untouched and two runs cannot see each other's log.
 *
 * The executable is a shell wrapper that runs `fake-gh.mjs` under the node that
 * runs the test, so the fixture needs no execute bit and no fixed interpreter.
 * `fake-gh.mjs` documents its environment, its response files and its log.
 */

const FAKE_GH = fileURLToPath(new URL("../fixtures/github-pr/fake-gh.mjs", import.meta.url));
const RESPONSES = fileURLToPath(new URL("../fixtures/github-pr/responses", import.meta.url));

export interface FakeGhFixture {
  /** Everything `createGhClient` needs, in one object. */
  readonly clientOptions: GhClientOptions;
  /** The file that receives one JSON line per answered call. */
  readonly logFile: string;
  /** The response directory in use, for a test that adds a file of its own. */
  readonly responsesDir: string;
  /** Let writes through, which is off unless a test asks for it. */
  allowWrites(): void;
  /** Every answered call, in order. */
  calls(): Promise<{ args: string[]; stdin: string; response: string }[]>;
}

export interface FakeGhOptions {
  /** Another response directory. Defaults to the shared fixtures. */
  readonly responsesDir?: string;
  /** Let writes through from the start. */
  readonly allowWrites?: boolean;
}

export async function fakeGhFixture(options: FakeGhOptions = {}): Promise<FakeGhFixture> {
  const root = await mkdtemp(join(tmpdir(), "fake-gh-"));
  const ghPath = join(root, "gh");
  await writeFile(ghPath, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`, { mode: 0o755 });
  const logFile = join(root, "calls.jsonl");
  await writeFile(logFile, "", "utf8");

  const environment: Record<string, string> = {
    FAKE_GH_RESPONSES: options.responsesDir ?? RESPONSES,
    FAKE_GH_LOG: logFile,
  };
  if (options.allowWrites === true) environment["FAKE_GH_ALLOW_WRITES"] = "1";

  const clientOptions: GhClientOptions = { ghPath, timeoutMs: 20_000, env: environment };

  return {
    clientOptions,
    logFile,
    responsesDir: environment["FAKE_GH_RESPONSES"] ?? RESPONSES,
    allowWrites() {
      // The child reads this variable at start, and `createGhClient` copies the
      // object at every call, so setting it here reaches the next call.
      environment["FAKE_GH_ALLOW_WRITES"] = "1";
    },
    async calls() {
      const text = await readFile(logFile, "utf8");
      return text
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as { args: string[]; stdin: string; response: string });
    },
  };
}

/**
 * A response directory built for one test.
 *
 * Queue mode, because there is no `routes.json` here: the files are used in
 * file-name order, one file per call. Most single-call tests want this instead of
 * the shared `responses` directory, whose routes answer a whole list fetch.
 */
export async function writeResponses(responses: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fake-gh-responses-"));
  for (const [name, body] of Object.entries(responses)) {
    await writeFile(join(dir, name), JSON.stringify(body), "utf8");
  }
  return dir;
}
