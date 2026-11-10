// Find known values and two shapes in a tree.
//
//   node scripts/scan-tree.mjs                       # the tree in the cwd
//   node scripts/scan-tree.mjs --root <dir>
//   node scripts/scan-tree.mjs --words <file> --allow <file>
//   node scripts/scan-tree.mjs --secrets-dir <dir>
//   node scripts/scan-tree.mjs --no-machine-values
//   node scripts/scan-tree.mjs --no-shapes
//
// The scan reports known values and two shapes. The known values come from four
// places: the secrets directory of a pi-sec install, the home path and the host
// name of the machine the scan runs on, the personality name and the account
// name of the install the scan runs in, and a word list given on the command
// line. The two shapes are a generated id (a ULID) and an e-mail address. Both
// identify an installation or a person, so a commit must not carry either. An
// exception file removes a finding in one named place. This file names no
// particular install and no particular person.
//
// Input set. When the root is a git work tree, the scan reads the tracked files
// (`git ls-files`). Otherwise, such as a `git archive` copy, it walks the root
// and reads every regular file. `node_modules/`, `dist/` and `.git/` are never
// read, and a file with a NUL byte in its first 8000 bytes is skipped as binary.
//
// `--words <file>`: one entry per line. Blank lines and lines starting with `#`
// are ignored. Each entry is a literal string, matched case-insensitively, and
// only where no ASCII letter comes directly before or after it. A line that
// starts with `!` is not a word. It names one install value (see below) that the
// scan does not search for, compared without case.
//
// An exception never removes a `secret-value` finding. It applies to words,
// machine values, install values and shapes only, because a hidden secret value
// is a leak.
//
// `--allow <file>`: one exception per line, as `<path or path glob>` TAB
// `<JavaScript regex>`. Blank lines and lines starting with `#` are ignored. In
// the first field `*` matches any run of characters except `/`, and `**`
// matches any run of characters. A finding is skipped when its path matches the
// first field and its line matches the second, unless the finding is a
// `secret-value`. The repository's own
// `scripts/scan-allow.txt` is always applied; this option adds files to it.
//
// `--secrets-dir <dir>`: every regular file in the directory holds one secret
// value, except the file named `env`. The daemon registry reads `env` line by
// line (`KEY=value`), and so does this script, with the same parser
// (`src/secrets/env-file.ts`). A finding for a value of `env` names it
// `env:<KEY>`. A malformed line of `env` is counted and never printed. A secret
// file this script cannot read is a usage error. Each value is searched for in the tree, and a hit prints the secret
// file's name and the location, never the value and never the matching line.
// Values shorter than 8 characters are skipped, because they would match
// everywhere. Without this option the scan reads the secrets directory of the
// install: `$PI_SEC_HOME/secrets`, or `~/.pi/sec/secrets` when `PI_SEC_HOME` is
// empty. A machine without that directory skips the check.
//
// Machine values. The home directory named by `HOME` and the host name of the
// machine are findings of their own, printed as `machine home` and
// `machine host`. The home check is skipped when `HOME` is empty or `/`, and
// the host check is skipped when the host name is `localhost` or shorter than 4
// characters.
//
// Install values. The personality name and the account name of the install are
// findings of their own, printed as `install name personality-name` and
// `install account account-name`, never with the value. The name is the `name:`
// of the front matter of the personality file: `personality.file` of
// `$PI_SEC_HOME/config.json` (default `memory/personality.md`, a relative path
// is under the install home). The account is `os.userInfo().username`. A missing
// file or account gives no value. A value is skipped when it is only ASCII and
// shorter than 4 characters, or has another character and is shorter than 2, when
// it is a common account name (accounts only), or when the word list names it
// with a `!` line.
//
// Shapes. `shape ulid` is a token of 26 characters (first 0 to 7, then Crockford
// base32, either case) with no letter or digit next to it, unless it holds a run
// of 6 equal characters (a synthetic id). `shape email` is a local part, an at
// sign, and a dotted domain, unless the domain is example.com, example.net, example.org, or ends in
// `.example`, `.invalid`, `.test` or `.localhost`.
//
// `--no-machine-values`: turn off the secrets directory of the install, the
// home check, the host check and the install values, so that a run reads
// nothing but the tree and the lists it is given. A test uses it, and so does a
// run on another machine.
//
// `--no-shapes`: turn off the two shape rules, for a tree that is not pi-sec.
//
// Output: one finding per line as `path:line: <kind> <rule or word>`, and under
// it the matched line, cut to 200 characters, with every registered secret
// value replaced by `[redacted]`. A secrets-dir finding has no second line,
// because the value is what identifies the finding. The exit code is 1 when
// there is a finding and 0 when there is none; a usage error, such as a file
// this script cannot read, exits 2.

import { execFileSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile } from "../src/secrets/env-file.ts";

const here = dirname(fileURLToPath(import.meta.url));
/** The repository's own exceptions, applied to every run. */
const REPO_ALLOW = join(here, "scan-allow.txt");
/** Directories a scan never reads, wherever they sit under the root. */
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
/** A NUL byte in the first bytes of a file makes it binary. */
const BINARY_PROBE_BYTES = 8000;
/** How much of a matched line is printed. */
const MAX_LINE_PRINTED = 200;
/** A shorter secret value matches too much of the tree to say anything. */
const MIN_SECRET_LENGTH = 8;
/** A shorter host name is a stand-in, and it would match too much. */
const MIN_HOST_LENGTH = 4;
/** An install value of one ASCII character class shorter than this says nothing. */
const MIN_ASCII_VALUE_LENGTH = 4;
/** An install value with another character is skipped below this length. */
const MIN_OTHER_VALUE_LENGTH = 2;
/** Account names that name no person and no install, compared in lower case. */
const COMMON_ACCOUNTS = new Set([
  "root", "admin", "administrator", "user", "guest", "test", "tester", "operator", "daemon",
  "nobody", "www-data", "git", "ubuntu", "debian", "fedora", "centos", "alpine", "ec2-user",
  "azureuser", "opc", "runner", "node", "docker", "vagrant", "jenkins", "codespace", "gitpod",
  "coder", "vscode", "build", "dev", "developer", "pi", "pi-sec",
]);
/** The personality file of an install that names no other one. */
const DEFAULT_PERSONALITY_FILE = "memory/personality.md";
/** A generated id: 26 characters, first 0 to 7, Crockford base32, alone, no run of 6. */
const ULID_PATTERN =
  /(?<![0-9A-Za-z])(?![0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]*(.)\1{5})[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25}(?![0-9A-Za-z])/;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
/** What a printed line shows in place of a registered secret value. */
const SECRET_MASK = "[redacted]";

const USAGE = `usage: node scripts/scan-tree.mjs [--root <dir>] [--words <file>] [--allow <file>]... [--secrets-dir <dir>] [--no-machine-values] [--no-shapes]`;

/** A short reason to stop, for the caller's message and the exit code. */
class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    root: process.cwd(),
    words: undefined,
    allows: [],
    secretsDir: undefined,
    noMachineValues: false,
    noShapes: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--no-machine-values": {
        options.noMachineValues = true;
        break;
      }
      case "--no-shapes": {
        options.noShapes = true;
        break;
      }
      case "--root":
      case "--words":
      case "--allow":
      case "--secrets-dir": {
        if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
        index += 1;
        if (flag === "--root") options.root = resolve(value);
        else if (flag === "--words") options.words = resolve(value);
        else if (flag === "--allow") options.allows.push(resolve(value));
        else options.secretsDir = resolve(value);
        break;
      }
      default:
        throw new UsageError(`unknown argument: ${flag}`);
    }
  }
  return options;
}

/** Escape a string so it is literal inside a regular expression. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A literal value as a pattern: only where no ASCII letter touches it. */
function literalPattern(value, ignoreCase) {
  return new RegExp(`(?<![A-Za-z])${escapeRegExp(value)}(?![A-Za-z])`, ignoreCase ? "i" : "");
}

/**
 * The home path and the host name of this machine, as values to look for.
 *
 * A home of `/` or an empty `HOME` is no value at all, and neither is a host
 * name of `localhost` or a name short enough to appear in ordinary text.
 */
