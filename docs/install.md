# Installing pi-sec

Companion to [README.md](./README.md) and [security.md](./security.md). This page
takes one unprivileged Linux account from an empty home to a running daemon: it
creates the control structure and the two code trees, connects a model provider,
writes the first model configuration, chooses how the daemon runs, and covers
updating and rolling back.

Commands on this page are written as `pi-sec <command>`. The installed CLI is
`~/.pi/sec/snapshot/dist/cli.js`, so run them as
`node ~/.pi/sec/snapshot/dist/cli.js <command>`, or put that file on `PATH` under
the name `pi-sec`. The install script prints the long form in every command it
asks you to run.

---

## 1. Prerequisites

| Requirement | Why |
|-------------|-----|
| Linux | The systemd user unit and the runner are the two supported ways to keep the daemon running. |
| An unprivileged account | The daemon runs as that account and never uses `sudo`. Use an account of its own, not your login account. |
| Node 22.19 or newer | `package.json` requires it. |
| `npm` and `git` | `npm ci` and `npm run build` fill both code trees, and the second tree is a git worktree of the first. |
| `flock` | `user-tools/update-and-restart` takes a lock with it before every update. `flock` is part of `util-linux`, which most distributions install. |

The install script refuses to run as root. It looks for `node`, `npm`, `git` and
`flock`, lists every one that is missing or too old with a hint for installing
it, and stops before it creates anything.

Some more system packages are optional. A missing one never stops the install.
After step 8, the script prints a block titled `optional system packages` with
the missing ones and one command for root that installs them. The script never
runs that command, because it has no root.

- The shared libraries of headless Chromium, for browser tests and `ui-probe`
  screenshots. The package list comes from the Playwright in the workspace tree.
- The headless Chromium browser itself. The install downloads it, as the
  account that runs the install, into `~/.cache/ms-playwright` (or the folder
  that `PLAYWRIGHT_BROWSERS_PATH` or `XDG_CACHE_HOME` names). The download is
  about 128 MB, and the browser takes about 277 MiB on disk. Add
  `--skip-browser` to leave it out. The folder is outside `~/.pi/sec`, so you
  delete it yourself when you remove pi-sec.
- A Korean font, for Korean text in browser screenshots. `fc-list :lang=ko` must
  list one. On Debian and Ubuntu the printed command installs `fonts-nanum`.
