# pi-sec — Design Overview

> Status: **implemented** (see the repository root for `src/`, `test/`, and
> `user-tools/`). This directory remains the source of truth for the project's
> structure and the decisions behind it. Where this design and the code diverge,
> the design describes intent and the code is the current behavior.
>
> New here? Read **[introduction.md](./introduction.md)** first, then come back to
> this document for the structured overview.

`pi-sec` is an **autonomous personal agent** built on
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).
The name is short for **secretary**: `pi-sec` does whatever its user asks,
using only its own unprivileged permissions. It runs as a **dedicated,
unprivileged Linux user created for it at install time** (never root, and not
your login account), exposes **one web server process** as its primary interface,
owns its model credentials and catalog under `~/.pi/sec`, and keeps its
**control structure** in `~/.pi/sec` — while the directories it manages may live
anywhere that dedicated user can write. It is **self-improving**: it edits
its own code in a workspace tree, hot reloads runtime extensions, and asks the
user to perform a cold restart for core changes.

This document is deliberately high level. Each sibling document goes deep on one
area.

---

## 1. Goals

| # | Goal |
|---|------|
| G1 | A single, always-on personal agent process (daemon) with **durable** state that survives crashes and restarts. |
| G2 | **One process serves everything**: a web server (HTTP + SSE) as the primary interface. No WebSocket. Reachable via localhost or a reverse proxy. |
| G3 | A minimal starter endpoint, `/basic-chat`, that a human can open in a browser and chat with a model, including session reset and context compaction. |
| G4 | **Autonomy**: scheduled jobs, background subagents, an inbox, and durable tasks that continue across restarts. |
| G5 | **Self-improvement**: the agent edits its own code in a workspace tree, validates it, hot reloads runtime extensions, and stages core changes for a user-executed cold restart. |
| G6 | The code is a clean, publishable **git project**; all personal data lives outside it. |
| G7 | Runs as a **dedicated, unprivileged Linux user** created for it, separate from the user's own account. No `sudo`, ever. Privileged tasks are emitted as scripts for the user to run. |
| G8 | Owns its model credentials and catalog under `~/.pi/sec`; never reads the user's `~/.pi/agent`. |
| G9 | **Secrets never enter model context, and redaction is irreversible.** The harness replaces secret values with fixed dummy tokens; the agent uses secrets only by writing scripts that read them from `~/.pi/sec/secrets/`. |
| G10 | The agent can always **enumerate the highest-unit jobs it manages** — the work it has taken on, including their subjobs — and decides for itself what to record as a job. |

## 2. Non-goals

- Multi-tenant SaaS. `pi-sec` is single-user by design.
- Authentication inside `pi-sec`. Access control is the reverse proxy's job (or
  the fact that it is bound to localhost). See [security.md](./security.md).
- Text-rule-based tool-call guards. Safety comes from OS privilege boundaries,
  not from pattern-matching command strings. See [security.md](./security.md).
- A general plugin marketplace (extensions are code in this repo, plus runtime
  extensions in `~/.pi/sec/extensions`).
- Mobile/desktop native clients. The web UI is the only first-party UI.
- Replacing `pi` (the coding agent CLI). `pi-sec` uses the pi ecosystem's runtime
  libraries but is a distinct product.

## 3. Core decisions (summary)

1. **Agent engine is `@earendil-works/pi-durable`**, not `pi-coding-agent`. We get
   durable conversations/tasks/documents, crash recovery, compaction, subagents,
   and a registry. See [architecture.md](./architecture.md).
