// Copy non-TypeScript assets (web UI, prompts) into dist/ after tsc.
import { cp, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

async function copyDir(from, to) {
  try {
    await access(from);
  } catch {
    return;
  }
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, { recursive: true });
}

await copyDir(resolve(root, "src/web"), resolve(root, "dist/web"));
await copyDir(resolve(root, "prompts"), resolve(root, "dist/prompts"));
