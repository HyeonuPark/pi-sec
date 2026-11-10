import { join } from "node:path";
import { sendBody } from "../../server/compress.ts";
import { resolveMount } from "../../server/proxy.ts";
import { json, type RouteContext } from "../../server/router.ts";
import { readPage, renderPage } from "../../server/static.ts";
import { contentSecurityPolicy, fillUiSlots, UI_RENDER_TIMEOUT_MS } from "../../server/ui-page.ts";
import type { ExtensionRouteCleanup, ExtensionRouteContext } from "../index.ts";
import { fetchPrDetail, fetchPrRefs } from "./detail.ts";
import { CommitNotInPrError, computeCommitDiff, computePrDiff } from "./diff.ts";
import {
  createGhClient,
  createGhReader,
  createGhWriter,
  fetchRepositoryInfo,
  GhError,
  type GhReader,
  type GhWriter,
} from "./gh.ts";
import { fetchPrList, type PrListPayload } from "./list.ts";
import { createPrListCache, type ListCacheTimers, type PrListCache } from "./list-cache.ts";
import { configuredRepository, createSettingsReader, DISK_LIMIT_DEFAULT_MEGABYTES, splitRepository, type GithubPrSettings } from "./settings.ts";
import { createReviewDraftStore, DraftInputError, readOp } from "./review-drafts.ts";
import { createRepoStore, DiskLimitError } from "./store.ts";
import {
  commentOnPullRequest,
  replyToThread,
  resolveThread,
  editComment,
  editDescription,
  setReaction,
  submitReview,
  WriteConflictError,
  WritesDisabledError,
  WriteInputError,
  type ReactionContent,
  type ReviewEvent,
  type ReviewLineComment,
  type WriteContext,
} from "./writes.ts";

/**
 * The web routes of the pull request dashboard: three pages, one read API and
 * its event stream, and five write APIs.
 *
 * Everything that reads GitHub, keeps a bare repository or computes a diff lives
 * in the modules beside this file; this module is the wiring and the HTTP
 * answers, and the paths are fixed. Three
 * rules run through it.
 *
 *   1. **The config is read again per request and per poll.** `githubPr` may
 *      change between two requests, so nothing here holds a settings value: the
 *      reader is a function over the config that is loaded now. That covers the
 *      disk cap too, which the store asks for at every check. The only value a
 *      process cannot re-read is the repository store's root.
 *   2. **A refusal is a flat `{ "error": "<message>" }`.** That is the shape
 *      the pages read (`src/ui/api/github-pr.ts`), not the `{ "error": { code,
 *      message } }` envelope the fixed routes of this server use.
 *   3. **A page is the shell plus data blocks.** The shell is the file in
 *      `src/web`, the data blocks are what the page can draw before its first
 *      request, and both are written as `<script type="application/json">` with
 *      every `<` escaped, so no value can close the element early and the
 *      page's `script-src 'self'` policy has nothing to refuse.
 *
 * The cleanup this module returns stops the poll, which is the only thing here
 * that outlives a request, and then waits for the work that was already running:
 * the boot reconcile and every read it started write into the repository root,
 * so a caller that removes that root must not race them.
 */

/** The SSE event name of the dashboard: the cached list changed. */
export const PRS_EVENT = "prs";

/** The SSE channel key, one channel for every open dashboard page. */
const EVENTS_CHANNEL = "github-pr";

/** The shell of each page, under `src/web` (and the built `web` directory). */
const LIST_PAGE = "github-pr-list.html";
const VIEW_PAGE = "github-pr-view.html";
const DIFF_PAGE = "github-pr-diff.html";

/** A full commit id as the commit routes accept it. */
const COMMIT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

/** The two markers the shells leave for the server, and the ids they become. */
const META_MARKER = "<!--github-pr-meta-->";
const META_ID = "github-pr-meta";
const LIST_FIRST_MARKER = "<!--github-pr-list-first-->";
const LIST_FIRST_ID = "github-pr-list-first";

