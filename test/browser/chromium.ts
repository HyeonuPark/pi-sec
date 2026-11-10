/**
 * The one place where the browser files launch Chromium.
 *
 * Chromium needs X11, atk and gbm libraries that a minimal Linux image may not ship,
 * and there may be no root to install them. They are unpacked from Fedora RPMs into a
 * local prefix under `HOME`, and the launch points the dynamic linker at it. Same as
 * scripts/ui-probe.mjs, which is a script and cannot import this file.
 *
 * A host may have no GPU, and the GPU process may not start at all
 * (`gpu_data_manager_impl_private.cc: GPU process isn't usable`). `--single-process`
 * keeps rendering on the CPU inside the browser process, which is all most files need.
 * With that flag, closing a context takes the browser down with it, so a file that
 * needs more than one context at a time (ui-sync: two machines and a phone) passes
 * `singleProcess: false`.
 */
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

/** Read when this module loads, as each browser file did. */
const BROWSER_LIBS = `${process.env["HOME"]}/.cache/pi-sec-browser/root/usr/lib64`;
const BASE_ARGS = ["--disable-gpu", "--disable-dev-shm-usage", "--no-sandbox"] as const;

export interface LaunchOptions {
  /** Default true. False for a file that needs more than one context at a time. */
  readonly singleProcess?: boolean;
}

/** The flags that a launch passes. */
export function launchArgs(options: LaunchOptions = {}): string[] {
  return options.singleProcess === false ? [...BASE_ARGS] : ["--single-process", ...BASE_ARGS];
}

export async function launchChromium(options: LaunchOptions = {}): Promise<Browser> {
  // The library directory goes first in the search path once, before the launch.
  if (existsSync(BROWSER_LIBS) && process.env["LD_LIBRARY_PATH"]?.split(":")[0] !== BROWSER_LIBS) {
    process.env["LD_LIBRARY_PATH"] = [BROWSER_LIBS, process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
  }
  try {
    return await chromium.launch({ args: launchArgs(options) });
  } catch (error) {
    // A launch failure is the host's, not the code's, and the exact error is the only useful thing to report.
    throw new Error(`chromium did not launch: ${error instanceof Error ? error.message : String(error)}`);
  }
}
