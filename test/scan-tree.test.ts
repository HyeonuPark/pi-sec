/**
 * `scripts/scan-tree.mjs`: one run over a tree, and what it must and must not
 * find.
 *
 * The scan blocks known values and two shapes (a generated id and a real-looking
 * address), so every value that has to be a finding is either a fake written into
 * a temporary tree, built when the test runs, or a value the run reads from the
 * machine it runs on. The fake secret value and the fake word are built here from
 * pieces, and the shape inputs come from test/made-up-values.ts, so this file is
 * not itself a finding for the same scan. Nothing here is a credential.
 *
 * The script is run as a child process with an environment built from nothing
 * but this test's own directory as `HOME`, its own `PATH` and `TERM`. Nothing
 * from `process.env` is spread in, so a run cannot inherit the home of a
 * running daemon. `HOME` is this test's
 * directory, so the home check of a run looks for that directory, and the host
 * check looks for the host name of the machine this test runs on.
 */
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePersonality } from "../src/extensions/personality-file.ts";
import { MUST_PASS, madeUpAddress, mustFail } from "./made-up-values.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(REPO, "scripts", "scan-tree.mjs");

/** The host name of this machine, and whether it is a value the scan looks for. */
const MACHINE_HOST = hostname().trim();
const HOST_IS_A_VALUE = MACHINE_HOST.toLowerCase() !== "localhost" && MACHINE_HOST.length >= 4;

/** The word a word list carries, and the value a secrets directory holds. */
const LOCAL_WORD = "localname";
const SECRET_VALUE = ["s3cr3t", "alpha", "value"].join("-");
const SECRET_FILE = "alpha.key";

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-sec-scan-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Run the scan over `where`.
 *
 * The environment has no `PI_SEC_HOME`, no `HOME` outside this test's directory,
 * and nothing else a running daemon could have exported. `env`
 * overrides single values, such as a `HOME` for the skip cases.
 */
