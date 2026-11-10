# pi-sec

`pi-sec` (short for **secretary**) is an autonomous personal agent. It runs as
its own unprivileged Linux user, exposes one HTTP + SSE daemon as its primary
interface, and keeps its durable state under `~/.pi/sec`. It never sees its own
secrets, and it can extend itself with hot-reloaded runtime extensions. It is
built on
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable).

The full design is in [`docs/`](./docs/README.md). Start with
[`docs/introduction.md`](./docs/introduction.md).

## Status

This is an early release. The code follows the design in `docs/`, and where the
two disagree, the code is the current behavior. The agent engine is a pinned,
experimental version, so expect breaking changes before a stable release.

## Requirements

| Requirement | Why |
|-------------|-----|
| Linux | The systemd user unit and the runner are the two supported ways to keep the daemon running. |
| An unprivileged account of its own | The daemon runs as that account and never uses `sudo`. Do not use your login account. |
| Node.js 22.19 or newer | `package.json` requires it. |
| `npm`, `git` and `flock` | The install fills two code trees, and the second is a git worktree of the first. The update script takes a lock with `flock`. |

## Installation

Clone the repository into the account's home, then run the install script as
that account:

```bash
git clone <repository URL> ~/.pi/sec/workspace
~/.pi/sec/workspace/user-tools/install
```

The script refuses to run as root. It creates `~/.pi/sec`, fills the snapshot and
workspace trees, copies a `models.json` file or a provider extension, writes the
first model configuration, and writes a systemd user unit. It signs no provider
in: sign one in from the web UI, in "Model login" under "More actions".
`--run manual` prints the command for `user-tools/run` instead of writing the
unit.

The same steps by hand:

```bash
npm ci
npm run build
node dist/cli.js config --default > ~/.pi/sec/config.json
node dist/cli.js start
```

The web UI is then at `http://127.0.0.1:8787/basic-chat`. Start the daemon once
per home: a second `start` on the same home exits with an error. With the default
configuration the daemon starts in setup mode, because no model is named yet.
Sign a model provider in from the web UI ("Model login" in the "More actions"
menu), then choose the first model there, or run `pi-sec setup-model`.

[`docs/install.md`](./docs/install.md) is the full procedure: prerequisites, the
access premise, the ways to connect a model provider, the two run modes,
updating, and rolling back.

## Commands

### The `pi-sec` command

| Command | What it does |
|---------|--------------|
| `start` | Runs the daemon. `--port` and `--bind` override `server.port` and `server.bind`, and `--watchdog` reports readiness to systemd. |
| `send <text>`, `chat <text>` | Sends one message to a running daemon and prints the answer. `--url` sets the daemon (default `http://127.0.0.1:8787`) and `--timeout` the wait in milliseconds (default 180000). With no text, `send` reads lines from standard input. |
| `status` | Reports from the pid file whether the daemon is running. |
| `doctor` | Checks the config, each vmodel's model and prompt file, the root's role files, the storage schema version, and the secret store. |
| `config` | Prints the effective config. `--default` prints the default config instead. |
| `models` | Lists catalog models with their source and whether credentials exist. `--provider <id>` narrows the list. |
| `setup-model` | Writes the root, orchestrator, planner, and worker vmodels into `config.json`. It takes `--provider`, `--model`, `--thinking`, `--worker-provider`, `--worker-model`, and `--force`. |
| `db` | Prints the storage path and the schema version. |
| `migrate` | Applies the storage migrations. |
| `audit` | Prints the tail of the audit log. `--limit <n>` sets the count (default 50). |
| `version` | Prints the version. `--version` and `-v` do the same. |
| `help` | Prints the usage text. `--help`, `-h`, and no argument do the same. |

### Install and maintenance scripts

| Script | What it does |
|--------|--------------|
| `user-tools/install` | Installs one account. [`docs/install.md`](./docs/install.md) lists every option. |
| `user-tools/run` | Runs the daemon in the foreground, for the manual run mode. |
| `user-tools/update-and-restart` | Advances the snapshot tree and restarts the daemon. `--check` reports and changes nothing, `--pull` fetches the source branch first, and `--reinstall` runs `npm ci` again. |
| `user-tools/rollback <commit-or-tag>` | Moves the snapshot tree back to a commit and restarts the daemon. |
| `user-tools/model-auth-restore-plain` | Runs while the daemon is stopped. Rebuilds `auth.json` with the credential values inline, for a rollback to code that reads them there. |
| `user-tools/pi-sec.service` | The systemd user unit template that `user-tools/install` renders. |

