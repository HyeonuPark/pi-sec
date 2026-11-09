# Runtime Layout & Data Model

Companion to [README.md](./README.md). Defines where `pi-sec` keeps its data and
what that data means. **None of this lives in the git code tree.**

Path resolution:

- `PI_SEC_HOME` env var overrides everything.
- Default: `~/.pi/sec`, under the run account's home. No other variable moves it.
- `~` is the **dedicated `pi-sec` user's home** (`os.homedir()` / `$HOME`). The
  account is created for `pi-sec` at install time; its name is chosen then and is
  not hardcoded in the code.
- Code trees are configured explicitly (see §2), not inferred from the data dir.

---

## 1. Directory tree

```text
~/.pi/sec/
├── config.json                 # user-editable, validated on load
├── auth.json                   # pi-sec-owned model credentials: references to secret files (0600)
├── models.json                 # pi-sec-owned model catalog
├── model-catalog.json          # 0600, reference list of this install's providers and models, written once per boot and never read
├── VERSION                     # schema/migration version
├── scan-words.txt              # 0600, one word per line: names of this install that the commit hooks refuse (outside the repository)
├── commit-identities.txt       # 0600, one `Name <email>` per line: the identities that the commit hooks accept (outside the repository)
├── snapshot/                   # execution tree (git worktree on branch `snapshot`)
├── workspace/                  # modification tree (never executed; has user-tools/)
├── state/
│   ├── sec.sqlite              # pi-durable storage (WAL) — live jobs, reports, inbox
│   ├── sec.sqlite-wal
│   ├── sec.sqlite-shm
│   ├── archive.sqlite          # archived jobs and reports, their own database
│   ├── focused-chats.sqlite    # the focused chats: title, archive time, and a tombstone per deleted chat
│   ├── model-calls.sqlite      # one row per model call: timing and token counts, kept 90 days
│   ├── model-logins.json       # newest successful model login per provider: time and type
│   ├── device-id               # this install's installation ID: one lowercase UUID, 0600, created on first use by a login flow and never rewritten
│   ├── reports/                # report bodies: reports/<reportId>/v<n>.md
│   ├── drafts/                 # draft report bodies: drafts/<draftId>.md
│   ├── remote-machines/
│   │   └── known_hosts         # 0600: the host keys this install pinned, one line per machine
│   └── archive/reports/        # the same, after their job was archived
├── memory/                     # plaintext/markdown notes; normal file tools
│   ├── index.md                # hub: lists big topics, links to notes/anchors
│   └── *.md
├── prompts/                    # prompt overrides
│   └── role/
│       └── <name>.md           # replaces the shipped role file of that name
├── extensions/                 # runtime extensions (hot reload)
│   └── <name>/
│       ├── index.js            # or index.ts (loaded via jiti)
│       └── config.json         # per-extension config (hot reload)
├── secrets/                    # per-secret files, readable by scripts
│   ├── <name>                  # 0600, e.g. gh_token, smtp_password
│   ├── model-auth.<provider>.<field>  # 0600, pi-sec's own model credential values
│   └── env                     # optional KEY=value lines; each value is registered
├── logs/
│   ├── app.log                 # rotating structured logs (JSON lines)
│   ├── audit.jsonl             # rotating audit trail (append-only per file)
│   └── update-and-restart.log  # output of the update script, kept across runs
├── run/
│   ├── pi-sec.pid
│   ├── ssh/                    # 0700: one unix socket per remote machine and user, while a connection is kept open
│   ├── daemon.lock             # held by the running daemon; a second `start` on the same home exits
│   ├── update-and-restart.lock # held by a running update or rollback script
│   └── restart-pending         # present only after a restart that did not finish
├── gh-repo/                    # github-pr's bare repositories (0700): one per fork network
│   └── <owner>/                #   of the configured repositories; safe to delete, they are
│       └── <repo>.git/         #   fetched again when a diff is next viewed
├── state/github-pr/review-drafts/  # github-pr's saved, unsubmitted reviews (0700): one file per pull
│                               #   request, named `<owner>+<repo>+<number>.json` in lower case
│                               #   (0600); a dot-named temporary file is a write in progress
├── cache/
    └── <timestamp>/
```

