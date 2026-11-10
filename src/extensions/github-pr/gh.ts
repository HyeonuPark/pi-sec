import { spawn } from "node:child_process";
import { splitRepoSlug } from "./network.ts";
import { repoInfoEndpoint } from "./queries.ts";

/**
 * `gh` as a subprocess, split into a read half and a write half.
 *
 * The split is the point of this module. A read may only run `gh api` and may
 * only send a request that reads: the GraphQL text carries no `mutation`, an
 * explicit `-X`/`--method` is absent or names GET, and a REST read carries no
 * request body. The last rule matters because `gh api` sends a POST, not a GET,
 * as soon as one parameter is added (`-f`, `-F`, `--field`, `--raw-field`,
 * `--input`), even with no method flag. All three rules are checked before a
 * process is started, so a refused read leaves no child behind and no trace in
 * the fake `gh` of a test.
 *
 * The write half is not a mirror image. It refuses a `GET`, and a mutation call
 * has to name `mutation` in its text, so a write can only be a write. Whether
 * this install may write at all is a different question, answered from the
 * config on every call by `writes.ts`; this module only keeps the two halves of
 * the command line apart.
 *
 * Nothing here retries, parses GitHub's JSON beyond unwrapping `data`/`errors`,
 * or keeps state between calls.
 */

/** Ceiling for one `gh` run: a hung child must not pin a request forever. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** A `gh` run that failed, or that could not be started. */
export class GhError extends Error {
  readonly args: readonly string[];

  constructor(message: string, args: readonly string[] = []) {
    super(message);
    this.name = "GhError";
    this.args = args;
  }
}

/**
 * A command line refused before a process was started.
 *
 * It is a `GhError` so a caller that maps "gh went wrong" onto one answer needs
 * no case of its own, but the message says the call never reached GitHub, which
 * is a fault in this code rather than a failure of the remote.
 */
export class GhRefusalError extends GhError {
  constructor(message: string, args: readonly string[] = []) {
    super(message, args);
    this.name = "GhRefusalError";
  }
}

/** Values a GraphQL variable may carry. The original passed nothing else. */
export type GhVariables = Readonly<Record<string, string | number | boolean>>;

export interface GhClientOptions {
  /** The `gh` executable. A test passes the path of the fake. Default `gh`. */
  readonly ghPath?: string;
  /** How long one run may take. Default `DEFAULT_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
  /** Extra environment for the child, on top of the process's own. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory of the child. Defaults to the daemon's own. */
  readonly cwd?: string;
}

export interface GhClient {
  /** The executable this client runs, for a log line or a page. */
  readonly ghPath: string;
  /** Run `gh` and return stdout. Rejects with `GhError` on a non-zero exit. */
  run(args: readonly string[], input?: string): Promise<string>;
}

/** The one `gh` subcommand a read may name. */
const READ_SUBCOMMAND = "api";

/** Any of these tokens in a read's text is a mutation, whatever it wraps. */
const MUTATION_WORD = /\bmutation\b/i;

/**
 * Flags that take a value but add no request parameter. The value is the next
 * argument when the flag carries none of its own, so the scan steps over it.
 */
const VALUE_TAKING_FLAGS = new Set([
  "-X",
  "--method",
  "-H",
  "--header",
  "--hostname",
  "-q",
  "--jq",
  "-t",
  "--template",
  "-p",
  "--preview",
  "--cache",
]);

/**
 * Flags that add a request parameter or a request body. `gh api` switches to POST
 * when any one of them is given, so a read may carry one only with an explicit
 * GET. Each takes a value, in the argument after it or after `=`.
 */
const BODY_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

/** Whether this argument is one of the body flags, in any of its spellings. */
function isBodyFlag(arg: string): boolean {
  if (BODY_FLAGS.has(arg)) return true;
  // The value may be attached: `-ftitle=x`, `-Ftitle=x`, `--field=title=x`,
  // `--raw-field=...`, `--input=f`. No other `api` flag starts with `-f`/`-F`.
  return (
    (arg.length > 2 && (arg.startsWith("-f") || arg.startsWith("-F"))) ||
    arg.startsWith("--field=") ||
    arg.startsWith("--raw-field=") ||
    arg.startsWith("--input=")
  );
}

