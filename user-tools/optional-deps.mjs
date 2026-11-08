// Optional system packages for pi-sec, checked for user-tools/install.
//
// Usage: node optional-deps.mjs --tree <dir> [--probe-browser]
//          [--browser-note attempted|skipped|none] [--daemon-path <PATH>]
//
// Default output is the "optional system packages" block on stdout.
// --probe-browser prints one word instead: present, missing or unknown.
// The script only reads. It never installs anything, never prints the word for
// privilege escalation tools, and exits 0 unless its arguments are wrong.
//
// Test seam: PI_SEC_OS_RELEASE names the file read instead of /etc/os-release.
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
let tree = "";
let probe = false;
let note = "none";
let daemonPath = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--tree") tree = args[++i] ?? "";
  else if (arg === "--probe-browser") probe = true;
  else if (arg === "--browser-note") note = args[++i] ?? "";
  else if (arg === "--daemon-path") daemonPath = args[++i] ?? "";
  else {
    process.stderr.write(`optional-deps: unknown argument: ${arg}\n`);
    process.exit(2);
  }
}
if (tree === "" || !["attempted", "skipped", "none"].includes(note)) {
  process.stderr.write("optional-deps: usage: --tree <dir> [--probe-browser] [--browser-note attempted|skipped|none] [--daemon-path <PATH>]\n");
  process.exit(2);
}

/** Playwright facts: { state, version, deps, utils, browser } */
function readPlaywright() {
  const core = join(tree, "node_modules", "playwright-core");
  if (!existsSync(join(core, "package.json"))) return { state: "none" };
  let version = "unknown";
  try {
    version = JSON.parse(readFileSync(join(core, "package.json"), "utf8")).version;
    const require = createRequire(join(tree, "package.json"));
    const bundle = readFileSync(join(core, "lib", "coreBundle.js"), "utf8");
    const marker = "// packages/playwright-core/src/server/registry/nativeDeps.ts\n";
    const start = bundle.indexOf(marker);
    if (start < 0) throw new Error("nativeDeps module not found");
    const end = bundle.indexOf("\n// packages/", start + marker.length);
    const box = { __esm: (o) => Object.values(o)[0] };
    vm.runInNewContext(`${bundle.slice(start, end)}\ninit_nativeDeps(); this.deps = deps;`, box, { timeout: 2000 });
    const deps = box.deps;
    if (typeof deps !== "object" || deps === null) throw new Error("no package table");
    const { utils, registry } = require("playwright-core/lib/coreBundle");
    const shell = registry.registry.findExecutable("chromium-headless-shell");
    const directory = shell.directory;
    const executable = shell.executablePath("javascript");
    const present = existsSync(executable) && existsSync(join(directory, "INSTALLATION_COMPLETE"));
    return { state: "ok", version, deps, platform: utils.hostPlatform, browser: { present } };
  } catch {
    return { state: "unreadable", version };
  }
}

const pw = readPlaywright();

if (probe) {
  process.stdout.write(`${pw.state === "ok" ? (pw.browser.present ? "present" : "missing") : "unknown"}\n`);
  process.exit(0);
}

function osIds() {
  const ids = [];
  try {
    const text = readFileSync(process.env.PI_SEC_OS_RELEASE ?? "/etc/os-release", "utf8");
    for (const key of ["ID", "ID_LIKE"]) {
      const m = new RegExp(`^${key}="?([^"\\n]*)"?$`, "m").exec(text);
      if (m) ids.push(...m[1].split(/\s+/));
    }
  } catch {
    /* no os-release: treated as another distribution */
  }
  return ids;
}
const debianFamily = osIds().some((id) => id === "debian" || id === "ubuntu");

function findOn(pathValue, name) {
  for (const dir of pathValue.split(delimiter)) {
    if (dir === "") continue;
    const file = join(dir, name);
    try {
      if (statSync(file).isFile()) {
        accessSync(file, constants.X_OK);
        return true;
      }
    } catch {
      /* not here */
    }
  }
  return false;
}

function installedFrom(text) {
  return new Set(
    String(text ?? "")
      .split("\n")
      .filter((l) => / ii $/.test(l))
      .map((l) => l.split(" ")[0].split(":")[0]),
  );
}

/** Items: { label, status: "ok" | "missing" | "unchecked", lines: [], apt: [], other: [] } */
const items = [];
const aptPackages = [];
const otherCommands = [];
let browserCommand = "";

