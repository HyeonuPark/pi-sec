// Bundle the page entry modules with esbuild.
//
//   npm run build                      tsc, copy the assets, then this script
//   node scripts/build-ui.mjs          the same, writing dist/web
//   node scripts/build-ui.mjs --mode test --outdir /tmp/ui
//
// One entry module per page lives in `src/ui/pages/`, and each becomes
// `ui-<page>.js` in the output directory, which is what the page's shell loads.
// The `ui-` prefix keeps a bundle apart from the files the daemon serves beside
// it, such as `ui-cards.js` and `base.js`.
//
// Production bundles are ES modules with a split file for the code that two
// pages share. The split file is imported by a relative path, so the same files
// load under `/report/assets/` as under `/`. The test build is one IIFE per
// page, because jsdom does not run module scripts; the tests put that code into
// the page with `window.eval`, so they run the code the browser would run, from
// the same source.
//
// Both modes return the names of the packages the bundles pull in, read from
// esbuild's own input list. `uiPackages` reads the same list for every module
// under `src/ui/` at once, so a page that is not built yet still reports its
// packages. `scripts/third-party-notices.mjs` writes that list into
// THIRD_PARTY_NOTICES.md, so a new import cannot be missed.
//
// The production build copies one file beside the bundles that esbuild does not
// write: `ui-highlight-github.css`, the GitHub light palette of the highlight.js
// package, which the pull request and diff pages load for their code blocks. The
// file is copied from the installed package into the output directory, so nothing
// third-party is copied into the tracked tree; `npm run notices` lists the
// package, and a rebuild through `/api/admin/ui-restart` runs this same script and
// so writes the same file.
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root: the directory that holds `package.json`. */
export const ROOT = resolve(here, "..");

/** Where `npm run build` writes the bundles, beside the shells and the CSS. */
export const OUT_DIR = "dist/web";

/**
 * The code-block palette, as the output directory names it.
 *
 * A name of its own rather than `github.min.css`, because the file is served from
 * the same directory as the shells: a name that says which part of the page it
 * colours is what keeps it apart from `ui-cards.js` and the bundles.
 */
export const HIGHLIGHT_CSS_NAME = "ui-highlight-github.css";

/** The palette inside the installed highlight.js package. */
const HIGHLIGHT_CSS_SOURCE = "node_modules/highlight.js/styles/github.css";

/** The settings both builds share. */
const COMMON = {
  bundle: true,
  target: "es2022",
  jsx: "automatic",
  jsxImportSource: "preact",
  legalComments: "none",
  logLevel: "silent",
  metafile: true,
};

/** The production settings: one ES module per page, with the shared code split out. */
const PRODUCTION = {
  ...COMMON,
  format: "esm",
  splitting: true,
  entryNames: "[name]",
  chunkNames: "ui-chunks/[name]-[hash]",
  minify: true,
  sourcemap: "linked",
  conditions: ["browser", "production"],
  define: { "process.env.NODE_ENV": '"production"' },
};

/** The test settings: one self-contained IIFE per page, in memory. */
const TEST = {
  ...COMMON,
  format: "iife",
  splitting: false,
  minify: false,
  write: false,
  sourcemap: false,
  conditions: ["browser", "production"],
  define: { "process.env.NODE_ENV": '"production"' },
};

/**
 * The page entry modules, keyed by page name: every `src/ui/pages/*.tsx`.
 *
 * The base name is the page name, so adding a page is adding a file. A tree
 * with no entries answers an empty object rather than failing, so a checkout
 * without page code still builds the server.
 */
export async function pageEntries(root = ROOT) {
  const directory = join(root, "src/ui/pages");
  let names;
  try {
    names = await readdir(directory);
  } catch {
    return {};
  }
  const entries = {};
  for (const name of names.sort()) {
    if (!name.endsWith(".tsx")) continue;
    entries[name.slice(0, -".tsx".length)] = join(directory, name);
  }
  return entries;
}

/** Sort directory entries by name, so two runs walk the tree in one order. */
function byName(left, right) {
  if (left.name === right.name) return 0;
  return left.name < right.name ? -1 : 1;
}

/**
 * Every module under `src/ui/`, as paths relative to `root/src/ui`.
 *
 * A test file and a type declaration are left out: neither is code that the
 * page runs, and a type declaration has no runtime import at all.
 */
async function uiModules(root) {
  const base = join(root, "src/ui");
  const found = [];
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort(byName)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "__tests__" || entry.name === "__mocks__") {
          continue;
        }
        await walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
      if (entry.name.endsWith(".d.ts")) continue;
      if (/\.(test|spec)\.[cm]?tsx?$/.test(entry.name)) continue;
      found.push(path);
    }
  };
  await walk(base);
  return found.map((path) => relative(base, path).split(sep).join("/"));
}

/**
 * The packages that every module under `src/ui/` reaches, and the directories
 * they were resolved from.
 *
 * The modules become one virtual entry module, which esbuild bundles with the
 * test settings: in memory, with no page entry to leave out. The import list of
 * that bundle is the answer, so a module that no page imports yet still counts,
 * and a package that only the server pulls in does not.
 */
export async function uiPackages({ root = ROOT } = {}) {
  const files = await uiModules(root);
  const contents = files.map((file) => `import ${JSON.stringify(`./${file}`)};`).join("\n");
  const result = await esbuild.build({
    ...TEST,
    absWorkingDir: root,
    stdin: {
      contents: contents === "" ? "" : `${contents}\n`,
      resolveDir: join(root, "src/ui"),
      sourcefile: "ui-all.ts",
      loader: "ts",
    },
  });
  return inputPackages(result.metafile);
}

