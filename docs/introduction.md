# Introduction to pi-sec

> Newcomer-friendly orientation. When you want the precise details, follow the
> links at the end.

---

## pi-sec in one paragraph

`pi-sec` is a **personal secretary that runs on your own computer**, as its own
Linux user. You talk to it through a web page; it uses a shell, files, and the
network to actually get things done — schedule recurring work, watch for events,
research things, and remember what it learns. It is built on **pi-durable**, a
runtime that makes every message, model turn, and tool call durable: work is
written to a local database before it is shown, so a process crash or reboot never
loses it. (The very newest commit may still be lost on host power failure, per the
WAL `synchronous = NORMAL` setting.) It is **unprivileged by design**, **never sees your secrets**, and can
**improve itself** by writing new capabilities and staging changes to its own
code.

The name is short for **secretary**: `pi-sec` does what you ask, within the
permissions of its own account.

---

## The idea that explains everything

`pi-sec` is a *separate user*, not a program running as you.

The intended install creates a dedicated, unprivileged Linux account and runs
`pi-sec` there — never as your login account, never as root. That single choice
shapes the whole design:

- It has its own home, its own files, and its own permissions.
- It can work anywhere *that account* can write — which is its own workspace.
- It cannot touch your files unless you explicitly grant access.
- It can never escalate to root. If something truly needs root, it writes a
  script and asks *you* to run it.

Think of it as hiring an assistant and giving them their own desk, their own
login, and a clear boundary: "here is your computer account; do whatever I ask
inside it."

---

## How you use it

You open a web page — by default `http://localhost:8787/basic-chat` — and chat.
It is a proper app, not a bare textarea: themed, responsive, with rendered
markdown, a composer, a live job tree, and an inbox.
That is the whole interface for now.

`pi-sec` does **no authentication of its own**. It binds to localhost only;
putting it behind a reverse proxy (which handles TLS and login) is your
job, or you simply keep it local. There is no token, session, or login page
inside the daemon.

The chat page supports the essentials:

- send a message and watch the answer stream in;
- **reset** the conversation (a fresh context; history is kept);
- **compact** the context when it gets large (older messages become a summary);
- answer questions the agent asks you.

`/basic-chat` is the only first-party channel today. Underneath it is a general
HTTP + SSE API, so other channels (a CLI, a bot, alternate UIs) can be added
later without changing the core.

---

## What it is made of

Three layers, top to bottom:

```
        you (browser)
             │  HTTP + Server-Sent Events (SSE)
             ▼
    ┌───────────────────────────┐
    │  pi-sec  (one daemon)     │
    │  HTTP · SSE · extensions  │
    │           │               │
    │  ┌────────▼─────────────┐ │
    │  │  pi-durable Harness  │ │
    │  │  conversations, jobs, │ │
    │  │  tasks, secrets       │ │
    │  └────────┬─────────────┘ │
    └───────────┼───────────────┘
                ▼
          SQLite + your files + a model API
```

- **You** — the user. You ask, approve, and run the rare privileged script.
- **The agent** — a single long-running program. It holds the conversation, calls
  the model, runs tools, and tracks ongoing work.
- **The runtime** — pi-durable. It records everything durably and resumes
  unfinished work after a restart. `pi-sec` mostly orchestrates it.

There is **one process**. No worker fleet, no message broker, no WebSocket
server. It owns one local SQLite database and serves the web UI plus a streaming
event feed.

---

## A worked example

You open the chat page and type:

> "Every weekday at 8am, give me a briefing; also keep an eye on my inbox."

Then:

1. Your message is **durably recorded** before anything else happens.
2. The model decides what to do and calls tools — run `bash`, read files, fetch a
   web page.
3. It creates a **job** for the recurring briefing: a durable record with a name,
   a schedule, and, if useful, a directory for its artifacts and links to memory.
4. It creates a second **job** to watch the inbox, running in the background so
   it does not tie up your conversation.