function run(args: readonly string[], where: string, env: Record<string, string> = {}): Run {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: where,
    env: { HOME: root, PATH: process.env["PATH"] ?? "", TERM: "dumb", ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Write a tree under this test's directory and return its path. */
async function tree(files: Record<string, string | Buffer>, name = "tree"): Promise<string> {
  const base = join(root, name);
  for (const [path, content] of Object.entries(files)) {
    const full = join(base, path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return base;
}

/**
 * Write a file that is not part of the scanned tree.
 *
 * A word list and an exception file live outside the tree in the real runs, and
 * they have to here too: a word list inside the tree holds the word it lists,
 * and the scan would report the list.
 */
async function outside(name: string, content: string): Promise<string> {
  const full = join(root, "lists", name);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, "utf8");
  return full;
}

/** A fake secrets directory, named so that it is neither the tree nor `HOME`. */
async function secretsDir(name: string, value: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, SECRET_FILE), `${value}\n`);
  return dir;
}

/** The finding lines of a run, without the printed line text under each. */
function findings(run_: Run): string[] {
  return run_.stdout
    .split("\n")
    .filter((line) => /^[^ ].*:\d+: /.test(line));
}

describe("scan-tree: shape rules", () => {
  it("reports a made-up id and a made-up address, and passes the must-pass inputs", async () => {
    const failing = await tree({ "fail.txt": mustFail().join("\n") }, "fail-tree");
    const result = run([], failing);
    expect(findings(result)).toEqual([
      "fail.txt:1: shape ulid",
      "fail.txt:2: shape ulid",
      "fail.txt:3: shape ulid",
      "fail.txt:4: shape email",
    ]);
    expect(result.code).toBe(1);

    const passing = await tree({ "pass.txt": MUST_PASS.join("\n") }, "pass-tree");
    const clean = run([], passing);
    expect(findings(clean)).toEqual([]);
    expect(clean.code).toBe(0);
  });

  it("passes the reserved example domains and reports the same address on another domain", async () => {
    const reserved = ["example.com", "example.net", "example.org", "mail.example", "mail.invalid", "mail.test", "mail.localhost"];
    const where = await tree({ "mail.txt": reserved.map((domain) => `a@${domain}`).join("\n") });
    expect(findings(run([], where))).toEqual([]);
    const other = await tree({ "mail.txt": madeUpAddress() }, "other");
    expect(findings(run([], other))).toEqual(["mail.txt:1: shape email"]);
  });

  it("does not print the id or the address in the finding line, and a word list still names an address", async () => {
    const address = madeUpAddress();
    const where = await tree({ "mail.txt": `real = ${address}` });
    const words = await outside("words.txt", address);
    const listed = run(["--no-shapes", "--words", words], where);
    expect(findings(listed)).toEqual([`mail.txt:1: word ${address}`]);
  });

  it("turns both rules off with --no-shapes", async () => {
    const where = await tree({ "fail.txt": mustFail().join("\n") });
    const result = run(["--no-shapes"], where);
    expect(findings(result)).toEqual([]);
    expect(result.code).toBe(0);
  });
});

describe("scan-tree: install values", () => {
  const NAME = "Zebraquartz";
  const HANGUL = "테봇";

  /** An install home with a made-up personality file, and the environment that names it. */
  async function install(personality: string | undefined, config?: Record<string, unknown>): Promise<Record<string, string>> {
    const home = join(root, "install-home");
    await mkdir(join(home, "memory"), { recursive: true });
    if (personality !== undefined) await writeFile(join(home, "memory", "personality.md"), personality);
    if (config !== undefined) await writeFile(join(home, "config.json"), JSON.stringify(config));
    return { PI_SEC_HOME: home };
  }
  const front = (name: string, extra = "language: en\n") => `---\n${extra}name: ${name}\n---\nBody text.\n`;
  const scan = async (text: string, env: Record<string, string>, args: readonly string[] = []): Promise<string[]> =>
    findings(run([...args], await tree({ "notes.txt": text }), env));

  it("finds a made-up name in the default personality file, in either letter case", async () => {
    const env = await install(front(NAME));
    expect(await scan(`The assistant is ${NAME}.`, env)).toEqual(["notes.txt:1: install name personality-name"]);
    expect(await scan(`the assistant is ${NAME.toLowerCase()}.`, env)).toEqual(["notes.txt:1: install name personality-name"]);
    expect(await scan("nothing here", env)).toEqual([]);
  });

  it("never prints the name in a finding line", async () => {
    const env = await install(front(NAME));
    const result = run([], await tree({ "notes.txt": `x ${NAME}` }), env);
    expect(result.stdout).toContain("notes.txt:1: install name personality-name");
    expect(result.stderr).not.toContain(NAME);
    expect(result.stdout.split("\n").filter((line) => /^[^ ].*:\d+: /.test(line)).join("\n")).not.toContain(NAME);
  });

  it("finds a made-up two-syllable Hangul name", async () => {
    const env = await install(front(HANGUL, "language: ko\n"));
    expect(await scan(`이름은 ${HANGUL} 입니다`, env)).toEqual(["notes.txt:1: install name personality-name"]);
  });

  it("finds a name in a file that an absolute personality.file of config.json names", async () => {
    const elsewhere = join(root, "elsewhere.md");
    await writeFile(elsewhere, front(NAME));
    const env = await install(undefined, { personality: { file: elsewhere } });
    expect(await scan(`x ${NAME}`, env)).toEqual(["notes.txt:1: install name personality-name"]);
  });

  it("finds a name in a file that a relative personality.file names, under the install home", async () => {
    const env = await install(undefined, { personality: { file: "memory/other.md" } });
    await writeFile(join(env["PI_SEC_HOME"] as string, "memory", "other.md"), front(NAME));
    expect(await scan(`x ${NAME}`, env)).toEqual(["notes.txt:1: install name personality-name"]);
  });

  it("skips a three-letter name, a name that a ! line turns off, a file with no front matter, and an unknown four-line block", async () => {
    expect(await scan("x Abc", await install(front("Abc")))).toEqual([]);
    const words = await outside("skip.txt", `# skip\n!${NAME.toUpperCase()}\n`);
    expect(await scan(`x ${NAME}`, await install(front(NAME)), ["--words", words])).toEqual([]);
    expect(await scan(`x ${NAME}`, await install(`${NAME} is the assistant.\n`))).toEqual([]);
    expect(await scan(`x ${NAME}`, await install(`---\ncolor: red\nname: ${NAME}\n---\nBody.\n`))).toEqual([]);
    expect(await scan(`x ${NAME}`, { PI_SEC_HOME: join(root, "no-such-home") })).toEqual([]);
  });

  it("agrees with parsePersonality on which files name someone", async () => {
    const files = [
      front(NAME),
      front(NAME, ""),
      `---\nname: ${NAME}\nlanguage: ko\n---\nBody.\n`,
      `---\nname: ${NAME}\n---\nBody.\n`,
      `---\nlanguage: en\n---\nBody.\n`,
      `---\nlanguage: en\nlanguage: ko\n---\nBody.\n`,
      `---\nname: ${NAME}\nname: ${NAME}x\n---\nBody.\n`,
      `---\ncolor: red\nname: ${NAME}\n---\nBody.\n`,
      `---\ncolor: red\n---\nBody.\n`,
      `---\nname:\n---\nBody.\n`,
      `---\nlanguage: en\nname: ${NAME}\n---\n\n`,
      `${NAME} is the assistant.\n`,
    ];
    for (const [index, file] of files.entries()) {
      const env = await install(file);
      const parsed = parsePersonality(file)?.name;
      const found = (await scan(`x ${NAME} y ${NAME}x`, env)).length > 0;
      expect(found, `file ${index}`).toBe(parsed !== undefined && (parsed === NAME || parsed === `${NAME}x`));
    }
  });

  const ACCOUNT = userInfo().username;
  const COMMON = new Set(["root", "admin", "administrator", "user", "guest", "test", "tester", "operator", "daemon", "nobody", "www-data", "git", "ubuntu", "debian", "fedora", "centos", "alpine", "ec2-user", "azureuser", "opc", "runner", "node", "docker", "vagrant", "jenkins", "codespace", "gitpod", "coder", "vscode", "build", "dev", "developer", "pi", "pi-sec"]);
  // eslint-disable-next-line no-control-regex
  const ACCOUNT_IS_A_VALUE = (/^[\x00-\x7f]*$/.test(ACCOUNT) ? ACCOUNT.length >= 4 : [...ACCOUNT].length >= 2) && !COMMON.has(ACCOUNT.toLowerCase());

  it.skipIf(!ACCOUNT_IS_A_VALUE)("finds the account name of the machine that runs the test", async () => {
    const env = await install(undefined);
    expect(await scan(`owner = ${ACCOUNT}`, env)).toEqual(["notes.txt:1: install account account-name"]);
    const skip = await outside("skip-account.txt", `!${ACCOUNT.toUpperCase()}\n`);
    expect(await scan(`owner = ${ACCOUNT}`, env, ["--words", skip])).toEqual([]);
  });

  it("turns the install values off with --no-machine-values", async () => {
    const env = await install(front(NAME));
    expect(await scan(`x ${NAME} ${ACCOUNT}`, env, ["--no-machine-values"])).toEqual([]);
  });
});

describe("scan-tree: the input set", () => {
  it("walks a directory that is not a git work tree and skips binaries, node_modules and dist", async () => {
    const where = await tree({
      "plain.txt": `name = ${LOCAL_WORD}`,
      "node_modules/dependency/index.js": `name = ${LOCAL_WORD}`,
      "dist/cli.js": `name = ${LOCAL_WORD}`,
      "binary.bin": Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(LOCAL_WORD, "utf8")]),
    });
    const words = await outside("words.txt", LOCAL_WORD);

    const result = run(["--words", words], where);

    expect(findings(result)).toEqual(["plain.txt:1: word localname"]);
    expect(result.stderr).toContain("skipped 1 binary file(s)");
    expect(result.stdout).toContain("scan: 1 files, 1 findings");
  });
});