function machineValues() {
  const values = [];
  const home = (process.env["HOME"] ?? "").replace(/\/+$/, "");
  if (home !== "") {
    values.push({ kind: "machine home", rule: "home-directory", pattern: literalPattern(home, false) });
  }
  const host = hostname().trim();
  if (host.toLowerCase() !== "localhost" && host.length >= MIN_HOST_LENGTH) {
    values.push({ kind: "machine host", rule: "hostname", pattern: literalPattern(host, true) });
  }
  return values;
}

/** Whether a value is long enough to say something about an install. */
function longEnough(value) {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(value)) return value.length >= MIN_ASCII_VALUE_LENGTH;
  return [...value].length >= MIN_OTHER_VALUE_LENGTH;
}

/** The install home: `PI_SEC_HOME`, or `~/.pi/sec`, or `undefined` without a home. */
function installHome() {
  const piHome = process.env["PI_SEC_HOME"];
  if (piHome !== undefined && piHome !== "") return piHome;
  const home = process.env["HOME"];
  if (home === undefined || home === "") return undefined;
  return join(home, ".pi", "sec");
}

/**
 * The name in the front matter of a personality file, or `""`. This copies the
 * few lines of `frontMatterOf` in src/extensions/personality-file.ts, because a
 * plain Node script cannot import that module. A test keeps the two equal.
 */
function personalityNameOf(raw) {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") return "";
  const end = lines[2]?.trim() === "---" ? 3 : lines[3]?.trim() === "---" ? 4 : 0;
  if (end === 0) return "";
  let languageSeen = false;
  let name = "";
  let nameSeen = false;
  for (const line of lines.slice(1, end - 1)) {
    const text = line.trim();
    if (/^language:\s*(\S+)\s*$/.test(text) && !languageSeen) {
      languageSeen = true;
      continue;
    }
    const nameMatch = /^name:\s*(.*)$/.exec(text);
    if (nameMatch !== null && !nameSeen) {
      name = (nameMatch[1] ?? "").trim();
      nameSeen = true;
      continue;
    }
    // A three-line block with another middle line names nothing. A four-line
    // block with one makes the whole file the body.
    return "";
  }
  // A document with no body is no personality.
  if (lines.slice(end).join("\n").trim() === "") return "";
  return name;
}

/** The personality file path of the install, by `personalityPath` of src/extensions/personality-file.ts. */
async function personalityFile(piHome) {
  let configured = "";
  try {
    const text = (await readFile(join(piHome, "config.json"), "utf8")).replace(/^\uFEFF/, "");
    const value = JSON.parse(text)?.personality?.file;
    if (typeof value === "string") configured = value;
  } catch {
    // A missing or unreadable configuration means the default file.
  }
  const file = configured === "" ? DEFAULT_PERSONALITY_FILE : configured;
  return file.startsWith("/") ? file : join(piHome, file);
}

/**
 * The personality name and the account name of the install the scan runs in.
 * `skip` holds the values (lower case) that the word list turned off.
 */
async function installValues(skip) {
  const values = [];
  const piHome = installHome();
  if (piHome !== undefined) {
    const raw = await readFile(await personalityFile(piHome), "utf8").catch(() => undefined);
    const name = raw === undefined ? "" : personalityNameOf(raw);
    if (name !== "" && longEnough(name) && !skip.has(name.toLowerCase())) {
      values.push({ kind: "install name", rule: "personality-name", pattern: literalPattern(name, true) });
    }
  }
  let account = "";
  try {
    account = userInfo().username ?? "";
  } catch {
    // No passwd entry for this user id: no account value.
  }
  if (
    account !== "" &&
    longEnough(account) &&
    !COMMON_ACCOUNTS.has(account.toLowerCase()) &&
    !skip.has(account.toLowerCase())
  ) {
    values.push({ kind: "install account", rule: "account-name", pattern: literalPattern(account, true) });
  }
  return values;
}

/** The shapes a line holds, as rule names. */
function shapeHits(line) {
  const hits = [];
  if (ULID_PATTERN.test(line)) hits.push("ulid");
  for (const found of line.matchAll(EMAIL_PATTERN)) {
    if (!isExampleDomain(found[1] ?? "")) {
      hits.push("email");
      break;
    }
  }
  return hits;
}

