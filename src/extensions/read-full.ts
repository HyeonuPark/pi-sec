import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ExtensionContext } from "./context.ts";
import { recordRefusal, refusesRecordForCall } from "./user-record-guard.ts";

/**
 * `read-full` — one tool, `read_full`, that returns one whole text file in a
 * single call.
 *
 * The `read` tool cuts at 2000 lines or 50KB and asks the caller to continue
 * with `offset`, so a script that edits a large file loses its tail. This tool
 * exists for that case, and for nothing else. It is a bundled extension that the
 * default `agent.extensions.enabled` list does not name, so an operator turns it
 * on by adding `"read-full"` to that list.
 *
 * Four decisions:
 *
 *   1. The cap is a refusal, not a cut. A file over `readFull.maxBytes` (256 KiB
 *      by default), and a file that is not text, are refused with the size and
 *      the way to read the file in parts. Half a file returned without an error
 *      is what this tool was made to stop.
 *   2. The result bound follows the cap. The Harness bounds every tool result to
 *      2000 lines or 50KB unless the tool declares `outputLimits`, so a whole
 *      256 KiB text would be cut at 50KB after this tool returned it. The
 *      declared bound is the cap plus a small margin, and a line count the cap
 *      cannot reach, because the bound is whichever of the two is hit first.
 *   3. Paths resolve and files are read through `api.env`, as `read` does. A
 *      relative path then means what it means for `read` (the environment's
 *      cwd), and the text passes the same secret redaction, which the Harness
 *      applies to every tool result and to the text `js` returns.
 *   4. A byte-order mark is kept as text. The returned string is the bytes of
 *      the file decoded as UTF-8, which is what `fs.readFileSync(path, "utf8")`
 *      gives as well.
 *
 * The cap is read from the config on every call (`context.getConfig()`), so a
 * value an operator changes is the value the next call enforces. The declared
 * result bound is fixed when the extension is installed, because a tool
 * declaration cannot change between calls, and the config it comes from is
 * read at boot.
 */

/** The largest file this tool returns whole when the config names no cap: 256 KiB. */
const DEFAULT_MAX_BYTES = 256 * 1024;
/** Bytes asked of the environment per read call. */
const READ_CHUNK = 64 * 1024;
/** Room above the size cap for the declared result bound. */
const RESULT_SLACK_BYTES = 4 * 1024;

/** The sentence for this tool, and one sentence for the default cap. */
const DESCRIPTION =
  "Read one whole text file in a single call and return its exact text, with no 2000-line or 50KB cut. " +
  "A file larger than the size cap, or a file that is not text, is refused, not cut. " +
  "It is meant for workers and for js scripts that edit a large file. " +
  "The root and orchestrators can call it, but it is not recommended for them: a whole file fills the context that their judgment needs. " +
  "Read the part you need with read, or give the reading to a worker. " +
  "The size cap is 256 KiB by default.";