/** Whether a read's argument list adds a parameter to the request. */
function carriesBodyArgument(args: readonly string[]): boolean {
  return args.some(isBodyFlag);
}

/**
 * The endpoint: the first argument that is not a flag or the value of one.
 *
 * A flag written with its value attached (`-XGET`, `--method=GET`) consumes
 * nothing else; a flag that takes a value consumes the next argument. A flag this
 * list does not know is treated as a boolean one, so a value it takes could be
 * read as the endpoint; that can only make the body check stricter.
 */
function endpointArgument(args: readonly string[]): string | undefined {
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) return arg;
    if (arg.startsWith("--") && arg.includes("=")) continue;
    if (!VALUE_TAKING_FLAGS.has(arg) && !BODY_FLAGS.has(arg)) continue;
    index += 1;
  }
  return undefined;
}

/** The method an argument list names, upper-cased, or undefined when it names none. */
function requestedMethod(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "-X" || arg === "--method") {
      const value = (args[index + 1] ?? "").toUpperCase();
      return value === "" ? undefined : value;
    }
    if (arg.startsWith("--method=")) {
      const value = arg.slice("--method=".length).toUpperCase();
      return value === "" ? undefined : value;
    }
    if (arg.startsWith("-X") && arg.length > 2) return arg.slice(2).toUpperCase();
  }
  return undefined;
}

/**
 * Refuse a command line that a read may not run, before a process exists.
 *
 * The three rules: the subcommand is `api`, the
 * request reads, and a REST request carries no body. A method flag other than GET
 * is refused. So is a body flag (`-f`, `-F`, `--field`, `--raw-field`, `--input`)
 * on an endpoint that is not `graphql`, unless the caller also names GET: `gh api`
 * sends a POST as soon as a parameter is added, whatever the method flag says.
 * A `graphql` endpoint is exempt from that rule because a GraphQL query is a POST
 * that reads, and the mutation check keeps it a query. The mutation check searches
 * every argument, because the GraphQL text travels as one `-f query=...` value.
 */
export function assertReadArguments(args: readonly string[]): void {
  const [command, ...rest] = args;
  if (command !== READ_SUBCOMMAND) {
    throw new GhRefusalError(`gh ${String(command)} is not allowed for a read: only ${READ_SUBCOMMAND} is`, args);
  }
  for (const arg of rest) {
    if (MUTATION_WORD.test(arg)) {
      throw new GhRefusalError("a read may not carry a GraphQL mutation", args);
    }
  }
  const method = requestedMethod(args);
  if (method !== undefined && method !== "GET") {
    throw new GhRefusalError(`a read may not send ${method}: only GET is allowed`, args);
  }
  const endpoint = endpointArgument(args);
  if (endpoint !== "graphql" && carriesBodyArgument(rest) && method !== "GET") {
    throw new GhRefusalError(
      "a REST read may not carry a request body without an explicit GET: gh api sends a POST when a parameter is added",
      args,
    );
  }
}

/**
 * Refuse a command line that is not a write.
 *
 * A write is a mutation or a request with a method of its own, and it never
 * reads. This is the counterweight of `assertReadArguments`: the two halves
 * cannot drift into each other by accident.
 */
export function assertWriteArguments(args: readonly string[]): void {
  const [command, ...rest] = args;
  if (command !== READ_SUBCOMMAND) {
    throw new GhRefusalError(`gh ${String(command)} is not allowed for a write: only ${READ_SUBCOMMAND} is`, args);
  }
  const method = requestedMethod(args);
  if (method === "GET") {
    throw new GhRefusalError("a write may not send GET", args);
  }
  // A call with neither a mutation nor a method of its own is a read, and the
  // write half does not read: the two halves stay apart in both directions.
  const hasMutation = rest.some((arg) => MUTATION_WORD.test(arg));
  if (method === undefined && !hasMutation) {
    throw new GhRefusalError("a write needs a GraphQL mutation or a method that is not GET", args);
  }
}