/** The directory the bare repositories live in, under the pi-sec home. */
export const REPO_DIRECTORY = "gh-repo";

/**
 * What a caller may inject for this extension through
 * `ServerOptions.extensionRoutes["github-pr"]`.
 *
 * The daemon passes none of it and gets the real inputs: the `gh` on `PATH`, the
 * `gh-repo` directory under the pi-sec home, and the system clock and timers. A
 * test passes a fake `gh`, a temporary repository root and a clock here instead
 * of replacing a global that the whole process shares.
 *
 * Every field is optional and an absent field means the real thing. Only
 * `repoRoot` is fixed for the life of a process, because the store it reaches is
 * made once when the routes are registered. Every other field is read when it is
 * needed, and the disk cap of the config is read at every check, so a reload of
 * `githubPr` reaches a running daemon.
 */
export interface GithubPrRouteOptions {
  /** The `gh` executable. Default `gh`, found on `PATH`. */
  readonly ghPath?: string;
  /**
   * Extra environment for the `gh` child, on top of the process's own. A test
   * passes the fake's response directory and log file here, and keeps the same
   * object so that a later change of it reaches the next call.
   */
  readonly ghEnv?: Readonly<Record<string, string>>;
  /** Absolute path of the `gh-repo` directory. Default `<pi-sec home>/gh-repo`. */
  readonly repoRoot?: string;
  /**
   * How a remote's URL is built from `owner/repo`. Default GitHub's HTTPS URL.
   * A test points this at a local repository.
   */
  readonly remoteUrl?: (slug: string) => string;
  /** The clock, for the store's 24-hour reconcile interval. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * The directory the review drafts live in, one file per pull request. Default
   * `<pi-sec home>/state/github-pr/review-drafts`. A test passes its own.
   */
  readonly draftsDir?: string;
  /** The poll's timer functions. Default `setTimeout`/`clearTimeout`. */
  readonly timers?: ListCacheTimers;
  /**
   * The cap on `gh-repo`, in megabytes; 0 means no limit. Default the config's
   * `githubPr.diskLimitMegabytes`, read again at every disk check. A test sets it
   * small to reach a refusal, and where it is set it wins over the config.
   */
  readonly diskLimitMegabytes?: number | (() => number);
  /** How often a fork network is read again. Default 24 hours; a test may shrink it. */
  readonly reconcileIntervalMs?: number;
  /**
   * Where the three shells are read from. Default `deps.webDir`, which is the
   * directory the daemon serves. A test that wants its own shell passes one.
   */
  readonly webDir?: string;
}

/** Read an options object that arrived as `unknown`, ignoring fields of the wrong type. */
function optionsOf(value: unknown): GithubPrRouteOptions {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof raw["ghPath"] === "string") out["ghPath"] = raw["ghPath"];
  if (typeof raw["ghEnv"] === "object" && raw["ghEnv"] !== null) out["ghEnv"] = raw["ghEnv"];
  if (typeof raw["repoRoot"] === "string") out["repoRoot"] = raw["repoRoot"];
  if (typeof raw["draftsDir"] === "string") out["draftsDir"] = raw["draftsDir"];
  if (typeof raw["remoteUrl"] === "function") out["remoteUrl"] = raw["remoteUrl"];
  if (typeof raw["now"] === "function") out["now"] = raw["now"];
  if (typeof raw["timers"] === "object" && raw["timers"] !== null) out["timers"] = raw["timers"];
  if (typeof raw["diskLimitMegabytes"] === "number") out["diskLimitMegabytes"] = raw["diskLimitMegabytes"];
  if (typeof raw["diskLimitMegabytes"] === "function") out["diskLimitMegabytes"] = raw["diskLimitMegabytes"];
  if (typeof raw["reconcileIntervalMs"] === "number") out["reconcileIntervalMs"] = raw["reconcileIntervalMs"];
  if (typeof raw["webDir"] === "string") out["webDir"] = raw["webDir"];
  return out as GithubPrRouteOptions;
}