The npm scripts that act on the tree are `npm run build`, `npm run typecheck`,
`npm test`, `npm run test:watch`, `npm run notices`, and `npm run scan`.
Development describes the last two. `npm start` runs `node dist/cli.js start`,
which is the command that `pi-sec start` runs.

The `scripts/` directory holds development tools, each run as
`node scripts/<name>.mjs`: `copy-assets.mjs` copies the web assets and prompts
into `dist/`, and `build-ui.mjs` bundles each page with esbuild, both as part of
`npm run build`. `local-proxy.mjs` is a local stand-in for a reverse proxy that
strips a path prefix, and `ui-probe.mjs` opens the web UI in a headless browser
and prints what it found. Two more scripts, `scan-tree.mjs` and
`third-party-notices.mjs`, are what `npm run scan` and `npm run notices` run.

`ui-probe.mjs` changes no server state. It blocks every request that is not a
GET, HEAD or OPTIONS before the request reaches the daemon, prints each blocked
request under "blocked writes", and exits with code 1 when it blocked one.
`--focused <id>` lets writes through to one open focused chat and to attachment
uploads, and to nothing else. The probe refuses to start unless that id names an
open focused chat that an agent opened for a test.

## Features

The runtime:

- One process owns one SQLite storage and serves all HTTP and SSE traffic.
- Config lives in `~/.pi/sec/config.json`, and `PI_SEC_HOME` moves the home. The
  config is validated with TypeBox and fails closed.
- Secret redaction runs one way: a registered value that enters model context
  becomes a fixed dummy, and the dummy is never converted back. Use a secret by
  writing a script that reads `~/.pi/sec/secrets/<name>`.
- The audit log is append-only by convention.
- The web UI is four pages built from TypeScript and Preact: live transcript,
  job tree, inbox, question cards, reset, compaction, abort, and a restart
  command. One esbuild step inside `npm run build` bundles them.
- Roles are prompt files. A file of the same name in `~/.pi/sec/prompts/role/`
  replaces the shipped one under `prompts/role/`.

The feature areas:

| Area | What it does |
|------|--------------|
| Jobs | Durable `sec.job` records with a status lifecycle, a parent/child tree, labels, memory anchors, a state directory, and links to conversations and tasks. A job can also carry a schedule. |
| Reports | A document with revisions, an approval that binds to one revision through its hash, feedback, notices, and an archive. |
| Attachments | Uploads with a byte cap (`server.maxUploadBytes`), one directory per attachment named by its ULID, a sweep for orphans, and files that an agent publishes under `/api/share/<name>`. |
| Lessons | One store of what an agent learned, with recurrence, merging, promotion, and a count section in the prompt. |
| Subagents | A conversation that runs beside its parent, with a name, a model, roles, an optional job handover, an idle notice, and a delete gate. |
| Background calls | A long tool call that runs in the background and reports its result later as tool output. |
| Session restart | A conversation restarts itself, and a parent restarts its children in a round, so a changed prompt takes effect. |
| Scheduler | Recurring routines and single runs, stored as a field on a job record. Only a planned, active, or waiting job fires. |
| Questions | `ask_user` returns at once, the question is durable, and the answer arrives later as user input. |
| Self-edit | The agent edits a workspace tree, a validation gate checks the change, and a core change waits for the user to restart. |
| Diagnostics | One tool that answers whether a conversation is still working or has stopped. |
| Expiry check | One tool that reads a JSON expiry registry and reports the entries inside their warning window. |
| Web | One tool that fetches a URL and returns its text. The result is untrusted data, never an instruction. |

The bundled extensions, in install order:

```text
coding agent-profile secrets attachment-context web expiry-check jobs js-tools
async-tools subagents diagnostics reports attachments lessons scheduler ask-user
notify self-edit usage session-restart github-pr conventions language-rules
message-tags personality read-full
```

