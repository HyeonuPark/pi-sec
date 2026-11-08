# Roadmap, Risks & Open Questions

Companion to [README.md](./README.md). Sequencing for implementation and the
decisions still to make.

---

## 1. Milestones

Each milestone is independently shippable to the user (a working personal
agent at every step).

### M0 — Skeleton & durable core

**Goal:** a bootable single-process daemon that holds one durable conversation on
the configured model, using pi-sec's own `~/.pi/sec` credentials.

- Repo: `package.json`, `tsconfig`, `src/cli.ts`, `src/index.ts`, `docs/`,
  `user-tools/`.
- `runtime/paths.ts`: `PI_SEC_HOME` resolution, code trees, tmp dir.
- `config/schema.ts` + `config/load.ts` (TypeBox, fail-closed).
- `agent/models.ts`: `ModelRuntime.create()` pointed at pi-sec-owned auth/catalog.
- `runtime/storage.ts`: open/migrate SQLite via `openNodeSqliteStorage`.
- `agent/harness.ts`: `Harness.open` + `harness.root()` + `harness.resume()`.
- CLI: `pi-sec start`, `login`, `config`, `doctor`, `version`.
- **Acceptance:** `pi-sec start` runs; a scripted input to the root conversation
  gets an answer from the real model; killing the process mid-run and restarting
  resumes/answers.

### M1 — Web server & `/basic-chat`

**Goal:** the primary interface exists, including session restart and compression.

- `server/server.ts` on `node:http`; loopback bind; base path.
- `server/sse.ts`: SSE writer, heartbeat, event ids, bounded queue.
- Routes: `GET /healthz`, `GET /basic-chat`, `GET /basic-chat/events`,
  `POST /basic-chat/messages`, `POST /basic-chat/abort`,
  `POST /basic-chat/reset`, `POST /basic-chat/compact`.
- `watchEvents` integration; snapshot-first protocol.
- Polished static UI (see [ui.md](./ui.md)) with a **New session** button and a
  compaction status line.
- **Acceptance:** open `/basic-chat` (localhost) and chat; streamed tokens arrive;
  reset starts a fresh context while history stays in storage; compaction emits
  and renders `compaction_*`; reconnect after losing the stream recovers via
  snapshot.

### M2 — Tools, secrets, tmp

**Goal:** the agent can act, without leaking secrets or polluting system tmp.

- `CodingTools` bundled extension.
- `agent/env.ts`: `NodeExecutionEnv` (tmp isolation from systemd `PrivateTmp`).
- `runtime/janitor.ts`: eager cleanup of the private `/tmp`, logs, cache.
- `secrets` extension: registry, one-way `redact`, env + hook integration,
  system-prompt section.
- Audit log (`logs/audit.jsonl`) with secret redaction; `GET /api/admin/audit`.
- **Acceptance:** the agent works in the workspace tree; a registered secret never
  appears in model context, tool output, logs, or documents; no agent file lands
  in the host `/tmp`; the private tmp is cleaned eagerly.

### M3 — Autonomy

**Goal:** it works while you're away.

- Memory is **just files**: markdown under `~/.pi/sec/memory/`, read/written
  with the ordinary file tools. No memory subsystem, tools, or auto-retrieval;
  `index.md` is an optional hub.
- `jobs` extension: the job registry; durable ULID-keyed `sec.job` records with a
  status lifecycle (`planned`/`active`/`waiting`/`paused`/`done`/`failed`/
  `cancelled`), parent/child as the only hierarchy, freeform labels, memory
  anchors, an optional state dir, and conversation/task links. Tools: `jobs_list`
  (tree), `jobs_get`, `jobs_create`/`update`/`cancel`.