function runGh(
  ghPath: string,
  args: readonly string[],
  input: string | undefined,
  timeoutMs: number,
  extraEnv: Readonly<Record<string, string>> | undefined,
  cwd: string | undefined,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      const options = {
        // stdin is always a pipe and always closed below: `gh` waits on it when
        // it is asked for `--input -`, and an open pipe would hang the call.
        stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(extraEnv ?? {}),
          // A prompt would wait for a terminal that a daemon does not have.
          GH_PROMPT_DISABLED: "1",
          NO_COLOR: "1",
        },
        ...(cwd === undefined ? {} : { cwd }),
      };
      child = spawn(ghPath, [...args], options);
    } catch (error) {
      reject(new GhError(`cannot run ${ghPath}: ${String(error)}`, args));
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    // The timer must not be the reason the daemon stays awake.
    timer.unref?.();

    child.on("error", (error: Error) => {
      clearTimeout(timer);
      reject(new GhError(`cannot run ${ghPath}: ${error.message}`, args));
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (killed) {
        reject(new GhError(`${ghPath} did not finish within ${timeoutMs}ms`, args));
        return;
      }
      if (code === 0) {
        resolve(stdout);
        return;
      }
      // The original reported whichever stream had text, stderr first.
      const message = (stderr.trim() || stdout.trim() || "gh failed") as string;
      reject(new GhError(message, args));
    });

    child.stdin?.on("error", () => {
      // A child that exited before reading stdin is a failure the close handler
      // reports; an EPIPE here must not become an unhandled error event.
    });
    child.stdin?.end(input ?? "");
  });
}

/**
 * A client for one `gh` executable.
 *
 * `ghPath` is the injection point of the whole extension: the daemon passes
 * nothing and gets `gh` from the PATH, and a test passes the path of the fake so
 * that no real `gh` is ever started.
 */
export function createGhClient(options: GhClientOptions = {}): GhClient {
  const ghPath = options.ghPath ?? "gh";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    ghPath,
    run: (args, input) => runGh(ghPath, args, input, timeoutMs, options.env, options.cwd),
  };
}

function graphqlArgs(query: string, variables: GhVariables): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "boolean") args.push("-F", `${key}=${value ? "true" : "false"}`);
    else if (typeof value === "number") args.push("-F", `${key}=${value}`);
    else args.push("-f", `${key}=${value}`);
  }
  return args;
}

/** Read a GraphQL answer: `data` on success, `GhError` on `errors`. */
async function graphqlAnswer<T>(stdout: string, args: readonly string[]): Promise<T> {
  let payload: { data?: unknown; errors?: { message?: string }[] };
  try {
    payload = JSON.parse(stdout) as typeof payload;
  } catch {
    throw new GhError(`gh returned something that is not JSON: ${stdout.slice(0, 200)}`, args);
  }
  if (payload.errors !== undefined && payload.errors.length > 0) {
    const text = payload.errors.map((error) => error.message ?? JSON.stringify(error)).join("; ");
    throw new GhError(text === "" ? "GraphQL error" : text, args);
  }
  return payload.data as T;
}

/**
 * Read the body of a REST answer.
 *
 * A REST answer is the value itself, not a `data`/`errors` envelope, so there is
 * nothing to unwrap and no partial success to report: `gh` already exits non-zero
 * on a status it did not accept, and `runGh` turns that into a `GhError` that
 * carries GitHub's own message.
 */
function restAnswer<T>(stdout: string, args: readonly string[]): T {
  const text = stdout.trim();
  if (text === "") throw new GhError("gh returned an empty answer", args);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new GhError(`gh returned something that is not JSON: ${text.slice(0, 200)}`, args);
  }
}

export interface GhReader {
  readonly client: GhClient;
  /** Run a GraphQL query and return its `data`. Throws `GhError` on `errors`. */
  graphql<T = unknown>(query: string, variables?: GhVariables): Promise<T>;
  /**
   * Read one REST path and return the body it answered with.
   *
   * The path is relative to `https://api.github.com/` and carries no leading
   * slash, so `repos/owner/repo` names one repository. The method is GET: the
   * argument list carries no method flag and no request parameter, which is what
   * `gh api` needs to send a GET rather than a POST.
   */
  rest<T = unknown>(path: string): Promise<T>;
  /**
   * Run one `gh api` read. The caller builds the argument list; the read rules
   * of `assertReadArguments` apply before anything is started.
   */
  api(args: readonly string[]): Promise<string>;
}

