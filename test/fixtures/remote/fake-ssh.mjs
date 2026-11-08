#!/usr/bin/env node
// A stand-in for the OpenSSH client. No test in this repository starts the real
// `ssh`, and neither does a unit test of the remote machines feature.
//
// Usage (from a test, from a shell, or from another fixture):
//
//   FAKE_SSH_LOG=<file> FAKE_SSH_RESPONSES=<file> node fake-ssh.mjs <ssh args...>
//
// The server code takes the program to run as an option, so a test passes the path
// of this file wherever the daemon would have said `ssh`. It is the same device
// `test/fixtures/github-pr/fake-gh.mjs` is for `gh`.
//
// Environment
//
//   FAKE_SSH_LOG        file that receives one JSON line per call (required)
//   FAKE_SSH_RESPONSES  JSON file that decides what each call answers (required)
//
// The response file is read on every call, so a test changes what the next call
// sees by rewriting it: that is how "the machine comes back", "the key changed"
// and "the machine-id is different now" are all one line of a test each.
//
//   {
//     "rules": [
//       { "contains": ["-O", "exit"], "response": { "exit": 0 } },
//       { "user": "bob", "response": { "stdout": "...", "exit": 0 } },
//       { "kinds": ["heartbeat"], "response": { "stderr": "No route to host", "exit": 255 } }
//     ],
//     "default": { "stdout": "0123456789abcdef0123456789abcdef\n" }
//   }
//
// A rule matches when every string in `contains` appears in the joined argument
// list, when `user` matches the `user@` part of the destination, and when every
// kind in `kinds` is one of the kinds below. An absent field constrains nothing,
// so `{}` matches everything. The first rule that matches WINS, so put the narrow
// rules first: one rule's needles may be a subset of another's.
//
// Kinds, derived from the arguments alone:
//
//   "exit"       the call carries `-O exit`, so it asks a local socket to close
//   "heartbeat"  the call runs `cat /etc/machine-id`
//
// A response is `{ "stdout": "...", "stderr": "...", "exit": 0 }`. An absent
// `exit` is 0, and an absent stream is empty.
//
// The log
//
//   One line per call, in the order they arrived:
//     { "n": 1, "args": ["-F", "/dev/null", ...], "kinds": ["heartbeat"], "user": "alice" }
//
// The log is what a test reads to prove which calls were made, and it is the only
// way to prove that no call was made at all: an empty file, or a file whose lines
// are all `-O exit`, is the answer.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const logFile = process.env["FAKE_SSH_LOG"] ?? "";
const responsesFile = process.env["FAKE_SSH_RESPONSES"] ?? "";

function fail(code, message) {
  process.stderr.write(`fake ssh: ${message}\n`);
  process.exit(code);
}

if (logFile === "" || responsesFile === "") {
  fail(2, "FAKE_SSH_LOG and FAKE_SSH_RESPONSES must both be set");
}

const argv = process.argv.slice(2);
const joined = argv.join(" ");

/** The kinds of this call, from its arguments alone. */
function kindsOf(args) {
  const kinds = [];
  const at = args.indexOf("-O");
  if (at !== -1 && args[at + 1] === "exit") kinds.push("exit");
  if (joined.includes("cat /etc/machine-id")) kinds.push("heartbeat");
  return kinds;
}

/** The destination: the last argument ssh treats as `[user@]host`. */
function userOf(args) {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (arg === undefined || arg.startsWith("-")) continue;
    const at = arg.indexOf("@");
    if (at > 0) return arg.slice(0, at);
  }
  return "";
}

const kinds = kindsOf(argv);
const user = userOf(argv);

/** Whether one rule matches this call. */
function matches(rule) {
  for (const needle of rule.contains ?? []) {
    if (!joined.includes(String(needle))) return false;
  }
  if (typeof rule.user === "string" && rule.user !== user) return false;
  for (const kind of rule.kinds ?? []) {
    if (!kinds.includes(String(kind))) return false;
  }
  return true;
}

let responses;
try {
  responses = JSON.parse(readFileSync(responsesFile, "utf8"));
} catch (error) {
  fail(2, `cannot read ${responsesFile}: ${String(error)}`);
}

let chosen;
for (const rule of responses.rules ?? []) {
  if (matches(rule)) {
    chosen = rule.response ?? {};
    break;
  }
}
if (chosen === undefined) chosen = responses.default ?? {};

const counterPath = `${logFile}.count`;
const logged = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) || 0 : 0;
writeFileSync(counterPath, String(logged + 1), "utf8");
appendFileSync(logFile, `${JSON.stringify({ n: logged + 1, args: argv, kinds, user })}\n`, "utf8");

if (typeof chosen.stdout === "string" && chosen.stdout !== "") process.stdout.write(chosen.stdout);
if (typeof chosen.stderr === "string" && chosen.stderr !== "") process.stderr.write(`${chosen.stderr}\n`);
process.exit(typeof chosen.exit === "number" ? chosen.exit : 0);