/** A whole, positive byte count, or undefined for anything else. */
function byteCount(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Bytes as `300.0KB (307200 bytes)`, so a refusal names the size the caller must plan around. */
function formatSize(bytes: number): string {
  const size =
    bytes < 1024
      ? `${bytes}B`
      : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)}KB`
        : `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${size} (${bytes} bytes)`;
}

/** The refusal: an error result, so the caller sees a failure and not a short text. */
function refusal(message: string) {
  return { isError: true, output: [{ type: "text" as const, text: message }] };
}

/** The bundled `read-full` extension: the `read_full` tool, and nothing else. */
export function createReadFullExtension(context: ExtensionContext): Extension<ToolRegistration> {
  const declaredCap =
    byteCount(context.getConfig().readFull.maxBytes) ?? DEFAULT_MAX_BYTES;

  return defineExtension({
    name: "read-full",
    tools: [
      defineTool({
        name: "read_full",
        description: DESCRIPTION,
        parameters: obj(
          {
            path: str({ description: "Path to the file to read (relative or absolute)" }),
          },
        ),
        replay: "safe",
        outputLimits: {
          maxBytes: declaredCap + RESULT_SLACK_BYTES,
          // A file of `declaredCap` bytes holds at most that many newline bytes, so its line count is
          // below this. The byte bound is the one that holds; this one only stays out of the way.
          maxLines: declaredCap + 1,
          retain: "head" as const,
        },
        async execute(args, api, chord) {
          const maxBytes = byteCount(context.getConfig().readFull.maxBytes) ?? DEFAULT_MAX_BYTES;
          const env = api.env;
          if (env === undefined) {
            return refusal("read_full needs an execution environment, and this call has none, so no file was read.");
          }

          const resolved = await env.absolutePath(args.path, chord);
          if (!resolved.ok) {
            return refusal(`read_full cannot resolve ${args.path}: ${resolved.error.message}`);
          }
          const path = resolved.value;

          if (await refusesRecordForCall(context, api, chord, "read_full", path)) {
            return recordRefusal("read_full", path);
          }

          const opened = await env.openBinaryReader(path, undefined, chord);
          if (!opened.ok) {
            return refusal(`read_full cannot open ${path}: ${opened.error.message}`);
          }

          const reader = opened.value;
          try {
            const info = await reader.info(chord);
            if (!info.ok) {
              return refusal(`read_full cannot read the size of ${path}: ${info.error.message}`);
            }
            if (info.value.kind !== "file") {
              return refusal(`${path} is a ${info.value.kind}, not a file, so read_full did not read it.`);
            }
            if (info.value.size > maxBytes) {
              return refusal(
                `${path} is ${formatSize(info.value.size)}, over the ${formatSize(maxBytes)} size cap of read_full, ` +
                  "so it was refused and not cut. Read it in parts with read: the first call returns up to 2000 lines or 50KB " +
                  "from line 1, and each later call takes offset=<the next line> (add limit for a smaller part). " +
                  "Or cut the range you need with bash.",
              );
            }

            // Read until the file ends, not until the size read above: a file that grew in between is
            // then refused by the cap below instead of being returned short.
            const chunks: Uint8Array[] = [];
            let total = 0;
            for (;;) {
              const bytes = await reader.read(total, Math.min(READ_CHUNK, maxBytes + 1 - total), chord);
              if (!bytes.ok) {
                return refusal(`read_full cannot read ${path}: ${bytes.error.message}`);
              }
              if (bytes.value.length === 0) break;
              chunks.push(bytes.value);
              total += bytes.value.length;
              if (total > maxBytes) {
                return refusal(
                  `${path} is larger than ${formatSize(maxBytes)}, the size cap of read_full, so it was refused and not cut. ` +
                    "Read it in parts with read: the first call returns up to 2000 lines or 50KB from line 1, and each later call " +
                    "takes offset=<the next line> (add limit for a smaller part). Or cut the range you need with bash.",
                );
              }
            }

            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.length;
            }

            const nul = bytes.indexOf(0);
            if (nul !== -1) {
              return refusal(
                `${path} is ${formatSize(total)} and holds a NUL byte at byte ${nul}, so it is not text and read_full refused it ` +
                  "instead of returning bytes as characters. Read the part you need with read (offset and limit) or with bash.",
              );
            }

            let text: string;
            try {
              // fatal: an invalid UTF-8 sequence is an error here, not U+FFFD in the middle of a file.
              // ignoreBOM keeps a byte-order mark as text, which is what fs.readFileSync(path, "utf8") returns.
              text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
            } catch (error) {
              const reason = error instanceof Error ? error.message : String(error);
              return refusal(
                `${path} is ${formatSize(total)} and is not valid UTF-8 (${reason}), so it is not text and read_full refused it ` +
                  "instead of returning bytes as characters. Read the part you need with read (offset and limit) or with bash.",
              );
            }

            let lines = text === "" ? 0 : 1;
            for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines++;

            return {
              output: text === "" ? [] : [{ type: "text" as const, text }],
              details: { path, bytes: total, lines },
            };
          } finally {
            await reader.close(chord);
          }
        },
      }),
    ],
  });
}
