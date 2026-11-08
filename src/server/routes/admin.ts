import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isModelSetupMode } from "../../agent/model-setup.ts";
import { reloadConfigAndRoot } from "../config-reload.ts";
import { readAuditTail } from "../../runtime/audit.ts";
import { writeSecretText, type SecretWriteFailure } from "../../secrets/upload.ts";
import { legacyScheduleProblem } from "../streams.ts";
import { apiError, intParam, json, type Router } from "../router.ts";
import { API_VERSION, type AppDeps, type UiRestartOutcome } from "../deps.ts";

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
}

/** One sentence per failure code, written for a page to show as it is. */
const UI_RESTART_MESSAGES: Record<"source_missing" | "web_dir_missing" | "sync_failed" | "build_failed", string> = {
  source_missing: "the web source directory does not exist",
  web_dir_missing: "the web directory to replace does not exist",
  sync_failed: "the web assets could not be replaced",
  build_failed: "the web pages could not be built from the workspace",
};

/**
 * One fixed sentence per refusal, and nothing taken from the request.
 *
 * A refusal never quotes the name, the text, or an error object: the text is a
 * secret, and an interpolated error is how a body ends up in a response through
 * a path nobody was looking at.
 */
const SECRET_WRITE_MESSAGES: Record<SecretWriteFailure, string> = {
  invalid_name:
    "the name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$, must not be env, and must not end with a dot",
  empty_secret: "the secret text is empty",
  name_exists: "a secret with that name already exists",
  write_failed: "the secret could not be written",
};

const SECRET_WRITE_STATUS: Record<SecretWriteFailure, number> = {
  invalid_name: 400,
  empty_secret: 400,
  name_exists: 409,
  write_failed: 500,
};