describe("scan-tree: unreadable input", () => {
  it("fails with exit 2 when a tracked file cannot be read", async () => {
    const where = await tree({ "kept.txt": "fine", "gone.txt": `name = ${LOCAL_WORD}` });
    const words = await outside("words.txt", LOCAL_WORD);
    const git = (...args: string[]) => spawnSync("git", ["-C", where, ...args], { encoding: "utf8" });
    expect(git("init", "-q").status).toBe(0);
    expect(git("add", "kept.txt", "gone.txt").status).toBe(0);
    await rm(join(where, "gone.txt"));

    const result = run(["--words", words], where);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("gone.txt");
    expect(result.stderr).not.toContain("binary");
  });
});

describe("scan-tree: the two option files", () => {
  it("matches a word only where no ASCII letter touches it, in either case", async () => {
    const where = await tree({
      "text.txt": [
        `one = ${LOCAL_WORD}`,
        `two = ${LOCAL_WORD.toUpperCase()}`,
        `three = my${LOCAL_WORD}`,
        `four = ${LOCAL_WORD}s`,
        `five = a second-word here`,
      ].join("\n"),
    });
    const words = await outside("words.txt", ["# a comment", "", LOCAL_WORD, "second-word"].join("\n"));

    const result = run(["--words", words], where);

    expect(findings(result)).toEqual([
      "text.txt:1: word localname",
      "text.txt:2: word localname",
      "text.txt:5: word second-word",
    ]);
  });

  it("skips a finding whose path and line the exception file names", async () => {
    const where = await tree({
      "skip.txt": `one = ${LOCAL_WORD}`,
      "keep.txt": `one = ${LOCAL_WORD}`,
    });
    const words = await outside("words.txt", LOCAL_WORD);
    const allow = await outside("allow.txt", ["skip.txt", `^one = ${LOCAL_WORD}$`].join("\t"));

    const result = run(["--words", words, "--allow", allow], where);

    // The exception covers one file and one line shape; the other file still
    // reports the same word.
    expect(result.code).toBe(1);
    expect(findings(result)).toEqual(["keep.txt:1: word localname"]);
  });
});

