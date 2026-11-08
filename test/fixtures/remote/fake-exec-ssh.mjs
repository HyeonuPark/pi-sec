#!/usr/bin/env node
// A stand-in for the OpenSSH client, for tests that need a remote machine to
// behave like a machine: files that persist, a process that really starts, output
// that really grows, and an exit status that really arrives.
//
// `fake-ssh.mjs` next to it answers from a file and starts nothing. That is what
// the heartbeat tests need: they ask "was this called". A detached run needs the
// opposite, because the core reads the run directory after the start and decides
// from what is in it. So this program does what ssh does with a command line: it
// takes the options off the front, finds the destination, and runs the rest with a
// shell whose HOME is a directory the test named.
//
//   FAKE_EXEC_SSH_LOG=<file> FAKE_EXEC_HOME=<dir> node fake-exec-ssh.mjs <ssh args...>
//
// Environment
//
//   FAKE_EXEC_SSH_LOG   file that receives one JSON line per call (required)
//   FAKE_EXEC_HOME      the home directory the remote command runs with (required)
//   FAKE_EXEC_FAIL      when set, the call fails with this text on stderr and 255,
//                       as an unreachable machine would
//   FAKE_EXEC_PROGRAM   the shell that runs the command. Default `sh`.
//
// The destination
//
//   Everything up to and including the destination is skipped: the options this
//   feature passes are all in the `-o value` and `-F value` and `-p value` forms, so
//   the first argument that does not start with `-` after all of those is the
//   destination, and it is `user@address`. The rest, joined by spaces, is the
//   remote command. `-O exit` is answered with a success and starts nothing.
//
// The log
//
//   One line per call, in the order they arrived:
//     { "n": 1, "args": [...], "kinds": ["exec"], "user": "alice", "command": "..." }
//
// A `kinds` entry is `exit` for `-O exit`, `exec` for a command, and nothing else.
//
// Output and statuses are the remote command's own: the shell's stdout and stderr
// go where the caller's do, and its exit status is this program's.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const logFile = process.env["FAKE_EXEC_SSH_LOG"] ?? "";
const home = process.env["FAKE_EXEC_HOME"] ?? "";
const failWith = process.env["FAKE_EXEC_FAIL"] ?? "";
const shell = process.env["FAKE_EXEC_PROGRAM"] ?? "sh";

function record(entry) {
  if (logFile === "") return;
  mkdirSync(dirname(logFile), { recursive: true });
  const counterPath = `${logFile}.count`;
  const logged = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) || 0 : 0;
  writeFileSync(counterPath, String(logged + 1), "utf8");
  appendFileSync(logFile, `${JSON.stringify({ n: logged + 1, ...entry })}\n`, "utf8");
}

if (home === "") {
  process.stderr.write("fake exec ssh: FAKE_EXEC_HOME must be set\n");
  process.exit(2);
}

const argv = process.argv.slice(2);

// The options this feature passes take one value each, and every one of them
// starts with `-`. The destination is the first word that does not.
let index = 0;
while (index < argv.length) {
  const arg = argv[index];
  if (arg === "-O") {
    record({ args: argv, kinds: ["exit"], user: "", command: "" });
    // A local socket close never reaches a machine, so it never fails either.
    process.exit(0);
  }
  if (arg.startsWith("-")) {
    // `-o key=value`, `-F path`, `-p port`, `-l user`, `-i path`, `-b -` and the
    // single-letter flags all carry their value as the next word when they carry
    // one at all. The ones this feature uses all do.
    index += 2;
    continue;
  }
  break;
}
const destination = argv[index] ?? "";
const command = argv.slice(index + 1).join(" ");
const at = destination.indexOf("@");
const user = at > 0 ? destination.slice(0, at) : "";

record({ args: argv, kinds: command === "" ? [] : ["exec"], user, command });

if (failWith !== "") {
  process.stderr.write(`${failWith}\n`);
  process.exit(255);
}

if (command === "") process.exit(0);

const result = spawnSync(shell, ["-c", command], {
  env: { ...process.env, HOME: home },
  stdio: "inherit",
  cwd: home,
});
process.exit(result.status ?? 1);