/** Whether a domain is reserved for examples. */
function isExampleDomain(domain) {
  const lower = domain.toLowerCase();
  if (["example.com", "example.net", "example.org"].includes(lower)) return true;
  return /\.(example|invalid|test|localhost)$/.test(lower);
}

/** The secrets directory of the install, or `undefined` when there is none. */
function installSecretsDir() {
  const piHome = process.env["PI_SEC_HOME"];
  if (piHome !== undefined && piHome !== "") return join(piHome, "secrets");
  const home = process.env["HOME"];
  if (home === undefined || home === "") return undefined;
  return join(home, ".pi", "sec", "secrets");
}

/** Whether a path is a directory, without throwing. */
async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** A path field of an exception: an exact path, or a glob with `*` and `**`. */
function pathMatcher(spec) {
  const wanted = spec.startsWith("./") ? spec.slice(2) : spec;
  if (!wanted.includes("*")) return (path) => path === wanted;
  let source = "";
  for (let index = 0; index < wanted.length; index += 1) {
    const character = wanted[index];
    if (character === "*") {
      if (wanted[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else {
      source += escapeRegExp(character);
    }
  }
  const pattern = new RegExp(`^${source}$`);
  return (path) => pattern.test(path);
}

/** Read one exception file. Missing and unreadable files are a usage error. */
async function readAllowFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`cannot read the exception file ${path}`);
  }
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) throw new UsageError(`${path}: expected <path> TAB <regex>, got: ${line}`);
    const pathField = line.slice(0, tab).trim();
    const pattern = line.slice(tab + 1).trim();
    entries.push({ source: pathField, matchesPath: pathMatcher(pathField), line: new RegExp(pattern) });
  }
  return entries;
}

/**
 * Read one word list. Missing and unreadable files are a usage error. A `!`
 * line is no word: it goes to `skip`, in lower case.
 */
async function readWordFile(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new UsageError(`cannot read the word file ${path}`);
  }
  const words = [];
  const skip = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("!")) {
      skip.add(line.slice(1).trim().toLowerCase());
      continue;
    }
    words.push({ word: line, pattern: literalPattern(line, true) });
  }
  return { words, skip };
}

/** The tracked files of a git work tree, or `undefined` when the root is not one. */
function trackedFiles(root) {
  try {
    const output = execFileSync("git", ["-C", root, "ls-files", "-z"], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.toString("utf8").split("\0").filter((path) => path !== "");
  } catch {
    return undefined;
  }
}

/** Every regular file under the root, as paths relative to it, sorted. */
async function walkedFiles(root) {
  const files = [];
  async function visit(directory, prefix) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      throw new UsageError(`cannot read the directory ${directory}`);
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(join(directory, entry.name), path);
      } else if (entry.isFile()) {
        files.push(path);
      }
    }
  }
  await visit(root, "");
  return files;
}

/** The files to read: the tracked ones in a work tree, the walked ones otherwise. */
async function inputFiles(root) {
  const tracked = trackedFiles(root);
  if (tracked === undefined) return walkedFiles(root);
  return tracked.filter((path) => !path.split("/").some((segment) => SKIP_DIRS.has(segment)));
}

/** One file's text, or `undefined` when it is binary. A file that cannot be read is a usage error. */
async function readText(path) {
  let buffer;
  try {
    buffer = await readFile(path);
  } catch {
    throw new UsageError(`cannot read the input file ${path}`);
  }
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES);
  if (probe.includes(0)) return undefined;
  return buffer.toString("utf8");
}

/** A line, cut for printing. */
function cut(text) {
  const trimmed = text.endsWith("\r") ? text.slice(0, -1) : text;
  return trimmed.length > MAX_LINE_PRINTED ? `${trimmed.slice(0, MAX_LINE_PRINTED)}...` : trimmed;
}

/** A line with every registered secret value replaced by the fixed marker. */
function maskSecrets(text, secrets) {
  let masked = text;
  for (const secret of secrets) masked = masked.split(secret.value).join(SECRET_MASK);
  return masked;
}