describe("scan-tree: allow entries and secret values", () => {
  it("never lets an allow entry remove a secret-value finding", async () => {
    const secrets = await secretsDir("allow-secrets", SECRET_VALUE);
    const words = await outside("words.txt", LOCAL_WORD);
    const where = await tree({ "mixed.txt": `one = ${LOCAL_WORD} and ${SECRET_VALUE}` });
    const allow = await outside("allow.txt", ["mixed.txt", `^one = `].join("\t"));

    const result = run(["--secrets-dir", secrets, "--words", words, "--allow", allow], where);

    expect(result.code).toBe(1);
    expect(findings(result)).toEqual([`mixed.txt:1: secret-value ${SECRET_FILE}`]);
  });
});

describe("scan-tree: a secrets directory", () => {
  it("reports the location and the secret file name, and never the value", async () => {
    const secrets = await secretsDir("given-secrets", SECRET_VALUE);
    await writeFile(join(secrets, "tiny.key"), "short\n");
    const where = await tree({
      "inside.txt": ["a line", `value = ${SECRET_VALUE}`, "another line", `again = ${SECRET_VALUE}`].join("\n"),
    });

    const result = run(["--secrets-dir", secrets], where);

    // One finding per place the value appears, and no second line under either.
    expect(findings(result)).toEqual([
      `inside.txt:2: secret-value ${SECRET_FILE}`,
      `inside.txt:4: secret-value ${SECRET_FILE}`,
    ]);
    expect(result.stdout).not.toContain(SECRET_VALUE);
    expect(result.stderr).not.toContain(SECRET_VALUE);
    // The line that holds the value is not printed either, because the value is
    // what identifies the finding.
    expect(result.stdout).not.toContain(`inside.txt:2: secret-value ${SECRET_FILE}\n    `);
    expect(result.stderr).toContain("shorter than 8");
  });

  it("reads the env file line by line, like the daemon registry", async () => {
    const envValue = ["env", "value", "one", "xyz"].join("-");
    const quoted = ["env", "quoted", "two", "xyz"].join("-");
    const malformed = ["malformed", "line", "text", "xyz"].join("-");
    const dir = join(root, "env-secrets");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "env"),
      [`FIRST_KEY=${envValue}`, "# a comment", `SECOND_KEY="${quoted}"`, malformed, ""].join("\n"),
    );
    const where = await tree({
      "inside.txt": ["a line", `${envValue}`, `x = ${quoted}`, "last"].join("\n"),
    });

    const result = run(["--secrets-dir", dir], where);

    expect(findings(result)).toEqual([
      "inside.txt:2: secret-value env:FIRST_KEY",
      "inside.txt:3: secret-value env:SECOND_KEY",
    ]);
    for (const text of [envValue, quoted, malformed]) {
      expect(result.stdout).not.toContain(text);
      expect(result.stderr).not.toContain(text);
    }
    expect(result.stderr).toContain("skipped 1 malformed line(s) of env");
  });

  it.skipIf(process.getuid?.() === 0)("fails with exit 2 on a secret file it cannot read", async () => {
    const secrets = await secretsDir("locked-secrets", SECRET_VALUE);
    await chmod(join(secrets, SECRET_FILE), 0o000);
    const where = await tree({ "inside.txt": "nothing here" });

    const result = run(["--secrets-dir", secrets], where);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain(SECRET_FILE);
    expect(result.stderr).not.toContain(SECRET_VALUE);
  });

  it("reads the secrets directory of the install when no option is given", async () => {
    const piHome = join(root, "pi-sec-home");
    const install = await secretsDir(join("pi-sec-home", "secrets"), SECRET_VALUE);
    expect(install).toBe(join(piHome, "secrets"));
    const where = await tree({ "inside.txt": `value = ${SECRET_VALUE}` });

    // `$PI_SEC_HOME/secrets` is the first place the scan looks.
    const fromPiHome = run([], where, { PI_SEC_HOME: piHome });
    expect(findings(fromPiHome)).toEqual([`inside.txt:1: secret-value ${SECRET_FILE}`]);
    expect(fromPiHome.stdout).not.toContain(SECRET_VALUE);

    // Without `PI_SEC_HOME`, `~/.pi/sec/secrets` is read instead.
    await secretsDir(join(".pi", "sec", "secrets"), SECRET_VALUE);
    const fromHome = run([], where);
    expect(findings(fromHome)).toEqual([`inside.txt:1: secret-value ${SECRET_FILE}`]);

    // A machine without that directory skips the check instead of refusing.
    const missing = run([], where, { PI_SEC_HOME: join(root, "no-install") });
    expect(findings(missing)).toEqual([]);
    expect(missing.code).toBe(0);
  });

  it("replaces a registered secret value in a printed line with a fixed marker", async () => {
    const secrets = await secretsDir("mask-secrets", SECRET_VALUE);
    const words = await outside("words.txt", LOCAL_WORD);
    const where = await tree({ "mixed.txt": `one = ${LOCAL_WORD} and ${SECRET_VALUE}` });

    const result = run(["--secrets-dir", secrets, "--words", words], where);

    expect(findings(result)).toEqual([
      "mixed.txt:1: word localname",
      `mixed.txt:1: secret-value ${SECRET_FILE}`,
    ]);
    // The word finding prints its line, and that line holds the secret value
    // beside the word; the value is taken out of it.
    expect(result.stdout).toContain("[redacted]");
    expect(result.stdout).not.toContain(SECRET_VALUE);
  });
});