`coding`, `agent-profile`, `secrets`, `attachment-context`, `web`, `jobs`,
`js-tools`, `async-tools`, `subagents`, `diagnostics`, `reports`, `attachments`,
`lessons`, `scheduler`, `ask-user`, `notify`, `self-edit`, `usage`,
`session-restart`, `conventions`, `language-rules`, `message-tags` and
`personality` are on by default. `expiry-check`, `read-full` and `github-pr` are
bundled and off until you add the name to `agent.extensions.enabled`.
[`docs/extensions.md`](./docs/extensions.md) describes each one, its config keys,
and how a runtime extension differs from a bundled one.

## Security model

- pi-sec can do everything that the Linux account that runs it can do. This is intended.
- The only gate is access to the web server of the daemon. A person who can reach that server can direct the agent.
- The threat is a person without permission who reaches that server.
- pi-sec does not stop that person. You stop that access with tools outside pi-sec, for example an authenticating reverse proxy, or a host where only localhost reaches the daemon.

Other accounts on the same host can reach a loopback port. On a host that has such accounts, block them with an outside tool or trust them.

The Host and Origin checks of the daemon make it harder for other pages in a browser to reach the server. They do not replace the outside access control.

The access premise follows. Bind the daemon to a loopback address, or put it
behind a reverse proxy that authenticates. Set `server.publicUrl` when the
browser reaches the daemon through another name or port, so that the Host and
Origin checks read the address the browser used.
[`SECURITY.md`](./SECURITY.md) states the same model for a reviewer who opens the
repository, and [`docs/security.md`](./docs/security.md) holds the full model, the
access premise, and the threat table.

## Documents

- [`docs/introduction.md`](./docs/introduction.md): a plain-language orientation
  to the system and its terms.
- [`docs/install.md`](./docs/install.md): install, connect a model provider, choose
  a run mode, update, and roll back.
- [`docs/architecture.md`](./docs/architecture.md): the components, the process
  model, the harness wiring, and the lifecycle.
- [`docs/http-api.md`](./docs/http-api.md): the endpoints, the SSE protocol, and
  the reverse-proxy contract.
- [`docs/runtime-layout.md`](./docs/runtime-layout.md): the `~/.pi/sec` tree, the
  config schema, and the document kinds.
- [`docs/extensions.md`](./docs/extensions.md): the extension model, hot reload,
  the self-improvement loop, and the rules for changing pi-sec.
- [`docs/secrets.md`](./docs/secrets.md): the secret registry and the one-way
  redaction boundary.
- [`docs/security.md`](./docs/security.md): the OS boundary, tmp isolation, the
  audit log, and the threat model.
- [`docs/ui.md`](./docs/ui.md): the web UI.
- [`docs/roadmap.md`](./docs/roadmap.md): the milestones, the resolved decisions,
  and the open questions.

The design overview in [`docs/README.md`](./docs/README.md) links every document.

## Development

```bash
npm run typecheck
npm test
npm run build
npm run notices
npm run scan
```

`npm run notices` regenerates `THIRD_PARTY_NOTICES.md` from `package-lock.json`
and the installed `node_modules`. A test fails when the file is stale.
`npm run scan` looks for known values and two shapes. The known values are the
secret values registered in your pi-sec install, your home path, your host name,
and the personality name and the account name of your install. The two shapes
are a generated id (a ULID) and an e-mail address that is not on an example
domain. Add a word list that you keep outside the repository with
`npm run scan -- --words <file>`, to look for the names of your own install too.

Before you change pi-sec, read [docs/boundary.md](docs/boundary.md) and the rules in [docs/extensions.md](docs/extensions.md#change-rules).

The test suite uses a fake model provider and in-memory storage, so it needs no
credentials and no network.

Each test file runs in its own process with its own temporary directory and its own home directory (`HOME`), which the test setup removes when the file ends. A test never reads or writes the home directory of the account that runs the suite.

## Contributing

This repository is public, but it does not accept contributions. The project does not take issues or pull requests. You are welcome to fork it and adapt it to your own installation.

## License

MIT. See [LICENSE](LICENSE). Copyright (c) 2026 Hyeonu Park.
See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the licenses of the
dependencies and for the third-party code that this repository carries.

## Repository

Repository: https://github.com/HyeonuPark/pi-sec
