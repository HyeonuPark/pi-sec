#!/usr/bin/env node
// A stand-in for the GitHub CLI. No test in this repository starts the real `gh`.
//
// Usage (from a test, from a shell, or from another fixture):
//
//   FAKE_GH_RESPONSES=<dir> FAKE_GH_LOG=<file> node fake-gh.mjs <gh args...>
//
// The server code takes the `gh` executable as an option, so a test passes the
// path of this file wherever the daemon would have said `gh`. The ready-made
// wrapper is `test/github-pr/fake-gh-helpers.ts`: it makes a temporary `gh` shell
// script for a test, points it at a response directory and hands back the log.
//
// Environment
//
//   FAKE_GH_RESPONSES  directory of response files (required)
//   FAKE_GH_LOG        file that receives one JSON line per call (required)
//   FAKE_GH_ALLOW_WRITES
//                      "1" lets a write through. Without it this script refuses a
//                      call that carries a GraphQL `mutation` or a method other
//                      than GET, and exits 3 BEFORE it records anything. So a test
//                      that expects "writes are off, nothing was sent" checks the
//                      log file for being empty, and a mis-wired write makes the
//                      call fail loudly instead of reaching a response file.
//
// Two counters live beside the log file, `<FAKE_GH_LOG>.calls` and
// `<FAKE_GH_LOG>.count`, so the response directory stays read only and two test
// files never share a counter.
//
// Which response answers a call
//
//   Routes file:   <FAKE_GH_RESPONSES>/routes.json holds
//                    { "routes": [ { "contains": ["graphql", "mentions:"], "file": "mentions.json" }, ... ],
//                      "default": "empty.json" }
//                  The first route whose every `contains` string appears in the
//                  call's arguments (joined with a space) WINS, so put the narrow
//                  routes first: one route's needles may be a subset of another's.
//                  A route may leave `contains` out to match everything. `default`,
//                  when present, answers a call that no route matched; without it
//                  such a call exits 4.
//
//   Queue mode:    with no routes.json, the response files are used in file-name
//                  order, one call each: `0001-viewer.json`, `0002-search.json`,
//                  and so on. A call past the last file uses `default.json` when
//                  that file exists, and otherwise exits 4.
//
// A response file is JSON:
//
//   { "json": { ... } }             stdout is this value, JSON-encoded
//   { "stdout": "text" }            stdout is this text as written
//   { "stderr": "text", "exit": 1 } stderr and the exit code, for a failure
//
// `exit` defaults to 0. `stdout` wins over `json` when a file has both.
//
// The log
//
//   One line per answered call, in the order the calls arrived:
//     { "n": 1, "args": ["api", "graphql", "-f", "query=..."], "stdin": "", "response": "0001-viewer.json" }
//   A refused write is not logged at all, which is the point of the refusal.
//
// The shared response set (`test/fixtures/github-pr/responses`)
//
//   `routes.json` answers a whole fetch of one repository and the writes:
//
//     viewer.json              the account is `example-user`
//     search-*.json            one file per list section, for `acme/widgets`
//     mentions-detail.json     the mention check: PR 10 still waits, PR 12 is answered
//     pr-detail.json           the detail of PR 10 (comments, reviews, threads, checks)
//     pr-refs.json             the refs and node id of PR 10
//     repo-info*.json          one repository's fork relationship, as REST answers
//                              it (`acme/widgets` -> `upstream/widgets`), and the
//                              root repository's own answer for `upstream/widgets`.
//                              Any other repository name gets the `acme/widgets`
//                              answer, so a test that configures a name of its own
//                              still resolves into that network.
//     write-*.json             one answer per write
//     empty.json               the default, for a call no route matched
//
//   A test that needs its own data passes `responsesDir` with a `routes.json` of
//   its own, or uses `writeResponses` for queue mode. Names are in
//   `test/github-pr/fake-gh-helpers.ts`.