export function registerAdmin(router: Router, deps: AppDeps): void {
  router.get("/api/admin/status", async (route) => {
    const registry = deps.runtime.registry.snapshot();
    const restart = deps.adminState.restart.status;
    // A watch that is not installed (the extension is off) holds nothing, and a
    // read that fails says the same: a status route must not fail because one
    // field could not be built.
    const usageHold = await deps.runtime.usageFreeze
      ?.holdView(BACKGROUND_CONTEXT)
      .catch(() => []) ?? [];
    json(route.res, 200, {
      version: deps.version,
      apiVersion: API_VERSION,
      uptimeMs: Date.now() - deps.startedAt,
      // Two facts, not one: `restartRequired` is the truth, `restartReady` is
      // the signal that the batch is closed and its gate passed. A page must be
      // able to tell "a core change is waiting" from "go ahead now".
      restartRequired: restart.required,
      restartReady: restart.ready,
      restartRequiredAt: restart.requiredAt ?? null,
      restartReadyAt: restart.readyAt ?? null,
      // Sections whose source moved while their session keeps the value it started
      // with. A page that loads after the fact has to see this too, which is why
      // it is state on the status endpoint and not only an event.
      sectionsStale: deps.runtime.sections.staleConversations(),
      configError: deps.adminState.configError ?? null,
      // True while `agent.vmodel` is empty: the daemon runs with no root model and
      // the page asks for the first one. `vmodelKeys` names what config.json declares.
      modelSetupRequired: isModelSetupMode(deps.runtime.getConfig()),
      vmodelKeys: Object.keys(deps.runtime.getConfig().vmodels),
      notes: deps.adminState.notes.all(),
      extensions: registry.installed().map((extension) => extension.name),
      runtimeExtensions: deps.runtime.loader.list(),
      secretNames: deps.runtime.secrets.names(),
      scheduler: deps.runtime.getConfig().scheduler.enabled ? "running" : "disabled",
      config: {
        // The model is chosen by name now. Reporting the name rather than a
        // resolved pair keeps one answer to "which model", and nothing read the
        // pair: a chat page draws the model from the conversation snapshot.
        vmodel: deps.runtime.getConfig().agent.vmodel,
        server: { bind: deps.runtime.getConfig().server.bind, port: deps.runtime.getConfig().server.port, basePath: deps.runtime.getConfig().server.basePath },
      },
      // The providers whose usage limit is holding conversations right now, one
      // entry per provider, and the empty list when nothing is held. Read from
      // documents and from the last signal each provider gave, so the answer costs
      // no provider call; the banner draws it and hides when it is empty.
      usageHold,
    });
  });

  router.post("/api/admin/reload", async (route) => {
    const result = await deps.runtime.loader.reload();
    deps.runtime.events.emit("extension_reloaded", { reloaded: result.reloaded, errors: result.errors });

    if (deps.reloadConfig !== undefined) {
      const reloaded = await reloadConfigAndRoot(deps);
      if (!reloaded.ok) {
        // A config that cannot load, or whose root vmodel the boot would refuse,
        // is not a successful reload. Returning 200 with a note nobody renders is
        // how a silently broken config survives: the daemon keeps serving the
        // config it started with, and the operator believes the new one is live.
        // Answer with the reasons instead.
        //
        // Deliberately no restartRequired: a restart would read the same file and
        // refuse to start. A running daemon on the last config that worked is a
        // better place to leave the operator than a daemon that cannot boot.
        json(route.res, 400, {
          status: "config_failed",
          issues: reloaded.issues,
          restartRequired: deps.adminState.restart.status.required,
          // The config on disk did not apply, so the running one is still live and
          // its legacy list is what fires (or does not) right now.
          legacyScheduleProblem: await legacyScheduleProblem(deps.runtime),
        });
        return;
      }
    }

    // The secret names are part of what `/api/admin/status` answers, and a file
    // the operator removed with `rm` is invisible to the registry until the
    // registry lists the directory again. This is the re-read the secret write
    // route already calls, so one answer covers config, extensions and the store,
    // and "reloaded" is never said over a name list that still shows a file that
    // is gone. It comes after the config step, because a refused config answers
    // `400` and the operator needs that reason more than a stale name list.
    await deps.runtime.secrets.reload();

    json(route.res, 200, {
      status: "reloaded",
      ...result,
      // A non-null value here means `config.scheduler.jobs` is non-empty and is
      // being ignored: the schedule lives on the job records now.
      legacyScheduleProblem: await legacyScheduleProblem(deps.runtime),
    });
  });

  router.post("/api/admin/restart-request", (route) => {
    // The operator asking for a restart is the authority on both facts: the
    // change is required (recording it is what `self-edit` does) and they are
    // saying to apply it now.
    deps.adminState.restart.requireRestart();
    deps.adminState.restart.markReady();
    deps.runtime.audit.append({ type: "restart_requested" });
    deps.runtime.events.emit("restart_required", { source: "admin", ready: true });
    json(route.res, 202, { status: "recorded", ...deps.adminState.restart.status });
  });

  // Retract a pending request without pretending the need went away. Used when
  // the agent reopens a batch: a restart taken up mid-batch boots half a change.
  router.post("/api/admin/restart-withdraw", (route) => {
    deps.adminState.restart.withdraw();
    deps.runtime.audit.append({ type: "restart_withdrawn", source: "admin" });
    deps.runtime.events.emit("restart_withdrawn", { source: "admin" });
    json(route.res, 202, { status: "withdrawn", ...deps.adminState.restart.status });
  });

  // A restart asked for from the web UI. Not the same as `restart-request`
  // above: that one records an intention, this one hands
  // `user-tools/update-and-restart` to the process that supervises this daemon.
  // Under the systemd user unit that is a transient unit of its own, because the
  // script stops this very service and a child of this process would be stopped
  // with it (see runtime/restart-helper.ts). Under `user-tools/run` there is no
  // unit: the runner is the supervisor, so the daemon ends with the code the
  // runner reads as "update and come back", after this answer is sent.
  router.post("/api/admin/restart", async (route) => {
    // A cross-site form can POST here without a preflight. Requiring a JSON body
    // type is what stands in the way: without asking the browser first, a form
    // can only send text/plain, urlencoded or multipart, and all three fail here.
    const contentType = route.req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      apiError(route.res, 415, "json_required", "send this request with Content-Type: application/json", route.requestId);
      return;
    }
    if (deps.restart === undefined) {
      apiError(route.res, 500, "restart_unavailable", "this daemon has no way to restart itself", route.requestId);
      return;
    }

    // The dropdown's second entry asks for the same handoff with `--reinstall`.
    // A missing field, or any value but `true`, is the plain restart.
    const reinstall = bodyObject(route.body)?.reinstall === true;
    const outcome = await deps.restart.launch("ui", { reinstall });
    if (!outcome.ok) {
      // The same fields as the tool path's refusal in `src/extensions/self-edit.ts`:
      // every `restart_refused` row names its `source`, a stable `code` for the
      // reason, and the human-readable `reasons`, so one reader can treat them
      // alike without asking where the row came from.
      deps.runtime.audit.append({
        type: "restart_refused",
        source: "ui",
        code: outcome.code,
        reasons: [outcome.message],
      });
      deps.runtime.logger.warn("restart refused", { code: outcome.code });
      apiError(route.res, outcome.status, outcome.code, outcome.message, route.requestId);
      return;
    }

    deps.runtime.audit.append({
      type: "restart_launched",
      ...(outcome.unit === undefined ? {} : { unit: outcome.unit }),
      script: outcome.script,
      source: "ui",
      reinstall,
      mode: outcome.mode,
    });
    deps.runtime.logger.info("restart launched", { mode: outcome.mode, unit: outcome.unit, logFile: outcome.logFile });
    // The exit goes on the response's own `finish`, registered before the answer
    // is written: the page gets its 202, and the process ends once the socket
    // has the bytes. `null` and not an absent key for `unit`: the page reads the
    // body as one shape, and under the runner there is no unit to name.
    const exitAfterAnswer = outcome.exitAfterAnswer;
    if (exitAfterAnswer !== undefined) {
      route.res.once("finish", () => exitAfterAnswer());
    }
    json(route.res, 202, {
      status: "launched",
      mode: outcome.mode,
      unit: outcome.unit ?? null,
      script: outcome.script,
      logFile: outcome.logFile,
      requestedAt: outcome.requestedAt,
    });
  });

  // Replace the files the browser loads, and leave the process alone. The static
  // route reads from disk per request and sends `no-cache`, so the next reload
  // serves the new bytes; a change to compiled server code is not carried, which
  // is what `codeDrift` in the answer counts. This is not a cold restart and not
  // a session restart: the pid and every conversation baseline stay as they are.
  router.post("/api/admin/ui-restart", async (route) => {
    // Same defence as the restart route above, and the same words: a cross-site
    // form can POST without a preflight, and a form cannot send a JSON type.
    const contentType = route.req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      apiError(route.res, 415, "json_required", "send this request with Content-Type: application/json", route.requestId);
      return;
    }
    if (deps.uiRestart === undefined) {
      apiError(route.res, 500, "ui_restart_unavailable", "this daemon has no way to replace its web assets", route.requestId);
      return;
    }

    let outcome: UiRestartOutcome;
    try {
      outcome = await deps.uiRestart.run();
    } catch (error) {
      // A swap that threw instead of answering is still a failed swap, not an
      // internal error of the route: the page has to say "the assets could not
      // be replaced" and the audit row has to name the same code. Nothing here
      // knows whether the previous tree is back, so `restored` is false rather
      // than a guess the operator would act on.
      deps.runtime.logger.error("ui restart threw", { error: String(error) });
      deps.runtime.audit.append({ type: "ui_restart_refused", source: "ui", code: "sync_failed" });
      json(route.res, 500, {
        error: {
          code: "sync_failed",
          message: UI_RESTART_MESSAGES.sync_failed,
          requestId: route.requestId,
          details: { code: "sync_failed", restored: false },
        },
      });
      return;
    }

    if (!outcome.ok) {
      const code = outcome.code ?? "sync_failed";
      const restored = outcome.restored === true;
      // Three kinds of failure, two status codes: a missing directory and a
      // build of the workspace's own pages are facts that the operator fixes in
      // the tree and retries, while a swap that failed halfway is a server fault.
      // A failed build is the same 409 as a missing directory because the served
      // tree is untouched in both cases, and the code says which fix to make.
      const status = code === "sync_failed" ? 500 : 409;
      deps.runtime.audit.append({ type: "ui_restart_refused", source: "ui", code });
      deps.runtime.logger.warn("ui restart refused", { code, restored });
      // `apiError` carries no room for details, and this refusal needs one more
      // fact than the error envelope holds: whether the previous assets are
      // still served. The envelope is otherwise the same shape.
      json(route.res, status, {
        error: {
          code,
          message: UI_RESTART_MESSAGES[code],
          requestId: route.requestId,
          details: { code, restored },
        },
      });
      return;
    }

    const codeDrift = outcome.codeDrift ?? { known: false, behind: 0, codePaths: [] };
    deps.runtime.audit.append({
      type: "ui_restart",
      source: "ui",
      copied: outcome.copied ?? 0,
      uiHash: outcome.uiHash ?? "",
      behind: codeDrift.behind,
    });
    deps.runtime.logger.info("ui assets replaced", { copied: outcome.copied, uiHash: outcome.uiHash, behind: codeDrift.behind });
    json(route.res, 200, {
      ok: true,
      copied: outcome.copied ?? 0,
      uiHash: outcome.uiHash ?? "",
      source: outcome.source,
      target: outcome.target,
      codeDrift,
    });
  });

  router.get("/api/admin/audit", async (route) => {
    const sinceRaw = route.url.searchParams.get("since");
    const since = sinceRaw === null ? undefined : Number(sinceRaw);
    const limit = intParam(route.url, "limit", 200);
    const events = await readAuditTail(deps.runtime.paths.auditLog, Number.isFinite(since) ? since : undefined, limit);
    json(route.res, 200, { events });
  });

  // Manual sweep. The daemon runs one a day at `archive.sweepAt`, but an operator
  // who has just finished a batch of work should not have to wait for it.
  router.post("/api/admin/archive", async (route) => {
    const report = await deps.runtime.archivist.run();
    if (report === undefined) {
      json(route.res, 200, { status: "skipped", reason: "archiving is disabled or a sweep is already running" });
      return;
    }
    json(route.res, 200, { status: "swept", ...report });
  });
}