5. Later, the inbox job needs a decision and calls `ask_user`. A question with
   choices appears in the UI, and the job carries on without waiting for it.
   Your answer comes back as genuine input from the user to the conversation, whether
   you pick a listed choice or type words.
6. The agent writes what it learned into **memory** — ordinary markdown files it
   can read again later.
7. When it notices it keeps doing something awkward, it writes a small **runtime
   extension** to automate it and loads it live. If it wants to change its own
   core code, it commits the change to the workspace (modification) tree and tells
   you a restart is needed; your update script advances the snapshot to that
   commit and starts a new process.

At any point you can ask it what it is working on. It answers by listing its
**jobs** — the high-level commitments it is tracking.

---

## Vocabulary

A short glossary; you do not need all of it at once.

| Term | Plain meaning |
|------|---------------|
| **Agent** | The model-driven worker; also the whole `pi-sec` program. |
| **Harness** | pi-durable's engine for running conversations and tasks over durable storage. |
| **Conversation** | One transcript. `/basic-chat` uses a single default conversation. |
| **Entry** | One immutable record in a transcript: a user message, a model reply, a tool result, a reset, a compaction summary. |
| **Run** | One input and everything the agent does until it answers. |
| **Task** | An internal step of a run — call the model, run a tool. Short-lived machinery, not something you manage. |
| **Job** | A **high-level unit of work** the agent has taken on and tracks. What a secretary would put on a task board. |
| **Inbox** | A durable queue of asynchronous messages to the agent (job results, notifications, subagent reports), shown in the UI. |
| **Memory** | Plain markdown files the agent reads and writes with ordinary file tools. |
| **Secret** | A credential value kept in a file. It becomes a harmless placeholder before it can reach the model, and is never converted back. |
| **Extension** | A named bundle of tools and prompt sections. Runtime extensions can be hot-reloaded. |
| **Core** | The shipped code itself. Changing it requires a restart. |
| **Context** | The messages actually sent to the model for one request. |
| **Compaction** | Replacing older context with a summary so a conversation can continue within the model's context window. |

### Jobs are the unit of work

A **job** is the highest unit of work — deliberately distinct from the internal
tasks a run is made of. A job can be:

- recurring ("brief me every morning"),
- background ("watch this and tell me"),
- delegated ("research X and report"),
- or anything else the model decides is worth tracking.

A job has a **status** (`planned`, `active`, `waiting`, `paused`, `done`,
`failed`, `cancelled`) that changes only when something updates it. It may also
carry:

- zero or more **subjobs** — parent/child is the *only* job hierarchy;
- freeform **labels** (e.g. `schedule`, `research`) — hints, not types;
- **memory anchors** — pointers like `index.md#identity` into the memory
  directory;
- a **state directory** where its files live (any path the `pi-sec` user can
  write, inside or outside `~/.pi/sec`): a new job keeps its work files under
  `~/job/<slug>/`, and its `stateDir` field holds that absolute path;
- links to the **conversation** and the internal **tasks** that serve it.

The agent can always list its jobs, and the web UI shows them as a tree. Internal
tool or model-call steps are **not** jobs; the model decides what counts.

---

## Where everything lives

There are two zones. Keeping them straight explains most of the design.

```
~/.pi/sec/                 # CONTROL STRUCTURE (always here)
  config.json              #   your settings
  auth.json, models.json   #   pi-sec's own model credential shapes + catalog
  state/sec.sqlite         #   durable agent state, jobs, conversations
  secrets/                 #   secret files (read by scripts); model credential values too
  logs/                    #   app log + audit trail
  snapshot/                #   execution tree: the running code
  workspace/               #   modification tree: the agent edits here
  extensions/              #   runtime extensions (hot reload)
  prompts/role/            #   role files that replace the shipped ones

anywhere its user can write # MODEL-MANAGED DATA (may live outside)
  ~/job/<slug>/            #   a new job's work files (its `stateDir`)
  job state dirs, project workspaces, notes, outputs
```

