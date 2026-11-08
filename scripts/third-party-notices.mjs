// Generate THIRD_PARTY_NOTICES.md from package-lock.json, node_modules and the
// import list of the code under `src/ui/`.
//
//   npm run notices                                    rewrite the file
//   node scripts/third-party-notices.mjs --check       compare with the file
//   node scripts/third-party-notices.mjs --check FILE  compare with a copy
//
// Section 2 is read from `scripts/build-ui.mjs`, whose `uiPackages` bundles every
// module under `src/ui/` as one virtual entry and reports the packages esbuild
// resolved. Reading that list is what makes a new import show up here without
// anyone remembering to add it, and the list does not change when a page that
// already imports the same packages is added.
//
// Nothing in the tracked tree holds third-party code any more: the page scripts
// are bundles built from the packages the lockfile names, so every third-party
// file this repository ships is listed by one of the two sections below. The
// copy of markdown-it that `src/web/vendor/` used to carry went with the
// hand-written page scripts, and the bundled section already names markdown-it.
//
// The lockfile is the source of the package list. `npm sbom --omit=dev` leaves
// out nine runtime packages that the lockfile and `npm ls --omit=dev` both keep,
// so it is not used here. The output must not depend on the machine that runs
// the script: every entry that is optional and carries an `os` or `cpu` field is
// one platform's build of a package, and the list leaves all of them out, on
// every host. Nothing here reads the network. The run reads package-lock.json
// and the installed package manifests only.

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { uiPackages } from "./build-ui.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// The repository root: the directory that holds package.json and package-lock.json.
export const ROOT = resolve(here, "..");

// The generated file, relative to the root.
export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

export const STALE_MESSAGE = "THIRD_PARTY_NOTICES.md is out of date. Run: npm run notices";

const MODULE_PREFIX = "node_modules/";

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

// Compare "1.2.10" above "1.2.9", and fall back to text comparison for the parts
// that are not numbers. Sorting must not depend on the host locale.
function compareVersions(left, right) {
  const a = String(left).match(/\d+|\D+/g) ?? [];
  const b = String(right).match(/\d+|\D+/g) ?? [];
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === y) continue;
    const difference = Number(x) - Number(y);
    if (/^\d+$/.test(x) && /^\d+$/.test(y) && difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
    return compareText(x, y);
  }
  return a.length - b.length;
}

function licenseOf(manifest) {
  const value = manifest?.license;
  if (typeof value === "string") return value;
  if (value && typeof value.type === "string") return value.type;
  const list = manifest?.licenses;
  if (Array.isArray(list)) {
    const names = list.map((item) => (typeof item === "string" ? item : item?.type)).filter(Boolean);
    if (names.length > 0) return names.join(", ");
  }
  return "";
}

/**
 * Turn a package.json `repository` value into an https URL. The forms in the
 * lockfile are `github:owner/repo`, the bare `owner/repo` shorthand, an https
 * URL, and an object whose `url` is `git+https://`, `git://`, `git+ssh://git@`
 * or `git@host:owner/repo`. The result is empty when the manifest has none.
 */
export function repositoryUrl(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (typeof raw !== "string") return "";
  let url = raw.trim();
  if (url === "") return "";

  if (url.startsWith("github:")) {
    url = `https://github.com/${url.slice("github:".length)}`;
  } else {
    url = url.replace(/^git\+/, "");
    url = url.replace(/^ssh:\/\/[^/]*@/, "https://");
    url = url.replace(/^git:\/\//, "https://");
    url = url.replace(/^[^/@]+@([^/:]+):/, "https://$1/");
    if (!url.includes("://")) url = `https://github.com/${url}`;
  }
  // A clone address may name a user, as in `git+https://user@host/repo.git`.
  // The user is not part of the address of the code, so it is dropped.
  url = url.replace(/^(https?:\/\/)[^/@]+@/, "$1");
  url = url.replace(/\.git$/, "").replace(/\/+$/, "");

  // A monorepo publishes each package from its own directory, and the directory
  // is the only part of the address that identifies the package.
  const directory = typeof repository === "object" ? repository?.directory : undefined;
  if (typeof directory === "string" && directory !== "") {
    url = `${url}/tree/HEAD/${directory.replace(/^\/+|\/+$/g, "")}`;
  }
  return url;
}

/**
 * An entry is a runtime package when the lockfile does not mark it as a
 * development package, and when it is not a platform-specific optional build.
 */
export function isRuntimeEntry(entry) {
  if (entry?.dev === true || entry?.devOptional === true) return false;
  if (entry?.optional === true && (entry.os !== undefined || entry.cpu !== undefined)) return false;
  return true;
}

async function readManifest(root, directory) {
  try {
    return JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
  } catch {
    // A package the lockfile lists but the tree does not hold contributes the
    // lockfile fields alone.
    return undefined;
  }
}

/** Every runtime package in package-lock.json, deduplicated and sorted. */
export async function readRuntimeEntries(root = ROOT) {
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const rows = [];
  const seen = new Set();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith(MODULE_PREFIX)) continue;
    if (!isRuntimeEntry(entry)) continue;
    const name = key.slice(key.lastIndexOf(MODULE_PREFIX) + MODULE_PREFIX.length);
    const version = String(entry.version ?? "");
    const id = `${name}@${version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const manifest = await readManifest(root, key);
    rows.push({
      name,
      version,
      license: entry.license || licenseOf(manifest),
      repository: repositoryUrl(manifest?.repository),
    });
  }
  rows.sort((left, right) =>
    left.name === right.name
      ? compareVersions(left.version, right.version)
      : compareText(left.name, right.name),
  );
  return rows;
}

/**
 * The packages that code under `src/ui/` reaches, with the version, license and
 * address of the copy the bundle actually resolved.
 *
 * The version comes from the installed package the input list names, not from
 * the lockfile's first entry for that name: two versions of one package can be
 * installed at once, and the bundle carries only the one it resolved.
 */
export async function readBundledEntries(root = ROOT) {
  const { packages, dirs } = await uiPackages({ root });
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const rows = [];
  for (const name of packages) {
    const directory = dirs[name] ?? `${MODULE_PREFIX}${name}`;
    const entry = lock.packages?.[directory] ?? {};
    const manifest = await readManifest(root, directory);
    rows.push({
      name,
      version: String(manifest?.version ?? entry.version ?? "unknown"),
      license: entry.license || licenseOf(manifest),
      repository: repositoryUrl(manifest?.repository),
    });
  }
  rows.sort((left, right) =>
    left.name === right.name ? compareVersions(left.version, right.version) : compareText(left.name, right.name),
  );
  return rows;
}

function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|");
}

function table(headers, rows) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(" | ")} |`);
  return lines.join("\n");
}