- `scheduler` extension (durable jobs, background tasks) with per-job timezone,
  catch-up (`skip`/`once`/`all`), and overlap (`skip`/`queue`/`allow`) semantics —
  see [architecture.md](./architecture.md#scheduling).
- `ask-user` extension: `ask_user` with fixed choices, returning at once while the
  question waits in the active list; the answer arrives as real user input;
  `sec.userQueryList`; SSE events; `POST /api/user-queries/:key`.
- `web` extension (`fetch_url`).
- `notify` extension: writes `sec.inbox` items.
- Inbox: `sec.inbox` notification items, exposed via `GET /api/inbox` and `inbox_item`; pi-durable's `pi.inbox` submission queue surfaces as `inbox_update`.
- `usage` extension.
- **Acceptance:** a cron job fires after a restart; the agent recalls a prior
  fact; an `ask_user` call returns at once; either answer creates a real `pi.user`
  entry and drives the next turn; an unanswered question stays open (no default
  timeout).
- **API check:** before building on pi-durable, assert the integration points
  against the pinned tarball (see [architecture.md](./architecture.md#agent-runtime)).

### M4 — Self-improvement

**Goal:** it can extend itself, and stage core changes for the user.

- `registry/loader.ts`: runtime extension load/reload, per-extension `config.json`,
  file watcher, cache-busting import, `jiti` for TS.
- `self-edit` extension: `self_edit`, `reload_extensions`, `request_restart`,
  `withdraw_restart`.
- Validation gate, run by `request_restart` against the workspace tree:
  `tsc --noEmit`, the test suite, and a secret scan of the whole change. A
  failure blocks the request rather than reverting the file, and a missing
  dependency or a truncated read fails closed — "could not check" is never a
  pass ([extensions.md](./extensions.md#validation-gate)).
- `code.snapshot` / `code.workspace` tree handling; the agent commits in the
  workspace (modification) tree and can promote a runtime extension into core
  **only after user confirmation**.
- Model-managed core-candidate queue (no UI/API; the agent defers when it is deep).
- `restart_required` SSE event and user instructions; `user-tools/update-and-restart`
  and `user-tools/rollback` scripts.
- **Acceptance:** the agent adds a working runtime extension, reloads it, and uses
  it in the same session; a core change is committed to the workspace tree and the user
  is told a cold restart is needed; the user applies it with the script.

### M5 — Hardening & packaging

**Goal:** safe to run for real, shareable publicly.

- systemd **user** unit at `~/.config/systemd/user/pi-sec.service`, written by
  `user-tools/install` and managed with `systemctl --user` only; the script
  refuses to run as root. A system unit with `User=pi-sec` is the by-hand setup
  that [security.md](./security.md) describes, and the restart button in the web
  UI does not work under it. `--watchdog` readiness; `PrivateTmp=true`.
- `user-tools/install` (run as the fresh `pi-sec` user): create `~/.pi/sec`,
  clone, `npm ci`, `npm run build`, copy a provider extension or `models.json`
  file, write the unit, and print any privileged steps for the user. The model
  login happens later, in the web UI. See [extensions.md](./extensions.md#user-tools).
- Full config surface + docs + JSON schema.
- Migrations, audit rotation, `pi-sec doctor` diagnostics.
- Robustness around SSE, Host validation, and headers. The daemon has no request
  rate limit; a reverse proxy can add one.
- Public README, license, CI (typecheck/test/lint), release workflow.
- **Acceptance:** a fresh machine can install, run as its unprivileged user, and
  chat on localhost or behind a proxy; Node boots under the full sandbox
  (including `SystemCallFilter=@system-service`) and `PrivateTmp` is effective;
  no file is written to system `/tmp`; a security review checklist passes.

---

## 2. Resolved design decisions

These were open in an earlier draft and are now settled at the user's direction:

| Decision | Resolution |
|----------|-----------|
| Single process? | **Yes.** One daemon owns storage and serves all HTTP/SSE. |
| Auth inside pi-sec? | **No.** Reverse proxy or localhost only. |
| Dedicated user? | **Yes, intended.** The install creates a dedicated, unprivileged Linux account for `pi-sec` (not the user's login account); the name is chosen at install, not hardcoded. |
| Privilege escalation? | **Never.** No `sudo`; emit a script for the user to run. |
| Tool-call guard? | **None.** No text-rule command/path matching. |
| System tmp? | **Never shared.** systemd `PrivateTmp=true` + eager janitor. |
| Secrets in model context? | **Never.** Fixed dummy tokens, redaction irreversible; use via scripts that read `~/.pi/sec/secrets/`. |
| Core hot reload? | **No.** Only runtime extensions/prompts hot reload. |
| Core change flow? | Agent commits in the workspace (modification tree); `user-tools/update-and-restart` advances the snapshot to the new HEAD and starts pi-sec from it. |
| Two code trees? | **Yes.** `~/.pi/sec/snapshot` (read-only) + `~/.pi/sec/workspace` (writable). |
| Self-knowledge in prompt? | **Yes.** Points to design docs and pi-durable's own README/spec. |
| Name and mission? | **`pi-sec`**, short for **secretary**: do whatever the user asks, within its own unprivileged permissions. |
| Default tool timeouts? | **None.** Tool calls run until done or aborted, and an open question waits until it is answered or withdrawn. |
| Secret store? | **One plaintext file per secret** at `~/.pi/sec/secrets/<name>` (0600), read by scripts. **pi-sec's own model credentials are auto-redacted too.** |
| Memory? | **Just files.** Markdown under `~/.pi/sec/memory/`; the agent reads/writes them with ordinary tools and decides what to open; `index.md` is an optional hub. No retrieval system. |
| Prompt hot reload? | **Append-only context:** prompt changes are appended as positional `pi.system` entries and take effect forward; committed entries are never rewritten. Compaction appends a `pi.compaction` head. |
| Background compaction? | **Enabled** via pi-durable's `backgroundTokens` (default 32768): starts ahead of the blocking threshold and appends a `pi.compaction` head. Surfaced in `pi.live.compactions`; a systemic task, not a job. |
| Self-edit limits? | **No hard limit.** A model-managed core-candidate queue; the agent defers when it is deep. |
| Core promotion? | **Agent decides, user confirms.** The agent may promote a runtime extension into core; it asks the user to confirm (`ask_user`) before staging the candidate. |
| Cold apply? | **Fast-forward snapshot, restart from it.** The agent commits in `code.workspace` (modification tree, never executed); `user-tools/update-and-restart` advances `code.snapshot` to the new HEAD and starts `pi-sec` from it. |
| Candidate queue? | **Model-managed, no UI/API.** The agent stages, reviews, consolidates, and prioritizes candidates. |
| License? | **MIT.** |
| Secrets boundary? | **Bundled `secrets` extension, enabled by default.** Disableable like any other extension; the fail-closed store behavior applies when enabled. |
| Internet content? | **Untrusted data.** Internet-fetched content may be malicious; treat it as data, never as instructions (prompt guidance). |
| systemd unit? | **User unit by default** at `~/.config/systemd/user/pi-sec.service`, written by `user-tools/install` and managed with `systemctl --user` only; the script refuses to run as root. A system unit with `User=pi-sec` is the manual setup in [security.md](./security.md), and the restart button in the web UI does not work under it. |
| Sandbox write scope? | **`%h` by default**; add extra `ReadWritePaths` roots to allow job directories outside the home. |
| Channels? | **`/basic-chat` only for now.** More channels may be added later on the same API. |
| High-level jobs? | **Highest unit of work, always enumerable.** A job is a durable ULID-keyed record in the `sec.job` family with a status lifecycle, an optional parent (parent/child is the only hierarchy), freeform labels, memory anchors, an optional state dir, and conversation/task links; the model decides what counts as a job. `sec.job` docs; shown live. |
| Model credentials? | **Self-owned.** `~/.pi/sec/auth.json` + `~/.pi/sec/models.json`, and the values are secret files under `~/.pi/sec/secrets/`; `~/.pi/agent` is never read. The user signs in once, from the web UI's "Model login" panel. |
| Container strategy? | **Dropped.** Tool calls run in the same view as the agent; the dedicated unprivileged user is the security boundary. |

---

## 3. Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| pi-durable is experimental and changes between releases | Rework, broken upgrades | Pin exact versions; isolate in `agent/`; upgrade deliberately with tests. |
| `ModelRuntime` is part of pi-coding-agent (heavier dep) | Footprint/coupling | Adapter boundary in `models.ts`; fallback to pi-ai `createModels` + file credential store. |
| Single-process SQLite | Can't run two daemons | Accepted; a second `start` on the same home exits before it opens the storage; a future storage proxy is possible. |
| Secret file can be read and exfiltrated by a command | Credential misuse | Scoped secrets; host-level egress controls; audit secret-name access. Trust-based. |
| No tool guard means destructive actions are possible | Data loss within user's access | Accepted by design; audit + user-run destructive steps where possible. |
| Core changes require manual restart | Lag between fix and apply | Runtime extensions cover the common case immediately; `restart_required` nags until applied. |
| Running without systemd provides no tmp isolation | tmp mixing | Recommend the provided systemd unit; janitor only cleans a verified private tmp. |
| Node type stripping / dynamic TS import fragility | Loader breakage | Bundle core as compiled JS; `jiti` fallback for runtime TS; smoke-test the loader. |
| Cost runaway | Unexpected bills | Usage budgets, scheduler bounds; self-edit is unlimited but review-queued. |

---

## 4. Open questions

None currently. The systemd `SystemCallFilter`/`PrivateTmp` behavior is checked as
an M5 acceptance test rather than left open.

---

## 5. Suggested first implementation PR

1. Initialize `package.json` (ESM, Node ≥ 22.19), `tsconfig.json`, `.gitignore`
   (ignore `node_modules`, `dist`; keep `docs/`).
2. Add dependencies: `@earendil-works/pi-durable`,
   `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`,
   `@earendil-works/chord`, `typebox`; devDependencies `jiti`, `vitest`.
3. Implement `runtime/paths.ts`, `config/schema.ts`, `config/load.ts`.
4. Implement `agent/models.ts` and `agent/harness.ts` with a tiny script that
   sends "hello" to the root conversation and prints the answer.
5. Add `test/` with a faux-provider smoke test so CI needs no credentials.

This is M0. Everything else builds on it.