/** The read half: `gh api` queries and reads only. */
export function createGhReader(client: GhClient): GhReader {
  const api = async (args: readonly string[]): Promise<string> => {
    assertReadArguments(args);
    return client.run(args);
  };

  return {
    client,
    api,
    async graphql<T = unknown>(query: string, variables: GhVariables = {}): Promise<T> {
      const args = graphqlArgs(query, variables);
      return graphqlAnswer<T>(await api(args), args);
    },
    async rest<T = unknown>(path: string): Promise<T> {
      // No flag at all: `gh api <path>` is a GET, and any `-f`/`-F` would make
      // `assertReadArguments` refuse it as a REST read that carries a body.
      const args = ["api", path];
      return restAnswer<T>(await api(args), args);
    },
  };
}

export interface GhWriter {
  readonly client: GhClient;
  /** Run a GraphQL mutation and return its `data`. */
  mutation<T = unknown>(query: string, variables?: GhVariables): Promise<T>;
  /**
   * Run one `gh api` write. `input`, when given, becomes the request body, and
   * the argument list has to name `--input -` for it to reach GitHub.
   */
  api(args: readonly string[], input?: string): Promise<string>;
}

/** The write half: mutations and requests with a method of their own. */
export function createGhWriter(client: GhClient): GhWriter {
  const api = async (args: readonly string[], input?: string): Promise<string> => {
    assertWriteArguments(args);
    return client.run(args, input);
  };

  return {
    client,
    api,
    async mutation<T = unknown>(query: string, variables: GhVariables = {}): Promise<T> {
      if (!MUTATION_WORD.test(query)) {
        throw new GhRefusalError("a write must carry a GraphQL mutation", [query]);
      }
      const args = graphqlArgs(query, variables);
      return graphqlAnswer<T>(await api(args), args);
    },
  };
}

/** One repository's fork relationship and size, as a fork resolve needs it. */
export interface RepositoryInfo {
  /** Whether GitHub calls the repository a fork. */
  readonly fork: boolean;
  /**
   * The repository it was forked from, or undefined when GitHub reports none.
   * A private fork can come back without one, and `network.ts` then treats it as
   * the root of its own network.
   */
  readonly source?: { readonly owner: string; readonly name: string } | undefined;
  /** GitHub's size for the repository, in kilobytes. It is an estimate. */
  readonly size: number;
}

/** The part of GitHub's REST answer for one repository that this module reads. */
interface RestRepository {
  readonly full_name?: string;
  readonly fork?: boolean;
  /** GitHub's size for the repository, in kilobytes. */
  readonly size?: number;
  /**
   * The repository at the root of the fork network, for a fork.
   *
   * GitHub leaves the key out entirely on a repository that is not a fork, so
   * both `undefined` and `null` mean "no source".
   */
  readonly source?: { readonly full_name?: string } | null;
}

/**
 * Read one repository's fork relationship, for the fork-network resolver.
 *
 * `network.ts` takes a reader rather than calling `gh` itself, so this is the
 * function a caller wires into it. The one call is a REST GET of the repository,
 * because that answer carries all three values the resolver needs: `fork`,
 * `source.full_name` for the repository at the root of the fork network, and
 * `size` in kilobytes, which is what the disk guard adds up. GitHub's GraphQL
 * `Repository` type has no field for that root repository, so a query cannot
 * answer this question at all; `queries.ts` records the reasoning.
 *
 * A repository GitHub does not answer for fails with `gh`'s own message, which
 * names the status (`gh: Not Found (HTTP 404)`). The resolver reports that
 * message against the configured name, so an operator sees which name is wrong.
 */
export async function fetchRepositoryInfo(reader: GhReader, owner: string, name: string): Promise<RepositoryInfo> {
  const found = await reader.rest<RestRepository | null>(repoInfoEndpoint(owner, name));
  if (found === null) {
    throw new GhError(`repository ${owner}/${name} not found`);
  }
  const parts = found.source?.full_name == null ? undefined : splitRepoSlug(found.source.full_name);
  const source = parts === undefined ? undefined : { owner: parts.owner, name: parts.repo };
  return {
    fork: found.fork === true,
    ...(source === undefined ? {} : { source }),
    size: found.size ?? 0,
  };
}