describe("scan-tree: machine values", () => {
  it("reports the home path of this machine", async () => {
    // `HOME` is this test's directory, so a path under it is the machine's home
    // path, and `~`-style text is not.
    const where = await tree({
      "paths.txt": [`notes = ${root}/job/notes`, `tilde = ${["~", "job", "notes"].join("/")}`].join("\n"),
    });

    const result = run([], where);

    expect(findings(result)).toEqual(["paths.txt:1: machine home home-directory"]);
    expect(result.stdout).toContain(`notes = ${root}/job/notes`);
    expect(result.code).toBe(1);
  });

  it("skips the home check when the home directory is empty or the root", async () => {
    const where = await tree({ "paths.txt": `notes = ${root}/job/notes` });

    // The same tree is a finding against this test's home, and no finding
    // against no home at all.
    expect(findings(run([], where, { HOME: root }))).toEqual(["paths.txt:1: machine home home-directory"]);
    expect(findings(run([], where, { HOME: "" }))).toEqual([]);
    expect(findings(run([], where, { HOME: "/" }))).toEqual([]);
  });

  it.skipIf(!HOST_IS_A_VALUE)("reports the host name of this machine", async () => {
    const where = await tree({ "host.txt": `host = ${MACHINE_HOST}` });

    const result = run([], where);

    expect(findings(result)).toEqual(["host.txt:1: machine host hostname"]);
  });

  // The two tests around this one cover both branches of the host check, and a
  // run shows the branch that its machine takes.
  it.skipIf(HOST_IS_A_VALUE)("skips the host check when the name is localhost or very short", async () => {
    const where = await tree({ "host.txt": `host = ${MACHINE_HOST}` });

    const result = run([], where);

    expect(findings(result)).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("turns off the default secrets directory, the home check and the host check", async () => {
    // The install's secrets directory, where a run without the option looks.
    await secretsDir(join(".pi", "sec", "secrets"), SECRET_VALUE);
    const where = await tree({
      "values.txt": [`secret = ${SECRET_VALUE}`, `home = ${root}/job/notes`, `host = ${MACHINE_HOST}`].join("\n"),
    });

    const withMachine = findings(run([], where));
    expect(withMachine).toContain(`values.txt:1: secret-value ${SECRET_FILE}`);
    expect(withMachine).toContain("values.txt:2: machine home home-directory");
    expect(withMachine.filter((line) => line.includes("machine host"))).toHaveLength(HOST_IS_A_VALUE ? 1 : 0);

    // The same tree, read for nothing but its own files.
    const result = run(["--no-machine-values"], where);

    expect(findings(result)).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/scan: \d+ files, 0 findings/);
  });
});

describe("scan-tree: this repository", () => {
  it("finds nothing in the tree when the machine values are off", () => {
    const result = run(["--root", REPO, "--no-machine-values"], REPO);
    // The shape rules stay on, so a real-looking id or address in the tree fails here.

    // The scan reads the tracked files when the root is a git work tree and
    // walks it otherwise, so this passes in a checkout and in a `git archive`
    // copy of the same files. The machine values are off, so the result does
    // not depend on the home and the host name of the machine that runs the
    // test, and a checkout of this repository reports the same on any machine.
    expect(findings(result)).toEqual([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/scan: \d+ files, 0 findings/);
  });
});