/** The answer for a path that names nothing this extension can show. */
function notFound(res: RouteContext["res"]): void {
  json(res, 404, { error: "not found" });
}

/** One refusal of this extension: the flat `{ "error": "<message>" }` body. */
function refuse(res: RouteContext["res"], status: number, message: string): void {
  json(res, status, { error: message });
}

/** The message of a failure, whatever it is. */
function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  const text = String(error ?? "");
  return text === "" ? "the request failed" : text;
}

/** A pull request number from a URL, or `undefined` when it is not one. */
function numberParam(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,18}$/.test(raw)) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** One pull request a request names: the configured spelling and its parts. */
interface PrTarget {
  /** The configured spelling, `owner/repo`, as every payload shows it. */
  readonly repo: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
}

/**
 * Put a value into a page as a JSON data block.
 *
 * The block is data, not code: its type is `application/json`, so the browser
 * parses it and never runs it. Every `<` is written as `\u003c`, so no value can
 * close the element early; the rest of the JSON needs no escaping inside a
 * `script` element. The same technique and the same reason as the usage page's
 * `#usage-first` block.
 */
function dataBlock(id: string, value: unknown): string {
  const body = JSON.stringify(value ?? null).replaceAll("<", "\\u003c");
  return `<script type="application/json" id="${id}">${body}</script>`;
}

/**
 * Replace one marker in a shell, and leave the shell alone when the marker is
 * not there.
 *
 * The replacement is a function, not a string: `String.replace` reads `$` in a
 * string replacement as a pattern (`$&`, `$'`, `$1`), and a JSON block can carry
 * a `$` in any text it holds, such as a pull request's title.
 */
export function fillMarker(html: string, marker: string, replacement: string): string {
  return html.includes(marker) ? html.replace(marker, () => replacement) : html;
}

/** A `Content-Type` that names JSON, which every write of this extension requires. */
function isJsonRequest(context: RouteContext): boolean {
  const header = context.req.headers["content-type"] ?? "";
  return header.toLowerCase().includes("application/json");
}

/** A request body read as an object, or `undefined`. */
function bodyObject(body: unknown): Record<string, unknown> | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  return body as Record<string, unknown>;
}

/**
 * Register the dashboard's routes, start the poll, and return the cleanup that
 * stops it.
 *
 * The poll starts here rather than at the first request, because the first
 * page a reader opens already has the list. It reads
 * GitHub at once and then waits the configured interval after each cycle.
 */