import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const responsesDir = process.env["FAKE_GH_RESPONSES"] ?? "";
const logFile = process.env["FAKE_GH_LOG"] ?? "";
const allowWrites = process.env["FAKE_GH_ALLOW_WRITES"] === "1";

function fail(code, message) {
  process.stderr.write(`fake gh: ${message}\n`);
  process.exit(code);
}

if (responsesDir === "" || logFile === "") {
  fail(2, "FAKE_GH_RESPONSES and FAKE_GH_LOG must both be set");
}

const argv = process.argv.slice(2);
const joined = argv.join(" ");

function methodOf(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-X" || arg === "--method") {
      const value = (args[index + 1] ?? "").toUpperCase();
      return value === "" ? undefined : value;
    }
    if (arg.startsWith("--method=")) {
      const value = arg.slice("--method=".length).toUpperCase();
      return value === "" ? undefined : value;
    }
    if (arg.startsWith("-X") && arg.length > 2) return arg.slice(2).toUpperCase();
  }
  return undefined;
}

const subcommand = argv[0];
if (subcommand !== "api") {
  fail(3, `only "api" is allowed, got ${JSON.stringify(subcommand ?? "")}`);
}

const method = methodOf(argv);
const isMutation = /\bmutation\b/i.test(joined);
const isWrite = isMutation || (method !== undefined && method !== "GET");
if (isWrite && !allowWrites) {
  // No log line: a test that expects nothing to be sent reads an empty log.
  fail(3, "writes are not allowed in this test (FAKE_GH_ALLOW_WRITES is not 1)");
}
if (!isWrite && method !== undefined && method !== "GET") {
  fail(3, `a read may not send ${method}`);
}

function readResponse(name) {
  const path = join(responsesDir, name);
  if (!existsSync(path)) return undefined;
  return { name, body: JSON.parse(readFileSync(path, "utf8")) };
}

/** Pick the response: the routes file first, then the queue, then the default. */
function choose() {
  const routesPath = join(responsesDir, "routes.json");
  if (existsSync(routesPath)) {
    const routes = JSON.parse(readFileSync(routesPath, "utf8"));
    for (const route of routes.routes ?? []) {
      const needles = route.contains ?? [];
      if (needles.every((needle) => joined.includes(needle))) {
        return readResponse(route.file);
      }
    }
    if (typeof routes.default === "string") return readResponse(routes.default);
    return undefined;
  }

  const files = readdirSync(responsesDir)
    .filter((name) => name.endsWith(".json") && name !== "default.json" && name !== "routes.json")
    .sort();
  // The counter lives beside the log, not in the responses directory, so the
  // fixture directory stays read-only for a test that only reads it.
  const counterPath = `${logFile}.calls`;
  const served = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) || 0 : 0;
  const next = files[served];
  if (next === undefined) {
    const fallback = readResponse("default.json");
    if (fallback !== undefined) return fallback;
    fail(4, `no response left for call ${served + 1}`);
  }
  writeFileSync(counterPath, String(served + 1), "utf8");
  return readResponse(next);
}

let stdin = "";
try {
  stdin = readFileSync(0, "utf8");
} catch {
  stdin = "";
}

const chosen = choose();
if (chosen === undefined) fail(4, `no response matched: ${joined.slice(0, 200)}`);

const logCounterPath = `${logFile}.count`;
const logged = existsSync(logCounterPath) ? Number(readFileSync(logCounterPath, "utf8")) || 0 : 0;
writeFileSync(logCounterPath, String(logged + 1), "utf8");
appendFileSync(
  logFile,
  `${JSON.stringify({ n: logged + 1, args: argv, stdin, response: chosen.name })}\n`,
  "utf8",
);

const body = chosen.body ?? {};
const stdout = body.stdout !== undefined ? String(body.stdout) : body.json !== undefined ? JSON.stringify(body.json) : "";
if (body.stderr !== undefined) process.stderr.write(`${String(body.stderr)}\n`);
if (stdout !== "") process.stdout.write(stdout);
process.exit(typeof body.exit === "number" ? body.exit : 0);
