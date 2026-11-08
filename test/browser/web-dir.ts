/**
 * The directory a browser test serves, which is the built tree.
 *
 * `defaultWebDir()` resolves the web directory beside `src/server/server.ts`, so
 * under vitest it is `src/web/`. That directory holds the shells, the CSS and the
 * two scripts the shells load from source, and the page modules are not there: the
 * pages became bundles, and `npm run build` writes them into `dist/web` beside a
 * copy of the same shells. A test that served `src/web` would get a shell whose
 * `<script type="module">` answers 404 and would then wait for rows no script
 * draws.
 *
 * So these tests serve what a browser is served after a build. The check below
 * fails with the missing path rather than with a page that never draws.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `dist/web` of this repository, which is `npm run build`'s output. */
export const BUILT_WEB_DIR = fileURLToPath(new URL("../../dist/web/", import.meta.url));

/** `dist/web`, after checking that the build put the chat page's bundle there. */
export function builtWebDir(): string {
  const bundle = join(BUILT_WEB_DIR, "ui-chat.js");
  if (!existsSync(bundle)) {
    throw new Error(`the pages are not built: ${bundle} is missing. Run "npm run build" before "npm run test:browser".`);
  }
  return BUILT_WEB_DIR;
}