export function registerGithubPrRoutes(context: ExtensionRouteContext): ExtensionRouteCleanup {
  const { router, deps } = context;
  const options = optionsOf(context.options);
  const logger = deps.runtime.logger;

  const client = createGhClient({
    ...(options.ghPath === undefined ? {} : { ghPath: options.ghPath }),
    ...(options.ghEnv === undefined ? {} : { env: options.ghEnv }),
  });
  const reader: GhReader = createGhReader(client);
  const writer: GhWriter = createGhWriter(client);

  // Read fresh on every request and every poll: a config reload changes what
  // this extension shows and may write without a restart.
  const settings = createSettingsReader(() => deps.runtime.getConfig());
  const currentSettings = (): GithubPrSettings | undefined => settings();

  const repoRoot = options.repoRoot ?? join(deps.runtime.paths.home, REPO_DIRECTORY);
  // The disk cap is read at every check, so a reload of `githubPr` reaches this
  // process: the store holds a function, not the number it answered with when
  // the routes were registered. A test that passes a cap wins over the config.
  const diskLimitMegabytes =
    options.diskLimitMegabytes ??
    (() => currentSettings()?.diskLimitMegabytes ?? DISK_LIMIT_DEFAULT_MEGABYTES);
  const store = createRepoStore({
    root: repoRoot,
    diskLimitMegabytes,
    ...(options.remoteUrl === undefined ? {} : { remoteUrl: options.remoteUrl }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.reconcileIntervalMs === undefined ? {} : { reconcileIntervalMs: options.reconcileIntervalMs }),
    // The fork relation is read with the read half of `gh`, one repository at a
    // time, by the resolver inside the store.
    read: (owner, name) => fetchRepositoryInfo(reader, owner, name),
  });

  const drafts = createReviewDraftStore({
    dir: options.draftsDir ?? join(deps.runtime.paths.stateDir, "github-pr", "review-drafts"),
    ...(options.now === undefined ? {} : { now: options.now }),
    logger,
  });

  const channel = deps.sse.channel(EVENTS_CHANNEL);

  /**
   * Reconcile the bare repositories, one call at a time.
   *
   * Registration, every poll and every diff ask for this, and the store's
   * reconcile is not reentrant: two of them at once would write the same mapping
   * and could prune a remote the other is about to use. The chain makes the
   * calls run in the order they were asked for.
   *
   * A failure is logged and nothing else: matching the bare repositories to the
   * configured list is housekeeping, and a config that no longer matches must not
   * take the list or a diff down with it.
   */
  let reconcileChain: Promise<void> = Promise.resolve();
  /**
   * Whether the server has closed. Nothing new starts after that: a read asks
   * for no housekeeping any more, and the cleanup waits for what is running.
   */
  let closing = false;
  const reconcileQuietly = (repos: readonly string[]): Promise<void> => {
    // A reconcile started during the close would write into the repository root
    // after the caller of `close` may have removed it, so none starts.
    if (closing) return Promise.resolve();
    const run = reconcileChain.then(async () => {
      try {
        const report = await store.reconcileIfDue(repos);
        if (report === undefined) return;
        for (const failure of report.failures) {
          logger.warn("github-pr reconcile", { repo: failure.repo, reason: failure.message });
        }
      } catch (error) {
        logger.warn("github-pr reconcile failed", { error });
      }
    });
    reconcileChain = run;
    return run;
  };

  // The configured repositories as they are now, or none when the key is absent.
  // A config without `githubPr` while the extension is enabled is refused by the
  // loader, so this only reaches a test that built a config by hand.
  const configuredRepos = (): readonly string[] => currentSettings()?.repos ?? [];

  /** Read GitHub for the list, after the housekeeping a poll or a page asks for. */
  const fetchList = async (): Promise<PrListPayload> => {
    const active = currentSettings();
    if (active === undefined) throw new GhError("the githubPr settings are missing from the config");
    await reconcileQuietly(active.repos);
    const payload = await fetchPrList(reader, active.repos);
    return payload;
  };

  const cache: PrListCache = createPrListCache({
    fetch: fetchList,
    // Read at every cycle, so a reload of the interval changes the pace.
    interval: () => currentSettings()?.fetchIntervalSeconds ?? 300,
    onChange: () => {
      // The frame is a request to read the list again, not a payload: every open
      // page asks the list route, which is the one answer that is current.
      channel.publish(PRS_EVENT, {});
    },
    ...(options.timers === undefined ? {} : { timers: options.timers }),
  });

  /** Resolve the repository and number a request names, or answer 404 and return `undefined`. */
  const targetOf = (route: RouteContext): PrTarget | undefined => {
    const active = currentSettings();
    const owner = route.params["owner"] ?? "";
    const name = route.params["repo"] ?? "";
    const number = numberParam(route.params["number"]);
    const repo = active === undefined ? undefined : configuredRepository(active, owner, name);
    if (repo === undefined || number === undefined) {
      notFound(route.res);
      return undefined;
    }
    const parts = splitRepository(repo);
    return { repo, owner: parts.owner, name: parts.name, number };
  };

  /* ---------------------------------------------------------------- pages */

  const webDir = options.webDir ?? deps.webDir;

  /**
   * The facts every dashboard page carries: who `gh` is logged in as, which
   * repositories the operator configured, and whether the write routes answer.
   *
   * The viewer comes from the cached list, which is the only place this process
   * holds it; `null` means no list was read yet and the page asks for one. The
   * repository list is the configured spelling, in file order.
   */
  const meta = (): { viewer: string | null; repos: { repo: string }[]; writes: boolean } => {
    const active = currentSettings();
    return {
      viewer: cache.current()?.viewer ?? null,
      repos: (active?.repos ?? []).map((repo) => ({ repo })),
      writes: active?.writes === true,
    };
  };

  /**
   * Answer one page: the shell, stamped with the mount prefix and the time zone,
   * the meta block, and on the list page the list this process already holds.
   *
   * The order is the usage page's: stamp the mount and the zone, fill the UI
   * slots, then write the blocks. A card's own text is never read as one of the
   * shell's placeholders that way, and the nonce a rendered card needs is the one
   * the policy below names. These three shells open no slot today, so the policy
   * carries no nonce; the call stays because it is what makes a card on one of
   * them work without a second edit here.
   */
  const answerPage = async (
    route: RouteContext,
    shell: string,
    extra: { readonly listFirst?: boolean; readonly externalImages?: boolean },
  ): Promise<void> => {
    const raw = await readPage(webDir, shell);
    if (raw === undefined) {
      refuse(route.res, 500, `the page shell ${shell} is not installed`);
      return;
    }
    const config = deps.runtime.getConfig();
    const prefix = resolveMount(route.req, config).prefix;
    const page = await fillUiSlots(renderPage(raw, prefix, config.timezone), {
      ui: deps.runtime.ui,
      prefix,
      timezone: config.timezone,
      renderTimeoutMs: UI_RENDER_TIMEOUT_MS,
      logger,
    });
    let html = fillMarker(page.html, META_MARKER, dataBlock(META_ID, meta()));
    if (extra.listFirst === true) {
      html = fillMarker(html, LIST_FIRST_MARKER, dataBlock(LIST_FIRST_ID, cache.current() ?? null));
    }
    sendBody(route.res, {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: html,
      headers: {
        // A page carries the list this process held at that moment, so a cached
        // copy would be a page that says nothing about now.
        "Cache-Control": "no-cache",
        // The pull request page allows images from `https:` origins, because a
        // description may embed one on GitHub's asset host. The list and diff
        // pages carry no such image and keep the policy of every other page.
        "Content-Security-Policy": contentSecurityPolicy(page.nonce, {
          externalImages: extra.externalImages === true,
        }),
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      },
    });
  };

  router.get("/github/pr/", async (route) => {
    await answerPage(route, LIST_PAGE, { listFirst: true });
  });

  router.get("/github/pr/:owner/:repo/:number", async (route) => {
    if (targetOf(route) === undefined) return;
    await answerPage(route, VIEW_PAGE, { externalImages: true });
  });

  router.get("/github/pr/:owner/:repo/:number/diff", async (route) => {
    if (targetOf(route) === undefined) return;
    await answerPage(route, DIFF_PAGE, {});
  });

  router.get("/github/pr/:owner/:repo/:number/commits/:sha", async (route) => {
    if (targetOf(route) === undefined) return;
    if (!COMMIT_ID.test(route.params["sha"] ?? "")) {
      notFound(route.res);
      return;
    }
    await answerPage(route, DIFF_PAGE, {});
  });

  /* ----------------------------------------------------------------- read */

  router.get("/api/github/pr/list", async (route) => {
    const force = route.url.searchParams.get("refresh") === "1";
    try {
      // A forced refresh reads GitHub now and replaces the copy; when it fails
      // the copy stays as it was and the failure is the answer.
      json(route.res, 200, await cache.load(force ? { force: true } : {}));
    } catch (error) {
      logger.warn("github-pr list failed", { requestId: route.requestId, error });
      refuse(route.res, 502, messageOf(error));
    }
  });

  router.get("/api/github/pr/events", async (route) => {
    // The dashboard's one event: a frame that says the cached list moved. No
    // snapshot is sent, because a page that opens this stream asks the list route
    // for its first answer and a frame carries no data either way.
    channel.attach(route.req, route.res);
  });

  router.get("/api/github/pr/:owner/:repo/:number", async (route) => {
    const target = targetOf(route);
    if (target === undefined) return;
    try {
      // A read with no cache: GitHub answers every open of this page.
      const detail = await fetchPrDetail(reader, { owner: target.owner, name: target.name }, target.number);
      json(route.res, 200, { ...detail, repo: target.repo });
    } catch (error) {
      logger.warn("github-pr detail failed", { requestId: route.requestId, error });
      refuse(route.res, 502, messageOf(error));
    }
  });

  router.get("/api/github/pr/:owner/:repo/:number/diff", async (route) => {
    const target = targetOf(route);
    if (target === undefined) return;
    try {
      // A diff is the moment the bare repository is needed, so it is also a
      // moment to bring that repository in line with the configured list.
      await reconcileQuietly(configuredRepos());
      const refs = await fetchPrRefs(reader, { owner: target.owner, name: target.name }, target.number);
      const diff = await computePrDiff({
        store,
        repo: target.repo,
        number: target.number,
        baseRef: refs.baseRefName,
        headSha: refs.headRefOid,
      });
      // `repo` and `title` are the two fields the diff does not compute: the
      // first is the configured spelling and the second comes from GitHub.
      json(route.res, 200, { ...diff, repo: target.repo, title: refs.title });
    } catch (error) {
      if (error instanceof DiskLimitError) {
        // A first fetch refused by the disk guard, with the three sizes the page
        // shows. Nothing was fetched, so there is nothing to retry.
        json(route.res, 409, error.toPayload());
        return;
      }
      logger.warn("github-pr diff failed", { requestId: route.requestId, error });
      refuse(route.res, 502, messageOf(error));
    }
  });

  router.get("/api/github/pr/:owner/:repo/:number/commits/:sha", async (route) => {
    const target = targetOf(route);
    if (target === undefined) return;
    const sha = route.params["sha"] ?? "";
    if (!COMMIT_ID.test(sha)) {
      notFound(route.res);
      return;
    }
    try {
      await reconcileQuietly(configuredRepos());
      const refs = await fetchPrRefs(reader, { owner: target.owner, name: target.name }, target.number);
      const diff = await computeCommitDiff({
        store,
        repo: target.repo,
        number: target.number,
        headSha: refs.headRefOid,
        sha,
      });
      json(route.res, 200, { ...diff, repo: target.repo, title: refs.title });
    } catch (error) {
      if (error instanceof CommitNotInPrError) {
        refuse(route.res, 404, error.message);
        return;
      }
      if (error instanceof DiskLimitError) {
        json(route.res, 409, error.toPayload());
        return;
      }
      logger.warn("github-pr commit diff failed", { requestId: route.requestId, error });
      refuse(route.res, 502, messageOf(error));
    }
  });

  /* --------------------------------------------------------- review drafts */

  /**
   * Run one draft route. The write switch does not guard these routes: they do
   * not reach GitHub. A body that is not JSON is `415` on the POST, as on the
   * write routes, and a repository that is not configured is `404`.
   */
  const draftRoute = async (route: RouteContext, post: boolean, work: (target: PrTarget) => Promise<object>): Promise<void> => {
    if (post && !isJsonRequest(route)) {
      refuse(route.res, 415, "send this request with Content-Type: application/json");
      return;
    }
    const target = targetOf(route);
    if (target === undefined) return;
    try {
      json(route.res, 200, await work(target));
    } catch (error) {
      if (error instanceof DraftInputError) {
        refuse(route.res, 400, error.message);
        return;
      }
      logger.warn("github-pr draft failed", { requestId: route.requestId, error });
      refuse(route.res, 500, messageOf(error));
    }
  };

  router.get("/api/github/pr/:owner/:repo/:number/draft", async (route) => {
    await draftRoute(route, false, (target) => drafts.get(target));
  });

  router.post("/api/github/pr/:owner/:repo/:number/draft", async (route) => {
    await draftRoute(route, true, async (target) => {
      const change = readOp(route.body, new Date((options.now ?? Date.now)()).toISOString());
      return await drafts.apply(target, change);
    });
  });

  /* ---------------------------------------------------------------- write */

  /**
   * Run one write and answer it.
   *
   * The order of the refusals is fixed, and it is the
   * order a caller reads: a body that is not JSON is `415`, before anything reads
   * it as a write; the repository and the number are `404`; the switch is `403`;
   * the body's fields are `400`; text that changed on GitHub since the page read it is
   * `409`; a failure of `gh` is `502`. `WritesDisabledError`
   * is a type of its own, deliberately not a `GhError`, so a switched-off install
   * says `403` rather than `502`, and `writes.ts` checks the switch again on its
   * own way to `gh`: this route cannot be the only guard. The audit row is
   * written by `writes.ts`, which is why the context carries the daemon's log:
   * one row per write that reached GitHub, never with the body.
   */
  const runWrite = async (route: RouteContext, work: (target: PrTarget) => Promise<object | void>): Promise<void> => {
    // A cross-site form cannot send `application/json`, so a form is refused here
    // before a body is looked at, whatever `writes` says.
    if (!isJsonRequest(route)) {
      refuse(route.res, 415, "send this request with Content-Type: application/json");
      return;
    }
    const target = targetOf(route);
    if (target === undefined) return;
    // The switch comes before the body: a switched-off install refuses without
    // reading what it would have written, and `writes.ts` checks it again on the
    // way to `gh`, so no path can skip the check.
    if (currentSettings()?.writes !== true) {
      refuse(route.res, 403, "writes are disabled");
      return;
    }
    try {
      const extra = await work(target);
      json(route.res, 200, { ok: true, ...(extra ?? {}) });
    } catch (error) {
      if (error instanceof WritesDisabledError) {
        refuse(route.res, 403, "writes are disabled");
        return;
      }
      if (error instanceof WriteInputError) {
        refuse(route.res, 400, error.message);
        return;
      }
      if (error instanceof WriteConflictError) {
        refuse(route.res, 409, error.message);
        return;
      }
      logger.warn("github-pr write failed", { requestId: route.requestId, error });
      refuse(route.res, 502, messageOf(error));
    }
  };

  const writeContext = (target: PrTarget): WriteContext => ({
    settings: currentSettings,
    repo: target.repo,
    number: target.number,
    audit: deps.runtime.audit,
    writer,
    reader,
  });

  router.post("/api/github/pr/:owner/:repo/:number/reply", async (route) => {
    await runWrite(route, async (target) => {
      const body = bodyObject(route.body);
      if (body === undefined) throw new WriteInputError("the body must be a JSON object");
      const text = body["body"];
      if (typeof text !== "string") throw new WriteInputError("body must be a string");
      const thread = body["threadId"];
      if (thread !== undefined && thread !== null && typeof thread !== "string") {
        throw new WriteInputError("threadId must be a string");
      }
      // One path, two meanings: a thread id makes it a reply inside a review
      // thread, and no thread id makes it a comment on the whole pull request.
      if (typeof thread === "string" && thread !== "") await replyToThread(writeContext(target), thread, text);
      else await commentOnPullRequest(writeContext(target), text);
    });
  });

  router.post("/api/github/pr/:owner/:repo/:number/reaction", async (route) => {
    await runWrite(route, async (target) => {
      const body = bodyObject(route.body);
      if (body === undefined) throw new WriteInputError("the body must be a JSON object");
      const subjectId = body["subjectId"];
      const content = body["content"];
      const add = body["add"];
      if (typeof subjectId !== "string") throw new WriteInputError("subjectId must be a string");
      if (typeof content !== "string") throw new WriteInputError("content must be a string");
      if (typeof add !== "boolean") throw new WriteInputError("add must be true or false");
      await setReaction(writeContext(target), subjectId, content as ReactionContent, add);
    });
  });

  router.post("/api/github/pr/:owner/:repo/:number/resolve", async (route) => {
    await runWrite(route, async (target) => {
      const body = bodyObject(route.body);
      if (body === undefined) throw new WriteInputError("the body must be a JSON object");
      const thread = body["threadId"];
      if (typeof thread !== "string" || thread.trim() === "") throw new WriteInputError("threadId must be a string");
      return { thread: await resolveThread(writeContext(target), thread) };
    });
  });

  router.post("/api/github/pr/:owner/:repo/:number/edit", async (route) => {
    await runWrite(route, async (target) => {
      const body = bodyObject(route.body);
      if (body === undefined) throw new WriteInputError("the body must be a JSON object");
      const text = body["body"];
      const base = body["baseBody"];
      const commentId = body["commentId"];
      if (typeof text !== "string") throw new WriteInputError("body must be a string");
      if (typeof base !== "string") throw new WriteInputError("baseBody must be a string");
      if (commentId !== undefined && commentId !== null && typeof commentId !== "string") {
        throw new WriteInputError("commentId must be a string");
      }
      // One path, two meanings: a comment id edits that comment, and no comment id
      // edits the description of the pull request.
      if (typeof commentId === "string") return await editComment(writeContext(target), commentId, text, base);
      return await editDescription(writeContext(target), text, base);
    });
  });

  router.post("/api/github/pr/:owner/:repo/:number/review", async (route) => {
    await runWrite(route, async (target) => {
      const body = bodyObject(route.body);
      if (body === undefined) throw new WriteInputError("the body must be a JSON object");
      const event = body["event"];
      const summary = body["body"] ?? "";
      if (typeof event !== "string") throw new WriteInputError("event must be a string");
      if (typeof summary !== "string") throw new WriteInputError("body must be a string");
      const rawComments = body["comments"] ?? [];
      if (!Array.isArray(rawComments)) throw new WriteInputError("comments must be a list");
      const comments: ReviewLineComment[] = rawComments.map((item, index) => {
        const comment = bodyObject(item);
        if (comment === undefined) throw new WriteInputError(`comments[${index}] must be an object`);
        const text = comment["body"];
        const path = comment["path"];
        const side = comment["side"];
        const line = comment["line"];
        const startLine = comment["startLine"] ?? null;
        if (typeof text !== "string") throw new WriteInputError(`comments[${index}].body must be a string`);
        if (typeof path !== "string") throw new WriteInputError(`comments[${index}].path must be a string`);
        if (side !== "LEFT" && side !== "RIGHT") throw new WriteInputError(`comments[${index}].side must be LEFT or RIGHT`);
        if (typeof line !== "number") throw new WriteInputError(`comments[${index}].line must be a number`);
        if (startLine !== null && typeof startLine !== "number") {
          throw new WriteInputError(`comments[${index}].startLine must be a number`);
        }
        return { body: text, path, side, line, startLine };
      });
      const draftIds = body["draftCommentIds"];
      if (draftIds !== undefined && (!Array.isArray(draftIds) || draftIds.some((id) => typeof id !== "string"))) {
        throw new WriteInputError("draftCommentIds must be a list of strings");
      }
      await submitReview(writeContext(target), event as ReviewEvent, summary, comments);
      // GitHub accepted the review. A failure above leaves the draft as it was.
      try {
        if (draftIds !== undefined) await drafts.removeSubmitted(target, draftIds as string[]);
      } catch (error) {
        logger.warn("github-pr draft cleanup after submit failed", { requestId: route.requestId, error });
      }
    });
  });

  /* ------------------------------------------------------------------ poll */

  // At boot, and then on the schedule the config states. The first cycle reads
  // GitHub at once, so a page opened right after a restart has its rows.
  void reconcileQuietly(configuredRepos());
  cache.start();

  return async () => {
    // The order is the point: stop first, so no timer and no later read starts
    // another cycle, and then wait for the boot cycle and every reconcile it
    // chained. `store.reconcile` maps the networks before it writes, so a
    // directory removed during it leaves `ENOTEMPTY` behind.
    closing = true;
    cache.stop();
    await cache.settled();
    await reconcileChain;
  };
}
