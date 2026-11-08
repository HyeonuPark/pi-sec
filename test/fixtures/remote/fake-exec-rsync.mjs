#!/usr/bin/env node
// A stand-in for `rsync`, for the tree copy.
//
// A real rsync starts the ssh named by `-e` and speaks its own protocol with an
// rsync on the other end. Nothing in this repository needs that protocol, so this
// program does the copy it was asked for and records the command line it was given.
// That is the honest test of the side this code owns: which arguments `remote_sync`
// builds, and that `-e` names a wrapper that exists and is executable.
//
//   FAKE_EXEC_RSYNC_LOG=<file> node fake-exec-rsync.mjs <rsync args...>
//
// A destination of the form `user@host:path` is a push, and the copy lands in
// `path`. A source of that form is a pull, and `path` is read. The remote part is a
// real path here, which is what lets one directory stand in for one machine.
//
//   FAKE_EXEC_FAIL   when set, the call fails with this text and status 23, which is
//                    rsync's own code for a partial transfer
//
// The log
//
//   One line per call: { "n": 1, "args": [...], "direction": "push", "delete": true,
//   "wrapper": "<path>", "wrapperExists": true, "wrapperExecutable": true }
//
// The two facts about the wrapper are the ones a test cannot get from anywhere else:
// rsync is the only program that is told about it as a string, and a path that is
// wrong there is a copy that fails with a message nobody can act on.

import {
  accessSync,
  appendFileSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

const logFile = process.env["FAKE_EXEC_RSYNC_LOG"] ?? "";
const failWith = process.env["FAKE_EXEC_FAIL"] ?? "";

const argv = process.argv.slice(2);

/** The remote part of a `user@host:path` argument, or null when it has none. */
function remotePath(argument) {
  const colon = argument.indexOf(":");
  if (colon <= 0) return null;
  const head = argument.slice(0, colon);
  if (head.includes("/")) return null;
  return argument.slice(colon + 1);
}

let wrapper = "";
let wrapperExists = false;
let wrapperExecutable = false;
const operands = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === "-e") {
    wrapper = argv[index + 1] ?? "";
    index += 1;
    continue;
  }
  if (arg.startsWith("-")) continue;
  operands.push(arg);
}

if (wrapper !== "") {
  wrapperExists = existsSync(wrapper);
  if (wrapperExists) {
    try {
      accessSync(wrapper, constants.X_OK);
      wrapperExecutable = true;
    } catch {
      wrapperExecutable = false;
    }
  }
}

const source = operands[0] ?? "";
const destination = operands[1] ?? "";
const fromRemote = remotePath(source);
const toRemote = remotePath(destination);
const direction = fromRemote === null ? "push" : "pull";
const deleteRequested = argv.includes("--delete");

if (logFile !== "") {
  mkdirSync(dirname(logFile), { recursive: true });
  const counterPath = `${logFile}.count`;
  const logged = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) || 0 : 0;
  writeFileSync(counterPath, String(logged + 1), "utf8");
  appendFileSync(
    logFile,
    `${JSON.stringify({
      n: logged + 1,
      args: argv,
      direction,
      delete: deleteRequested,
      wrapper,
      wrapperExists,
      wrapperExecutable,
    })}\n`,
    "utf8",
  );
}

if (failWith !== "") {
  process.stderr.write(`${failWith}\n`);
  process.exit(23);
}

if (wrapper !== "" && !wrapperExecutable) {
  process.stderr.write("fake rsync: the -e program is not there or not executable\n");
  process.exit(23);
}

const from = fromRemote === null ? source : fromRemote;
const to = toRemote === null ? destination : toRemote;
if (!isAbsolute(from) || !isAbsolute(to)) {
  process.stderr.write("fake rsync: this stand-in copies between real paths only\n");
  process.exit(23);
}
if (!existsSync(from)) {
  process.stderr.write(`fake rsync: ${from} does not exist\n`);
  process.exit(23);
}
// A destination that ends in a slash, or that is an existing directory, receives the
// source inside it; anything else is the file's own new name. That is rsync's rule,
// and it is the difference between `host:tree/` and `host:tree/file.txt`.
const sourceStats = statSync(from);
const toIsDirectory = destination.endsWith("/") || (existsSync(to) && statSync(to).isDirectory());
if (sourceStats.isDirectory()) {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true, force: true });
} else {
  mkdirSync(dirname(to), { recursive: true });
  const target = toIsDirectory ? join(to, from.slice(from.lastIndexOf("/") + 1)) : to;
  cpSync(from, target, { force: true });
}

// `--delete` is the one part of the copy that removes something, so the stand-in
// removes what the destination has and the source does not, exactly as rsync does.
if (deleteRequested) {
  for (const name of readdirSync(to)) {
    if (!existsSync(join(from, name))) rmSync(join(to, name), { recursive: true, force: true });
  }
}
process.exit(0);