### Ownership and permissions

- Owner: the dedicated `pi-sec` user.
- All `pi-sec` commands run as that user (`sudo -u pi-sec …`, a login shell, or
  the systemd unit); no `pi-sec` code runs as the user's own account.
- `~/.pi/sec` is `0700`; `config.json`, `auth.json`, `models.json`,
  `model-catalog.json`, `secrets/`, `logs/`, `state/` are `0600`.
- `model-catalog.json` is a reference for a person who edits `vmodels` by hand:
  the daemon writes it once at boot and nothing in pi-sec reads it back. A
  missing or stale file changes no behavior.
- `pi-sec` owns its model credentials (`auth.json`, `models.json`). The values
  live in `secrets/model-auth.<provider>.<field>` files, and `auth.json` names
  those files. No other Pi configuration is read or written.

### Private tmp

Tmp isolation comes from systemd, not from env vars. The service runs with
`PrivateTmp=true`, so `/tmp` and `/var/tmp` are private mounts cleared when the
unit restarts. The janitor (§7) cleans them eagerly on long-running processes.
`TMPDIR`/`TMP` are **not** used as a control because processes routinely ignore
them and it is unreliable.

Anything that must outlive a restart goes to durable storage — control structure
under `~/.pi/sec` (`state/`, `memory/`, `logs/`), or a job's referenced directory
anywhere the `pi-sec` user can write — never to tmp. See
[security.md](./security.md#tmp-isolation).

---

## 2. Config schema <a id="config-schema"></a>

`config.json` is the only hand-edited file. It is validated with TypeBox
(the schema also powers `pi-sec config --default`). Unknown keys are rejected
(fail closed), except the informational `$schema` field. Secrets are **not**
stored here; use `secrets/` or environment variables.

```jsonc
{
  "$schema": "https://example.com/schema/config-v1.json",
  "version": 1,

  "timezone": "UTC",                  // IANA zone of the harness clock: restart notice, expiry_check, web stamp, preamble

  "server": {
    "bind": "127.0.0.1",              // "127.0.0.1" | "0.0.0.0"
    "port": 8787,
    "basePath": "",                    // e.g. "/sec" behind a subpath proxy
    "publicUrl": "https://agent.example.com/sec",
    "trustedProxies": ["127.0.0.1/32", "::1/128"],
    "sse": { "heartbeatMs": 15000, "queueBytes": 1048576, "bufferMs": 60000 },
    "maxBodyBytes": 1048576
  },

  "code": {
    "snapshot": "~/.pi/sec/snapshot",   // execution tree (worktree on branch `snapshot`)
    "workspace": "~/.pi/sec/workspace"  // modification tree (never executed)
  },

  "validation": { "timeoutMs": 600000 },  // ceiling of each restart-gate command (typecheck, test suite)

  // Model aliases, named by key. There is no default alias: the file declares
  // every key, and `agent.vmodel` names the root's.
  "vmodels": {
    "root": { "provider": "anthropic", "modelId": "claude-opus-5-5", "thinkingLevel": "high", "prompt": "claude" }
  },

  // Judgement models: pi-ai classifier models, named by key and called by code
  // with `context.judges.judge(name, { state, questions })`. Empty by default,
  // and pi-sec never writes an entry. Only classifier models are looked up, so a
  // chat model of the same id is never used. `timeoutMs` bounds one call, in
  // milliseconds; 5000 is the default. `reviewBelow` is the threshold the caller
  // marks an answer below, from 0 to 1; `report_check` uses 0.95 without it.
  "judges": {
    // "reply-language": { "provider": "openai", "modelId": "gpt-6-luna", "timeoutMs": 5000 }
  },

  "agent": {
    "vmodel": "root",                  // no default; empty starts setup mode, a key the file does not declare stops the boot
    "workspace": "~/.pi/sec/workspace", // default cwd for tools
    // The request options every model request carries. `cacheRetention` is how
    // long the provider keeps the prompt cache: "none", "short" (the provider's
    // own few minutes) or "long" (the longest it offers, one hour on Anthropic).
    // Absent means nothing is passed, and the model library decides from its own
    // default and PI_CACHE_RETENTION. Read on every request, so a reload reaches
    // the next one.
    "stream": { "cacheRetention": "long" },
    // The restart advice. A conversation whose last request was this many tokens
    // or more gets one advice on its next input, asking the agent to tidy its
    // state file and restart its own session at a resting point. 0 turns it off.
    // `roles` names the subagent roles that are targets; the root always is, and
    // a planner, a worker, a focused chat and a scheduled run are not.
    // `idle` is the time-based half: a target that has been quiet for `minutes`
    // gets one advice without an input, and `minTokens` keeps it away from a
    // context too small to gain from a restart. 0 turns either off.
    "contextRestart": {
      "thresholdTokens": 300000,
      "roles": ["orchestrator"],
      "idle": { "minutes": 55, "minTokens": 100000 }
    },
    "extensions": { "enabled": ["coding", "jobs", "scheduler", "self-edit", "ask-user", "web", "notify", "secrets", "usage"] },
    "compaction": {
      "enabled": true,
      "reserveTokens": 16384,          // room kept for the answer
      "keepRecentTokens": 20000,       // recent context kept verbatim
      "backgroundTokens": 32768        // start background compaction this far below the blocking threshold; 0 disables
    },
    "retry": { "enabled": true, "maxRetries": 3 },
    "subagent": {
      "idleNoticeMs": 300000           // tell a parent once when its child has waited for orders this long; 0 disables
    },
    // The focused chats the user opens from the web page. A chat is offered an
    // allow list of tools, so a tool a runtime extension adds stays closed to it
    // until it is named here.
    "focusedChat": {
      "extraTools": []                 // tool names added to a focused chat's allow list when it opens
    }
  },

  // The remote machines this install may reach over ssh. Absent or empty means the
  // feature is off: no sidebar panel, no connection and no ssh process. Every value
  // is read on use, so a reload reaches a running daemon. `id` is the machine's
  // name, and it keys the pinned host key and the stored level.
  "remoteMachines": {
    "identityFile": "~/.ssh/id_ed25519",  // the one key every connection uses
    "heartbeatSeconds": 60,              // 15 to 3600
    "runCheckSeconds": 1800,             // 60 to 1800: how often a live run is read
    "tightenDeadlineSeconds": 300,       // 30 to 3600: the wait before the core stops what a stricter level disallows
    "restrictedSeconds": 600,            // 10 to 86400: the clock on a command at level restricted
    "outageSeconds": 3600,               // 60 to 86400: how long a machine may stay unreachable before the core makes its level off
    "machines": [
      {
        "id": "box-a",                   // lower-case letters, digits and `-`, up to 32
        "address": "192.0.2.10",         // an address or a host name, not starting with `-`
        "port": 22,
        "users": ["alice", "bob"],       // the first is the main user; the rest are secondary
        "machineId": "0123456789abcdef0123456789abcdef"  // optional: /etc/machine-id to expect
      }
    ]
  },

  // Settings of the optional `linear` extension. Add the key only together with
  // the name `linear` in `agent.extensions.enabled`: the load refuses an enabled
  // extension with no key. Neither value has a default, and `writes` also decides
  // at boot whether the three write tools exist.
  "linear": {
    "apiKeySecret": "linear.api-key",  // the secret file under ~/.pi/sec/secrets/ that holds the personal API key
    "writes": false                    // whether the write tools exist; read again by every write call
  },

  "auth": {
    "authPath": "~/.pi/sec/auth.json",     // pi-sec-owned credentials
    "modelsPath": "~/.pi/sec/models.json"  // pi-sec-owned catalog
  },

  "secrets": {
    "dir": "~/.pi/sec/secrets",        // one file per secret, read by scripts; model credential values too
    "dummyFormat": "⟦secret:{name}⟧",  // fixed width; no resolution step
    "redactEncodings": ["raw", "base64", "url"],  // variants redacted at commit
    "includeModelCredentials": true,   // also redact pi-sec's own model auth
    "modelCredentialPaths": ["~/.pi/sec/auth.json", "~/.pi/sec/models.json"]
  },

  "tmp": {
    "cleanup": true,                   // private /tmp via systemd PrivateTmp
    "maxAgeHours": 6,
    "maxBytes": 1073741824,
    "eagerThresholdBytes": 67108864    // delete large files sooner
  },

  // Where uploaded and published files live. Both resolve against the account
  // running the daemon (`$HOME`), not against the pi-sec home; ~/, $HOME/ and an
  // absolute path are accepted.
  "attachments": {
    "dir": "~/attachments",            // uploads: one ULID directory per file
    "shareDir": "~/share"              // files an agent published, served at /api/share/<name>
  },

  // Finished jobs move to the archive database, once a day. `sweepAt` is a time of
  // day in the harness `timezone` above, and a daemon that is stopped then skips
  // the day instead of catching up. `sweepMs` is the interval the sweep used to
  // run on: it is still accepted so an older file loads, and it does nothing.
  "archive": {
    "enabled": true,
    "afterDays": 3,                    // days a finished job stays in the live store
    "sweepAt": "05:00",                // HH:MM, in `timezone`
    // "sweepMs": 3600000              // ignored; warns once at start when present
  },

  "scheduler": {
    "enabled": true,
    "tickMs": 30000,
    "timezone": "UTC",                 // IANA default for routines that omit one
    // A schedule is a field on the job record: `routine` recurs, `once` runs at one
    // time. `jobs` is a boot-migration input. The migration moves each entry onto a
    // record's `routine` and empties the list, and the scheduler reads records only
    // after that. Editing this list does not change what fires.
    "jobs": []
  },

  "logging": {
    "level": "info",
    "redact": ["authorization", "apiKey", "token"],
    "maxBytes": 16777216,             // rotate app.log
    "retainFiles": 5
  },
  "audit": { "maxBytes": 67108864, "retainDays": 90 }
}
```

### Precedence

`defaults < config.json < environment variables < CLI flags`.

Environment variables use the `PI_SEC_` prefix with `__` for nesting, and each
segment is matched to the config's own key names **without regard to case**, so
`PI_SEC_SERVER__BASEPATH=/sec` sets `server.basePath` and
`PI_SEC_AGENT__COMPACTION__BACKGROUNDTOKENS=8000` sets
`agent.compaction.backgroundTokens`. (A literal reading used to give
`server.basepath`, which failed config load — the example below worked only
because `port` happens to be all lower-case.) A name that matches nothing is kept
as written and fails config load, which is what a typo deserves. Array and object
values are JSON: `PI_SEC_SCHEDULER__JOBS='[…]'`. The key exists because the boot
migration reads it. Filling it after the migration changes nothing that fires, and
the scheduler records a refusal that names the entries it ignored. CLI flags
override for that invocation. `PI_SEC_HOME` is special and is read before config.

### Restart-required vs live

`server.*`, `code.*`, `tmp.*`, and the storage path are **startup-only**.
`agent.*`, `secrets.*` (format/encodings), `scheduler.*`, `notify.*`, `judges`,
`remoteMachines`, `linear` (its two values, not the extension name in the enabled list), `timezone`, and runtime extension/prompt/config files are
**live** (watched, applied without a restart). Two readers of `timezone` are the exception: the preamble sentence is a
sealed section, so a reload reaches it at the next new session, and the restart
notice writes the boot time once, with the config that boot read.

---

## 3. Durable state (pi-durable)

All durable conversation state is in `state/sec.sqlite` via
`openNodeSqliteStorage`. pi-durable owns the schema; `pi-sec` owns the documents
layered on top.

### Built-in pi-durable documents

`pi.agent` (rewindable), `pi.provider`, `pi.live`, `pi.inbox`, `pi.usage` — all
conversation-scoped and managed by the harness; surfaced read-only to clients via
views/events. Note `pi.inbox` is the conversation's **pending-submission queue**
(`steer`/`followUp`/`write`), not a notification inbox.

### Application documents (`sec.*`)

Singletons are defined with `defineDoc`; multi-valued families with
`defineDocFamily`.

| Kind | Scope | History | Purpose |
|------|-------|---------|---------|
| `sec.job` (family) | session | latest | One document per job, keyed `sec.job:<id>` where the id is `YYYYMMDD-<ULID>`: id, title, status, parent, origin, labels, memory anchors, state dir, schedule, conversation/task links, run stats, completion time. Definition version 2. |
| `sec.report` (family) | session | latest | One document per report, keyed by report id: the owning job (the root moves it with `reports_move`, which writes only that field), the URL slug, the title, the kind (`plan`, `result` or `briefing`), the index of revisions, and the feedback left on it. A revision may carry the user's `approval` (`{ at, via, sha256 }`), written into the revision it confirms. `archivedAt` is set on a report that left the live store on its own, which only a briefing report does: a newer briefing moves it to the archive while the job of its routine stays live. The bodies are files (see below), because a revision that is overwritten cannot be compared with anything. |
| `sec.migration` | session | latest | Ledger of one-shot data migrations already applied to this store, keyed by migration id. Separate from `state/VERSION`, which records the *storage backend's* schema version. |
| `sec.inbox` (family) | session | latest | Notification items (job results, report notices, subagent reports), one document per item, keyed by item id. A write of a briefing report also copies the notices of the briefing before it, and every item of kind `briefing`, into the same family in the archive database, and retires them from the live store. |
| `sec.userQueryList` | session | latest | The active `ask_user` questions: one item per open question, with its content key, its id, the conversation that asked, the question, the choices, and the time it was asked. |
| `sec.selfEdit` (family) | conversation | rewindable | One document per self-edit operation: proposals, validation, commits, restart notices. |
| `sec.candidate` (family) | session | latest | Core-candidate review queue: one document per proposed core change. |
| `sec.settings` | session | latest | Agent-adjustable non-secret preferences (never the model, which is user-set). Also the UI state every browser shares: cleared jobs, opened titles, folded job groups (`collapsedJobs`), cleared inbox items, the two revert queues (`revertQueueJobs`, `revertQueueInbox`) that hold the last ten hides each list can undo, the `theme`, the two panel fold lists (`foldedWide`, `foldedNarrow`), and `uiRevision`, which rises by one on every UI change. All of these are optional fields of version 1. |
| `sec.agent` (family) | session | latest | One agent record per conversation, keyed by that conversation's id: its kind (`root`, `subagent`, `scheduled`, `focused`), its name, its parent, the vmodel and roles that apply to it, its status, and the last `await_orders` note. The only place a status is written. `stopped` and `failed` are retired in the same commit that writes them, so a finished agent cannot hold a slot. An archived focused chat keeps its record on purpose, so its kind and its name survive it. The store row says it is archived, and `holdsSlot` reads that row to give the slot back. |
| `sec.agentChild` (family) | conversation | latest | A parent's name index, keyed by the child's name, holding nothing but the child's conversation id. Immutable, so uniqueness within one parent is a property of the store; an entry is retired when the child is deleted. |
| `sec.message` (family) | conversation | latest | One inter-agent message, stored with its receiver, keyed by a ULID. `status` is the whole delivery decision, so exactly one consumer can deliver it. |
| `sec.agentHub` | session | latest | The live-subagent counter the limit is checked against, written inside the creating commit so a parallel spawn cannot slip past a full limit. Recomputed at boot. |
| `sec.remoteMachine` (family) | session | latest | One document per remote machine, keyed by the machine's id: its level (`off`, `restricted` or `on`) and when it was last changed, a change sequence that numbers the notice a loosening sends, `pending` (a stricter level that is being applied: when the wait started, its deadline and how many runs are left, or null), `outage` (while a machine the user did not switch off stops answering: when the core first saw it down, which is the whole of the record), the state of each ssh user's connection with the moment it was written, the first `/etc/machine-id` read over a pinned connection, and any block with the evidence it watches. The address, the port, the users and the key file are **not** here: they come from `config.json` on every use, so a reload reaches a running daemon. A machine removed from the config keeps its record and is not shown. |
| `sec.remoteRun` (family) | session | latest | One document per detached run, keyed by the run id: the machine and the user it runs as, the conversation to answer and the tool call it came from, the level it started at, the start time, the process number and its start tick, when the next check is due, the judgment last read and the judgment last delivered, the output size and its change time, the exit status, whether it settled and when, and how many messages about it were sent. The run itself is a directory on the machine; this record is what lets a check outlive the daemon and answer the conversation that started the run. |
| `sec.reportDraft` (family) | session + `jobId` | latest | A subagent's draft report: the job it belongs to, a title, the note explaining what it is, a path under `state/drafts/`, a status, and the sha256 of the text written to that path. The scope is `session`; `jobId` is a field on the row, and it decides the draft's life. Any conversation reads one by id with `reports_get`; the root publishes it with `reports_publish_draft`, as a new report or, with `reportId`, as the next revision of a live report of the same job. A publish that gives no note of its own uses the draft's note as the revision's, and a note given to publish wins. Publishing refuses a draft whose file no longer matches the recorded sha256. A row written before the field existed has none and is not checked. The user is never told about one, and it is dropped as soon as it is published, and otherwise when the root discards it with `reports_draft_drop`. Deleting the author leaves the draft in its job, and the draft is dropped when that job ends (reason `job-finished`, and the body file is removed with the row), when the job moves to the archive (`job-archived`), or when the boot sweep finds it orphaned (`orphaned`). A row written before the job field existed has no job and is still abandoned with its author. |

Rules:

- `defineDoc` kinds are versioned; migrations are registered centrally
  (`runtime/storage.ts`).
- Regenerable state (caches) never goes into a document; use `cache/`.
- **No secrets in documents.** Secrets live only in `secrets/` and enter execution
  contexts, never model context; see [secrets.md](./secrets.md).
- `sec.*` documents are created **lazily**: the tool that first writes one makes
  it, with `tx.doc(token, conversationId, key, seed)`. There is no
  `conversationCreated` hook in this implementation, and none is needed — lazy
  creation already reaches every conversation, including subagent children.

---

## 4. Memory <a id="memory"></a>

Memory is **just files**. There is no memory subsystem, no dedicated tools, and no
retrieval pipeline. `~/.pi/sec/memory/` is a plain markdown workspace that the
agent reads and writes with the ordinary file tools (`read`, `write`, `edit`,
`bash`), exactly like any other directory.

- The agent looks up files **by names it remembers** and reads them. It may
  list/scan the directory with `bash`, but scanning is not a primary interface —
  it is just what you do with files.
- `index.md` is an **optional, model-maintained hub** listing big topics and
  linking to notes and section anchors. It is a convention, not an enforced index.
- Prompts may point at the memory directory or a specific file, but nothing is
  auto-injected or "retrieved": the model decides what to open.
- There is no ranking, no embeddings, and no `memory_*` tool set.
- Plaintext means the user can read, edit, diff, and version memory with
  ordinary tools.

---

## 5. Extension config

Each extension owns a config file **next to its code**:

```
~/.pi/sec/extensions/<name>/
  index.js
  config.json     # validated against the extension's schema
```

- A runtime extension module exports `{ name, configSchema?, create(config) }`.
  The loader validates `config.json`, then calls `create(config)` to obtain the
  pi-durable extension.
- Changing `config.json` marks the extension for hot reload; the new config is
  validated and applied by replacing the extension in the registry.
- Bundled (core) extensions take their defaults from code; the same override file
  mechanism applies under `~/.pi/sec/extensions/<name>/config.json` without
  duplicating code.
- Invalid config for a runtime extension: log, keep the previously installed
  instance, surface a diagnostic in `/api/admin/status`. Never crash the daemon.

See [extensions.md](./extensions.md#per-extension-config).

---

## 6. Storage lifecycle

- **Open** at daemon start; fail if locked by a live process.
- **WAL**, `synchronous = NORMAL` (pi-durable default). Commits survive process
  crash; the newest may be lost on host power failure. Acceptable for a personal
  agent; a `synchronous = FULL` option can trade speed for safety.
- **Migrations** run before `Harness.open`. Version recorded in `VERSION`.
- **Report bodies are files, not documents.** `state/reports/<id>/v<n>.md`, one
  per revision, never overwritten. Backing up `sec.sqlite` alone does not save a
  report; `state/reports/` and `state/archive/` are part of the backup.
- **The archive is a second database**, `state/archive.sqlite`, for jobs that
  finished more than `archive.afterDays` ago. It keeps the live store small and
  its scans cheap. Nothing is deleted, and an archived id still resolves.
  The sweep that moves them starts once a day at `archive.sweepAt` (default
  `05:00`) in the harness `timezone`, and a daemon that was stopped at that time
  skips the day rather than catching up. Because the two files cannot be written
  atomically, the sweep copies first and retires second: the worst case is a
  duplicate the next sweep cleans up, never a loss. A report also reaches it
  without its job: a briefing report moves there when a newer briefing replaces
  it, and it takes the notices that point at it and the items of kind `briefing`
  with it. The archive holds `sec.report` and `sec.inbox` rows for that reason,
  and nothing reads the notices out of it.
- **The focused chats are a database of their own**, `state/focused-chats.sqlite`,
  for the same reason: the transcript store is the durable library's schema, and a
  table added to it is one this code does not own. One row holds a chat's
  conversation id, its name, its title, when it opened, when it was archived and
  whether it was opened as a test chat, and the title and the archive time live
  nowhere else. The test mark is one column, `test`, which a file written by an
  older build gains when it is opened; its rows read `0`, "not a test chat". A
  deleted chat moves to `deleted_focused_chats` instead of vanishing, so a route
  can tell "never existed" from "deleted". Its transcript entries stay in
  `state/sec.sqlite`, because the transcript store has no delete. The file is
  opened at boot, before any extension is installed, and it belongs in a backup
  with `state/`.
- **No builtin backup.** `pi-sec` ships no backup/restore command. To back up,
  stop the daemon and copy `state/` (plus `secrets/`, `config.json` if you want
  them) yourself; the code checkouts are recoverable from git. Restore is the
  reverse, while stopped.
- **Retention**: app logs rotate; `audit.jsonl` rotates by size/age (`audit.maxBytes`, `audit.retainDays`), and rotated files are immutable.

---

## 7. Janitor <a id="7-janitor"></a>

A small in-process timer (`runtime/janitor.ts`) keeps the runtime clean. It never
leaves `~/.pi/sec` and only acts on tmp when systemd has given the daemon a
private `/tmp`:

- When `PI_SEC_PRIVATE_TMP` is set (by the systemd unit), scan the private `/tmp`
  and `/var/tmp`: delete files older than `tmp.maxAgeHours`, delete files larger
  than `tmp.eagerThresholdBytes` sooner, and enforce `tmp.maxBytes` (oldest
  first). Because the tmp is private and restart-cleared, this is safe.
- Without a private tmp, skip tmp cleanup entirely — never delete arbitrary
  `/tmp` files.
- Rotate `app.log` by size/count and `audit.jsonl` by size/age; prune rotated
  audit files past `audit.retainDays`.
- Prune `cache/`.
- Report disk usage in `/api/admin/status`.

It does not touch `gh-repo/`. That directory belongs to the `github-pr`
extension, which reconciles it against the repositories in `githubPr.repos`.
The extension keeps its size under `githubPr.diskLimitMegabytes`, where 0 means no limit and the size has no
bound, so it can pass 5 GB. A deletion in
that directory from outside can break a diff that is running.

The guiding rule: tmp is for ephemeral, restart-scoped data and is cleaned
eagerly; anything that must persist goes to `state/`, `memory/`, or `logs/`.

---

## 8. Migration and upgrade

An installed home updates through the scripts in the workspace tree's
`user-tools/`. They assume the layout the install created: one repository, with
`main` in `workspace/` and `snapshot/` as a worktree on branch `snapshot`.

### Update

`user-tools/update-and-restart [--check] [--pull] [--reinstall]`:

1. Take `run/update-and-restart.lock`, so a click in the web UI and a command in
   a terminal cannot interleave.
2. With no unit to stop, check whether a daemon of this home is running, and
   refuse when it is. `--check` skips this check, because it changes nothing.
3. With `--pull`, fetch `origin` and fast-forward `main` onto `origin/main`. It
   refuses, with nothing changed, when the workspace has uncommitted changes, is
   not on `main`, or has commits `origin/main` does not have. `--check --pull`
   fetches and reports how far behind and ahead `main` is, and moves neither
   branch.
4. Stop the daemon: the systemd user unit, the system unit through `sudo`, or,
   under `user-tools/run`, nothing, because that daemon has already ended with
   exit code 75.
5. Fast-forward `snapshot` to `main`. A diverged snapshot is refused and the
   service started again where there is one, because guessing which side wins is
   worse than stopping.
   Then run `install-git-hooks --update` of the execution tree on the workspace,
   so the workspace has the commit hooks of the applied commit. A refusal prints
   a note and the update goes on.
6. Run `npm ci` when `package-lock.json` changed, when `node_modules` is missing,
   or always with `--reinstall`; then `npm run build`.
7. Remove `run/restart-pending`, start the daemon again, and print
   `done: <from> -> <to>`. Under the runner the script only prints that the runner
   starts the daemon when it exits.

The order matters: the lock and the stop check come first, so nothing moves under
a running daemon, and the pull comes next, so the merge applies what the fetch
brought.

A failure after the stop starts the service again. The script leaves
`run/restart-pending` behind only when the service stays down, or, under the
runner, so the next boot reports the unfinished restart. `--check` reports the two
commits and stops: it takes no lock, changes no tree and restarts nothing, and it
works while the daemon serves.

A home that runs under `user-tools/run` updates through the web UI's restart
button, which ends the daemon with code 75, lets the runner run this script, and
lets the runner start the daemon again. The same script run by hand refuses while
that daemon runs and says so.

### Rollback

`user-tools/rollback <commit-or-tag>` resets the snapshot branch to that commit,
installs dependencies if the tree has none, rebuilds, and starts the daemon
again. It refuses when the snapshot has uncommitted changes, and, with no unit to
stop, when a daemon of this home is running. Storage is not touched.

### Migrations

The daemon runs pending storage migrations at boot, before the harness opens the
store. `pi-sec migrate` applies them to a stopped home and prints the schema
version, and `pi-sec db` prints the version without changing anything.

A storage written by a newer `pi-sec` refuses to open on an older binary, so a
rollback across a migration needs your own copy of `state/` as well.

Full commands and options are in [install.md](./install.md#updating).

---

## 9. Separation of roles

- `snapshot/` is the **execution tree** (the running code); `workspace/` is the
  **modification tree** (never executed).
- `state/`, `secrets/`, `logs/`, `extensions/`, `prompts/`, `config.json`, and
  the `sec.job` records are the **control structure** — they live under
  `~/.pi/sec`.
- `memory/` is a **model-managed** directory that conventionally lives under
  `~/.pi/sec`, but can be relocated.
- **Model-managed directories may live anywhere** the dedicated `pi-sec` user can
  write — project workspaces, job state dirs, notes, outputs. They are not
  required to be under `~/.pi/sec`.
- **A job's work files stay out of the control structure.** A new job keeps its
  work files under `~/job/<slug>/`, and its `stateDir` field holds that absolute
  path. The control state that the harness reads and writes itself stays under
  `~/.pi/sec/state/`. An extension keeps its bookkeeping files under that same
  harness state root, as in `state/<extension>/usage.jsonl`.
- `pi-sec` owns its model credentials and catalog (`~/.pi/sec/auth.json`,
  `~/.pi/sec/models.json`); the credential values are `secrets/model-auth.*`
  files. No other Pi configuration is read. Global npm caches stay with the
  package manager.

Keeping **code checkouts**, **control structure**, **model-managed data**,
**pi-sec-owned model credentials**, and **shared package caches** in distinct
places is a first-class requirement, even though the checkouts and control
structure live under `~/.pi/sec` for a self-contained install.
