# Architecture

Companion to [README.md](./README.md). This document describes how the pieces fit
together at runtime, with emphasis on the pi-durable integration points.

---

## 1. Process model <a id="process-model"></a>

`pi-sec` is **one long-lived Node process** — a single daemon that owns one
pi-durable `Harness` over one storage and serves the entire HTTP/SSE interface.
There is no worker process, no message broker, and no WebSocket gateway.

```
systemd (system unit with `User=pi-sec`) or a supervised `pi-sec start`
  └── node .../pi-sec/dist/cli.js start            (runs as the dedicated pi-sec user)
        └── daemon
              ├── SQLite storage owner
              ├── Harness + secret registry + scheduler
              └── HTTP/SSE server
```

Rules:

- **Single writer.** pi-durable storage has no cross-process locking. Exactly one
  process opens the SQLite file at a time. `pi-sec doctor` does not open the
  database: it reads only the schema version file next to it. A second `start` on
  the same home exits with an error before it opens the storage.
- **Runs as its own dedicated user.** The intended install creates a dedicated,
  unprivileged Linux account for `pi-sec` (not the user's login account); the
  account name is chosen at install and is not hardcoded. Paths come from
  `os.homedir()` / `$HOME`, `PI_SEC_HOME`, or config. The user is unprivileged;
  that is an intended restriction, not a problem to work around.
- **No privilege escalation.** `pi-sec` never runs `sudo`, never uses setuid,
  never installs a privileged helper. See [security.md](./security.md).
- **All commands run as the dedicated user.** Every `pi-sec` command (`start`,
  `login`, `config`, `secret`, …) is run as the `pi-sec` account — via
  `sudo -u pi-sec …`, a login shell, or the systemd unit. No `pi-sec` code runs
  as the user's own account.
- **Startup is fail-closed.** Invalid config, an unreadable data dir, or a missing
  default model aborts startup rather than running degraded.
- **Graceful shutdown** (`SIGTERM`): stop accepting → close SSE → drain active
  work with a deadline → `harness.close(context)` → close storage. SIGKILL is safe:
  unfinished tasks are committed and resume on boot.
- **Cold restart** is how core changes apply. It means **stop the running process
  and start a new one** after `user-tools/update-and-restart` advances the snapshot
  to the new HEAD. The running process never replaces its own loaded core modules;
  it commits to the workspace tree and asks the user to update and restart
  (`runtime/supervisor.ts` coordinates health and the restart target). The UI's
  restart command asks the same question, and gets the same answer: the script runs
  as a transient systemd unit of its own, because a child of the daemon would be
  stopped with it (`runtime/restart-helper.ts`).

---

## 2. Agent runtime <a id="agent-runtime"></a>

The central object is the pi-durable `Harness`:

```ts
// src/agent/harness.ts (illustrative, not implementation)
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

const storage = await openNodeSqliteStorage(paths.stateDb);
const registry = createRegistry();
for (const ext of bundledExtensions()) registry.install(ext);
for (const ext of await loader.loadRuntimeExtensions()) registry.install(ext);

const secrets = await secretRegistry.load(paths.secrets);
const harness = await Harness.open(storage, {
  models: modelRuntime,              // implements pi-ai's Models
  registry,
  settings: liveSettings(config),    // getters: live config, no restart
  env: ({ conversationId, cwd }) =>
    new NodeExecutionEnv({ cwd: resolveCwd(conversationId, cwd) }),
  conversationCreated: (tx, conversation) => ensureAppDocs(tx, conversation.id),
  onReport: (err) => logger.warn("extension error", err),
}, BACKGROUND_CONTEXT);

harness.resume(); // continue work left unfinished by a previous process
```

> **Verified against `@earendil-works/pi-durable@1.5.0`** (and `pi-ai@1.5.0`,
> `pi-coding-agent@1.5.0`): `Harness.open(storage, options, context)`,
> `harness.root()/resume()/close(context)`, `createRegistry().install()`,
> `openNodeSqliteStorage`, `NodeExecutionEnv({ cwd, shellPath?, shellEnv?, watch? })`,
> `defineDoc`/`defineDocFamily`, `defineExtension`/`defineTool`/`section`,
> `conversation.watch(ctx)`, and
> `ModelRuntime.create({ authPath, modelsPath })` all exist as used. `Models` is
> **pi-ai's** interface, which pi-durable consumes; `ModelRuntime implements Models`.

Key choices:

- **One harness, many conversations.** `harness.root()` is the default
  conversation; scheduled jobs, subagents, and future UI features add more.
- **Bundled vs runtime extensions.** Bundled extensions are installed from the
  running code; runtime extensions are loaded from `~/.pi/sec/extensions` and may
  be hot-reloaded. Core code and bundled extensions are **cold-only**. The
  system-prompt sections that differ per conversation are bundled too
  (`conventions`, `language-rules`, `personality`, `message-tags`), and each one
  reads its settings from `~/.pi/sec/config.json`, so `docs/extensions.md` holds
  the keys.
- **Settings are live.** `HarnessSettings` (retry, compaction, streaming, tool
  execution, extension selection) is read at every use, so `settings.ts` exposes
  getters backed by the in-memory config. **Model and thinking are per-conversation
  agent state** (`pi.agent`, set through `configure()` / `root({ agent })`), not
  `HarnessSettings`.
- **Documents.** Singletons use `defineDoc`; multi-valued families use
  `defineDocFamily`. Conversation-scoped families (`sec.selfEdit`,
  `sec.asyncCall`) are created **lazily**, by the tool that first writes one, with
  `tx.doc(token, conversationId, key, seed)`; there is no
  creation hook in this implementation. Lazy creation is what makes them work in
  a conversation nothing announced — including a subagent child. Session-scoped
  families/documents (`sec.job`, `sec.inbox`, `sec.candidate`, `sec.settings`,
  `sec.userQueryList`) are keyed by id and shared across conversations.
  `sec.asyncCall` is keyed by the background call's title within its
  conversation, which is what makes that title unique; a row exists with
  `status: "unused"` when nothing but a read has touched it, and that state is
  how a duplicate title is refused (see
  [extensions.md](./extensions.md#background-calls)).

### Contexts and cancellation

Every call takes a Chord `Context`. A client disconnect aborts only that request's
wait, never the committed work. Closing a browser tab does not cancel an answer.

### Context is append-only <a id="prefix-cache"></a>

The **entry log** is append-only: `pi-sec` never modifies or deletes a committed
entry. Forward changes to the *derived model context* are expressed by appending
new entries, and the newest head marker determines where the active context
begins. Provider prefix caching is a first-class concern:

- **Reset** appends a `pi.reset` entry (`head: "self"`); older entries stay in
  storage but leave the active context.
- **Compaction** appends a `pi.compaction` entry whose `head` is the first kept
  entry; older entries stay in storage. This intentionally changes the request
  prefix, so provider caching is dropped at the compaction boundary — that is the
  point of compaction, and it is **not** a history rewrite.
- **Background compaction** (`settings.compaction.backgroundTokens`) starts the
  same append ahead of the blocking threshold so the summary is ready sooner; it
  is a systemic task surfaced in `pi.live.compactions`, not a job.
- **Prompt/tool changes** are appended as positional `pi.system` entries and take
  effect from that point forward; they never substitute earlier entries.
- Self-edits and memory writes must not mutate committed context entries.
- Sections should render deterministically; a section that returns a different
  value on every call defeats the cache.

"Append-only" constrains the **log**, not the **request**: reset, compaction, and
section changes legitimately alter what the model sees going forward. What they
must never do is rewrite or delete what was already committed.

---

## 3. Model and auth integration <a id="model-and-auth-integration"></a>

pi-durable needs a value satisfying `Models`. `@earendil-works/pi-coding-agent`
exports `ModelRuntime`, which implements `Models`. `pi-sec` owns its model
credentials and catalog rather than reading any other Pi installation:

- `~/.pi/sec/auth.json`: credential shape (API keys + OAuth tokens), 0600
- `~/.pi/sec/models.json`: custom providers and model catalogs
- `~/.pi/sec/secrets/model-auth.<provider>.<field>`: the credential values, one
  file each, 0600

`auth.json` holds a reference to each value instead of the value itself:
`{ "type": "api_key", "key": { "file": "model-auth.deepseek.key" } }`.

```ts
// src/agent/models.ts (illustrative)
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create({
  authPath: paths.secAuth,     // ~/.pi/sec/auth.json (pi-sec-owned)
  modelsPath: paths.secModels, // ~/.pi/sec/models.json (pi-sec-owned)
  credentials: new ModelCredentialStore({ authPath, secretsDir }),
});
```

Rules:

1. **Self-owned.** `pi-sec` never reads or writes `~/.pi/agent` or any other
   user's Pi configuration. The default provider/model come from `config.json`
   (`agent.model`).
2. **Login is explicit.** The web UI's "Model login" panel runs the provider
   auth flow inside the daemon, which writes the value to
   `~/.pi/sec/secrets/model-auth.<provider>.<field>`; `auth.json` names that
   file. OAuth refresh writes back the same way, so the credential is durable
   and self-contained. The daemon moves inline values to files once at start.
3. **Credentials are secrets.** The values live in `secrets/model-auth.*` files
   and in sensitive fields of `models.json`. They are registered with the secret
   registry and redacted one-way, so the agent can never read its own API keys or
   tokens. See [secrets.md](./secrets.md).
4. **Credential store.** `agent/models.ts` builds `createModels()` with
   `ModelCredentialStore` as the credential store, so `auth.json` keeps shapes and
   references and the values stay in the secret directory.

Model selection per conversation: the user sets the root's alias in `config.json` (`agent.vmodel`), and a subagent names its own when it is spawned. A scheduled job names one in `routine.vmodel` or `once.vmodel`. There is no default alias and no fallback: a config that names no root model starts the daemon in setup mode (the web server runs, the chat write routes answer `409 model_not_configured`, and the first model is chosen on the web page or with `pi-sec setup-model`), a root model that is named but unusable stops the boot, a spawn without `vmodel` is refused, and a run whose record names none fails without starting. The agent itself cannot change the model.

---

## 4. Execution environment

pi-durable's built-in tools operate only through an `ExecutionEnv`. `pi-sec`
supplies `NodeExecutionEnv` with a resolved working directory; tmp isolation comes
from systemd, not from env vars. There is **no text-rule command/path guard** —
see §7.

```ts
env: ({ cwd }) => new NodeExecutionEnv({
  cwd: cwd ?? paths.workspace,
  shellEnv: process.env,   // tmp isolation is systemd PrivateTmp, not TMPDIR
})
```

Responsibilities:

- Rely on systemd `PrivateTmp=true` for a private `/tmp` (see
  [security.md](./security.md#tmp-isolation)); the janitor cleans it eagerly.
- Write no audit row per tool call. A tool call leaves its trace in the log and
  in the conversation, and the audit log records the records that change.

Tools run in the **same view as the agent**: same unprivileged user, same
filesystem, same namespaces, same working set. There is no per-tool sandbox or
container. The dedicated user is the security boundary — the agent can do exactly
what that user can do and nothing more.

The agent's default working directory is its **workspace tree** (the writable
checkout). It can be granted read access to the user's project roots via config. It
is not pointed at `~/.pi/sec` for coding tasks, keeping data and code separated.

---

## 5. Secret boundary

Secrets must never enter model context, and redaction is **irreversible**. The
harness maintains a local registry and redacts text in one direction only:

```
tool output / user input / fetched text ──redact──▶ dummy tokens ──▶ model context
                                                          │
                     model writes a script that reads ~/.pi/sec/secrets/<name>
                                                          ▼
                                                   execution (real value)
```

- At commit: every occurrence of a secret value is replaced with a **fixed**
  dummy token (length is not preserved) before the entry is stored.
- There is **no resolution step**. A dummy in a tool argument is passed literally
  and can never be converted back.
- To use a secret, the model writes a command/script that reads the secret file
  itself. The system prompt tells it the path and the available names.
- Output that echoes a secret is redacted before the model sees it again.
- Redaction is applied when content is committed: entries are stored already
  redacted. The request the model receives is redacted again, message by message,
  because `beforeRequest` maps every message of the request through the redactor.
  See [secrets.md](./secrets.md).
- **Model credentials count as secrets.** The values live in
  `~/.pi/sec/secrets/model-auth.*` files that `~/.pi/sec/auth.json` names, and
  sensitive fields of `~/.pi/sec/models.json` are registered the same way, so
  reading `auth.json` yields only file references and reading a secret file
  yields a placeholder.

Full contract and edge cases in [secrets.md](./secrets.md).

---

## 6. Server architecture

```
node:http server
  ├── Router                (method + path prefix; base path aware)
  ├── Middleware chain
  │     ├── request id + context
  │     ├── forwarded headers, when the peer is a trusted proxy
  │     ├── host check                  (421 misdirected)
  │     ├── origin check, writes only   (403 origin_forbidden)
  │     └── body parsing (JSON, size-limited)
  ├── Routes (principal)
  │     ├── GET  /healthz
  │     ├── GET  /basic-chat                      (HTML)
  │     ├── GET  /basic-chat/events               (SSE)
  │     ├── POST /basic-chat/messages
  │     ├── POST /basic-chat/abort
  │     ├── POST /basic-chat/reset                (new context)
  │     ├── POST /basic-chat/compact
  │     ├── GET  /api/conversations
  │     ├── GET  /api/conversations/:id/events    (SSE)
  │     ├── POST /api/conversations/:id/messages
  │     ├── GET  /api/jobs
  │     ├── GET  /api/jobs/events                 (SSE)
  │     ├── GET  /report                          (HTML)
  │     ├── GET  /report/:name                    (HTML)
  │     ├── GET  /api/reports
  │     ├── GET  /api/reports/:id/diff
  │     ├── GET  /api/inbox
  │     ├── POST /api/inbox/:id/read
  │     ├── GET  /api/user-queries
  │     ├── POST /api/user-queries/:key
  │     ├── GET  /api/remote-machines
  │     ├── POST /api/remote-machines/:id/level
  │     ├── POST /api/admin/reload
  │     ├── POST /api/admin/restart              (asks systemd to run the update script)
  │     └── GET  /api/admin/status
  └── SSE writer (heartbeat, event ids, bounded queue)
```

- **No auth middleware.** `pi-sec` does not authenticate. It binds loopback; the
  reverse proxy (or localhost-only access) is the access boundary. A
  forwarded identity header, if present, is used only for display/audit, never for
  a security decision.
- **No framework required.** A small router keeps the public project light and
  auditable. `hono` is the candidate if a framework is later justified.
- **Static, polished UI** from `src/web`: theme tokens, responsive chat,
  rendered markdown, a live job tree, and an inbox. See [ui.md](./ui.md).
- **Backpressure**: bounded SSE queues; a slow client is disconnected and gets a
  fresh snapshot on reconnect (pi-durable already collapses lagging watchers).
- **One source per streaming endpoint.** The upstream watch and the control-event
  subscription belong to the endpoint, not to the connection, and fan out to every
  attached client (`src/server/streams.ts`). A window is a reader, never a second
  source: watching per connection publishes each event once per open window, so a
  second window duplicates every frame for all of them. A client that joins while
  the endpoint is live takes its snapshot under a barrier, which holds
  publications until the snapshot is on the wire — so the snapshot and the frame
  stream tile exactly, with no gap and no repeat. A client whose `Last-Event-ID`
  replay would cross a stretch nobody was watching gets a snapshot instead, since
  those commits reached no buffer.

### The two header checks

Both checks run before any route, after the mount point is resolved. Neither one
authenticates anybody:

- The **`Host` check** accepts the hostname of `server.publicUrl` or a loopback
  name, and refuses any other name with `421 misdirected`. Without `publicUrl`,
  only loopback names pass.
- The **`Origin` check** runs on every method except `GET` and `HEAD` and refuses
  a value that is not the origin of `server.publicUrl` or a loopback origin on the
  listening port. The refusal is `403 origin_forbidden`. A request with no `Origin`
  header passes.

There is no request rate limit. A proxy in front of the daemon can add one. The
daemon sees the proxy's address, so a counter of its own would put every client in
one bucket. The full rules are in
[http-api.md](./http-api.md#31-host-and-origin-refusals).

---

## 7. No text-rule tool guard (rationale)

Earlier designs put an allow/deny policy in front of tool calls (command patterns,
path allowlists). That is intentionally **removed**:

- Command-string heuristics are easy to bypass and create a false sense of safety.
- The real boundary is the **OS privilege level**: the process is unprivileged,
  so `rm -rf /`, reading system files, etc. are already constrained by the
  filesystem and the fact that there is no root.
- The agent and every tool it runs share one unprivileged account. The guarantee is
  "never root", not "only these commands".

What remains:

- Private tmp isolation (cleanup hygiene).
- Secret isolation (keep credentials out of model context).
- Append-only audit (visibility, not enforcement).
- For genuine privilege needs: **generate a script, ask the user to run it**. No
  privileged broker, no `sudo`, no setuid. See
  [security.md](./security.md#privileged-actions).

---

## 8. Concurrency and scheduling

- **Submissions**: POST handlers call `conversation.submit(...)`. If busy, the
  default is a follow-up; `steer`/`reject` are selectable. `requestId` provides
  idempotency. Whatever the queue holds when a boundary comes is placed together,
  rather than one item per boundary: the queue is where every asynchronous
  arrival lands — a background result, a message from another agent, an input
  typed while the agent works — and one item per boundary would cost one run per
  arrival. The trade is that several messages arrive as one user message, so the
  model answers them in one turn.
- **Durable tasks**: the scheduler creates tasks with persisted schedules;
  pi-durable checkpoints every step, so jobs survive restarts.
- **Background work** runs as background-owned tasks so long jobs do not keep the
  main conversation busy.
- **User queries** (`ask_user`) are durable: the question goes into the active
  list document and the tool returns at once. The answer arrives as input from the
  user that drives the next turn. See
  [http-api.md](./http-api.md#user-queries).
- **No default execution timeout.** Tool calls run until they complete or are
  aborted. Durable tasks make long-running tools safe across restarts; there is no
  implicit deadline on any tool call.
- **Parallelism**: tool calls may run in parallel where safe; CPU-heavy work goes
  through `exec` child processes.

### High-level jobs <a id="job-registry"></a>

`pi-sec` maintains a first-class, app-level **job registry**. A *job* is the
**highest unit of work** the agent has taken on — the thing a secretary would put
on a task board. Jobs are durable, first-class records owned by `pi-sec`; they are
**not** derived from pi-durable's internal task graph.

**Identity and storage.** A job has a ULID `id` and is stored as one document in
the `sec.job` family (`sec.job:<id>`), session-scoped, latest-wins — so jobs span
conversations and survive restarts. `jobs_list` is always available and returns
the full tree.

**Fields.**

| Field | Type | Meaning |
|-------|------|---------|
| `id` | ULID | Stable identity. |
| `title` | string | Short human label. |
| `description` | string? | Optional detail. |
| `status` | enum | `planned` \| `active` \| `waiting` \| `paused` \| `done` \| `failed` \| `cancelled`. |
| `parentId` | ULID? | Subjob link; parent/child is the only hierarchy. |
| `origin` | enum | `user` \| `agent` \| `scheduler` \| `system` — who created it. |
| `labels` | string[] | Freeform tags; never a type that constrains behavior. |
| `memoryAnchors` | string[] | Zero or more `file#anchor` pointers into the memory directory. |
| `stateDir` | path? | Optional directory for artifacts; any path the `pi-sec` user can write. |
| `routine` | RoutineSpec? | The recurring schedule itself: `{ cron, timezone?, catchUp?, overlap?, prompt, vmodel?, enabled? }`. The reconciler reads it on every tick, so the record is the schedule. A write that touches it needs `reportId`, and a job that carries it is never archived. A tool that writes one must name `vmodel`; the field stays optional on the record so a record written earlier is still read, and a run that names no model fails instead of borrowing the root's. |
| `once` | OnceSpec? | A single run: `{ at, prompt, vmodel?, state? }`. `at` is epoch milliseconds, written from an ISO 8601 instant that names its offset. `state` is `pending`, `done`, `cancelled`, or `missed`. The run fires once, and the job closes as `done`. A write that touches it needs no approval, and it must name `vmodel` like a routine. |
| `conversationId` | ULID? | Conversation where its work lives, if any. |
| `taskIds` | string[] | Zero or more internal pi-durable tasks backing it. |
| `createdAt` / `updatedAt` | number | Timestamps. |
| `lastRun` | RunSummary? | `{ at, status, summary }` of the most recent run. |
| `stats` | object | `{ runs, failures }`. |

**Hierarchy.** A job has at most one parent, and `parentId` is the *only*
job-to-job relationship — no dependency edges, no cross-links. Subjobs are
independent records; the parent does not own their lifecycle, but the UI rolls
their status up for display.

**Lifecycle.** Transitions are explicit calls (`jobs_update`, the scheduler, the
API), never auto-derived from task events:

```text
planned ──▶ active ──▶ done
            │  ▲  │
   pause ───┘  │  └──▶ failed
               ▼
            waiting / paused
any non-terminal ──▶ cancelled
```

- `planned` (created, not started), `active` (running), `waiting` (blocked, e.g.
  on `ask_user` or an external event), `paused`, `done`/`failed` (terminal),
  `cancelled` (terminal).
- Terminal jobs are retained, never deleted, so the agent can always enumerate
  what it did.

**Archiving.** A job that has been terminal for `archive.afterDays` (default 3)
moves out of the live store into `state/archive.sqlite`. The sweep that moves it
runs once a day at `archive.sweepAt` (default `05:00`) in the harness `timezone`,
and it runs no sweep at boot: a daemon that was stopped at that time skips the day
rather than catching up, so a restart is never a second sweep. Nothing is deleted,
an archived id still resolves, and a job that carries `routine` is never moved.

**Jobs vs. tasks.** A *task* is a mechanical step of a run (model call, tool
call, scheduled work item). A job may reference zero or more `taskIds`; tasks
never reference jobs. The scheduler, a background subagent, or the agent
correlates a job with its task(s) and updates the job when they finish. Jobs are
never auto-derived from the task graph — the model decides what counts as a job.

**Producers.** The scheduler (firing a `routine` or a `once` record), the
background-subagent tool, the agent (`jobs_create`), and the user
(`POST /api/jobs`).

**Tools.** `jobs_list` (tree; optional status/parent filters), `jobs_get`,
`jobs_create` (title, description, parent, labels, memory anchors, state dir,
conversation, `routine`, `once`, `reportId`), `jobs_update` (status, fields,
`routine`, `once`, `reportId`, and `parentId`: a job id moves the job under that
job, `null` removes the parent), `jobs_cancel`. `jobs_list` is the guaranteed way
for the agent to enumerate its work at any time.

`jobs_cancel` and the cancel route cancel the job and each descendant that is
not `done`, `failed` or `cancelled`, in one commit, and a descendant that already
finished keeps its status. An open job below a finished one is cancelled too. The
tool refuses the whole call when an open descendant carries `routine`, writes a
`routine_refused` audit row with code `routine_descendant`, and changes nothing.
The cancel route counts such a descendant as one more reason for the routine
gate instead, so one approval closes both. See
[http-api.md](./http-api.md#jobs).

`jobs_create` and `jobs_update` accept `routine` and `once`, and both reject an
unknown key. The write checks the value before it stores it: `cron` through the
parser the reconciler uses at every tick, `timezone` against `Intl`, and `at` as
a future instant on create. A job carries one of the two fields or neither, and
a write that sets both is refused.

A write that touches `routine`, and a status change on a job that carries
`routine`, needs `reportId`. That report's newest revision must carry an
approval, and the approval must name the same `sha256` as that revision. See
[Routine jobs](#routine-jobs).

The old `schedule` field is retired. A record written before the change can
still carry one, and nothing reads it. `routine` and `once` replace it: the
scheduler reads those and no copy of an entry.

`jobs_update` checks a string `parentId` before it commits. It refuses a parent
that does not exist, the job itself, and a job below the job being moved. A cycle
makes `jobs_list` and every tree walk recurse without end. The walk up from the
new parent is what decides it, and an id seen twice on that chain is refused too.
A `null` is not checked, because removing a parent cannot close a loop.

**Surfacing.** The web UI shows a live job tree backed by `GET /api/jobs` and
`GET /api/jobs/events` (SSE). The prompt contains only a stable section
explaining the model and the `jobs_list` tool — never a live list, preserving the
prefix cache.

### Inbox <a id="inbox"></a>

The inbox is `pi-sec`'s durable channel for asynchronous messages **to the
user and agent** — job results, briefing notices, subagent reports — as
opposed to a live chat turn or a queued submission. It is **not** pi-durable's
`pi.inbox`: that built-in is a conversation's queue of pending submissions
(`steer`/`followUp`/`write`), surfaced as `snapshot.inbox` and `inbox_update`.

The message inbox is `pi-sec`'s own session-scoped document family `sec.inbox`,
one document per item:

- **Items** are produced by the scheduler (a job result), the `notify`
  extension, and background subagents (a report). The morning briefing arrives as
  a briefing report rather than as an item of its own, so its notice is the one a
  report write leaves.
- Each item has `id`, `kind`, `title`, `body`, `createdAt`, `readAt?`,
  `source` (`jobId` / `conversationId` / `reportId` / `reportEvent?`), and an
  optional `severity`.
- A report notice carries the report's own `title`, with no `Report published:`
  style prefix in front of it. The write that raised the notice is held in
  `source.reportEvent` (`published` / `updated` / `answered`), and the inbox row
  draws that event as the color of the mark before the title. An item the
  `notify` tool raises for an existing report has `reportId` and no
  `reportEvent`. Stored items and the migration are unchanged: `source` is kept
  whole, so the new field is optional everywhere.
- The user sees unread items in the UI; reading marks `readAt` and does not
  delete the item. The agent can list unread items in a run.
- An item is never deleted either. A briefing report that a newer one replaces
  takes the notices that point at it, and every item of kind `briefing`, into the
  archive database with it; the live inbox then holds no notice of the earlier
  briefing.
- Surfaced as an `inbox_item` SSE event and via `GET /api/inbox` /
  `POST /api/inbox/:id/read`. The pi-durable submission queue is surfaced
  separately as `inbox_update`.

### Scheduling <a id="scheduling"></a>

A schedule is a field on a job record. `routine` makes the job recur, and `once`
runs it one time. The record is the only schedule: a change to the record is a
change to the schedule, and the next tick reads the new value. The scheduler is
an in-process timer (`scheduler.tickMs`), not a separate broker. Each due
occurrence becomes durable work, so it survives restarts.

A job fires only while its status is `planned`, `active`, or `waiting`. A
`paused` job does not fire, and a finished job does not fire. `routine.enabled:
false` stops a routine and keeps its record. Unpausing resumes at the next due
time, because that occurrence is still ahead of `lastRun`.

**The old list is a migration input.** `config.scheduler.jobs` was the schedule
before this change. The first boot on the new code reads it once, moves every
entry onto a job record's `routine`, and empties it. Three steps run in this
order, and the order is the point:

1. Fill `routine` on every matching record. The migration finds the record by
   the label `schedule:<name>`, and by the title when no label matches. It
   creates the record when neither matches, and that new record has no parent.
   Then it reads every routine back and compares it with the entry it came from.
2. Copy `config.json` to `config.json.bak-<stamp>-routine-migration`, and replace
   `scheduler.jobs` with an empty array.
3. Write `state/scheduler-migration.json` with each name and the job id it moved
   to. A later boot reads this file and does not run the migration again.

The records are filled before the list is emptied, so a process that stops in
the middle leaves the schedule in place. The next boot runs the migration again
and writes the same values. Emptying the list first loses a routine, and nothing
notices until the run does not happen.

A failed migration keeps the scheduler off for that boot, and the log, the audit
row, and an event name the reason. A half-moved set of routines either runs the
same work twice or stops one routine without a word. A boot with no routines says
so at once. `Scheduler.start()` waits for the migration and starts the timer only
after it succeeds.

A non-empty `scheduler.jobs` after the migration is refused, and the refusal
names the entries it ignored. The scheduler reads the records only, so an edit to
the old list changes nothing that fires. The message says so and tells the reader
to fix `routine` on the record. It appears in the response to
`POST /api/admin/reload` and in a banner on the jobs panel.

The `jobs` key stays in the config schema because the migration reads the list
before the process that empties it can run. `config.scheduler` keeps three global
values: `enabled`, `tickMs`, and `timezone`.

- **Timezone.** Cron expressions are evaluated in `routine.timezone` (IANA,
  falling back to `scheduler.timezone`, default `UTC`) and are DST-aware. A
  written expression is parsed before it is stored and again when the config
  loads, so a typo fails the write or the load instead of disabling one routine
  in silence.
- **Missed runs.** Every tick compares the job's `lastRun` with now and asks the
  expression for the most recent due minute strictly after it. `catchUp` decides
  what a due minute that is already more than five minutes old means. `skip`
  (default) does not run it: the tick moves the in-process `lastRun` to now,
  records a failed run with the summary `missed occurrence skipped`, and the
  occurrence is gone. `catchUp: "once"` and `catchUp: "all"` both run it, because
  the reconciler looks at that one most recent due minute and never replays the
  older ones. A process that was down for a day runs one catch-up, not one per
  missed minute.
- **Overlap.** A run does not start beside an unfinished one. Before an occurrence
  is dispatched, the reconciler reads the job's newest round (the
  `conversationId` the previous dispatch wrote) and that round's most recent 50
  tasks. If any of them has not settled, the occurrence stays pending and the
  tick returns without dispatching. `lastRun` is not advanced, so the occurrence
  is not lost, and it starts on the first tick after the round ends. That wait
  applies whatever `overlap` says. The setting is read in one place: a job whose
  dispatch is still running inside the same pass returns at once under `skip` and
  is let through under `queue` or `allow`, and `tick` already refuses to run
  twice at once. So the three values behave the same today. The wait is also not
  a queue: it holds one occurrence, and an occurrence that cannot start within
  five minutes of its due minute is dropped by `catchUp: "skip"` when the round
  ends.
- **No concurrency cap.** Earlier revisions declared `scheduler.maxConcurrent`
  and this document promised that "at most N job instances run at once". Nothing
  ever read it. `dispatch()` records the round's conversation on the job, and the
  overlap wait reads it, but that is one pointer per job and not a count of live
  rounds. So the field was removed rather than left promising behaviour nothing
  carried out, and **scheduler work is unbounded**, bounded in practice only by
  how many routines the user keeps.
- **No default timeout.** A run continues until it completes or is aborted, like
  any other durable task.
- **One scan per tick.** One pass is one `jobs.list` scan with a field test for
  `routine` or `once`. The label `schedule:<name>` is not a schedule link
  any more, because a label filter matches a whole string and a relabelled record
  stops firing without a word.
- **No archive for a routine.** A job that carries `routine` is never moved to
  the archive, whatever its status. The schedule lives on that record, and the
  reconciler reads the live store. A one-off run is not exempt: after it fires it
  is a finished job like any other and leaves after `archive.afterDays`. An
  archived routine loses its schedule, and the next boot does not start it.
- Each occurrence updates the job's `lastRun`/`stats` and may write an inbox item.
  Note what those record: `stats.runs` counts **dispatches**, and
  `lastRun.status: "success"` means the occurrence was admitted (the prompt was
  queued on a new conversation) and not that the agent went on to succeed.
  Nothing currently follows a run to its end.

**One-off runs.** A job with `once` fires at `at` and then it is over. `state`
carries the life of the run, and four rules cover it.

1. Create it with a future time. `at` is an ISO 8601 instant that names its
   offset, or epoch milliseconds. A write that names a past instant is refused,
   because a run set for a time that has passed either fires at once or is
   dropped as missed. Creation needs no approval.
2. It fires when a tick finds `at` reached. The dispatch is the same one a
   routine uses, so the run is a `scheduled` conversation with the same tools. A
   firing creates a conversation and creates no job.
3. After it fires, `once.state` is `done` and the job closes as `done` in the
   same commit. The record stays, it never fires again, and it is archived after
   `archive.afterDays`.
4. Cancel it before the time with `jobs_cancel` or `jobs_update {status:
   "cancelled"}`, and no approval is needed. `once.state` becomes `cancelled` in
   the same write.

A `pending` run whose time passed by more than five minutes is not fired. The
reconciler closes it with `once.state: "missed"` and the status `done`, and the
panel shows it as missed. Five minutes is the window `catchUp: "skip"` uses for a
routine, so one constant covers both rules. A missed run says so as a value, and
a `pending` run is never left looking due on every tick.

A job carries `routine` or `once`, never both. The two differ in when they fire,
in whether a change needs approval, and in what happens after firing, so one
record cannot hold both without a rule that says which side wins. A rule that can
disagree with itself is the state this change removes: a job that looks scheduled
and never runs. Make two records when both are needed.

### Routine jobs <a id="routine-jobs"></a>

A routine is a job that carries a `routine` field. Two properties follow from
that field, and they are the whole of what a routine is.

- **It carries the prompt the scheduler dispatches.** The scheduler finds a
  routine by the field on the record, and it creates no job of its own. One
  occurrence becomes one conversation, and the same record fires the next one.
- **Its creation, its change, and its removal take an approved report.** A
  routine is a durable change to what the harness does on its own, so it takes
  the user's word. A one-off run does not.

A routine is a child of the job that owns the work it does, so the panel draws it
under that job. There is no container job for routines, and no label marks one.
The set of routines changes, so no count and no name is fixed in this section or
in code.

**Creating a routine.** Write the plan as a report, have the user approve the
newest revision, then call the tool with that report's id.

1. `jobs_create {title, parentId: <the owning job>, routine: {cron, prompt, vmodel,
   timezone?, catchUp?, overlap?, enabled?}, reportId}`.
2. The write checks `cron` with the parser the reconciler uses at every tick, and
   it checks `timezone` against `Intl`. A value that the reconciler throws on
   cannot be stored. It also checks `vmodel`: the key must be one the config
   declares, and a write that names none is refused before anything is stored.
3. Check with `jobs_list` that the routine sits one level under its owner.

**Changing a routine.** A write that touches `routine` takes the same path:
`jobs_update {id, routine: {...}, reportId}`. A write that leaves `routine` out,
such as a new title, needs no approval.

**Removing a routine.** Removal is durable, so it takes the same approval.

1. Ask in a report: the name, the job id, the last run, the run count, and the
   reason. Wait for the approve button on the newest revision.
2. Delete the field with `jobs_update {id, routine: null, reportId}`. Firing stops
   at the next tick, and the record stays.
3. Close the job with `jobs_update {id, status: "done"}`. The field is gone by
   this step, so this write passes without the gate, and the approval for the
   removal covers it. Do not cancel a routine that has finished its work: a
   cancellation reads as a failure, and a cancel also cancels every descendant
   that is not finished.
4. Close live subjobs first, because a live child holds the parent back from the
   archive.

A record with no `routine` is archived like any other finished job, so the row
leaves the list after `archive.afterDays`. No tool deletes a job record, so a
removal means "delete the field and close the record". Writing the store file by
hand is outside the tools, and no gate sees it.

**The gate.** One rule covers the field:

> A write needs `reportId` when it creates, changes, or removes `routine`. It also
> needs one for a status change on a job that carries `routine`, such as a pause, a
> close, or a cancel. A job with `once` only, and a job with no schedule, passes
> without one.

An approval is written by Approve, and by Done, which is the approve button of a
result report. A briefing report asks for no approval at all, so it can never
clear this gate: the check answers `report_is_briefing`. Done records the same
approval record, with `button: "done"` on it,
so the gate below reads it exactly as it reads a press of Approve: the gate asks
which revision was approved and never which button wrote the record.

The approval must sit on the newest revision of that report, and the approval
record must carry the same `sha256` as that revision. A revision published after
the approval makes the approval stale, and the write is refused. A change from
`once` to `routine` is a routine creation and takes the gate. A change from
`routine` to `once` is a routine removal and takes it too. A write that sets
both fields at once is refused.

A refused write does not change the record. The tool answers with `isError` and
says what is missing and what to do: publish the plan, have the user press
Approve on the newest revision, and pass that report id. The refusal is also an
audit row. The HTTP routes apply the same rule for `POST /api/jobs`, `PATCH
/api/jobs/:id`, and `POST /api/jobs/:id/cancel`. `request_restart` checks its
approval with the same function (`checkApprovedReport` in
`src/jobs/registry.ts`): the report is live, its job has not ended, and the
approval names the sha256 of the newest revision. Only the words that name the act
and the next step differ between the two gates.

**Writes that skip the gate.** Two paths write a schedule field without a person
asking: the boot migration, which fills `routine` from the old list, and the
reconciler, which records a run and closes a `once` job it fired. Both are
exempt, and the code names them. A gate on those paths fails inside the
scheduler and leaves a routine stopped with a warning line.

**Custody.** A routine belongs to the job that owns its work, and a change of
owner is a `jobs_update {parentId}` with no approval. The prompt stays on the
routine, so a moved routine still fires with its own words.

### Remote machines <a id="remote-machines"></a>

A remote machine is another computer this install reaches over `ssh`. One object,
`RemoteMachines` in `src/remote/machines.ts`, owns everything the process does with
one: its level, its heartbeat, the connections it keeps open, the block that stops
them, the detached runs it starts and checks, and the files it moves over `sftp`
and `rsync`. There is one of these per runtime, created by `createAgentRuntime`
beside the job registry and the inbox, and every caller reads it rather than
keeping a copy.

```
config.json  remoteMachines            (address, port, users, key file, interval)
     │  read on every use, never copied
     ▼
RemoteMachines ──timer──► heartbeat per user ──► ssh (src/remote/ssh.ts)
     │                        │
     │                        ├─ host key mismatch ──► block + root notice
     │                        └─ machine-id mismatch ─► block + root notice
     ▼
sec.remoteMachine  (level, per-user state, first machine-id, block, pending, outage start)
sec.remoteRun      (per detached run: machine, user, pid, tick, dueAt, judgment)
     │
     ├──► GET  /api/remote-machines            (the panel's list)
     ├──► POST /api/remote-machines/:id/level  (the slider)
     └──► remote_machine_updated               (SSE, the panel re-reads)
```

**The config is live and the store is durable.** The machines are named in
`config.json`, and the manager reads that key each time it needs it: every
heartbeat round and every request. So adding a machine or changing an address
reaches a running daemon with one config reload, which is the class of section 9.
What the store holds is only what a reload cannot say: the level the user chose,
what the last heartbeat found, the first machine-id read, and any block. A machine
removed from the config keeps its record and is not shown, so adding it back finds
the level and the block it had.

**Two things stop every connection to a machine.** The host at the address not
presenting the pinned key, and a machine-id that is not the expected one. A block
is written to the record with a digest of the pinned keys and that machine's
config entry; it stays until that digest changes, which is exactly when the
operator pinned a new key or edited the entry. That is why no block needs a button
and none re-alerts on a timer.

**Nothing is contacted that should not be.** A machine at `off` costs no `ssh`
call, and the only command it may still cost is `ssh -O exit`, which talks to a
local socket and to nothing else. A machine with no pinned key is not contacted
either: the strict check would refuse it anyway, and the panel says
`host key not pinned` instead.

**A heartbeat is cheap.** One `cat /etc/machine-id` per user per interval answers
both questions at once: is the machine up, and is it the same machine. The
connection is kept open by `ControlMaster` with `ControlPersist=300`, so the next
round costs about 20 milliseconds instead of a handshake. A user's state is written
only when it changes, so a machine that stays up for a day costs one write and not
one per round.

**A loosening tells the root.** A level that moves toward wider permissions is
announced in the root conversation once, numbered by the machine's change sequence,
through the same device the restart notice uses.

**A tightening waits for what no longer fits.** The new level is stored at once,
like a loosening. The core then asks the run records which runs the level
disallows: everything, when the new level is `off`, and the runs that started at
`on` when it is `restricted`, because a run that started at `restricted` already
carries that limit. With none, the change applies at once and nothing is announced.
With some, the machine's record holds `pending` (the level, when the wait started,
the deadline and how many runs are left), the root receives one request that names
those runs and the agent that started each, and a timer is armed for the deadline.
The connections stay open for as long as the wait lasts, so the cleanup has a way
in: a machine at `off` closes them when the last run is gone, not when the slider
moved. At the deadline the core stops what is left through the run's own stop path,
tells each starting conversation that the core did it, tells the root once, and
drops the wait. A machine that cannot be reached at the deadline keeps its wait and
gets the same attempt when it answers.

**A machine that stops answering is made off by the core.** A machine the user did not
set to `off` that no user can reach for longer than `remoteMachines.outageSeconds`
is made `off` by the core, and the core asks nobody first. The outage starts at the
moment a heartbeat round first found the machine down, and that moment is kept in
the machine's record rather than read from a user's `since`, which moves whenever the
failure text changes. One outage makes the level `off` once: one commit writes the
level with the moment of the change and the next change sequence, drops the outage
record, settles every run that was live on that machine, and writes one inbox item
for the user. Everything after that commit is memory and messages: the tightening
deadline is cleared, the run timers are cancelled, the connections are closed, one
`remote_machine_updated` frame goes out, the audit trail gets its rows, each starting
conversation hears about its own run, and the root gets one notice that asks for no
action. The item is in the commit, so the user is told even when the process dies
right after the write, and the notice is the root's own record of the change.
The record is dropped when any user answers, when the level becomes `off`, and when
a block stops the machine, so the next outage is a new one with a new start. It
lives in `sec.remoteMachine`, so a restart keeps an outage the core had already
started. A block sends its own notice instead: a host key that does
not fit is not a machine that is off. The decision itself is `src/remote/outage.ts`,
a function of the stored record, the users, the level, the block and the clock, and
the manager only carries it out. The core cannot tell a machine that is powered down
from one that lost its network, so all of them end at `off`, and the slider is the
only way back.

**A run that was live is stranded, and the wake reports it.** The automatic off
dials nothing: every run that was live on that machine is written `stranded` in the
same commit, which is a fact about what the core did and not a reading of the run's
files. Its timer is cancelled, so no check dials the machine, and one message goes to
the conversation that started it. When the user raises the level of that machine
again, the core puts each stranded run back to live with a fresh check time and reads
it once, so the conversation that started it learns what became of it: finished,
lost, running, or stopped.

**One frame, one read.** Every change emits `remote_machine_updated` with the
machine's id, and the panel answers it by re-reading the list. The admin reload
route emits `extension_reloaded` *before* it replaces the config
(`src/server/routes/admin.ts`), so the panel must not refresh on that frame;
`setConfig` tells the manager instead, and the manager's own frame comes after the
new config is in place.

### Detached runs and their checks <a id="remote-runs"></a>

A run is a directory on the machine and a document in the store, and the pair is
what lets it outlive both the ssh session and the daemon.
`~/.local/state/pi-sec/runs/<run id>/` holds the command, its `cwd`, the level it
started at, the runner script, the process number and its start tick, the output
file and the exit status; `sec.remoteRun` holds what this install must remember:
the machine, the user, the conversation to answer, the start time, the process
number and tick, when the next check is due and the last judgment delivered. The
run id is a digest of the conversation and the tool call, so a call that is
replayed after a restart finds its own directory, and creating that directory is
the one step that starts a process: `mkdir` fails when it is there, so the second
call starts nothing.

**One timer per live run.** The interval is `runCheckSeconds`, and a check starts
thirty seconds before it so that the message lands inside the interval instead of
just after it. A check is one `ssh` call that reads three things: whether the
`exit` file is there, whether the recorded process number is alive with the start
tick that was recorded, and the size and change time of the output file. One call,
three answers, four judgments: finished, running, lost and unreachable. A live
number with a different tick is lost, because a number is reused by whatever starts
next. An unreachable machine keeps its schedule and is asked again a minute
later, without a message; a machine whose heartbeat turns `reachable` again is
checked at once, because a connection that came back is news. At boot the manager
reads the run records and checks what is already overdue, so a restart costs one
check per live run and nothing else.

**A check answers the conversation that started the run.** A scheduled check
reports whatever judgment it made, one that is not scheduled reports only when the
judgment changed, and finished, lost and stopped are reported once before the
checks end. Every message carries its own request id and arrives as `system` with
`via="remote-machines"`, so two checks never merge. When the starting conversation
is gone, or its agent record ended as stopped, failed or deleted, the message goes
to the root instead; when the root is not there either, it becomes an audit row
and nothing else.

---

## 9. Configuration and live settings

| Class | Examples | Applies |
|-------|----------|---------|
| **Live** | enabled extensions, compaction policy, extension configs, `remoteMachines`, per-conversation model/thinking (`configure()`), `timezone` | Immediately via getters / `registry.install()` / per-ext config reload |
| **Startup** | bind address/port, base path, storage path, snapshot/workspace tree paths | Requires cold restart |

`timezone` is live for `expiry_check` and for the `<meta name="pi-sec-timezone">`
stamp the server writes on every page. The restart notice writes the boot time
once, at boot, with the config that boot read. The preamble line that names the
zone is a sealed section, so a reload reaches that line at the next new session (a
new conversation, a reset, or a compaction).

`settings.ts` exposes `HarnessSettings` whose getters read the current config, so
a config reload affects subsequent work without a restart. A tool's own limits
are read the same way: the harness reads `outputLimits` while it sets up each
call, and the `js` tool supplies it as a getter over `agent.tools.js`, so that
tool follows a reload too. Startup-only changes surface the restart state
(`restartRequired` / `restartReady`) in the admin API; see
[extensions.md](./extensions.md#core-candidates) for how it is raised.

---

## 10. Observability

- **Structured logs** (`logs/app.log`, JSON lines) keyed by request, conversation,
  task, and submission ids, with secret redaction.
- **Audit log** (`logs/audit.jsonl`) for record changes: jobs, reports, drafts,
  inbox items, subagents, session restarts, self-edits and restarts. It holds no
  row for a tool call, for a secret read, or for a successful config reload.
- **Health** (`GET /healthz`): a fixed `200` that reports the process is answering,
  with `status`, `version`, `apiVersion`, `uptimeMs` and `scheduler`. It checks no
  store and returns no other status.
- **Diagnostics** (`GET /api/admin/status`): the version, the uptime, the restart
  flags and their times, the sections whose source moved, the last config error
  and notes, the installed and runtime extensions, the secret names, the
  scheduler state, and the root vmodel and server address.
- **Install check** (`pi-sec doctor`): the config, each vmodel's model and prompt
  file, the root's role files, the vmodels and role files that the conventions
  name, the storage schema version, and the secret store. It needs no running
  daemon and does not open the database.

---

## 11. Failure handling

| Failure | Behavior |
|---------|----------|
| Process crash / SIGKILL | WAL survives; `harness.resume()` continues pending tasks. |
| Model request fails | pi-durable retry policy; surface `unanswered` with reason. |
| Tool throws | Error result committed; model may recover. |
| Storage write fails | Run fails closed; committed state stays consistent. |
| Runtime extension throws at load | Logged, skipped, others still load. A configured-but-missing *required* runtime extension is a warning, not fatal. |
| Client disconnects | Only that SSE stream closes; committed work continues. |
| Config invalid at runtime | Keep last-good live config; surface error in status. |
| Core change breaks boot | The user's cold restart exposes the failure; git (and a user-managed storage copy) is the rollback. `user-tools/` provides recovery scripts. |
| Secrets store unreadable/inconsistent | **Fail closed.** Refuse to start (or refuse all model/tool work) with a prominent error; never run with a partial or empty registry while secret files exist. |
