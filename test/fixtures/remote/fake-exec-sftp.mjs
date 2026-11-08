#!/usr/bin/env node
// A stand-in for OpenSSH's `sftp`, for the file tools.
//
// `sftp -b - -` reads a batch of commands from standard input and does them on a
// remote machine. This program does the same against a directory, so a test can
// read back what it wrote. Three commands are supported, and they are the three the
// file tools send: `ls -ln`, `get`, `put` and `rename`, plus the `-rm` form that
// removes the temporary file of a failed write.
//
//   FAKE_EXEC_SFTP_LOG=<file> FAKE_EXEC_HOME=<dir> node fake-exec-sftp.mjs <sftp args...>
//
// Environment
//
//   FAKE_EXEC_SFTP_LOG   file that receives one JSON line per call (required)
//   FAKE_EXEC_HOME       the directory that plays the remote user's home (required)
//   FAKE_EXEC_FAIL       when set, the call fails with this text and 255
//
// Paths are read as absolute, or relative to the fake home when they do not start
// with `/`. `~` names the fake home, because the tools send the absolute paths the
// user typed and a test may type a `~` one.
//
// The log
//
//   One line per call: { "n": 1, "args": [...], "commands": ["put ...", ...] }
//
// A command that fails prints `sftp: <command>: <reason>` on stderr and exits 255,
// which is what the real program does in batch mode: it aborts on the first failure,
// and the caller reads the status rather than the output.

import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

const logFile = process.env["FAKE_EXEC_SFTP_LOG"] ?? "";
const home = process.env["FAKE_EXEC_HOME"] ?? "";
const failWith = process.env["FAKE_EXEC_FAIL"] ?? "";

function record(entry) {
  if (logFile === "") return;
  mkdirSync(dirname(logFile), { recursive: true });
  const counterPath = `${logFile}.count`;
  const logged = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) || 0 : 0;
  writeFileSync(counterPath, String(logged + 1), "utf8");
  appendFileSync(logFile, `${JSON.stringify({ n: logged + 1, ...entry })}\n`, "utf8");
}

if (home === "") {
  process.stderr.write("fake sftp: FAKE_EXEC_HOME must be set\n");
  process.exit(2);
}

const argv = process.argv.slice(2);
const batch = readFileSync(0, "utf8");
const commands = batch
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line !== "");

record({ args: argv, commands });

if (failWith !== "") {
  process.stderr.write(`${failWith}\n`);
  process.exit(255);
}

/**
 * One word of a batch line, with sftp's own quoting: a double-quoted run may hold
 * spaces, and a backslash escapes the next character inside it.
 */
function words(line) {
  const out = [];
  let index = 0;
  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index])) index += 1;
    if (index >= line.length) break;
    let word = "";
    if (line[index] === '"') {
      index += 1;
      while (index < line.length && line[index] !== '"') {
        if (line[index] === "\\" && index + 1 < line.length) index += 1;
        word += line[index];
        index += 1;
      }
      index += 1;
    } else {
      while (index < line.length && !/\s/.test(line[index])) {
        word += line[index];
        index += 1;
      }
    }
    out.push(word);
  }
  return out;
}

/** One path as a real path in the fake home. */
function real(path) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (path.startsWith("/")) return path;
  return join(home, path);
}

let failed = "";
for (const line of commands) {
  // A leading `-` asks sftp not to abort the batch when this one fails.
  const tolerant = line.startsWith("-");
  const body = tolerant ? line.slice(1) : line;
  const parts = words(body);
  const command = parts[0] ?? "";
  try {
    if (command === "ls") {
      // `ls -ln <path>`: one long line for a file.
      const path = real(parts[parts.length - 1] ?? ".");
      const stats = statSync(path);
      const mode = `-rw${(stats.mode & 0o400) !== 0 ? "r" : "-"}-------`;
      process.stdout.write(
        `${mode}    1 fake     fake ${String(stats.size).padStart(10)} Nov  3 00:00 ${parts[parts.length - 1]}\n`,
      );
    } else if (command === "get") {
      copyFileSync(real(parts[1] ?? ""), parts[2] ?? "");
    } else if (command === "put") {
      copyFileSync(parts[1] ?? "", real(parts[2] ?? ""));
    } else if (command === "rename") {
      renameSync(real(parts[1] ?? ""), real(parts[2] ?? ""));
    } else if (command === "rm") {
      rmSync(real(parts[1] ?? ""), { force: true });
    } else {
      throw new Error(`unsupported command ${command}`);
    }
  } catch (error) {
    failed = `${line}: ${error instanceof Error ? error.message : String(error)}`;
    if (!tolerant) break;
  }
}

if (failed !== "") {
  process.stderr.write(`sftp: ${failed}\n`);
  process.exit(255);
}
process.exit(0);
