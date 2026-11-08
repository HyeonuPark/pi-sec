import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config/schema.ts";
import { BUNDLED_EXTENSIONS } from "../src/extensions/index.ts";

/**
 * Which bundled extensions a fresh install gets, and in what order.
 *
 * The enabled list decides what is installed; the catalog order decides the
 * order of the sections in the prompt and of the request hooks. Both are read
 * here so a change to either is a decision a reviewer sees, not a side effect.
 *
 * The three checked here are the ones that used to be runtime extensions in the
 * instance's home. They sit after every older bundled extension, which keeps the
 * section order a running session already has: a runtime extension used to load
 * after all of them.
 *
 * Every name in the catalog has to be on one of two lists: the default enabled
 * list, or `OPERATOR_ENABLED` below. The last test holds that, so a new
 * extension cannot be added to the catalog without deciding whether a fresh
 * install runs it. Without the test the mistake is silent: the code is bundled
 * and the extension never loads, because the enabled list does not name it.
 */

/**
 * The bundled extensions a fresh install leaves off, each with the reason an
 * operator turns it on.
 *
 * The reason is part of the entry because it is the argument for leaving the
 * name out of the default list: a reviewer comparing the catalog with the
 * enabled list reads why the name is missing instead of guessing.
 */
const OPERATOR_ENABLED: Readonly<Record<string, string>> = {
  // Its only input is a registry file the operator keeps, so a fresh install has
  // nothing for the tool to read.
  "expiry-check": "opt-in: needs a JSON expiry registry file that a fresh install does not have",
  // One whole file in one call, past the 2000-line and 50KB cut `read` applies.
  // A fresh install has no large file a script must edit, and the uncut text
  // spends the context the cut protects.
  "read-full": "opt-in: returns a whole file in one call, past the size `read` accepts",
  // Its own web pages and its own settings key: an operator names the
  // repositories to show and decides whether the pages may write to GitHub, and
  // the loader refuses an enabled install that names no repositories. So the
  // extension cannot arrive with a page a fresh install has nothing to show on.
  "github-pr": "opt-in: needs `githubPr.repos`, at least one repository to show, and a restart to turn on",
  // The tools work on a machine an operator registered under `remoteMachines` and
  // pinned a host key for. A fresh install has neither, so its one prompt section
  // would describe a capability the install cannot use, and every tool would
  // refuse.
  "remote-machines": "opt-in: needs a machine under `remoteMachines` with a pinned host key, and a restart",
  // The tools need a personal API key that the user stores as a secret, and the
  // top-level `linear` key names that secret and decides whether the write tools exist.
  "linear": "opt-in: needs a Linear API key in a secret and the linear settings key, and a restart to turn on",
};

/** The names in `BUNDLED_EXTENSIONS`, in catalog order. */
function catalogNames(): string[] {
  return BUNDLED_EXTENSIONS.map((extension) => extension.name);
}

describe("bundled extension catalog", () => {
  it("names the three prompt extensions by default, and leaves read-full opt-in", () => {
    const enabled = defaultConfig().agent.extensions.enabled;

    expect(enabled).toContain("conventions");
    expect(enabled).toContain("message-tags");
    // `session-restart` is core: the conventions name its tools, so a fresh
    // install with the extension off cannot restart a session as they say.
    expect(enabled).toContain("session-restart");
    // `lessons` needs no secret and no service, and the README introduces it as
    // a feature, so a fresh install gets it.
    expect(enabled).toContain("lessons");
    // `read-full` and `expiry-check` are bundled extensions an operator turns on
    // by name: `expiry-check` needs a registry file that a fresh install has not.
    expect(enabled).not.toContain("read-full");
    expect(enabled).not.toContain("expiry-check");
    // `github-pr` serves pages for repositories an operator names, so a fresh
    // install, which names none, leaves it off.
    expect(enabled).not.toContain("github-pr");
  });

  it("lists them in the app phase, after every extension that came before them", () => {
    const names = catalogNames();
    const after = names.indexOf("session-restart");
    expect(after).toBeGreaterThanOrEqual(0);

    for (const name of ["conventions", "message-tags", "read-full"]) {
      const index = names.indexOf(name);
      expect(index).toBeGreaterThan(after);
      expect(BUNDLED_EXTENSIONS[index]?.phase).toBe("app");
    }
  });

  it("keeps those names in alphabetical order among themselves", () => {
    const names = catalogNames();
    const positions = ["conventions", "message-tags", "read-full"].map((name) => names.indexOf(name));

    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("decides for every bundled extension whether a fresh install enables it", () => {
    const enabled = new Set(defaultConfig().agent.extensions.enabled);
    const names = catalogNames();

    // An entry that names nothing in the catalog, or a name the default list
    // already enables, is a stale reason: it explains a choice no one makes.
    const stale = Object.keys(OPERATOR_ENABLED).filter(
      (name) => !names.includes(name) || enabled.has(name),
    );
    expect(stale, "OPERATOR_ENABLED must name catalog entries the default list leaves off").toEqual([]);
    const unexplained = Object.entries(OPERATOR_ENABLED).filter(([, reason]) => reason.trim() === "");
    expect(unexplained, "every operator-enabled entry needs a reason").toEqual([]);

    // The decision this test asks for: a name in the catalog is either enabled
    // by default, or left off with a reason written down here. When neither,
    // the failure names both places, because the fix is to add the name to one
    // of them.
    const undecided = names.filter((name) => !enabled.has(name) && !Object.hasOwn(OPERATOR_ENABLED, name));
    expect(
      undecided,
      "every BUNDLED_EXTENSIONS name (src/extensions/index.ts) must be in the default enabled list " +
        "(agent.extensions.enabled in src/config/schema.ts) or in OPERATOR_ENABLED in this test with a reason",
    ).toEqual([]);
  });
});