- `~/.pi/sec` holds the **control structure**: the small, stable set of things
  that make `pi-sec` run.
- The directories the agent works in are **model-managed** and may be anywhere
  the `pi-sec` user can write.
- A new job keeps its work files under `~/job/<slug>/`. The control state that
  the harness reads and writes itself stays under `~/.pi/sec/state/`. An
  extension keeps its bookkeeping files under that same root, as in
  `state/<extension>/usage.jsonl`.
- `pi-sec` keeps its **own** model credentials and catalog under `~/.pi/sec`
  (`auth.json`, `models.json`), and the credential values are secret files in
  `secrets/`; the user signs in once as the `pi-sec` user.
  It never reads the user's `~/.pi/agent`.

---

## The rules it lives by

In plain language, the behaviors the rest of the design upholds:

- **Crash-safe.** Work is committed before it is shown; a process crash resumes.
  On host power failure the newest commit may be lost (`synchronous = NORMAL`).
- **History is append-only.** The transcript is never rewritten. Reset and
  compaction move the start of the active context forward by *appending* markers.
- **The model never sees secrets.** It can *use* a secret by writing a script that
  reads the file, but the value itself is replaced by a fixed placeholder and is
  never recoverable. Its own model API keys and OAuth tokens are covered too.
- **Temporary files are private.** The service gets its own `/tmp`, cleared on
  restart, so its scratch space never mixes with unrelated system files.
- **No privilege.** It cannot become root and never tries. A task that needs root
  becomes a script for you to run.
- **No in-app authentication.** Bind to localhost or put it behind your proxy.
- **Commands run as the agent's user.** Every `pi-sec` command runs as the
  dedicated `pi-sec` account, never as you.
- **Two kinds of change.** Runtime extensions and prompts hot-reload instantly;
  core code changes are committed to the workspace (modification) tree, and your
  update script advances the snapshot and starts a new process (a cold restart).
- **The user is the boundary.** Tools run in the same view as the agent — the
  same unprivileged account. There is no per-tool sandbox and no command-string
  guard; isolation comes from account separation.

## What it is not

- Not multi-user. It is a single-user personal agent.
- Not sandboxed per tool. The dedicated, unprivileged account *is* the boundary.
- Not a plugin marketplace. Extensions are code in the project or in its data
  directory.
- Not a replacement for the `pi` coding CLI. It uses the same underlying runtime
  libraries but is its own product.

---

## How it starts

```
systemd (or `pi-sec start`), as the dedicated pi-sec user
  ├─ read ~/.pi/sec/config.json (fail closed on invalid config)
  ├─ open the SQLite store and resume unfinished work
  ├─ load ~/.pi/sec model credentials and catalog
  ├─ install extensions (bundled + runtime)
  ├─ start the scheduler and the janitor
  └─ serve the web UI on localhost
```

A second `start` on the same home exits with an error before it opens the store.

Graceful shutdown closes the event streams, stops accepting connections, and
closes the runtime, within a deadline of 20 seconds. A hard kill is safe:
unfinished tasks are committed and resume on the next boot.

---

## Where to go next

| If you want to know… | Read |
|----------------------|------|
| The structured overview and every decision | [README.md](./README.md) |
| How the pieces fit and the process model | [architecture.md](./architecture.md) |
| The web endpoints and the SSE protocol | [http-api.md](./http-api.md) |
| Where data lives, config schema, documents | [runtime-layout.md](./runtime-layout.md) |
| Extensions, hot reload, self-improvement | [extensions.md](./extensions.md) |
| How secrets are kept out of the model | [secrets.md](./secrets.md) |
| Privilege, tmp, audit, threat model | [security.md](./security.md) |
| Milestones and open questions | [roadmap.md](./roadmap.md) |
