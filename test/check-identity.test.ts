/**
 * `scripts/check-identity.mjs`: exit 0 when every identity is listed, 1 when one
 * is not, 2 for a usage error. It never prints an identity that is not listed.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LISTED_IDENTITY, UNLISTED_IDENTITY } from "./made-up-values.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/check-identity.mjs", import.meta.url));

let root = "";
let list = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-sec-identity-"));
  list = join(root, "identities.txt");
  await writeFile(list, `# a comment\n\n${LISTED_IDENTITY}\n  pi-sec <pi-sec@localhost>  \n`);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function check(args: readonly string[]): { code: number | null; text: string } {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  return { code: result.status, text: `${result.stdout}${result.stderr}` };
}

describe("check-identity", () => {
  it("accepts listed identities, comments and blank lines aside", () => {
    expect(check(["--identities", list, LISTED_IDENTITY]).code).toBe(0);
    expect(check(["--identities", list, LISTED_IDENTITY, "pi-sec <pi-sec@localhost>"]).code).toBe(0);
  });

  it("refuses an identity that is not listed, and does not print it", () => {
    const out = check(["--identities", list, LISTED_IDENTITY, UNLISTED_IDENTITY]);
    expect(out.code).toBe(1);
    expect(out.text).not.toContain("zebra");
  });

  it("compares the whole line, not a part of it", () => {
    expect(check(["--identities", list, "test"]).code).toBe(1);
    expect(check(["--identities", list, "test <test@example.com> x"]).code).toBe(1);
  });

  it("exits 2 for a missing file, a missing option, and an unknown option", () => {
    expect(check(["--identities", join(root, "missing.txt"), LISTED_IDENTITY]).code).toBe(2);
    expect(check([LISTED_IDENTITY]).code).toBe(2);
    expect(check(["--identities", list]).code).toBe(2);
    expect(check(["--other", list, LISTED_IDENTITY]).code).toBe(2);
  });
});