2. **Single process daemon.** One Node process owns one SQLite storage and serves
   the HTTP/SSE interface. Clients (browser on localhost, or through a reverse
   proxy) are thin. See [architecture.md](./architecture.md#process-model).
3. **Auth and model catalog are self-owned under `~/.pi/sec`** through
   pi-coding-agent's `ModelRuntime` (which implements pi-durable's `Models`). The
   user signs in once, from the web UI's "Model login" panel; the user's
   `~/.pi/agent` is never read. See [architecture.md](./architecture.md#model-and-auth-integration).
4. **Control structure lives in `~/.pi/sec`** (config, SQLite state, job registry,
   logs, runtime extensions, secrets, code checkouts). Model-managed directories —
   project workspaces, job state, notes — may live anywhere the dedicated
   `pi-sec` user can access.
5. **HTTP + Server-Sent Events**, never WebSockets. Maps onto pi-durable's
   commit-derived event stream and traverses reverse proxies. See
   [http-api.md](./http-api.md).
6. **No authentication in `pi-sec`.** It binds loopback only; the reverse proxy (or
   localhost-only access) decides who may reach it.
7. **No `sudo`, no text-rule guard.** The process runs as a dedicated,
   unprivileged user. If privilege is genuinely required, the agent writes a
   script and asks the user to run it. The OS, not heuristics, is the
   boundary.
8. **Secrets are isolated from the model.** A local secret registry redacts
   secret values to fixed dummy tokens, one way and irreversibly; there is no
   resolution step. See [secrets.md](./secrets.md).
9. **Isolated tmp.** The daemon and its tools never share the system `/tmp`; a
   private, janitored tmp dir prevents agent garbage from mixing with unrelated
   system files. See [security.md](./security.md#tmp-isolation).
10. **Two code trees.** A **snapshot** tree (current behavior; read-only by
    convention, not enforced) and a writable **workspace** tree (modifications).
    Runtime extensions hot reload; core changes are committed and await a
    user-driven cold restart. See [extensions.md](./extensions.md).
11. **Context history is append-only.** Committed entries are never modified or
    deleted. Forward changes — reset, compaction, prompt/section changes — are
    appended as new entries (`pi.reset`, `pi.compaction`, `pi.system`); the newest
    head marker sets where the active context begins. Compaction therefore appends
    a summary head and is fully allowed; provider prefix caching is best-effort.
    See [architecture.md](./architecture.md#prefix-cache).
12. **Jobs are the highest unit of work and always enumerable.** A job is a
    durable record (ULID id) in the `sec.job` family with a status lifecycle
    (`planned`/`active`/`waiting`/`paused`/`done`/`failed`/`cancelled`), an
    optional parent (parent/child is the only hierarchy), freeform labels, memory
    anchors, an optional state directory, and links to its conversation and
    tasks. The agent can list every job at any time (`jobs_list`), and the UI
    shows the tree live. See [architecture.md](./architecture.md#job-registry).
13. **Pin exact versions.** pi-durable is explicitly experimental.

## 4. High-level architecture

```text
                    browser (localhost)        browser (remote)
                          │                          │  HTTPS
                          │                          ▼
                          │               ┌─────────────────────────┐
                          │               │ reverse proxy (TLS)     │
                          │               │ auth is done HERE       │
                          │               └────────────┬────────────┘
                          │                            │ HTTP (loopback/unix)
                          ▼                            ▼
                    ┌──────────────────────────────────────────────┐
                    │            pi-sec  (single daemon)           │
                    │                                              │
                    │  HTTP + router + SSE hub   Extension registry │
                    │        │                        │            │
                    │        ▼                        ▼            │
                    │  ┌────────────────────────────────────────┐  │
                    │  │        pi-durable Harness              │  │
                    │  │  conversations · tasks · documents     │  │
                    │  │  one-way secret redaction boundary     │  │
                    │  └──────┬───────────────┬─────────────────┘  │
                    │         │               │                    │
                    │  ┌──────▼─────┐  ┌──────▼───────────────┐    │
                    │  │ SQLite     │  │ Execution env        │    │
                    │  │ (durable)  │  │ private tmp, no sudo │    │
                    │  └────────────┘  └──────────────────────┘    │
                    └───────────────────┬──────────────────────────┘
                                        │ Models (pi-ai)
                                        ▼
                             ~/.pi/sec/auth.json
                             ~/.pi/sec/models.json
                             ~/.pi/sec/secrets/model-auth.*
```

The daemon is the only owner of durable state. Everything the UI shows comes from
committed state, so a reconnecting client is always consistent. There is **no
second process**: no separate worker, no queue broker, no WebSocket gateway.

## 5. Component map

| Component | Responsibility | Doc |
|-----------|----------------|-----|
| **CLI** (`pi-sec`) | `start`, `status`, `doctor`, `config`, `login`, `db`, `migrate`, `audit`, `version` | [architecture.md](./architecture.md) |
| **Daemon** | Process lifecycle, graceful shutdown, health, restart-for-core-update | [architecture.md](./architecture.md#process-model) |
| **HTTP server + router** | Routing, static UI, JSON API, SSE | [http-api.md](./http-api.md) |
| **SSE hub** | Fan-out of pi-durable events, heartbeats, resume tokens | [http-api.md](./http-api.md#sse-protocol) |
| **Web UI** (`src/ui`, `src/web`) | Themed chat, job tree, inbox, prompts, drawn with Preact and signals and bundled by esbuild | [ui.md](./ui.md) |
| **Agent runtime** | `Harness`, storage, model runtime, environment, settings | [architecture.md](./architecture.md#agent-runtime) |
| **Secret registry** | Registered secrets incl. pi-sec's own model credentials; one-way dummy substitution (no resolution) | [secrets.md](./secrets.md) |
| **Job registry** | Durable jobs (ULID, status lifecycle, parent/child only) with labels, memory anchors, state dirs, task links; `jobs_list`; live UI | [architecture.md](./architecture.md#job-registry) |
| **Extension registry + loader** | Runtime extension install/replace, per-extension config, hot reload | [extensions.md](./extensions.md) |
| **Bundled extensions** | Coding tools, jobs, reports, scheduler, self-edit, ask-user, web, notify, secrets, usage | [extensions.md](./extensions.md#bundled-extension-catalog) |
| **Code trees** | Execution snapshot (running code) + modification workspace (never executed) + `user-tools/` | [extensions.md](./extensions.md#code-trees) |
| **Config loader** | `~/.pi/sec/config.json`, env overrides, validation | [runtime-layout.md](./runtime-layout.md#config-schema) |
| **Inbox** | `sec.inbox`: durable async messages to the user/agent (job results, briefings, subagent reports) | [architecture.md](./architecture.md#inbox) |
| **Memory (files)** | A plain markdown workspace the agent edits with ordinary file tools; `index.md` is an optional hub | [runtime-layout.md](./runtime-layout.md#memory) |
| **Audit log** | Append-only JSONL of tool calls and self-edits (append-only by convention, not enforced) | [security.md](./security.md#audit) |
| **User query tool** | `ask_user`: asks with fixed choices and returns at once, and the answer arrives as input from the user | [http-api.md](./http-api.md#user-queries) |

## 6. Repository layout (code — this git project)

```text
pi-sec/
├── package.json                 # ESM, "type": "module", bin: pi-sec
├── tsconfig.json
├── LICENSE                      # MIT
├── docs/                        # this directory (design + user docs)
├── src/
│   ├── index.ts                 # library entry (embeds pi-sec)
│   ├── cli.ts                   # `pi-sec` command
│   ├── server/
│   │   ├── server.ts            # node:http server + lifecycle
│   │   ├── router.ts
│   │   ├── sse.ts               # SSE writer, heartbeat, resume
│   │   └── routes/
│   │       ├── basic-chat.ts    # MVP chat UI + API (reset/compact)
│   │       ├── conversations.ts
│   │       ├── jobs.ts          # job tree + lifecycle
│   │       ├── inbox.ts         # inbox items
│   │       ├── user-queries.ts  # ask_user responses
│   │       ├── health.ts
│   │       └── admin.ts         # reload, diagnostics
│   ├── agent/
│   │   ├── harness.ts           # Harness.open(...)
│   │   ├── models.ts            # ModelRuntime adapter (~/.pi/sec)
│   │   ├── settings.ts          # live HarnessSettings from config
│   │   ├── env.ts               # ExecutionEnv (private tmp, no privilege)
│   │   └── conversation.ts
│   ├── secrets/
│   │   ├── registry.ts          # secret names -> values -> dummies
│   │   └── redact.ts            # one-way redaction (no resolution)
│   ├── jobs/
│   │   └── registry.ts          # high-level job records + status
│   ├── registry/
│   │   ├── registry.ts
│   │   └── loader.ts            # runtime extension load/reload + config
│   ├── extensions/              # bundled, cold-only (not hot reloaded)
│   │   ├── coding.ts
│   │   ├── jobs.ts
│   │   ├── scheduler.ts
│   │   ├── self-edit.ts
│   │   ├── ask-user.ts
│   │   ├── web.ts
│   │   ├── notify.ts
│   │   ├── secrets.ts
│   │   └── usage.ts
│   ├── config/
│   ├── runtime/
│   │   ├── paths.ts             # ~/.pi/sec + two code trees
│   │   ├── storage.ts
│   │   ├── logger.ts
│   │   ├── janitor.ts           # tmp/log cleanup
│   │   └── supervisor.ts        # health + cold-restart coordination
│   ├── ui/                      # the pages: TSX components, signal stores, streams
│   └── web/                     # page shells + CSS, served as written
├── prompts/                     # shipped prompt text: role/, vmodel/
├── user-tools/                  # scripts: install, update-and-restart, rollback
└── test/
```

## 7. Control-structure layout

```text
~/.pi/sec/
├── config.json                  # user-editable configuration
├── VERSION                      # schema/migration version
├── snapshot/                   # execution tree (running code; read-only by convention)
├── workspace/                  # modification tree (never executed; has user-tools/)
├── state/
│   └── sec.sqlite               # pi-durable storage (WAL)
├── memory/                      # plaintext/markdown notes; normal file tools
│   ├── index.md                 # optional hub listing big topics
│   └── *.md
├── prompts/                     # prompt overrides: role/<name>.md wins over the shipped file
├── extensions/                  # runtime extensions (hot reload)
│   └── <name>/
│       ├── index.js
│       └── config.json          # per-extension config (hot reload)
├── secrets/                     # per-secret files, readable by scripts
│   ├── <name>
│   └── env
├── logs/
│   ├── app.log
│   └── audit.jsonl
├── run/
│   └── pi-sec.pid
└── cache/                       # regenerable
```

Model-managed directories (job state, project workspaces, notes) may live
outside `~/.pi/sec`; only the control structure above is fixed there. Full tree,
config schema, and document kinds in [runtime-layout.md](./runtime-layout.md).

## 8. Primary flow — `/basic-chat` (including reset & compaction)

```text
browser                 pi-sec server                     pi-durable Harness
   │  GET /basic-chat          │                                   │
   │──────────────────────────▶ │  serve HTML                       │
   │  GET /basic-chat/events    │                                   │
   │──────────────────────────▶ │  conversation.watch(ctx) ──────▶ │
   │◀══ SSE snapshot ═══════════│                                   │
   │  POST /basic-chat/messages │                                   │
   │──────────────────────────▶ │  root.submit({type:"input"}) ───▶ │
   │◀─ 202 { submissionId } ────│                                   │
   │◀══ SSE message_start ══════│◀── generation chunks (committed) ─│
   │◀══ SSE message_end ════════│◀── final entry (committed) ───────│
   │◀══ SSE run_end ════════════│                                   │
   │  POST /basic-chat/reset    │  (new context; history retained)  │
   │──────────────────────────▶ │  root.reset(handoff?) ──────────▶ │
   │◀══ SSE snapshot ═══════════│                                   │
   │  POST /basic-chat/compact  │  (summarize older entries)        │
   │──────────────────────────▶ │  root.compact() ────────────────▶ │
   │◀══ SSE compaction_start ───│                                   │
   │◀══ SSE compaction_end ═════│                                   │
```

- **Session restart** in basic chat = `reset`: the model stops seeing older
  entries, but all entries stay in durable storage. An optional `handoff` note is
  carried into the new context.
- **Context compression** = pi-durable compaction: automatic per settings, plus a
  manual `compact` button. The UI renders `compaction_start`/`compaction_end` as a
  status line. A summary that cuts before the current context settles as `stale`
  and is ignored (far-cut wins).
- The starter uses one fixed "default" conversation. **`/basic-chat` is the only
  first-party channel for now**; the API underneath is general, and other channels
  (CLI, bots, additional UIs) may be added later on the same primitives.

## 9. Primary flow — daemon boot

```text
systemd (user unit) or `pi-sec start`
  ├─ resolve ~/.pi/sec, snapshot/workspace trees
  ├─ load + validate config.json (fail closed)
  ├─ open SQLite storage (WAL; single owner)
  ├─ init secret registry; install one-way redaction filters
  ├─ build ModelRuntime (~/.pi/sec auth + catalog)
  ├─ install bundled extensions + load runtime extensions (validated)
  ├─ Harness.open(storage, ...) ; harness.resume()
  ├─ start scheduler; start janitor (private tmp via systemd)
  ├─ start HTTP server (loopback)
  └─ write pid; notify systemd ready (Type=notify)
```

A second `start` on the same home exits with an error before it opens the storage.

Shutdown is graceful: stop accepting, drain SSE, `harness.close(context)`, close
storage.
A hard kill is safe: committed work resumes on next boot.

## 10. Self-improvement summary

Two code trees and two tiers:

- **Snapshot tree** (`~/.pi/sec/snapshot`): the **execution tree** — the checkout
  the running process boots from. Read-only by convention. The agent reads it to
  understand its own *current* behavior, even after it has modified the workspace.
- **Workspace tree** (`~/.pi/sec/workspace`): the **modification tree** — where the
  agent edits, validates, and commits. Never executed.
- **Runtime extensions/prompts** (`~/.pi/sec/extensions`, `~/.pi/sec/prompts`):
  hot-reloaded live. Core bundled extensions and prompts are **not** hot reloaded.
- To add a capability, the agent creates a runtime extension and reloads it, so it
  is live immediately. To **promote** it into core, the agent first asks the
  user to confirm, then commits it into the workspace tree as a core candidate.
- For core changes, the agent commits in the workspace tree and tells the user
  a cold restart is needed. The user runs `user-tools/update-and-restart`, which
  advances the snapshot to the committed HEAD and starts `pi-sec` from it. The
  composer menu's `Restart server` runs that same script from the UI, through
  `POST /api/admin/restart`. `Force reinstall and restart`, the entry under it,
  sends `{"reinstall": true}`, and the script builds `node_modules` again.

Every change is audited. There is no in-process rollback of core code; git and
the user are the rollback mechanism. Details in
[extensions.md](./extensions.md#self-improvement-loop).

## 11. Secrets summary

- Secrets are files under `~/.pi/sec/secrets/<name>`, readable by the agent's
  scripts but never loaded into model context.
- **pi-sec's own model credentials are redacted too**: the values are
  `~/.pi/sec/secrets/model-auth.*` files that `~/.pi/sec/auth.json` names, and
  sensitive fields of `models.json` are collected the same way, so reading them
  through a tool yields only placeholders.
- The harness replaces every occurrence of a secret value in text entering the
  model context with a **fixed dummy token** (length is not preserved).
- Redaction is **one-way and irreversible**. There is no resolution step: a dummy
  passed to a tool is passed literally and is never converted back.
- To use a secret, the model writes a script that reads the file itself (e.g.
  `TOKEN=$(cat ~/.pi/sec/secrets/gh_token)`). The system prompt tells it this.

Details and edge cases in [secrets.md](./secrets.md).

## 12. Security summary

- Runs as its own **dedicated, unprivileged Linux user**, never root. No `sudo`,
  no setuid helpers.
- If a privileged action is needed, `pi-sec` writes a script and asks the user to
  run it — last resort, human-in-the-loop, audited.
- **No text-rule-based tool guard.** The boundary is the OS privilege level.
- **No auth in `pi-sec`.** Bind loopback; the reverse proxy or
  localhost-only access controls entry.
- **Isolated tmp**: systemd `PrivateTmp=true` gives a private `/tmp` cleared on
  restart; the janitor cleans large/old files eagerly. Durable data goes to
  known storage (the control structure or a job's referenced directory), never tmp.
- Append-only **audit log**. Threat model in [security.md](./security.md).

## 13. Tech stack

| Concern | Choice |
|---------|--------|
| Runtime | Node.js ≥ 22.19, ESM, TypeScript (strict) |
| Agent engine | `@earendil-works/pi-durable` (pinned) |
| Model/auth | `@earendil-works/pi-coding-agent` `ModelRuntime` (implements `Models`) |
| Model APIs | `@earendil-works/pi-ai` |
| State | SQLite via `@earendil-works/pi-durable/storage/sqlite/node` |
| Tools | `@earendil-works/pi-durable/tools` (`CodingTools`) + custom |
| HTTP | Node `node:http` + small router; SSE hand-rolled |
| Extension loading | dynamic `import()` with cache busting (`jiti` for TS drop-ins) |
| Tmp isolation | systemd `PrivateTmp=true` (private, restart-cleared `/tmp`) + eager janitor |
| Validation | `typebox` |
| Tests | `vitest` |
| Packaging | npm package + systemd unit |

## 14. Design documents

| Document | Contents |
|----------|----------|
| [introduction.md](./introduction.md) | A plain-language introduction for newcomers: what `pi-sec` is, how to think about it, and the end-to-end story. |
| [install.md](./install.md) | Install, connect a model provider, choose a run mode, update and roll back. |
| [architecture.md](./architecture.md) | Components, process model, harness wiring, models/auth, env, secrets boundary, lifecycle, concurrency. |
| [http-api.md](./http-api.md) | HTTP endpoints, SSE protocol, basic chat reset/compact, user queries, reverse-proxy contract. |
| [runtime-layout.md](./runtime-layout.md) | `~/.pi/sec` tree, config schema, document kinds, memory, storage, migration, tmp. |
| [extensions.md](./extensions.md) | Extension model, per-extension config, runtime vs core, hot reload, two code trees, self-improvement. |
| [boundary.md](./boundary.md) | the rule that decides whether a feature belongs to the core or to an instance extension |
| [secrets.md](./secrets.md) | Secret registry, dummy token contract, one-way redaction boundary, edge cases. |
| [security.md](./security.md) | Unprivileged operation, no-guard rationale, tmp isolation, audit, threat model. |
| [ui.md](./ui.md) | The web UI: layout, chat, job tree, inbox, theming, accessibility. |
| [roadmap.md](./roadmap.md) | Milestones from MVP to autonomy, risks, open questions. |

## 15. Milestones (short form)

1. **M0 — Skeleton**: repo, CLI, config, SQLite, `Harness` with a root
   conversation on a real model via `~/.pi/sec` credentials; `harness.resume()`.
2. **M1 — `/basic-chat`**: HTTP + SSE + a polished chat UI incl. reset and compaction controls.
3. **M2 — Tools & secrets**: `CodingTools`, unprivileged env, private tmp,
   secret redaction, audit.
4. **M3 — Autonomy**: scheduler, inbox, background subagents, `ask_user`; memory is just files edited with normal tools.
5. **M4 — Self-improvement**: runtime extension loader + hot reload + per-ext
   config; two code trees; core commit + cold-restart notice.
6. **M5 — Hardening**: systemd unit, migration, janitor, observability,
   public packaging.

Full detail in [roadmap.md](./roadmap.md).