/** Every secret value in the directory, with the names of the files that hold them. */
async function readSecrets(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => {
    throw new UsageError(`cannot read the secrets directory ${directory}`);
  });
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const values = [];
  let short = 0;
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const raw = await readFile(join(directory, entry.name), "utf8").catch(() => {
      throw new UsageError(`cannot read the secret file ${entry.name}`);
    });
    // The daemon registry parses `env` line by line, so the scan does too.
    const found =
      entry.name === "env"
        ? parseEnvFile(raw, (message) => {
            if (message.startsWith("secrets env: ignoring malformed line")) malformed += 1;
          }).map((item) => ({ name: `env:${item.name}`, value: item.value }))
        : [{ name: entry.name, value: raw.replace(/\r?\n$/, "") }];
    for (const item of found) {
      if (item.value.length < MIN_SECRET_LENGTH) {
        short += 1;
        continue;
      }
      values.push(item);
    }
  }
  return { values, short, malformed };
}

async function main(argv) {
  const options = parseArgs(argv);
  const allow = await readAllowFile(REPO_ALLOW);
  for (const path of options.allows) allow.push(...(await readAllowFile(path)));
  const list = options.words === undefined ? { words: [], skip: new Set() } : await readWordFile(options.words);
  const words = list.words;
  const machine = options.noMachineValues ? [] : [...machineValues(), ...(await installValues(list.skip))];
  let secretsDir = options.secretsDir;
  if (secretsDir === undefined && !options.noMachineValues) {
    const install = installSecretsDir();
    // No pi-sec install means no secrets directory, and the check is skipped
    // rather than refused.
    if (install !== undefined && (await isDirectory(install))) secretsDir = install;
  }
  const secrets = secretsDir === undefined ? { values: [], short: 0, malformed: 0 } : await readSecrets(secretsDir);

  const paths = await inputFiles(options.root);
  let scanned = 0;
  let binary = 0;
  let findings = 0;

  const report = (path, line, kind, rule) => {
    findings += 1;
    process.stdout.write(`${path}:${line}: ${kind} ${rule}\n`);
  };
  /** The matched line under a finding, with every secret value taken out. */
  const printLine = (text) => {
    process.stdout.write(`    ${cut(maskSecrets(text, secrets.values))}\n`);
  };
  const allowed = (path, text) =>
    allow.some((entry) => entry.matchesPath(path) && entry.line.test(text));

  for (const path of paths) {
    const text = await readText(join(options.root, path));
    if (text === undefined) {
      binary += 1;
      continue;
    }
    scanned += 1;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const number = index + 1;
      if (allowed(path, line)) continue;
      for (const entry of words) {
        if (!entry.pattern.test(line)) continue;
        report(path, number, "word", entry.word);
        printLine(line);
      }
      for (const value of machine) {
        if (!value.pattern.test(line)) continue;
        report(path, number, value.kind, value.rule);
        printLine(line);
      }
      if (!options.noShapes) {
        for (const rule of shapeHits(line)) {
          report(path, number, "shape", rule);
          printLine(line);
        }
      }
    }
    // A secret value can span lines, so it is searched for over the whole text.
    // Every place it appears is reported once per line.
    for (const secret of secrets.values) {
      const seen = new Set();
      for (let at = text.indexOf(secret.value); at >= 0; at = text.indexOf(secret.value, at + 1)) {
        const number = text.slice(0, at).split("\n").length;
        if (seen.has(number)) continue;
        seen.add(number);
        report(path, number, "secret-value", secret.name);
      }
    }
  }

  if (binary > 0) process.stderr.write(`scan: skipped ${binary} binary file(s)\n`);
  if (secrets.short > 0) {
    process.stderr.write(`scan: skipped ${secrets.short} secret file(s) shorter than ${MIN_SECRET_LENGTH} characters\n`);
  }
  if (secrets.malformed > 0) process.stderr.write(`scan: skipped ${secrets.malformed} malformed line(s) of env\n`);
  process.stdout.write(`\nscan: ${scanned} files, ${findings} findings\n`);
  return findings === 0 ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`scan: ${error.message}\n${USAGE}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`scan: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