/**
 * The package a file of a bundle's input list comes from, as `node_modules`
 * names it, and the directory that package was resolved from.
 *
 * A path that runs through a nested `node_modules` names the package that file
 * really came from, which is what a lockfile lookup needs when two versions of
 * one package are installed.
 */
function packageOf(input) {
  const at = input.lastIndexOf("node_modules/");
  if (at === -1) return undefined;
  const rest = input.slice(at + "node_modules/".length).split("/");
  const first = rest[0];
  if (first === undefined || first === "") return undefined;
  if (first.startsWith("@")) {
    const second = rest[1];
    if (second === undefined || second === "") return undefined;
    return { name: `${first}/${second}`, dir: input.slice(0, at) + `node_modules/${first}/${second}` };
  }
  return { name: first, dir: input.slice(0, at) + `node_modules/${first}` };
}

/**
 * The packages a bundle's metafile names, sorted by name.
 *
 * `dirs` maps each package name to the directory it was resolved from,
 * relative to the build's working directory. It is what the notice file reads a
 * version from, so a package's version is the one that is bundled and not the
 * one the lockfile happens to list first.
 */
export function inputPackages(metafile) {
  const names = new Set();
  const dirs = {};
  for (const input of Object.keys(metafile?.inputs ?? {})) {
    const found = packageOf(input);
    if (found === undefined) continue;
    names.add(found.name);
    dirs[found.name] ??= found.dir;
  }
  return { packages: [...names].sort(), dirs };
}

/**
 * Remove the bundles a previous build left in the output directory, and nothing
 * else.
 *
 * `dist/web` holds the shells, the stylesheets and the card script beside the
 * bundles, and the daemon serves all of them, so the clean works by name: a
 * `ui-<page>.js` with its map, and the `ui-chunks/` directory. `ui-cards.js` is
 * the one served file whose name starts with `ui-` and is not a bundle, so it
 * stays.
 *
 * The pattern rather than the list of pages being built is what removes the
 * bundle of a page that no longer exists. A chunk is named after its content, so
 * a rebuild with a different hash leaves the old one behind unless the directory
 * goes first.
 */
async function clearBundles(target) {
  let entries;
  try {
    entries = await readdir(target, { withFileTypes: true });
  } catch {
    // Nothing has been built here yet.
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(target, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "ui-chunks") await rm(path, { recursive: true, force: true });
        return;
      }
      if (!entry.isFile()) return;
      if (entry.name === "ui-cards.js") return;
      if (!/^ui-.+\.js(\.map)?$/.test(entry.name)) return;
      await rm(path, { force: true });
    }),
  );
}

/**
 * Copy the code-block palette from the installed highlight.js package.
 *
 * The palette is not tracked in this repository: it is read from the package the
 * lockfile pins, which is what keeps one copy of it, and from the version the
 * pages are built with. A package that is not installed is a failure, not a
 * warning: a page that asked for `ui-highlight-github.css` would answer 404 and
 * every code block would draw uncoloured.
 */
async function copyHighlightCss(root, target) {
  await mkdir(target, { recursive: true });
  await copyFile(join(root, HIGHLIGHT_CSS_SOURCE), join(target, HIGHLIGHT_CSS_NAME));
}

/**
 * Bundle every page entry.
 *
 * `root` is the tree to build, so the same script serves the workspace tree and
 * the admin route that rebuilds the page assets in place. `outDir` is where the
 * production bundles go; the test mode keeps them in memory and returns them.
 *
 * The production build also writes `ui-highlight-github.css` beside the bundles.
 * The test mode does not: it answers code, not a directory, and no unit test reads
 * a stylesheet from a build.
 */
export async function buildUi({ root = ROOT, outDir, mode = "production" } = {}) {
  const entries = await pageEntries(root);
  const pages = Object.keys(entries);

  if (mode === "test") {
    const code = {};
    const packages = new Set();
    const dirs = {};
    for (const page of pages) {
      const result = await esbuild.build({
        ...TEST,
        absWorkingDir: root,
        entryPoints: [entries[page]],
      });
      const file = result.outputFiles?.[0];
      if (file === undefined) throw new Error(`the ${page} page bundle came back empty`);
      code[page] = file.text;
      const read = inputPackages(result.metafile);
      for (const name of read.packages) packages.add(name);
      Object.assign(dirs, read.dirs);
    }
    return { mode, pages, code, packages: [...packages].sort(), dirs };
  }

  if (mode !== "production") throw new Error(`unknown build mode: ${mode}`);

  const target = resolve(root, outDir ?? OUT_DIR);
  await clearBundles(target);
  const result = await esbuild.build({
    ...PRODUCTION,
    absWorkingDir: root,
    entryPoints: Object.fromEntries(pages.map((page) => [`ui-${page}`, entries[page]])),
    outdir: target,
  });
  await copyHighlightCss(root, target);
  const read = inputPackages(result.metafile);
  return {
    mode,
    outDir: target,
    pages,
    files: [...Object.keys(result.metafile?.outputs ?? {}), HIGHLIGHT_CSS_NAME].sort(),
    packages: read.packages,
    dirs: read.dirs,
  };
}

/** Read `--name value` from the command line, or answer the fallback. */
function argument(argv, name, fallback) {
  const at = argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

async function main(argv) {
  const mode = argument(argv, "mode", "production");
  const outDir = argument(argv, "outdir", join(ROOT, OUT_DIR));
  const result = await buildUi({ root: ROOT, outDir, mode });
  if (result.mode === "test") {
    const sizes = result.pages.map((page) => `${page} ${result.code[page].length}B`);
    process.stdout.write(`ui: built ${result.pages.length} test bundles (${sizes.join(", ")})\n`);
    return;
  }
  process.stdout.write(`ui: wrote ${result.files.length} files for ${result.pages.length} pages to ${result.outDir}\n`);
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entry) {
  process.exitCode = await main(process.argv.slice(2));
}