/**
 * One route writes into the secret store: `POST /api/admin/secrets/write`.
 *
 * It is registered on its own line in `server.ts` so the only writer of that
 * directory is visible in the top-level list of routes.
 *
 * The contract is narrow on purpose.
 * - `Content-Type: application/json` is required. A cross-site form can POST
 *   without a preflight, and a form cannot send that type.
 * - The name arrives in the body, not in the query: the access log records
 *   `req.url`, so a name in the query would be logged.
 * - The value is written, reloaded into the registry, and only then answered.
 *   Before the reload the registry does not know the value, so nothing is logged
 *   and no response is written until it does.
 * - No failure sentence carries the text, the name, or an error object.
 */
export function registerSecretWrite(router: Router, deps: AppDeps): void {
  router.post("/api/admin/secrets/write", async (route) => {
    // Same defence, and the same words, as the restart routes above.
    const contentType = route.req.headers["content-type"] ?? "";
    if (!contentType.includes("application/json")) {
      apiError(route.res, 415, "json_required", "send this request with Content-Type: application/json", route.requestId);
      return;
    }

    // A missing or non-string field is answered with the refusal that already
    // exists for it, so the set of codes stays closed: no name is a name that
    // cannot be used, and no text is a text that is empty.
    const body = bodyObject(route.body);
    const name = typeof body?.name === "string" ? body.name : "";
    const text = typeof body?.text === "string" ? body.text : "";

    const written = await writeSecretText(deps.runtime.paths.secretsDir, name, text);
    if (!written.ok) {
      apiError(
        route.res,
        SECRET_WRITE_STATUS[written.code],
        written.code,
        SECRET_WRITE_MESSAGES[written.code],
        route.requestId,
      );
      return;
    }

    // The new value is not in the registry until this finishes, and redaction
    // misses it until then. A reload that throws leaves that window open, so the
    // answer is a failure, not a 200 over a half-done write.
    try {
      await deps.runtime.secrets.reload();
    } catch {
      deps.runtime.logger.error("secret store reload failed after write", { name: written.name });
      apiError(route.res, 500, "write_failed", SECRET_WRITE_MESSAGES.write_failed, route.requestId);
      return;
    }
    // The registry reads its own directory. If the file landed somewhere it does
    // not read, the name is absent here, and saying "ok" would be a lie that a
    // user finds out about only when the value fails to appear.
    if (!deps.runtime.secrets.names().includes(written.name)) {
      deps.runtime.logger.error("secret not in the registry after write", { name: written.name });
      apiError(route.res, 500, "write_failed", SECRET_WRITE_MESSAGES.write_failed, route.requestId);
      return;
    }

    // Name and size only: no value, and no hash of it. A hash of a low-entropy
    // secret is a checkable guess.
    deps.runtime.audit.append({ type: "secret.write", name: written.name, bytes: written.bytes });
    json(route.res, 200, { ok: true, name: written.name, bytes: written.bytes });
  });
}