- An **OpenSSH client** (`ssh`, `sftp`) and `rsync`, for the `remoteMachines`
  feature. `ssh-keygen` is also useful on the machine where you read a key's
  fingerprint. The feature is off unless the `remoteMachines` key is in
  `config.json`: see [runtime-layout.md](./runtime-layout.md#config-schema).
- `gh`, for the `github-pr` extension, which is off by default.

The script does not read `config.json` to decide which of these to show. Each
line names its feature, so you can ignore the ones you do not use. On Debian and
Ubuntu the packages come from Playwright's own list and from `dpkg-query`. On
other distributions the block lists the missing shared libraries and the
commands, and you look up the packages yourself. The environment variable
`PI_SEC_OS_RELEASE` names the file that the check reads instead of
`/etc/os-release`, which tests use.

With `--run systemd`, the unit gets a fixed `PATH`. If `ssh`, `sftp`, `rsync` or
`gh` is on your shell's `PATH` but not on the unit's, the block adds a line that
names it. The daemon will not find that command.

Run `user-tools/install --check-deps` at any time to see the same block again. It
creates and changes nothing, takes no other option, and never downloads the
browser. If the browser is missing, it prints the download command. This is also
the way to get that command when a rerun stops at step 8 because the unit file
already exists, and after a Playwright update.

---

## 2. Access premise

`pi-sec` has no login of its own. It assumes one of two arrangements:

- an authenticating proxy in front of it, which decides who reaches the port, or
- access limited to localhost, with the default `server.bind` of `127.0.0.1`.

Two facts come with that premise:

- Another account on the same host can reach a loopback port. That account can
  call every route, including the ones that write secrets and restart the daemon.
  Only accounts you trust belong on the host.
- The daemon checks `Host` and `Origin` on every request, and neither check is a
  login. `Host` must name the hostname of `server.publicUrl` or a loopback name.
  A request other than a `GET` or a `HEAD` must carry the origin of
  `server.publicUrl` or a loopback origin on the port. These checks narrow the way
  another page in a browser reaches the daemon, and they do not replace the
  proxy.

Set `server.publicUrl` to the address you open the web UI at, when the browser
reaches the daemon by another name or port. Without it, the `Host` check accepts
loopback names only and the `Origin` check accepts loopback origins only, so that
page cannot write.

[security.md](./security.md#network) covers the model in full.

---

## 3. Install

The default route clones the repository into the account's home and runs the
install script from the workspace tree:

```bash
git clone <repository URL> ~/.pi/sec/workspace
~/.pi/sec/workspace/user-tools/install
```

The script works in eight steps, and every step is safe to repeat:

1. **Pre-checks.** Root is refused. `node`, `npm`, `git` and `flock` are looked
   up, and a missing or old one is reported with an install hint.
2. **Control structure.** `~/.pi/sec` and its eight subdirectories, mode `700`.
   `PI_SEC_HOME` moves the home. The default is `~/.pi/sec`.
3. **Modification tree.** `~/.pi/sec/workspace`. A repository already there is
   kept. A run from inside that directory uses it. A run from anywhere else
   clones that repository into it, and the clone's `origin` becomes the source
   repository's `origin` address. The step then runs
   `user-tools/install-git-hooks` (see [Commit hooks](#commit-hooks)). If that
   script refuses, the step prints a note and the install goes on.
4. **Execution tree.** `~/.pi/sec/snapshot`, a worktree of the workspace
   repository on branch `snapshot`, built with `npm ci` and `npm run build`. The
   workspace gets its own `npm ci`, because the restart gate runs typecheck and
   tests there.
5. **Configuration.** `~/.pi/sec/config.json`, from the built CLI's default, mode
   `600`. An existing file is kept.
6. **Model provider.** If a `models.json` file or a provider extension is named,
   the script copies it. The script signs nothing in: after the daemon starts,
   open the web UI and sign in from "Model login" in the "More actions" menu.
7. **First model.** `pi-sec models`, then `pi-sec setup-model`, as in
   [section 5](#first-model).
8. **Run mode.** A systemd user unit or the runner, as in
   [section 6](#run-modes).

After step 8 the script downloads the headless Chromium browser if it is not in
the browser folder yet, and prints the `optional system packages` block from
[section 1](#1-prerequisites). A failed download does not stop the install: the
block says so and prints the command to run later.

At the end the script prints the web UI address from the installed config (the
default is `http://127.0.0.1:8787/`) and one sentence about access, which follows
the bind address that is really configured.

### Commit hooks <a id="commit-hooks"></a>

The repository ships three git hooks in `user-tools/git-hooks/`. `pre-commit`
runs the tree scan (`npm run scan`) on a copy of the staged files. `commit-msg`
runs it on the commit message. `pre-push` runs it on every file and message of
the commits that a push sends. Each hook refuses the commit or the push when the
scan finds a value of your install, and it prints the file, the line, and the
kind of value. `pre-push` prints the place and the kind and never the value. A
linked worktree shares the hooks of its repository, so the hooks run there too.

The scan looks for the registered secret values, the home path, the host name,
the personality name and the account name of your install, and the words of a
word list. It also looks for two shapes: a generated id (a ULID) and an e-mail
address that is not on an example domain. The scan reads the install values when
it runs. The personality name is the `name:` of the personality file that
`config.json` names. The account name is the account that runs the scan. The scan
skips a short value (an ASCII value of fewer than 4 characters, or any other
value of fewer than 2) and a common account name such as `root` or `ubuntu`.

The word list is the file `scan-words.txt` in the pi-sec home
(`~/.pi/sec/scan-words.txt` by default). Write one word per line. A line that
starts with `#` is a comment. A line that starts with `!` is not a word: it names
one install value that the scan does not search for, for example `!Aria` when
your assistant has the name Aria and that word is also an ordinary word of the
tree. The file stays outside the repository. If the file is missing or
unreadable, the hooks refuse every commit and say so.

The identity list is the file `commit-identities.txt` in the pi-sec home. Write
one identity per line as `Name <email>`. A line that starts with `#` is a
comment. `pre-commit` refuses a commit whose author or committer is not in the
list. `pre-push` does the same for each commit of the push, which covers a
commit that skipped `pre-commit`, such as a rebase or a cherry-pick. A refusal
names the commit and the role and never prints the identity. If the file is
missing or unreadable, the hooks refuse every commit and push and say so.

`user-tools/install-git-hooks [--update] [repository]` copies the three hooks
into the hooks folder of the repository, mode `755`. It creates the word list
with a comment header and mode `600` when it is missing. It creates the identity
list with a comment header, the line `pi-sec <pi-sec@localhost>`, and mode `600`
when it is missing. It never replaces a hook file that holds other text: it
prints the file and exits 1 without a change. With `--update`, it also replaces a
hook file whose second line starts with `# pi-sec install hook.`, which is how it
brings an older pi-sec hook up to date. A file with the same text stays as it
is, so a second run changes nothing. It reads and writes no other hook file. Each
run of `user-tools/update-and-restart` runs `install-git-hooks --update`, so an
update installs the current hooks.

`user-tools/export-public` writes one commit of the repository as a new
repository with a single commit. It installs the hooks into the new repository,
checks the identity, the tree, and the scan of the result, and can write a bundle
of it. Run it without arguments to read its usage.

Before you add a word, write it alone into a temporary file outside the
repository and run `npm run scan -- --words <that file>`. Add the word only when
the scan reports 0 findings, because a word that is already in the repository
makes every later commit fail.

### Options

| Option | What it does |
|--------|--------------|
| `--provider <id>` | The provider of the first vmodels, which step 7 writes. |
| `--models-json [file]` | Copy a compatible-endpoint file to `~/.pi/sec/models.json`. Without a file, the script prints where the example is and copies nothing. |
| `--extension <dir>` | Copy a provider extension to `~/.pi/sec/extensions/<name>`. |
| `--model <id>` | The model for the root, orchestrator, planner and worker vmodels. |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium` or `high`. Default `medium`. |
| `--worker-provider <id>` | A provider for the worker vmodel. `--worker-model` goes with it. |
| `--worker-model <id>` | A model for the worker vmodel. |
| `--skip-model` | Do not write the first vmodels. |
| `--run systemd\|manual` | How the daemon runs. The default is `systemd` when the account has a user manager, `manual` otherwise. |
| `--skip-browser` | Do not download the headless Chromium browser. The block prints the download command instead. |
| `--check-deps` | Only check the system packages and print what is missing. Creates and changes nothing, and takes no other option. |
| `--no-start` | Write the unit file, but do not register or start it. |
| `--yes` | Never ask. With `--run systemd` it registers and starts the unit, so add `--no-start` to stop after writing the file. |
| `-h`, `--help` | Print the option list. |

An option takes its value as a separate word: `--provider anthropic`.

With a terminal on stdin and no `--yes`, a missing option is asked for. Without a
terminal, or with `--yes`, the script never waits for input: it uses the option or
the default, and it says which default it took.

`--models-json` and `--extension` are two routes of the same step, so they
cannot be combined. The conflict is refused before any work starts.

`--login` and `--skip-login` are gone, because the install no longer signs a
provider in. An automated install command that still names one stops with
`unknown argument`, so drop the option from that command.

A second run leaves an existing tree, `config.json`, `models.json`, extension
copy or unit file as it is. A non-interactive run that names no `--model` prints
that the daemon starts in setup mode, the exact `setup-model` command to run
later, and exits 0.

---

## 4. Connect a model provider <a id="connect-a-model-provider"></a>

A provider is the service a model comes from. The install script copies a
`models.json` endpoint file or a provider extension, and signs nothing in. You
sign a provider in from the web UI: start the daemon, open the web UI, and choose
"Model login" in the "More actions" menu. The panel lists every provider the
catalog holds, and marks a provider that a runtime extension registered with the
name of that extension.

### 4.1 A built-in provider, OAuth subscription login <a id="login-oauth"></a>

Choose the provider and the login type OAuth. The panel shows the provider's
login methods, for example "Copy code login" for Anthropic, and each one finishes
in the panel: open the sign-in link, sign in, and paste the code that the
provider shows into the panel.

### 4.2 A built-in provider, API key <a id="login-api-key"></a>

Choose the provider and the login type API key, and paste the key into the field
the panel shows. The typed characters stay hidden.

Either login writes the value to
`~/.pi/sec/secrets/model-auth.<provider>.<field>`, mode `0600`.
`~/.pi/sec/auth.json` then holds `{ "file": "<that name>" }` in place of the
value, so no credential value sits in `auth.json`. The daemon does not restart.

The panel shows whether a provider already has a credential. The daemon answers
the same requests on the routes in [http-api.md](./http-api.md), which is the way
to log in with `curl` when the page does not work.

pi-sec ships a `synthetic` provider for synthetic.new. Its models are the ones
the service lists at `https://api.synthetic.new/openai/v1/models`. The daemon
reads that list at start, and again every six hours, and replaces the provider's
models with what it read. The last good answer is kept in
`~/.pi/sec/state/synthetic-models.json`, so a start without a network registers
the models of the last read. A read that fails keeps that file and writes one
warning line to the log. A model that the service no longer lists leaves the
catalog with the next read.

Pick `synthetic` on the model login page and paste the API key. The key is stored
as `model-auth.synthetic.key`, and storing it reads the list once, so the models
appear without a restart. A home that never stored a list and cannot reach the
service registers one model, `hf:deepseek-ai/DeepSeek-V4.1-Flash`. No vmodel uses
this provider by default. `pi-sec models` and `pi-sec doctor` show the stored
list and never call the service.

Costs are recorded at synthetic.new's subscription rates, the rates at which a
token subtracts from the weekly credit. The list carries only the usage-based
price of a token, so the subscription rates are a table in the provider code,
taken from <https://synthetic.new/pricing/models>. A model that the table does
not name, and every `infinite:` alias, is recorded at the price in the list.

### 4.3 A compatible endpoint in `models.json` <a id="models-json"></a>

An endpoint that already speaks a supported API needs no code. Write it in
`~/.pi/sec/models.json`. This example is a proxy in front of an
OpenAI-compatible API:

```json
{
  "providers": {
    "example-proxy": {
      "baseUrl": "https://llm-proxy.example.com/v1",
      "api": "openai-completions",
      "apiKey": "$EXAMPLE_PROXY_KEY",
      "models": [
        {
          "id": "gpt-4.1-mini",
          "name": "GPT-4.1 mini (example proxy)",
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 128000,
          "maxTokens": 8192,
          "reasoning": false
        }
      ]
    }
  }
}
```

- `providers` is keyed by the provider id, and that id is what
  `pi-sec models` and `setup-model` name.
- `baseUrl` is the endpoint root. The API type appends its own path, so
  `openai-completions` sends requests to `<baseUrl>/chat/completions`.
- `api` names the wire protocol. `openai-completions` is the one Ollama, vLLM, LM
  Studio, SGLang and most proxies speak.
- `apiKey` can be a literal value, `$NAME` or `${NAME}` for an environment
  variable, or a leading `!command` whose output is used. A provider with no
  `apiKey` and no `oauth` block is registered as well: the model login panel
  offers it with the API key login, and every request then carries the key you
  paste there. That login is the way to keep a key out of `models.json`. A local
  server that ignores keys accepts any value at that login, and `ollama` is the
  usual stand-in.
- Each entry of `models` needs an `id`. The other fields describe the model:
  display name, input kinds, cost, context window, output limit, and whether it
  reasons.

`pi-sec models` lists the endpoint's models, and `setup-model` can name them.

### 4.4 An extension provider <a id="extension-provider"></a>

A runtime extension can export model providers: a custom authentication flow,
model discovery, or a wire protocol no built-in API implements. Runtime
extensions live in `~/.pi/sec/extensions/<name>/`.

```bash
~/.pi/sec/workspace/user-tools/install --extension <extension directory>
```

The script copies the directory to `~/.pi/sec/extensions/<name>`. It signs nothing
in: the web UI's "Model login" panel lists the provider with the extension that
registered it, and its API-key and OAuth logins are the same runtime call as a
built-in provider's. Credentials land in the same secret store under the same
names.

An extension provider runs inside the daemon and can see credentials, prompts and
responses. Put only code you trust there. The export shape, the two entry forms
and the reload rules are in [extensions.md](./extensions.md#model-providers).

---

## 5. Choose the first model <a id="first-model"></a>

A new home has no model configured. A daemon whose `agent.vmodel` is empty starts
in setup mode: the web server runs, and the chat page asks for a model. Setup
mode ends when a model is chosen in either of two ways.

- On the web page: sign a provider in from "Model login", then choose the model
  in the model form. The form writes the same `config.json` values that
  `pi-sec setup-model` writes and loads them, with no restart. It works in setup
  mode only. After that, the save request answers `409 model_already_configured`
  and `config.json` stays as it was.
- On the server: run `pi-sec setup-model` as below, then load the configuration
  with `POST /api/admin/reload` or restart the daemon.

A name that is set and cannot be used still stops the boot with exit code 2: a key
that `vmodels` does not hold, a missing prompt file, or a model outside the
catalog. Only the empty value starts setup mode. While it lasts, the daemon logs
the warning `no root model is configured; serving the model setup notice`, and a
chat message answers `409 model_not_configured`. A systemd unit shows `active`
in setup mode, so read the log or the web page, not `systemctl status` alone.

The two commands below are the server route.

### List the catalog

```bash
pi-sec models
```

One line per chat model:

```text
example-proxy/gpt-4.1-mini	source=models.json	auth=yes
```

`source` is the topmost layer that defines the provider: `extension:<name>`,
`models.json`, or `builtin`. `auth=yes` means the runtime finds a credential for
that provider. `--provider <id>` narrows the list. The command reads only: it
writes no file.

### Write the vmodels

```bash
pi-sec setup-model --provider <id> --model <id> [--thinking <level>] \
  [--worker-provider <id> --worker-model <id>] [--force]
```

The command writes into `~/.pi/sec/config.json`:

- `vmodels.root` and `vmodels.orchestrator`: the provider, the model, the
  thinking level and `"prompt": "default"`;
- `vmodels.planner`: the same values as `vmodels.orchestrator`, so the planner
  starts on the orchestrator's model and the two can be moved apart later;
- `vmodels.worker`: the same, or the model `--worker-model` names;
- `agent.vmodel: "root"`;
- `agent.roles: ["root-agent", "user-facing-agent"]` when the existing list is
  empty. A non-empty list is kept.

`--thinking` defaults to `medium` and applies to all four vmodels. Every other
key of the file is copied through unchanged, and a key the file does not have
stays absent. The file is written whole and atomically, mode `0600`.

An install that already runs keeps its own `agent.roles`, because a non-empty
list is kept. After you update such an install to this version, and before you
start the daemon, edit `~/.pi/sec/config.json` so that `agent.roles` starts with
`"root-agent"` before `"user-facing-agent"`. The root's own rules are in
`root-agent.md`, and a list that names `user-facing-agent` alone gives the root
the shared rules only. `pi-sec doctor` warns while `root-agent` is missing.

Do not add `root-agent` to the config of a daemon that runs older code. The
daemon reads the list at start, and it refuses to start when a listed role file
does not exist.

The command writes nothing, and exits 2, in these cases:

- the model is not in the catalog (run `pi-sec models` first);
- a vmodel of one of the three names already exists and `--force` is absent;
- only one of `--worker-provider` and `--worker-model` is given, or a thinking
  level is not one of the five;
- `config.json` is not valid JSON, or the result would fail config validation.

The four vmodels name the shipped prompt file `prompts/vmodel/default.md`, which
is empty, so serving them adds nothing to the system prompt. A built install has
that file under `dist/prompts`.

---

## 6. Choose how the daemon runs <a id="run-modes"></a>

Both modes run the same daemon from `~/.pi/sec/snapshot`. They differ in what
supervises the process, and that difference decides which maintenance features
work.

### 6.1 A systemd user unit <a id="run-systemd"></a>

`--run systemd` writes `~/.config/systemd/user/pi-sec.service` from the template
`user-tools/pi-sec.service`, filling four placeholders from the account: the
home, `PI_SEC_HOME`, the absolute path of `node`, and a `PATH` with that directory
first. The file is mode `600`. The script does not overwrite an existing unit
file. It prints where that file is and exits 1.

Then register and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now pi-sec
```

`--yes` runs both. Without `--yes` and without a terminal, the script prints them
and starts nothing.

To keep the daemon running while the account has no login session:

```bash
loginctl enable-linger <account>
```

The script prints that command and never runs it.

The unit is a user unit: it names no `User=` and no `Group=`, because the account's
own user manager runs it. It sets `Type=notify` with `NotifyAccess=all`, a 60
second watchdog, the sandbox and the resource limits listed in
[security.md](./security.md#service-and-sandbox), and
`Environment=PI_SEC_PRIVATE_TMP=1`, which is what gives the daemon a private
`/tmp` to clean.

### 6.2 The runner, without systemd <a id="run-manual"></a>

`--run manual` prints the command to run in a terminal that stays open: `tmux`,
`screen`, or a plain shell.

```bash
~/.pi/sec/snapshot/user-tools/run
```

The runner starts the daemon in the foreground with `PI_SEC_RUNNER=1` and its own
`PI_SEC_HOME`. It forwards `SIGINT` and `SIGTERM` to the daemon and ends with the
daemon's exit code.

When the daemon exits with code 75, which is a restart asked for from the web UI,
the runner runs `user-tools/update-and-restart` and starts the daemon again. Any
other exit code ends the runner with that code and the daemon is not started
again: a refusal to start or a crash would repeat, and a loop would hide the
reason from you. If you want more than that, run the runner under your own
supervisor. The daemon ends within 20 seconds of a stop request, so the runner always gets
an exit code.

The update's output goes to the terminal and to
`~/.pi/sec/logs/update-and-restart.log`.

### 6.3 The restart button <a id="restart-button"></a>

The composer menu's `Restart server` runs `user-tools/update-and-restart` through
the daemon. It works in both run modes:

| Mode | What the button does |
|------|----------------------|
| systemd user unit | The daemon hands the script to a transient unit of its own, so stopping `pi-sec` cannot stop the update. |
| `user-tools/run` | The daemon writes `run/restart-pending`, answers `202`, and exits with code 75. The runner applies the update and starts the daemon again. |

It refuses in three cases:

- the daemon already asked for one (`already_requested`);
- the daemon runs under a system unit, which needs `sudo` to restart
  (`system_unit`);
- the daemon runs under no unit at all, which is a bare `pi-sec start`:

  > no systemd unit named pi-sec was found and the daemon is not running under
  > user-tools/run; stop the daemon, run user-tools/update-and-restart, and start
  > the daemon again

The response bodies are in [http-api.md](./http-api.md#restart).

### 6.4 What is missing without systemd <a id="without-systemd"></a>

| Feature | systemd user unit | No systemd |
|---------|-------------------|------------|
| Restart button in the web UI | Works. | Works under the runner. It does not work when `pi-sec start` runs on its own. |
| Update and rollback scripts | Stop the daemon, update, rebuild, and start it again. | Update and rebuild only while the daemon is stopped. You, or the runner, start it again. |
| Private tmp and cleanup of `/tmp` | The unit gives the daemon a private `/tmp`, and the daemon cleans it. | Not provided. The daemon skips `/tmp` cleanup, so it never deletes another program's files. Temporary files an agent writes can stay in the shared `/tmp`. |
| Sandbox and resource limits | The unit forbids writes outside the home and privilege escalation, and caps memory and tasks. | Not provided. The daemon and the commands its agents run have every permission of the account. |
| Watchdog for a stopped daemon | The unit starts the daemon again when the daemon sends no signal for 60 seconds. | Not provided. |
| Automatic restart after a crash | The unit starts the daemon again after 3 seconds. | Not provided. The runner keeps the exit code and ends. |
| Start at boot | A user unit, plus linger, starts it at boot. | Not provided. |

---

## 7. Updating <a id="updating"></a>

`user-tools/update-and-restart` moves the execution tree to the workspace's
`main`, rebuilds, and restarts the daemon from that code. It always rebuilds and
restarts, even when the two trees are already in sync.

```bash
~/.pi/sec/workspace/user-tools/update-and-restart [--check] [--pull] [--reinstall]
```

| Option | What it does |
|--------|--------------|
| `--check` | Report the workspace and snapshot commits and stop. It changes and restarts nothing, and it works while the daemon serves. |
| `--pull` | Fetch `origin`, then fast-forward `main` onto `origin/main`, before the update. It never pushes. |
| `--reinstall` | Delete the execution tree's `node_modules` and install it again from `package-lock.json`. |
| `--check --pull` | Fetch, then report how far `main` is behind and ahead of `origin/main`. It moves neither branch and builds nothing. |

A plain run uses no remote: it fetches nothing into the workspace and pushes
nothing out of the account. `--pull` adds exactly one hop, and only when you ask
for it.

`--pull` refuses, with nothing changed, in three cases:

- the workspace has uncommitted changes;
- the workspace is checked out on a branch other than `main`;
- `main` has commits that `origin/main` does not have, which is the normal state
  after the agent commits its own edits. A merge is needed, and the message names
  both counts. Merge by hand, then run the script again.

Each applied update also runs `user-tools/install-git-hooks --update` of the
execution tree on the workspace, so the commit hooks of the applied commit are
the installed hooks. A refusal of the installer prints a note and the update goes
on.

`--check --pull` asks nothing of the sort: it fetches and reports, so you can see
how far behind a home is before you decide. `--check` cannot be combined with
`--reinstall`: that pair prints the usage line and exits 2.

A run that can change a tree holds `run/update-and-restart.lock` for its length,
so a click in the web UI and a command in a terminal cannot interleave a stop, a
build and a start. `--check` takes no lock, because it changes nothing.

With no unit to stop, the script checks whether a daemon of this home is running
before it changes anything. A running daemon makes it refuse and name the way
forward: stop the daemon yourself, or press the restart button under the runner.
`--check` skips that check, because it changes nothing.

The snapshot tree is read-only by convention. A change to tracked files in it is
refused. The update is a fast-forward, and a diverged snapshot is refused rather
than guessed at.

---

## 8. Rolling back <a id="rollback"></a>

`user-tools/rollback <commit-or-tag>` moves the execution tree back to an earlier
commit and restarts the daemon from it.

```bash
~/.pi/sec/workspace/user-tools/rollback <commit-or-tag>
```

With no argument it prints the last fifteen commits of the execution tree and
exits 2. It refuses when the execution tree has uncommitted changes, and, with no
unit to stop, when a daemon of this home is running.

After the reset it compares the lockfile of the two commits. It runs `npm ci`
when the lockfile differs, and also when the tree has no `node_modules`.
Otherwise it reuses `node_modules`. It then rebuilds and starts the daemon again
the way your run mode needs: the unit is started, or the script tells you to
start your own process.

A step that fails after the daemon was stopped ends the script with the exit code
of that step. The script does not start the daemon in that case, because a failed
install or build can leave the tree half written. It prints where the tree is now
and where it was before, and these commands: go back to where you started, try
the same rollback again, and repair the dependencies by hand. Under a unit it
also prints the command that starts the daemon.

Storage is not touched. A migration that made storage unreadable to the older
binary needs your own copy of `state/` as well. The next update fast-forwards
back to `main` and refuses if the two trees have diverged, which is what keeps a
rollback from being undone by accident.