/** Render the notice file. The result holds no timestamp, so two runs agree. */
export function renderNotices(rows, bundled = []) {
  const parts = [
    "# Third-party notices",
    "",
    "This file lists the third-party code that this repository contains, and the",
    "third-party packages that it uses at run time.",
    "",
    "`npm run notices` generates this file from `package-lock.json`, the",
    "installed `node_modules` directory and the import list of the code under",
    "`src/ui/`.",
    "Do not edit it by hand.",
    "",
    "No third-party source is copied into this repository. The page scripts are",
    "built from the packages that the lockfile names, so every third-party file",
    "the published package carries is either an installed runtime dependency or a",
    "bundle of one.",
    "",
    "The repository does not redistribute the packages in section 1. Install them",
    "with npm. Most installed packages carry their license text. Some packages ship",
    "no license file, and for those the license is the one that the table names, as",
    "the package declares it in its `package.json`.",
    "",
    "Section 1 holds every `package-lock.json` entry that is not a development",
    "package, except the optional entries that carry an `os` or `cpu` field. Those",
    "are one platform's build of a package, so this file leaves all of them out and",
    "the list is the same on every machine.",
    "",
    "Section 2 holds every package that code under `src/ui/` reaches. The build",
    "bundles those packages into the page scripts. They are development",
    "dependencies: the page code reaches them through the bundle, and the",
    "published package ships the built bundle rather than the packages themselves.",
    "",
    "## 1. Runtime dependencies",
    "",
    table(
      ["Package", "Version", "License", "Repository"],
      rows.map((row) => [row.name, row.version, row.license, row.repository]),
    ),
    "",
    "## 2. Packages that the code under `src/ui/` reaches",
    "",
    "`npm run build` bundles these packages into the page scripts under `dist/web/`.",
    "The list is read from one esbuild bundle of every module under `src/ui/`, so a",
    "new import cannot be missed, and a package that only the server code uses is",
    "not listed.",
    "",
    ...(bundled.length === 0
      ? ["No module under `src/ui/` reaches a package in this tree.", ""]
      : [
          table(
            ["Package", "Version", "License", "Repository"],
            bundled.map((row) => [row.name, row.version, row.license, row.repository]),
          ),
          "",
        ]),
  ];
  return parts.join("\n");
}

export async function buildNotices(root = ROOT) {
  const [rows, bundled] = await Promise.all([readRuntimeEntries(root), readBundledEntries(root)]);
  return { text: renderNotices(rows, bundled), count: rows.length, bundled: bundled.length };
}

async function readOrNull(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function main(argv) {
  const { text, count, bundled } = await buildNotices(ROOT);
  const checkAt = argv.indexOf("--check");
  if (checkAt === -1) {
    await writeFile(join(ROOT, NOTICES_FILE), text, "utf8");
    process.stdout.write(`${NOTICES_FILE}: ${count} runtime packages, ${bundled} bundled packages\n`);
    return 0;
  }
  const requested = argv[checkAt + 1];
  const target = requested && !requested.startsWith("--") ? resolve(requested) : join(ROOT, NOTICES_FILE);
  const current = await readOrNull(target);
  if (current === text) return 0;
  process.stderr.write(`${STALE_MESSAGE}\n`);
  return 1;
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  process.exitCode = await main(process.argv.slice(2));
}