// --- headless Chromium libraries and browser ---------------------------------
const libsLabel = "headless Chromium libraries, for browser tests and ui-probe screenshots";
if (pw.state === "none") {
  items.push({ status: "unchecked", lines: [`- headless Chromium: not checked, because Playwright is not installed in ${tree} (run npm ci there)`] });
} else if (pw.state === "unreadable") {
  items.push({
    status: "unchecked",
    lines: [
      `- headless Chromium libraries: not checked (could not read the package list of Playwright ${pw.version})`,
      `    to see the list, run in ${tree}: npx playwright install-deps --dry-run chromium`,
    ],
  });
} else {
  const platform = pw.platform;
  const arch = platform.endsWith("-arm64") ? "arm64" : "x64";
  const info = pw.deps[platform] ?? pw.deps[`ubuntu24.04-${arch}`];
  const lines = [];
  let status = "ok";
  if (debianFamily && pw.deps[platform]) {
    const packages = info.chromium;
    let stdout = "";
    let tool = true;
    try {
      stdout = execFileSync("dpkg-query", ["-W", "-f=${Package} ${db:Status-Abbrev}\n", ...packages], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      // dpkg-query exits 1 when a name is unknown: its stdout still lists the others.
      if (error.code === "ENOENT") tool = false;
      stdout = error.stdout ?? "";
    }
    if (!tool) {
      status = "unchecked";
      lines.push(`- ${libsLabel}: not checked, because dpkg-query is missing`);
    } else {
      const have = installedFrom(stdout);
      const missing = packages.filter((p) => !have.has(p));
      if (missing.length > 0) {
        status = "missing";
        aptPackages.push(...missing);
        lines.push(`- ${libsLabel}:`);
        lines.push(`    missing ${missing.length} of the ${packages.length} packages that Playwright ${pw.version} lists for ${platform}:`);
        lines.push(`    ${missing.join(" ")}`);
      }
    }
  } else {
    const sonames = Object.entries(info.lib2package ?? {})
      .filter(([, p]) => info.chromium.includes(p))
      .map(([s]) => s)
      .sort();
    let cache = null;
    for (const ldconfig of ["ldconfig", "/sbin/ldconfig", "/usr/sbin/ldconfig"]) {
      try {
        cache = execFileSync(ldconfig, ["-p"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        break;
      } catch {
        /* try the next place */
      }
    }
    if (cache === null) {
      status = "unchecked";
      lines.push(`- ${libsLabel}: not checked, because ldconfig is missing`);
    } else {
      const have = new Set(cache.split("\n").map((l) => l.trim().split(" ")[0]));
      const missing = sonames.filter((s) => !have.has(s));
      if (missing.length > 0) {
        status = "missing";
        lines.push(`- ${libsLabel}:`);
        lines.push(`    missing ${missing.length} of ${sonames.length} shared libraries: ${missing.join(" ")}`);
        lines.push(`    Playwright ${pw.version} names packages for Debian and Ubuntu only.`);
        lines.push("    Install the packages of this distribution that provide these files, as root.");
      }
    }
  }
  if (status !== "ok") items.push({ status, lines });
  else items.push({ status: "ok", lines: [] });

  // The browser itself.
  if (pw.browser.present) {
    items.push({ status: "ok", lines: [] });
  } else {
    const why = note === "attempted" ? "the download failed in this run (see the lines above)" : note === "skipped" ? "not downloaded (--skip-browser)" : "not downloaded";
    items.push({ status: "missing", lines: [`- headless Chromium browser, for the same features: ${why}`] });
    browserCommand = `cd ${tree} && npx playwright install --only-shell chromium`;
  }
}

// --- Korean font -------------------------------------------------------------
{
  const label = "Korean font, for Korean text in browser screenshots";
  let out = null;
  let tool = true;
  try {
    out = execFileSync("fc-list", [":lang=ko"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (error) {
    if (error.code === "ENOENT") tool = false;
    else out = String(error.stdout ?? "");
  }
  if (!tool) {
    items.push({ status: "unchecked", lines: [`- ${label}: not checked, because fc-list is missing (it comes with fontconfig)`] });
    if (debianFamily) aptPackages.push("fontconfig", "fonts-nanum");
  } else if (out.trim() === "") {
    const lines = [`- ${label}: missing`];
    if (debianFamily) aptPackages.push("fonts-nanum");
    else lines.push("    Install a font that covers Korean, as root.");
    items.push({ status: "missing", lines });
  } else {
    items.push({ status: "ok", lines: [] });
  }
}

// --- remote machines and github-pr commands ----------------------------------
const commands = [
  { names: ["ssh", "sftp"], package: "openssh-client", note: "for remote machines (off by default, the remoteMachines key in config.json turns it on)" },
  { names: ["rsync"], package: "rsync", note: "for remote machines (off by default, the remoteMachines key in config.json turns it on)" },
  { names: ["gh"], package: "gh", note: "for the github-pr extension (off by default)" },
];
const shellPath = process.env.PATH ?? "";
const notFoundByDaemon = [];
for (const group of commands) {
  for (const name of group.names) {
    if (findOn(shellPath, name)) {
      items.push({ status: "ok", lines: [] });
      if (daemonPath !== null && !findOn(daemonPath, name)) notFoundByDaemon.push(name);
    } else {
      items.push({ status: "missing", lines: [`- ${name}, ${group.note}: missing`] });
      if (debianFamily) {
        if (!aptPackages.includes(group.package)) aptPackages.push(group.package);
      } else otherCommands.push(name);
    }
  }
}

// --- print -------------------------------------------------------------------
const out = [];
out.push("");
out.push("optional system packages");
const notOk = items.filter((i) => i.status !== "ok");
if (notOk.length === 0) {
  out.push("  all present: headless Chromium libraries and browser, Korean font, ssh, sftp, rsync, gh");
} else {
  out.push("  pi-sec runs without these. Each one serves the feature named after it.");
  for (const item of notOk) for (const line of item.lines) out.push(`  ${line}`);
  if (notOk.length < items.length) out.push("  all other items are present");
  if (aptPackages.length > 0) {
    out.push("  to install the missing packages, run this as root:");
    out.push(`    apt-get update && apt-get install -y --no-install-recommends ${aptPackages.join(" ")}`);
  }
  if (otherCommands.length > 0) {
    out.push(`  install the package that provides each missing command, as root: ${otherCommands.join(", ")}`);
  }
  if (browserCommand !== "") {
    out.push("  to download the browser, run this as this account:");
    out.push(`    ${browserCommand}`);
  }
}
if (notFoundByDaemon.length > 0) {
  out.push(`  the daemon will not find ${notFoundByDaemon.join(", ")}: the systemd unit's PATH is ${daemonPath}`);
}
process.stdout.write(`${out.join("\n")}\n`);
