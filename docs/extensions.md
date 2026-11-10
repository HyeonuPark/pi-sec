# Extensions & Self-Improvement

Companion to [README.md](./README.md). pi-durable's extension mechanism is the
backbone of `pi-sec`'s feature set and its ability to improve itself.

---

## 1. The pi-durable extension model (recap)

An **extension** is a named bundle of `tools`, `sections` (system prompt parts),
`hooks`, `wraps`, and `tasks`. A **registry** holds the installed extensions;
conversations store extension *names*, not code.

Properties that matter here:

- `registry.install(extension)` replaces an installed extension **by name**,
  atomically and live.
- Work in flight keeps the old code; the **next task phase, request, or call**
  uses the new code.
- Installed state is not persisted; after a cold restart the host installs
  extensions again.
- Hooks let an extension observe/adjust the built-in `GenerationTask` and
  `ToolTask` (used for secret redaction and `ask_user`, **not** for command
  pattern guards).

**Two different "replays" — do not conflate them:**

- **Extension replay** is re-installing extension *code*: after a cold restart the
  host installs extensions again, and on hot reload `registry.install` replaces
  one by name. It changes which code *future* task phases use; it never re-runs
  past work.
- **Tool-call replay** is pi-durable re-executing a task or tool call when a run
  resumes after a crash. It is governed by the tool's `replay` declaration, and a
  tool marked `replay: "safe"` must be idempotent. It has nothing to do with which
  extension version is loaded.

---

## 2. Core vs runtime extensions

`pi-sec` deliberately separates two kinds:

| | Core (bundled) | Runtime |
|---|---|---|
| Location | `src/extensions/` in the code tree | `~/.pi/sec/extensions/<name>/` |
| Versioned | Yes, in git | No, personal |
| Hot reload | **No** — code is cold-only | **Yes** |
| Config | keys in pi-sec's `config.json` (`src/config/schema.ts`) | `config.json` next to code |
| Install order | First | After core; overrides same-name core |
| Change path | commit in workspace + cold restart | edit + reload; promote to core only with user confirmation |

[boundary.md](./boundary.md) gives the rule that decides on which side a feature belongs. This section describes how the two sides load and change.

This is intentional simplicity. Earlier designs hot-swapped core code; that is
hard to reason about. Instead:

- **Runtime extensions are the hot surface.** To add or change behavior, the agent
  creates/edits a runtime extension and reloads it. Functionality is live
  immediately.
- **Core changes are cold.** Core extensions and prompts are part of the running
  program. Changing them requires a cold restart the **user** performs.
- **Promotion to core is the agent's decision but needs user confirmation.** The
  agent may decide that a proven runtime extension belongs in-tree; it stages the
  change in the workspace tree (as a core candidate) only after asking the
  user (`ask_user`) to confirm. Because the extension already works live, there
  is no urgency.

---

## 3. Code trees <a id="code-trees"></a>

Two working directories for the pi-sec code itself, both under `~/.pi/sec`, plus
human tooling at the repo root:

| Tree | Path (config) | Access | Purpose |
|------|---------------|--------|---------|
| **Snapshot** | `code.snapshot` (`~/.pi/sec/snapshot`) | read-only by convention | The **execution tree**: the worktree the running process boots from, on branch `snapshot`. Ground truth for "current behavior"; moved only by `update-and-restart`. |
| **Workspace** | `code.workspace` (`~/.pi/sec/workspace`) | read/write | The **modification tree**: where the agent edits, validates, and commits, on branch `main`. Never executed. |
| **user-tools/** | repo root (`<tree>/user-tools/`) | human-run | Maintenance scripts: install, run, update-and-restart, rollback. |

Why two trees:

- **The snapshot is the code the running process booted from.** The agent reads it
  to learn its *current behavior* — even after it has modified the workspace tree,
  the snapshot still describes what is actually running.
- **The workspace is for modification, not execution.** Its changes have no effect
  on the running process until the user promotes them by advancing the
  snapshot and restarting (a clean review boundary: workspace = proposed changes,
  snapshot = accepted/running state).

Typical promotion of a core change:

```text
1. Agent edits files in code.workspace.
2. The agent commits in `code.workspace` (the modification tree) and records the
   commit in `sec.selfEdit`.
3. When the batch is closed, the agent calls `request_restart`. That runs the
   gate against the workspace tree and raises the request **only if it passes**.
     └─ fail: nothing is marked ready, the user is not asked, and the gate's
        output goes back to the agent to fix.
     └─ still-working child: the tool sends each busy child a safe-point note and
        waits; it does not refuse. See [Safe point before the gate](#safe-point).
4. A passing gate marks the restart ready and emits `restart_required`, asking
   the user to run `user-tools/update-and-restart`, or to press `Restart
   server` in the composer menu, which runs that same script.
5. The user runs `user-tools/update-and-restart`, which fast-forwards the
   snapshot branch to `main`, rebuilds, and starts `pi-sec` from that code.
6. `pi-sec` boots from the updated snapshot.
```

**The request is two facts.** `restartRequired` is the truth — committed core
work is not what the running process booted from; it is raised by the first
recorded core edit and cannot be withdrawn. `restartReady` is the signal that the
batch is closed and its gate passed. They are separate because a restart applies
whatever is on disk at that moment: a single flag that only ever went up could be
taken up between two edits and boot half a change. Recording another core edit
takes `restartReady` back down, and `withdraw_restart` (tool) or
`POST /api/admin/restart-withdraw` retracts it explicitly. Withdrawing never
clears the need — the banner reports "waiting", it does not disappear.

**The request belongs to the root, and the harness only reports what it sees.**
Nothing in the harness withdraws or raises the request: `request_restart`,
`withdraw_restart`, and the two admin routes are the only writers, and the root
decides when to call them. What the harness does is tell the root when the safe
point that the request describes no longer holds. While a request is up, four
events are judged by the rule the gate itself uses (`src/extensions/self-edit.ts`):

1. a status change in the hub (`SubagentHub.setStatus`);
2. a subagent's model request, in the hub's `beforeRequest` hook;
3. a background call that starts (`async_call_started`);
4. a background call that settles (`async_call_settled`).

The first subagent found working earns one note in the root's conversation, which
names it, and the `restart_safe_point_lost` audit row. The note asks the root to
withdraw the request. Nothing about the state changes, because the note is the
whole of the harness's part.

The idle notice and the stall note are held while the request is up, because a
note is input, an input wakes a parked parent, and the wake is what the watch
reads as a lost safe point.

When the root has withdrawn and an event finds every subagent at a safe point,
the harness sends the second note, which says that the request can be raised
again, and writes the `restart_safe_point_back` row. That note is not sent while
the request is still up: its wording would invite a second request beside the
first. One note per state means the lost note goes out once however many events
find the subagent still working, and the episode ends with the back note. Judging
starts again at the next passing `request_restart`.

Both notes are submitted as `restart` inputs with `whenBusy: followUp`, so a root
that is inside a tool call reads one when that call returns. There is no timer and
no poll, so a quiet tree is judged by nothing. A subagent that ends its turn
without `await_orders` or `finish_work` sends no event, so in that case the back
note waits for the next event that does.

Both trees are worktrees of **one repository**, each on its own branch: `main`
in the workspace, `snapshot` in the execution tree. Nothing leaves this account —
no remote, no push, no second clone in the path, so there is no hop that can
silently not happen. (There used to be one: the execution tree pulled from a
separate clone, so an update with nothing to pull restarted the daemon on the old
code and said nothing.) An update refuses outright when the two branches have
diverged, rather than guessing which one wins.

`pi-sec` never force-restarts itself for core changes and never overwrites the
running tree. `user-tools/` is part of the repo, so it exists at the root of both
checkouts; the user runs it from the workspace tree's copy — the execution
tree may be a few commits behind by definition.

### Install and maintenance scripts <a id="user-tools"></a>

`user-tools/` holds plain shell scripts run by a human. They make no privileged
calls themselves.

- **`user-tools/install`** — run **as the dedicated `pi-sec` user** on a fresh
  Linux account (the user creates the account first). It:
  1. refuses root, and lists any of `node` 22.19 or newer, `npm` and `git` that
     is missing or too old;
  2. creates `~/.pi/sec` and the control-structure directories with `0700`/`0600`;
  3. puts this repository in `~/.pi/sec/workspace`, the modification tree. A run
     from another checkout clones it there and keeps that checkout's `origin`;
  4. adds `~/.pi/sec/snapshot` as a worktree of that repository on branch
     `snapshot`, then runs `npm ci` in both trees and `npm run build` in the
     snapshot, so `dist/cli.js` exists;
  5. writes `config.json` from the built CLI's default;
  6. copies a model provider in: a compatible endpoint into `models.json`, or a
     provider extension into `~/.pi/sec/extensions/`. It signs nothing in, and
     points to the web UI's "Model login" panel instead;
  7. runs `pi-sec models` and `pi-sec setup-model` to write the first vmodels;
  8. takes `--run systemd` or `--run manual`: a systemd **user** unit rendered
     from `user-tools/pi-sec.service`, or the command that runs
     `user-tools/run`.

  It never uses `sudo` itself, it leaves a unit it finds in place, and a second
  run changes no existing tree or file. The privileged step it does
  name is `loginctl enable-linger`, which it only prints. Options, the provider
  routes and the two run modes are in [install.md](./install.md).
- **`user-tools/update-and-restart`** — advance the snapshot tree to the new HEAD
  and (re)start `pi-sec` from that snapshot code. It always rebuilds and restarts,
  even when the two trees are already in sync: the composer menu's `Restart server`
  runs this same script, and there the restart is the request. `--reinstall`
  deletes the execution tree's `node_modules` first, and the composer menu's
  `Force reinstall and restart` is what asks for it. It stops the service
  first, because `npm ci` and `npm run build` rewrite the tree the running process
  loads modules from. When it fails after stopping, it starts the service again and
  leaves `run/restart-pending` in place only if the service stays down, so the next
  boot reports the failure.
- **`user-tools/rollback`** — check out the previous tag and, if needed, restore
  the user's own storage copy.

---

## 4. Loading runtime extensions

Sources, in order (later same-name wins):

1. Core bundled extensions (`src/extensions/`).
2. Runtime extensions (`~/.pi/sec/extensions/<name>/`).

A runtime extension directory whose name matches a bundled extension replaces
the bundled extension. Both are installed by name: the bundled ones when the
harness opens, then every runtime directory in `loadAll`, and
`registry.install` replaces an installed extension with the same name in place.
Two consequences:

- A bundled extension can be overridden on disk. Removing the directory does not
  give the bundled one back on the next reload: the runtime copy stays installed
  until the next cold restart, as the paragraph below says.
- The runtime copy wins even when `agent.extensions.enabled` does not name the
  extension, because runtime loading never consults that list. An install that
  upgrades to a release which ships a name it already keeps on disk therefore
  keeps running its own copy. Remove the old directory to get the shipped
  extension.

Removing a runtime extension's directory and calling `reload_extensions` takes
back only the model providers that the extension registered. Its tools, sections
and hooks stay installed in the running daemon, because a reload installs what
it finds and does not rebuild the installed set. They go away at the next cold
restart, which installs only what is on disk. If you remove an extension because
it must not run, restart the daemon as well.

A runtime extension directory contains:

```
~/.pi/sec/extensions/<name>/
  index.js          # or index.ts (via jiti)
  config.json       # optional, validated against configSchema
```

### Shared packages

An extension may import the packages this install already has, including
`@earendil-works/pi-durable` and `@earendil-works/pi-ai`. That works because the
loader links this install's `node_modules` into the extensions directory before
it imports anything:

```
~/.pi/sec/extensions/node_modules -> <install tree>/node_modules
```

This is not a convenience. Node resolves a bare specifier by walking *up* from
the importing file, and `~/.pi/sec/extensions/<name>/` sits outside every
`node_modules` tree, so without the link every extension that imports the SDK
fails with `ERR_MODULE_NOT_FOUND` — for `.ts` under jiti as well as `.js`.

The link is (re)pointed at the running install on every `loadAll`, so it follows
the tree the process actually boots from. A real (non-symlink) `node_modules`
directory in that location is left untouched, and the directory scan skips the
name `node_modules` entirely, so the link is never mistaken for an extension.

Dependencies *outside* the install's tree are not available: to use another
package, install it into the install tree rather than in the extensions
directory.

The module shape (identical for core and runtime):

```ts
// ~/.pi/sec/extensions/example/index.js
import { Type } from "typebox";
import { defineExtension } from "@earendil-works/pi-durable";

export const name = "example";
export const configSchema = Type.Object({ greeting: Type.String() }); // optional
export function create(config) {
  return defineExtension({ name, sections: [...], tools: [...] });
}
```

A module with no config may instead `export default defineExtension({...})`. A
module may not both default-export an extension and define `create(config)`. A
module may also export `providers`, a list of model providers it adds to the
catalog; see [Model providers](#model-providers). It may also export `ui`, the
cards it puts in a slot of a page; see [Cards and slots](#ui-cards).

Loader behavior:

- **Normalize the export.** A module is either a *factory* (`name` +
  `create(config)`, optional `configSchema`) or a *bare extension* (`export
  default`). For a factory, the exported `name` must match the directory name.
- **Config is validated, never guessed.** If `config.json` exists, the module
  must declare `configSchema`; otherwise the extension is rejected. Without
  `config.json`, schema defaults (or no config) apply.
- **Dependency link** first: `<extensionsDir>/node_modules` is linked to the
  running install's `node_modules` (see above), so a bare `import` of a shared
  package resolves. A failure here is logged and loading continues.
- **Dynamic import** with a cache-busting query built from the extension directory:
  the newest modification time in it, and a digest of its files. The query reaches
  the files the entry imports from its own directory. So a reload reads a changed
  `lib/` file as well as a changed entry file, without restarting Node.
- TypeScript via `jiti` when the file is `.ts` or `.mts`. An entry in TypeScript
  follows the same export rule as one in JavaScript: `create(config)` alone, a
  default export alone, or neither is accepted, and both together is refused. The
  loader reads only the exports the file itself declares.
- **Config validation** before `create`. On failure: keep the previous instance,
  log, and surface a diagnostic. Never crash.
- A module that throws is logged and skipped; other extensions still load.
- **Providers** are registered with the model runtime after the extension
  installs, and taken back when it is replaced or its directory disappears. The
  rules are in [Model providers](#model-providers).
- **Cards** are registered on the same terms: after the extension installs, one
  reload replaces the previous cards, a failed reload keeps them, and an entry
  that breaks a rule is dropped with a diagnostic line. The slot a card names
  decides which page draws it: `sidebar.bottom` is the chat page's, and
  `usage.cards` is the usage page's. The rules are in
  [Cards and slots](#ui-cards).
- Only files under configured extension directories are loadable; path traversal
  is rejected.
- Records `{ name, source, path, mtime, configHash }` for diagnostics.

### Per-extension config <a id="per-extension-config"></a>

`config.json` is owned by the extension. The loader:

1. resolves `config.json` if present (rejecting it when the module has no
   `configSchema`),
2. validates it against `configSchema` (schema defaults apply when absent),
3. calls `create(config)`, or uses the default export when there is no factory,
4. installs the result.

Changing `config.json` (or `index.js`) marks the extension dirty. A debounced
watcher reloads it: validate → `create` → `registry.install`.

**A bundled extension has no per-extension config file.** Its settings are keys
in pi-sec's own `config.json` (`src/config/schema.ts`), read through
`context.getConfig()`, so a bundled extension declares no `configSchema` for a
directory config to be validated against. The loader still offers a directory
config to a core factory (`ExtensionLoaderOptions.coreFactory`), and nothing can
arrive through it: `normalizeExtension` rejects `config.json` when the module
declares no `configSchema`, so a directory that holds only `config.json` fails
with `extension <name> has config.json but the module declares no
configSchema`. To change a bundled extension's behavior, change the config key
and restart, or write a runtime extension with the same name.

### Model providers <a id="model-providers"></a>

A runtime extension may add model providers. The export sits next to `name`,
`create`, `configSchema` and `toolTags`, and takes one of two shapes: an array,
or a function of the extension's validated config value.

```js
// ~/.pi/sec/extensions/acme/index.js — the array form.
export const name = "acme";

export const providers = [
  {
    id: "acme",
    config: {
      name: "Acme",
      baseUrl: "https://api.acme.example.com/v1",
      api: "openai-completions",
      apiKey: "$ACME_API_KEY",
      models: [
        {
          id: "acme-chat",
          name: "Acme Chat",
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
          reasoning: false,
        },
      ],
    },
  },
];
```

```js
// ~/.pi/sec/extensions/acme/index.js — the function form.
// The argument is the validated value of this directory's config.json.
export function providers(config) {
  return config.enabled === true ? [providerFor(config)] : [];
}
```

The function form receives exactly what `create(config)` receives: `config.json`
merged over the module's `configSchema` defaults and checked against that
schema. A `config.json` with no `configSchema` is refused, as it is for `create`.
The value is read synchronously while the extension loads, so a promise is
refused rather than awaited. Returning nothing means "no providers".

The export is `providers`, and each entry is one of two forms:

| Form | What it holds | Registered with |
|------|---------------|-----------------|
| `{ id, config }` | `config` is the `ProviderConfig` of `@earendil-works/pi-coding-agent`: `name`, `baseUrl`, `apiKey`, `api`, `headers`, `authHeader`, `models`, `refreshModels`, `oauth`, `streamSimple`, `images`, `classifiers`. | `registerProvider(id, config)` |
| a complete `Provider` | The `Provider` of `@earendil-works/pi-ai`: `id`, `name`, `auth`, `getModels()`, `stream()`, `streamSimple()`, and optionally `refreshModels`, `filterModels`, `getAllModels`, `generateImages`, `classify`. The runtime uses it as it is and composes nothing onto it. | `registerNativeProvider(provider)` |

The two forms are told apart by shape, because an extension module is plain
JavaScript. An entry with a `getModels()` function and an `auth` object is a
provider. An entry with a string `id` and an object `config` is a config pair. An
entry with both, or with neither, is refused, and so is an id that is empty or
padded with spaces.

Either form may also carry `virtual: true` at the top of the entry, next to `id`.
An entry with that marker declares a provider that answers no request itself, and
that provider gets no card on the usage page.

The runtime checks a config pair as it registers it. `baseUrl` is required when
the config defines `models`, `api` is required next to `streamSimple`, and at
least one of `apiKey` and `oauth` is required. `apiKey` takes the `models.json`
syntax: a literal value, `$NAME` or `${NAME}` for an environment variable, or a
leading `!command` whose output is used.

Pick the smaller tool first. An endpoint that already speaks a supported API
goes in `models.json` and needs no code (see
[install.md](./install.md#models-json)). A provider
extension is for custom authentication, model discovery, or a wire protocol no
supported API implements.

Registration rules:

- **A reload replaces.** Loading the extension again registers its new ids and
  unregisters the ids it no longer exports. A reload that fails, because the
  module cannot be imported or because the function throws, keeps the previous
  registration, the way a failed reload keeps the previous tools.
- **A directory that disappears takes its providers with it**, and a provider the
  extension had overridden comes back. Tools and sections of that extension stay
  installed, which is today's behavior.
- **The first extension to claim an id keeps it.** A second extension that
  exports the same id is skipped with an error; its other providers, its tools
  and its sections still install.
- **An id may equal a provider the catalog already has.** That overrides it,
  which is how a proxy replaces a provider the catalog ships, and one log
  line records the override.
- **`virtual: true` marks a provider that answers no request itself.** An
  extension sets it on an entry whose provider hands each request to another
  provider, so pi-sec's record of a call names the provider that answered. The
  usage page and `GET /api/usage` then carry no card for it: a card would state
  zeros beside the card that already holds those numbers. The statistics page and
  `GET /api/usage/stats` leave it out as well, and the route refuses it as a
  `provider` value. Every other page, and
  `pi-sec models`, still list it. The marker sits beside `config` rather than
  inside it, because `config` is the `ProviderConfig` that reaches the runtime
  unchanged. An entry without the marker is a provider of its own.

Where an extension provider appears:

- `pi-sec models` lists its models with `source=extension:<name>`.
- The web UI's "Model login" panel lists it as `<id> [extension: <name>]`, with
  the extension that registered it. Its API-key and OAuth logins are the same
  runtime call a built-in provider uses.
- The daemon registers it before it checks the root vmodel, so a root vmodel may
  name a model an extension provides. An extension that cannot be read leaves the
  daemon at exit code 2 when the root vmodel needs it, with the extension's error
  in the log.
- Credentials land in `~/.pi/sec/secrets/model-auth.<provider>.<field>`, mode
  `0600`, and `~/.pi/sec/auth.json` keeps `{ "file": "<that name>" }` in place of
  each value. That is the store a built-in provider writes to as well.
- A reload, or a removed directory, that takes a vmodel's provider away writes
  one warning per affected vmodel and does not stop the daemon. The next request
  on that vmodel fails.

Model list refresh:

- A config pair may define `refreshModels(context)` and return the model list it
  wants published. A complete `Provider` refreshes through
  `context.publish({ update, persist })` instead, and a `persist` keeps the list
  in `~/.pi/sec/models-store.json`.
- The runtime calls `refreshModels` once when it builds the catalog and again
  after every registration and unregistration, always with the network phase off.
  pi-sec passes `allowModelNetwork: false` and never calls a refresh with it on,
  so a provider can rebuild a list it computed before but cannot fetch a fresh
  one by itself. A catalog that must follow a live service needs an operator-run
  refresh.

**A provider extension is trusted code.** It runs in the daemon's process and can
see credentials, system prompts, tool definitions, conversation content and model
responses. Put only code you trust in `~/.pi/sec/extensions/`, and log neither a
credential nor a whole provider payload.

### Judge models <a id="judge-models"></a>

A judge is a pi-ai **classifier** model (`type: "classifier"`): it reads one
piece of text and answers fixed questions about it, each with a probability. A
question is true-or-false, one of several choices, or a score. The top-level
`judges` table in `config.json` names one by key, and code calls it by that key:

```jsonc
"judges": {
  "reply-language": { "provider": "openai", "modelId": "gpt-6-luna", "timeoutMs": 5000 }
}
```

```ts
const result = await context.judges.judge("reply-language", {
  state: { text: reply },
  questions: {
    korean: {
      type: "bool",
      instructions: "Is this text written in Korean?",
      criteria: { true: "Korean", false: "not Korean" },
    },
  },
});
```

`provider` and `modelId` are required. `timeoutMs` is the deadline of one call in
milliseconds, and 5000 is the default. The table is empty by default, and pi-sec
does not write an entry to it.

pi-sec sends the request itself, to OpenAI's Decisions API. It does not use the
classifier call of pi-ai: that call turns one refused question into an error for
the whole request, and a refusal belongs to the question it names. The request
body is the one pi-ai builds, written out in `src/judges-openai-decisions.ts`.
OpenAI is the only judge service pi-sec speaks to, and another provider is added
when one is needed.

Lookup rules:

- Only classifier models are looked up. A chat model with the same id under the
  same provider is a separate catalog entry and is never used, so
  `openai`/`gpt-6-luna` means the classifier and not the chat model of that name.
  Nothing in this path builds a chat request.
- The lookup also reads the credential. A classifier model that the current
  credential cannot reach counts as missing: the `openai` provider hides
  `gpt-6-luna` while its credential is a ChatGPT login, because the Decisions API
  rejects that token. Such an entry is skipped, not failed.
- The model's api has to be `openai-decisions`. An entry naming another api is
  skipped without a call, because nothing in pi-sec can speak to it. The config
  schema accepts the entry: one judge must not keep the daemon from starting.
- A judge is for code. One tool reaches a judge: `report_check`, which only an
  orchestrator has, calls the judge named `report-check`. Every other judge is
  reached by code alone. A judgement is not part of any conversation.

One request is sent, with every question in it, and it is sent again only after a
connection error or an HTTP 408, 409, 429 or 5xx: at most twice, after the wait
the service asks for or 0.5 s and then 1 s, all inside `timeoutMs`. A 504 is not
retried, because the gateway times out on an input that a retry sends again. A
refusal is an answer, not an error, so it is never retried.

One call has one of three outcomes, and `judge()` never throws:

| Outcome | Fields | When |
|---|---|---|
| `answered` | `answers` (one per question that was answered, with its probability), `refused` (the keys the service would not answer), `usage` when the service reports tokens | The model answered every question, with an answer or a refusal. |
| `skipped` | `reason`: `name` (no such key), `model` (no reachable classifier model), `auth` (the provider has no credential), `api` (the model's api is not one pi-sec calls) | Nothing was called. |
| `failed` | `reason`: `timeout` (the deadline timer fired), `rate_limited` (the service answered 429 and the call gave up), `provider` (the reply had no readable answer, or the request failed); `status`, `retryAfterMs`, `errorType` and `errorCode` when the service answered with an error; `usage` when the service reported it | The model was called and gave no usable answer. |

A refusal is the answer of one question. It carries no probability, its key is in
`refused`, and the other answers of the same reply stand. A reply with every
question refused is still `answered`, with no answers and every key refused.

A failure carries its reason and, when the service answered with an error, the
status, the wait it asked for, and the short error type and code. A type or code
is kept only when it is one plain token of at most 64 characters. The provider's
own message and the reply body are dropped, because they can quote the text under
judgement. Treat
every outcome other than `answered` as "the judge said nothing" and go on with
your own fallback: a judgement must never be able to stop the work that asked for
it.

Recording:

- Every call appends one line to the audit trail (`logs/audit.jsonl`, `type:
  "judge"`): the judge name, the provider, the model, the outcome, the elapsed
  time, the reason and the four HTTP fields of a failure when they are known
  (`status`, `retryAfterMs`, `errorType`, `errorCode`), the refused question
  keys, the token counts and the cost. A failed call also writes one `app.log`
  line at level warn, `judge failed`, with the judge, the provider, the model,
  the reason, the elapsed time and the same HTTP fields. The text under
  judgement is not written, in the audit line or anywhere else. A call that was
  sent again records the usage of every reply that reported it, and a failed call
  records the usage the service reported, because a reply that cannot be read was
  still billed.
- A judgement is not added to a provider card on the usage screen, because that
  card counts the conversation records and a judgement runs outside every
  conversation. The usage page shows the audit trail's judgement lines on a card
  of its own, `Decision models`, with the calls, the tokens and the cost of each
  judge over the last 24 hours, 7 days and 30 days. A line timed after the
  moment of the read counts in no window until that moment comes. That card's
  cost is not added to any provider card's total.
- After every extension load pass, each judge entry is checked and gets one
  warning line if its provider has no classifier model of that id, if its model
  names an api pi-sec does not call, or if the provider has no credential. The
  checks are warnings only: a judge nothing can call does not stop the daemon, and
  the next call of it is skipped.

### Cards and slots: the `ui` export <a id="ui-cards"></a>

A runtime extension can put a card in a named slot of a page. The core opens two
slots today: `sidebar.bottom` on the chat page, and `usage.cards` on the usage
page (see [ui.md](./ui.md#slots)). The export sits next to `name`, `create`,
`configSchema`, `providers` and `toolTags`. It holds the cards, the callbacks the
server calls for one card, and a hook that receives the function that publishes
events to the page.

| Key | Required | What it is |
|-----|----------|------------|
| `cards` | yes | The cards this extension offers. Each entry is `{ slot, name, script? }`, and `script` names a file under `ui/`. |
| `render(args)` | yes | Draws one card. Returns `{ html, css? }`, or `null` to draw nothing this time. |
| `action(args)` | no | Answers one call from the card. Returns `{ html?, value? }`, or nothing. |
| `start(args)` | no | Runs once after the cards are registered. Its return value is ignored. |

The argument objects:

- `render({ slot, card, config, timezone })` draws one card for one page load.
- `action({ card, action, value, config, timezone })` answers one call. `action`
  is the name the card sent, and `value` is what it sent with it.
- `start({ publish, config })` receives the function that publishes events to the
  card, which the extension keeps for later.

`config` is the extension's validated config value, the same value `create`
receives. `timezone` is pi-sec's own timezone at call time. A runtime extension
gets no core context, so these arguments are where a card callback reads what it
needs.

The registry checks the value a callback returns. `render` returns
`{ html, css? }` with an `html` string, or `null` (or nothing) for a card that
draws nothing this time. `action` returns nothing, or `{ html?, value? }`, and
`value` can be any JSON value. A result of another shape, and a throw from
either callback, is a failure: the page shows the failure line, and the server
logs the reason.

#### Registration rules

- **A reload replaces the cards.** The `publish` an older module instance holds
  closes first, and a call on it is dropped without a word. Then the new cards
  are registered, and `start` runs once.
- **A failed reload keeps the previous cards.** The loader reaches the registry
  only after the module imports and `create` runs, so a load that fails before
  that changes nothing.
- **A directory that disappears takes its cards with it**, and its `publish`
  closes. Tools and sections stay installed, as they do for providers.
- **A bad entry is dropped alone**, with the reason in the extension diagnostics.
  A slot name or a card name off its rule, a repeated card name, and a script
  that is missing or points outside `ui/` all count.
- **A `ui` that cannot be used at all keeps no cards and reports one error.** A
  `ui` that is not an object, one with no `render` function, and one whose
  `cards` is not an array are the three cases. An `action` or a `start` that is
  not a function is ignored with one line.
- **A `start` that throws keeps the cards** and reports one line.
- **No `ui` export is not an error.** Most extensions have none.
- **An unknown slot is not an error.** A card whose slot no page opens is
  registered and never drawn.

The diagnostics are in `GET /api/admin/status`, under `runtimeExtensions`. A
record for an extension that registered a `ui` gains
`ui: { cards, errors }`: the card names that survived, and one line per dropped
entry. An extension keeps the newest 20 lines.

#### Slot and card names

- A slot name is lowercase words joined by dots, for example `sidebar.bottom`:
  `/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/`.
- A card name is 1 to 64 characters: a letter or a digit first, then letters,
  digits, `_` and `-`: `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`. A card name is unique
  inside one extension, and a repeat is dropped.
- A card script is a relative path under `ui/`. Each segment holds letters,
  digits, `.`, `_` and `-`, and no segment is `.` or `..`. The path ends in
  `.js` or `.mjs`, and it names an existing regular file whose real path stays
  inside `ui/`. A symlink that leaves `ui/` is dropped.

#### The card on the page

The server fills a slot when it builds the page that opens it: the chat page for
`sidebar.bottom`, and the usage page for `usage.cards`. Each page holds one empty
element per slot it opens,
`<div class="ui-slot" data-ui-slot="NAME"></div>`, and the fill happens on the
page's own route, after the mount prefix and the time zone are stamped and before
the page is sent (see [ui.md](./ui.md#slots)).

For each card of the slot, the server inserts a host element that holds the
card's own shadow root. The root is a declarative shadow root,
`<template shadowrootmode="open">`, so a browser draws the card while it parses
the page. Inside the root, in this order:

1. a `<style>` element with the card's `css`, when `css` is not empty,
2. a `<div data-ui-body>` element with the card's `html`,
3. a module `<script>` element, when the card has a script.

- **Styles are allowed by a nonce.** The `style` element carries a value the
  server makes new for every response, and that response's
  `Content-Security-Policy` names it, as `style-src 'self' 'nonce-<value>'`. The
  `script-src` directive and every other directive stay as they are today. A
  response that renders no card carries today's policy.
- **Theme variables cross the boundary.** The core's CSS custom properties
  inherit into the shadow root, so a card takes the core's colors, spacing and
  fonts. The core's rules do not enter the card, and the card's rules do not
  leave it.
- **The core gives the card no frame.** The core adds no border, no title and no
  padding. The slot stacks its cards with the gap of the sidebar footer, and the
  card host carries `contain: layout paint`, so a card draws inside its own
  place.
- **Every card gets 2 seconds.** The cards of one slot render in parallel, each
  with a 2000 ms timeout, so a slow extension delays the page by at most 2
  seconds.
- **A failure is one line.** A `render` that throws, times out, returns the wrong
  shape, or names a script file that is gone shows
  `<extension>/<card>: failed to load`. Markup that fails the check below shows
  `<extension>/<card>: invalid markup`. The line is text, not markup. A card
  that returned `null` puts nothing in the slot.

A browser that does not read a declarative shadow root gets the same card:
`ui-cards.js` attaches the template for it, and a script inside the template runs
at that moment.

#### Card scripts

A card script is a browser module. It lives under `ui/`, the server serves it
from `GET /ext/<extension>/ui/<file>`, and it loads as
`<script type="module" src="...?v=<mtime>">`, so the browser uses an edited file
after a reload.

- `piSecUi.define("<extension>/<card>", mount)` names the card the script belongs
  to. The page calls `mount(root, api)` once per card host, whatever order the
  script and the card arrive in.
- `root` is the card's shadow root. The script changes it directly, and
  `root.querySelector` finds the elements the extension drew.
- `api.call(action, value)` sends one action and resolves with the answer's
  `value`. When the answer carries `html`, the page replaces the card body with
  it before the promise resolves. A refusal rejects the promise with an Error
  that carries the status.
- `api.on(event, handler)` receives the events the extension publishes for this
  card, and returns the function that stops the subscription.
- A `mount` that throws, or returns a promise that rejects, adds
  `<extension>/<card>: script failed` to the card. The other cards and the page
  go on.

#### Controls without a script

A card needs no script to have controls. An element with a `data-action`
attribute sends that action name:

- `change` on an `input`, `select` or `textarea` sends the control's value. A
  checkbox sends its `checked` state: `true` or `false`.
- `click` on any other element sends the element's `value` attribute, or `null`
  when it has none.

When the answer carries `html`, it replaces the card body. This path is a good
default: the markup comes from the server, the answer is checked like any card
markup, and the extension needs no browser code.

#### The markup check

Before the server puts `render` or `action` markup on a page, it checks the
markup. A refusal draws the `invalid markup` line and logs the reason.

- Elements: `script`, `style`, `template`, `link`, `meta`, `base`, `iframe`,
  `frame`, `frameset`, `object`, `embed` and `form` are refused. A script comes
  from the card's file, and styles come from `css`.
- Attributes: a name that starts with `on` is refused, and so is a `style`
  attribute.
- URLs: `http:`, `https:`, a relative URL, a `#fragment`, and `data:image/` for
  `src` and `srcset` on `img`. A `javascript:` or `vbscript:` value is refused
  whatever the attribute.
- Size: `html` and `css` together stay under 64 KiB of UTF-8.
- CSS: `</style` in any case and `<!--` are refused, so the style element cannot
  be closed early.
- The server parses the html and writes it again from the parse tree. An
  unclosed tag, a comment, or a `</template>` in the text therefore stays inside
  the card.
- The check covers server-side markup only. The browser still blocks inline
  script and event attributes, and a script that changes the card afterwards is
  outside the check.

#### Events: `publish` and `ui_event`

`start` receives `publish(card, event, value)` and keeps it. The extension calls
it when something the card shows has changed, for example after a tool ran.

- `card` is one of the extension's registered cards. The core adds the extension
  name, so an extension cannot publish under another name.
- `event` is 1 to 64 characters: a letter or a digit first, then letters, digits,
  `_`, `.`, `:` and `-`.
- `value` is any JSON value up to 16 KiB of UTF-8. `undefined` arrives as `null`.
  A function, a symbol or a bigint is refused, and so is a value that does not
  serialize.
- The event leaves the daemon on the conversation stream as `ui_event` (see
  [http-api.md](./http-api.md#extension-cards)), and every open chat page
  receives it. The page hands it to the card of that extension and name only.
- **A page with no conversation stream hears nothing.** `ui_event` travels on a
  conversation's stream, so a card in `usage.cards` never receives one: the usage
  page opens no stream. Such a card draws at page load from its `render`, and it
  changes through the answer of its own control (`api.call`). A card that must
  follow something live belongs in `sidebar.bottom`.
- A reload or a removed directory closes the `publish` an older module instance
  holds. A call on a closed function is dropped without a word.
- A refused event is dropped with one diagnostic line, and the extension keeps
  running.

**An event is a notification, not a state.** A closed page misses every event,
and so does a page whose stream was down longer than 60 s (`server.sse.bufferMs`,
60 s by default). A reconnect can also deliver one event twice, because the
server resends recent events. A handler must be idempotent for that reason:
write the value it receives instead of adding to what it has. The real state of
the card comes from `render` at page load and from the answer of `api.call`.

#### The call API

`POST /api/ui/call` is the one route a card uses to reach its extension (see
[http-api.md](./http-api.md#extension-cards)). The body is
`{ extension, card, action, value }`.

- The request passes the `Origin` check that every write route gets, so a page
  of another site cannot send one.
- `Content-Type` must be `application/json`. The body has the cap of every other
  request (`server.maxBodyBytes`).
- An action needs a registered card and an extension that exports `action`.
  Otherwise the answer is `404`.
- The action gets 10 seconds. A timeout is `504`, and a throw or a bad result is
  `500`. The daemon keeps running either way.
- **Check every action name and every value you receive.** The card is not the
  only possible sender: a script, a `curl` call, or another program on the
  machine can post the same body. Treat `action` and `value` as input from
  outside, and refuse what you did not expect.

#### Files under `ui/`

`GET /ext/<extension>/ui/<file>` serves the card scripts and the other files of
a registered extension's `ui/` directory. It sits under the mount prefix like
every other route.

- Only files under `ui/` are served: `.js`, `.mjs`, `.css`, `.svg`, `.png`.
- A path traversal, a `\` or a NUL byte in a segment, and a symlink that
  resolves outside `ui/` are refused. Anything else that does not name a regular
  file inside `ui/` is a `404`.
- The headers are the ones of the static files: `Content-Type` by extension,
  `Content-Length`, `X-Content-Type-Options: nosniff`, and
  `Cache-Control: no-cache`.

**Anyone who can reach the server can read `ui/`.** This server has no login, so
a file in `ui/` is as public as the chat page. Never put a secret or personal
data in `ui/`. A secret belongs in `~/.pi/sec/secrets/<name>`, and the server
side of the extension reads it from there.

#### Safety: a card script runs with the user's rights

A card script runs in the user's page with every right that page has. It can read
the conversation from the routes the page calls, send a message, send a report
approval, and call an admin route. The `Origin` check does not stop it, because
its requests come from the page's own origin. Shadow DOM and
`contain: layout paint` separate how a card looks, not what it can do, and a
script can change elements outside its own card.

So installing an extension that exports `ui` gives that extension every right
the user has in pi-sec. The extension's server code already gets that trust,
because it runs inside the daemon process, and a card script adds a second way
to use it: inside the page the user watches. Read the code before you install an
extension, and keep the rule that no extension changes without approval. The
code does not enforce that rule.

The markup check does not cover a script. When a card shows text from outside,
such as an answer from the internet, escape it on the server or set it with
`textContent` in the script. Never build markup around text you did not write.

#### Example: a switch card with a script

An extension with one card in `sidebar.bottom`. The card has a button, and its
script sends one action and listens for one event.

```js
// ~/.pi/sec/extensions/demo-cards/index.js
export const name = "demo-cards";

export const ui = {
  cards: [{ slot: "sidebar.bottom", name: "switch", script: "switch.js" }],

  // Called on every page load. Return null to draw nothing this time.
  render({ config }) {
    const on = config.enabled === true;
    return {
      html:
        `<button type="button">${on ? "Turn off" : "Turn on"}</button>` +
        `<p data-calls>0 calls</p>`,
      css: "button { width: 100%; } p { margin: 0; }",
    };
  },

  // Called by POST /api/ui/call. Check what arrived.
  action({ action, value, config }) {
    if (action !== "start" && action !== "stop") return undefined;
    // Store the new state where this extension keeps its own state.
    return { value: { on: action === "start" } };
  },

  // Called once, after the cards are registered.
  start({ publish, config }) {
    // Keep `publish` and call it when the card has news, for example after a
    // tool call: publish("switch", "usage", { calls: 12 }).
  },
};
```

```js
// ~/.pi/sec/extensions/demo-cards/ui/switch.js
window.piSecUi.define("demo-cards/switch", function (root, api) {
  var button = root.querySelector("button");
  var calls = root.querySelector("[data-calls]");

  button.addEventListener("click", function () {
    var action = button.textContent === "Turn off" ? "stop" : "start";
    api.call(action, null).then(
      function (value) {
        button.textContent = value.on === true ? "Turn off" : "Turn on";
      },
      function () {
        // The call failed. The card keeps the state it shows.
      },
    );
  });

  // An event can arrive twice, so write the number rather than add to it.
  api.on("usage", function (value) {
    if (calls !== null && typeof value.calls === "number") {
      calls.textContent = value.calls + " calls";
    }
  });
});
```

### Pages: the `pages` export <a id="ext-pages"></a>

A runtime extension can show its own web pages under `/ext/<name>/`, where
`<name>` is the extension's directory name. The `ext` prefix is a namespace: the
core never serves a page of its own there, so an extension page cannot collide
with a core path. A page needs no restart. It answers as soon as the extension
loads, as a card does.

```js
export const pages = {
  // Required. One entry per page.
  entries: [
    { page: "", label: "Host status", menu: true, script: "app.js", style: "app.css" },
    { page: "history", label: "History" },
  ],
  // Required. Draws the body of one page. Returns { title?, html, css? }, or null for a 404.
  render({ page, query, config, timezone }) { /* ... */ },
  // Optional. Answers /ext/<name>/api/<path>. Returns { status?, json? }.
  api({ method, path, query, body, config, timezone }) { /* ... */ },
};
```

An extension that exports `pages` still exports an extension for the loader, as
every runtime extension does: a `create` function, or a default export. `pages`
is separate from `ui` on purpose. `ui` needs a `render` and `cards` with card
rules, and a page-only extension would fail that shape check.

#### Registration rules

- `page` is the page name. The empty string is the index page at `/ext/<name>/`.
  Any other name matches `^[a-z0-9][a-z0-9-]{0,63}$` and answers at
  `/ext/<name>/<page>`. A page has one path segment.
- The names `ui` and `api` are reserved, because the core serves those two
  sub-paths under every `/ext/<name>/`. The core serves no other path there.
- `label` is the menu text and the fallback for the page title. It is required.
- `menu: true` puts the page in the chat page's Pages menu.
- `script` and `style` name files under the extension's `ui/` directory. The rules
  are the card script rules (see "Card scripts"): plain path segments, no `.` or
  `..`, and a regular file whose real path stays inside the real `ui/` directory.
  `script` ends in `.js` or `.mjs`. `style` ends in `.css`.
- A bad entry is dropped alone with one diagnostic line. A `pages` value of the
  wrong shape keeps no page and reports one error. The registry keeps the newest
  20 lines.
- An extension name outside `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` cannot be a URL
  segment, so it registers no page and gets one error.
- `GET /api/admin/status` shows `pages: { pages, errors }` for each runtime
  extension that exports `pages`. The index page appears as `/`.

#### What the callbacks get

`render` receives `page`, `query` (the query string as an object of strings, the
first value of a repeated key), `config` (the extension's validated config
value) and `timezone`. `api` receives `method` (`GET`, `POST`, `PUT`, `PATCH` or
`DELETE`), `path` (the rest after `api/`), `query`, `body` (the parsed JSON body,
or `undefined`), `config` and `timezone`. Neither gets a request object or a core
context, as card callbacks get none. This keeps the interface small and easy to
test. It is not a security measure.

`render` returns `{ title?, html, css? }`. `title` sets the document title, and
the page title is `<title or label> · pi-sec`. `css` is optional style text, which
the core puts into a `<style>` element with a nonce, as it does for a card.
`api` returns `{ status?, json? }`. The status defaults to 200 and must be an
integer from 200 to 599. A thrown error answers 500 with no detail, and the
reason goes to the log.

#### The page document

The core builds the document and the extension supplies the body. The core writes
the head: the mount prefix, the time zone and the shared theme stamps, the core
theme, a small base style for the body font and colors, and the core policy. The
page then holds the extension's html, the declared stylesheet link (after the
core styles), the `render` css, and the declared script as a module, with
`?v=<mtime>` on each file URL. The extension needs to know neither the mount
prefix nor the theme. The core `styles.css` is not loaded, so no core selector
reaches the extension's markup.

The core adds `window.piSecPage` before the extension's script runs:
`extension`, `page`, `base`, `apiUrl(path)`, and `fetch(path, init)`. `fetch`
builds `<base>/ext/<name>/api/<path>`, sets `Content-Type: application/json` when
a body is given (an object body is sent as JSON), and calls the ordinary
`fetch`. A script can call `fetch` itself with the same URL.

The response carries `Cache-Control: no-cache`, `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer` and the core policy. The policy has a style nonce
only when `render` returned css. The card markup check does not run on page html:
a page is its own document and the policy already stops inline scripts.

#### The api

`/ext/<name>/api/<path>` accepts `GET`, `POST`, `PUT`, `PATCH` and `DELETE`. A
request with a body must send `Content-Type: application/json`, or the route
answers 415. The global `Origin` check runs first for every method except `GET`
and `HEAD`, so a page on another site cannot write.

An `api` GET must not change state, because the `Origin` check does not apply to
`GET`. The code cannot enforce this rule. A page on another site can send a GET
to the api, but it cannot read the answer.

#### Limits

| What | Limit | Answer over the limit |
|------|-------|-----------------------|
| `render` time | 5 seconds | 504, a core error page |
| `api` time | 10 seconds | 504 |
| Page body (html plus css) | 2 MiB | 500, a core error page, one log line |
| `api` answer | 4 MiB | 500, one log line |

A `render` that throws answers a core error page with 500. A `render` that
returns `null`, an unknown page, an unknown extension and a path with more than
one segment answer the same 404. A callback that has started finishes on the
module it started on, even when a reload replaces the module meanwhile.

#### Limits for page authors

The core policy forbids inline code, so an extension page has these limits:

- No inline `<script>` element, no event handler attribute such as `onclick`, and
  no `javascript:` URL. Put code in the declared script file and attach handlers
  with `addEventListener`.
- No `eval`, no `new Function`, and no string argument to `setTimeout`.
- No `style` attribute and no `<style>` element in the html. Put style in the
  declared style file or in the `css` field of `render`.
- Server data reaches the script through `data-` attributes, a
  `<script type="application/json">` data block (the browser parses it and never
  runs it), or a call to the extension's api.
- No image, script, style or font from another site, and no `fetch` to another
  site. Copy a library into `ui/` and import it from there. The extension's
  server code can fetch a remote image and serve it through the api, or embed it
  as `data:`.
- The file route serves only `.js`, `.mjs`, `.css`, `.svg` and `.png` (see
  "Files under `ui/`"). Other file types, such as fonts and JSON files, go
  through the api.

#### Load, reload and unload

- Load: a module with a valid `pages` export answers at once. Its menu links
  appear the next time the menu opens.
- Reload: a changed file reloads the extension after 250 ms. The new registration
  replaces the old one, and the next request renders with the new module.
- Failed reload: when the module does not import or `create` throws, the previous
  pages keep answering and the diagnostics record the error.
- Removed export: the pages answer 404 after the next load pass. The file route
  keeps answering only if the extension still holds cards.
- Removed directory: the pages, the api, the files and the menu links answer 404
  or disappear after the next load pass.

#### Safety: a page runs with the user's rights

The extension is inside the security boundary. Its server code runs in the daemon
process with the daemon's rights, and its page script runs in a same-origin page
with the user's rights. It can read conversations, send messages, send approvals
and call admin routes, as a card script can. The protection is the rule that no
extension is installed or changed without the user's approval. The code does not
enforce that rule.

The core policy keeps scripts hidden in outside text, such as a Slack message or a
Notion page that a page shows, from running. It does not limit the extension's own
script, which is a file on this origin. It does not stop a deceptive link or a
formatted passage either. Escape outside text on the server, or set it with
`textContent` in the script. See [security.md](./security.md#extension-pages).

#### Example: `host-status`

The example is read-only and uses no secrets. It reads `node:os` and `process`
only. The index page shows the host's uptime, the load averages, the free and total
memory, and the daemon's uptime. `GET /ext/host-status/api/status` answers the same
values as JSON, and a Refresh button calls it through `piSecPage.fetch`. The files
live in `test/fixtures/extensions/host-status/`, and the loader, route and browser
tests load them from there, so the example cannot drift from the code. To try it,
copy the directory to `~/.pi/sec/extensions/host-status/`.

`index.js`:

```js
// An example runtime extension that draws a web page: the host's uptime, load and
// memory. It is read-only, uses no secrets, and reads `node:os` and `process` only.
//
// Copy this directory to `~/.pi/sec/extensions/host-status/`. The page answers at
// `/ext/host-status/` as soon as the daemon loads it.
import os from "node:os";

export const name = "host-status";

export function create() {
  return { name: "host-status" };
}

/** The values the page and its api show. */
function status() {
  return {
    hostUptimeSeconds: Math.round(os.uptime()),
    load: os.loadavg().map((value) => Math.round(value * 100) / 100),
    freeMemoryBytes: os.freemem(),
    totalMemoryBytes: os.totalmem(),
    daemonUptimeSeconds: Math.round(process.uptime()),
  };
}

const escapeHtml = (value) =>
  String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** One table row. The script updates the cell with the same `data-field`. */
const row = (label, field, value) =>
  `<tr><th scope="row">${escapeHtml(label)}</th><td data-field="${field}">${escapeHtml(value)}</td></tr>`;

const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

export const pages = {
  entries: [{ page: "", label: "Host status", menu: true, script: "app.js", style: "app.css" }],

  render() {
    const now = status();
    return {
      title: "Host status",
      html:
        `<main class="host-status">` +
        `<h1>Host status</h1>` +
        `<table>` +
        row("Host uptime (s)", "hostUptimeSeconds", now.hostUptimeSeconds) +
        row("Load (1, 5, 15 min)", "load", now.load.join(", ")) +
        row("Free memory", "freeMemoryBytes", gib(now.freeMemoryBytes)) +
        row("Total memory", "totalMemoryBytes", gib(now.totalMemoryBytes)) +
        row("Daemon uptime (s)", "daemonUptimeSeconds", now.daemonUptimeSeconds) +
        `</table>` +
        `<button id="refresh" type="button">Refresh</button>` +
        `</main>`,
    };
  },

  api({ method, path }) {
    if (method === "GET" && path === "status") return { json: status() };
    return { status: 404, json: { error: "not found" } };
  },
};
```

`ui/app.js`:

```js
// The page script: a Refresh button that reads the extension's api and updates
// the table. It is a file on this origin, so the page policy lets it run.
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GiB`;

function show(values) {
  const text = {
    hostUptimeSeconds: String(values.hostUptimeSeconds),
    load: values.load.join(", "),
    freeMemoryBytes: gib(values.freeMemoryBytes),
    totalMemoryBytes: gib(values.totalMemoryBytes),
    daemonUptimeSeconds: String(values.daemonUptimeSeconds),
  };
  for (const [field, value] of Object.entries(text)) {
    const cell = document.querySelector(`[data-field="${field}"]`);
    if (cell !== null) cell.textContent = value;
  }
}

document.getElementById("refresh")?.addEventListener("click", async () => {
  const response = await window.piSecPage.fetch("status");
  if (response.ok) show(await response.json());
});
```

`ui/app.css`:

```css
.host-status table {
  border-collapse: collapse;
  margin: 1rem 0;
}

.host-status th,
.host-status td {
  padding: 0.25rem 0.75rem;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
```

---

## 5. Bundled extension catalog <a id="bundled-extension-catalog"></a>

<a id="scheduler"></a>
| Extension | Tools / behavior | Milestone |
|-----------|------------------|-----------|
| `coding` | `CodingTools` (`read`, `write`, `edit`, `bash`) from `@earendil-works/pi-durable/tools`; planning-oriented sections. Shell output is cut at 2000 characters per line after redaction, and the marker `[line cut: n more characters]` gives the number removed. A file that holds the full output keeps the uncut text. The extension also replaces the time marker on save; see [the marker](#now-marker). A file write and a shell never overlap in one conversation, and the two file tools write through a rename; see [writes beside a shell](#write-guard). | M2 |
| `secrets` | Installs the one-way redaction boundary (`GenerationTask`/`ToolTask` hooks + env wrapper) and a system-prompt section. See [secrets.md](./secrets.md). | M2 |
| `attachment-context` | No tools. A `beforeRequest` hook turns the references a message already carries into `image` parts: the `attachments` attribute of a user envelope, and a markdown image URL (`/api/attachments/<id>`, `/api/share/<name>`) in any message. The store keeps the reference and the base64 exists only in the request that needs it, so a turn is byte-identical when it is built twice. What the hook injects is not written to the transcript. Registered directly after `secrets`, because redaction must see the request text before this hook adds image bytes the user never typed. | — |
| `jobs` | `jobs_list` (tree), `jobs_get`, `jobs_create`/`update`/`cancel`; durable job records with a status lifecycle, parent/child only, labels, memory anchors, state dir, and conversation/task links. | M3 |
| `registry` | `repos_list`: one read-only tool over the git repositories, worktrees and buildfs caches of the registry, returning the same listing as `repos list --json`. It has no section and no hook. Installed in the app phase, because the listing reads a worktree's job title and status from the job store the extension context holds. In the default enabled list. See [The repository registry](#registry-tool). | — |
| `scheduler` | Durable cron, read from the job record: a job with `routine` recurs and a job with `once` runs one time, and each due occurrence submits its prompt on a new conversation. The boot migration moves each entry of `config.scheduler.jobs` onto a record's `routine` and empties the list, and the list is not a schedule after that. A routine is created, changed, and removed only through the routine gate. Timezone/catch-up/overlap semantics in [architecture.md](./architecture.md#scheduling). | M3 |
| `reports` | `reports_create`/`add_version`/`set_pending`/`move`/`list`/`get`; long documents owned by a job, with an append-only revision history and a viewer at `/report/<slug>`. `move` hands a live report to another live job and changes nothing else about it: the revisions, the approvals inside them, the feedback, the name and the title stay, and the drafts of the old job stay with that job. It refuses a report that is not live, including one that has moved to the archive, a report whose job has ended, a job the live store does not have, a job that has ended, and a report that already belongs to the job named; a refusal writes nothing, and a successful move leaves a `report_moved` audit row naming the report and both jobs. Only the root has it, so a subagent and a scheduled run cannot reach it. `set_pending` moves a live report between its open standing, `active` for a plan and `result` for a result report, and `pending`. Bringing a report back with an `answer` is the message form of an answer to user feedback, and that one call clears the flag and writes the inbox notice for that answer in the same commit. A report that waits on an answer to feedback cannot come back without one (`answer_required`), a report that is not waiting on one is refused when an `answer` is given (`not_awaiting`), a report whose job has ended is refused as `not_active`, and a result report that still waits for the user's Done or Feedback cannot be set aside at all (`needs_user_check`). `list` marks a report that is set aside while its newest entry is user feedback as `unanswered`; both forms of answer clear the mark, and a report that an approval set aside carries none. The draft flow rides on top: a subagent writes a temporary draft with `reports_draft` (and drops one nobody will use with `reports_draft_drop`), the root reads it by id with `reports_get`, and `reports_publish_draft` turns it into a report without the text passing through the chat. `reports_draft` takes the text as `content` or reads it from a markdown file named with `path`, exactly one of the two, and a file over the size cap of `read_full` or one it cannot read is refused with nothing written. Both `reports_draft` and `report_check` declare the execution mode `sequential`, so a bundle that holds either tool runs its calls one at a time in the order they are written, and a call that follows an edit of the same file reads the text the edit wrote. A report has one of three kinds, and the tools carry it: `reports_draft` and `reports_create` take `kind`, though a draft cannot name `briefing` because the root writes a briefing report itself with `reports_create`; `reports_publish_draft` takes it for a new report and refuses it next to `reportId` because a revision keeps its report's kind, and it refuses `briefing` as well; the listing marks a result report with `kind=result` and a briefing with `kind=briefing`. A briefing report asks for no approval, so it stays under a gate that asks for one (`report_is_briefing`), cannot be set aside (`briefing`), and a newer briefing moves it, with the notices that point at it and the items of kind `briefing`, into the archive database. A draft belongs to a job rather than to the session that wrote it: `reports_draft` requires `jobId`, and the tool refuses a call without one and a call that names a job that is neither the caller's own assigned job nor a job below it in the job tree. An agent that holds a top-level job therefore drafts the plans of its subjobs too. Deleting the draft's author leaves the draft in that job, and `reports_publish_draft` publishes it into that job and no other. The draft is open work of its job, which `jobs_get` and `reports_list` show, and it is dropped when the job ends. With `reportId`, `reports_publish_draft` makes the draft the next revision of an existing live report of the draft's own job instead of a new report. That write leaves the same inbox notice and `report_updated` event that `reports_add_version` leaves, and `title` and `name` are refused with it, because a revision keeps the report's own. A draft records the sha256 of its text when it is written, and both forms of publishing refuse a draft whose file no longer holds that text: the fix is a new draft. A draft row written before the field existed carries no sha256 and is not checked. | — |
| `attachments` | Five tools. `share_page` stores one HTML page that the user can open and use (a chart, an interactive demo, a small app), from a string or a file of up to 1 MiB, and returns the id, the `/rich-pages/<id>` URL and a markdown image tag that draws the page in a sandboxed frame (see [Rich pages](#rich-pages)). `share_image` puts a file under `attachments.shareDir` and returns the `/api/share/<name>` URL and the markdown that shows it, so an agent can put an image where its own words need one. The URL is mount-prefixed (it carries the deployment's path prefix when `server.basePath` is set), so use the URL the tool returns and do not rebuild the path. `attachment_open` reads a stored file back as an `image` part, which is how an original is shown again after a compaction removed the text that named it. `attachments_list` names the files of a conversation or a job. `attachments_assign` gives unowned files to a job and is the root's alone: a file with a job is kept after the job is archived, and a file with no job is deleted at the first daemon start 24 hours after it was stored. | — |
| `ask-user` | `ask_user` (fixed choices, returns at once while the question waits in the active list), `questions_open`, `question_withdraw`. The answer arrives as input from the user. `ask_user` is never a background call: it returns at once, so it carries no `complex` tag and `async_call` refuses it. See [http-api.md](./http-api.md#user-queries). | M3 |
| `web` | `fetch_url`; HTML→text; fetched content is external and untrusted. It reads at most 200,000 bytes of the body (the rest of the stream is cancelled), stops after 60 seconds, and ends at once when the tool call is cancelled. It is declared `replay: "unsafe"`, so a call that a daemon restart interrupted is reported as interrupted and is not sent again. | M3 |
| `expiry-check` | `expiry_check`: reads a JSON expiry registry that the user keeps and reports the entries inside their warning window, measured in the harness timezone. Read-only, no section, no secret. Not in the default enabled list: add the name to `agent.extensions.enabled` once a registry exists. | — |
| `notify` | Writes `sec.inbox` notification items (and SSE notices). Given a `reportId`, the item becomes a report notice that opens that report in the chat panel, and no revision is written. | M3 |
| `self-edit` | `self_edit`, `reload_extensions`, `request_restart`, `withdraw_restart`; validation gate; records `sec.candidate` entries for gated changes; promotes a runtime extension to core only with user confirmation; audit. `self_edit` writes only inside `code.workspace`: it resolves real paths and refuses a path whose real location is outside the tree, so a symbolic link that leaves the tree is not followed. A call without `kind` counts as a core change. `request_restart` takes a `reportId` and checks it with the routine gate's rule: the report is live, its job has not ended, and the approval names the sha256 of the newest revision. A report archived with its finished job is refused, so a core change cannot be landed without the user's consent to that change. When a child conversation is still working, it sends that child a safe-point note and waits instead of refusing; the argument `allowBusyReason` skips that check with a recorded reason. See [Safe point before the gate](#safe-point). | M4 |
| `usage` | The `usage` tool, reporting `pi.usage` totals for the session. Deliberately no section: the totals move on every request, and a section that returns a different value each time rewrites the head of the request and loses the provider prefix cache. See `test/agent-and-focused-chats.test.ts`. | M3 |
| `usage-freeze` | No tools and no section. A provider that refuses a model request for usage (HTTP 429) leaves the run settled `unanswered` and the agent record claiming to be `running`; this extension writes a state that answers that (`held`), keeps the conversation from calling the model while it is held, and sends it again once the provider accepts a request. Recovery is two steps: the provider's own usage numbers say the window has room, and then one short model request to the same provider and model proves it. One such request per provider per ten minutes, counted from the last attempt and stored, so a restart cannot shorten it and ten held conversations cost one request. An input to a held conversation is written to the transcript and starts no run, so the retry after a recovery carries it in the order it arrived. Every provider is covered, including the ones whose usage this server cannot read: those skip the first step and are checked by the short request from the first pass. The hold is `sec.usageHold`, one per conversation, and the probe clock is `sec.usageProbe`, one per provider; neither is a field of `sec.agent`, so a rollback reads the records it knows and never ends the holds. The banner draws `usageHold` from `GET /api/admin/status` (see [http-api.md](./http-api.md)). Audit rows: `usage_held`, `usage_probed`, `usage_retried`, `usage_resumed`. In the default enabled list. See [Held conversations](#usage-freeze-holds). | — |
| `session-restart` | `restart_session`, `restart_cascade_start`, `restart_cascade_status` and `restart_cascade_close`, and the `session-restart` section that explains them. An agent resets its own conversation with `restart_session` so that it reads a changed prompt; a parent opens a round, counts its children's resets, and closes the round. A restart with no `roundId` is the agent's own, taken because its context grew long: the ledger records the request and opens no round. The extension also reads the size of every answer's request, and a conversation that passes `agent.contextRestart.thresholdTokens` gets one restart advice on its next input. A root or an orchestrator that has been quiet for `agent.contextRestart.idle.minutes` gets a second advice while it rests, without waiting for an input, and `agent.contextRestart.idle.minTokens` keeps it away from a conversation whose context is too small to gain from a restart. The round ledger is under `state/restart/`. The conventions name these tools. In the default enabled list. | — |
| `sections` | No tools and no section of its own. Seals every other section for the life of a session and writes the notes that record a change. Installed unconditionally, not through `agent.extensions.enabled`. See [Session seal for system-prompt sections](#session-seal). | — |
| `js-tools` | The `js` tool: run JavaScript that can call the other tools as `tools.<name>(args)`. Executes in a QuickJS VM (`@earendil-works/pi-codemode`) inside a worker thread, so a spinning script does not stop the daemon, a deadline terminates it, and its memory is capped. Not a security boundary; a nested call runs on the daemon's thread with the same privileges as any other call. A nested call whose tool cut its output ends with one `[truncated]` line. See [Background calls](#background-calls). | — |
| `async-tools` | `async_call`, `async_cancel`, `background_list`, and the `sec.asyncCall` task. Starts a complex tool as a background task owned by the conversation, delivers its result as user input wrapped in `<pi-message src="tool-output" ...>`, and cancels one call by title. It also wraps every tool so a call that outlives `agent.tools.backgroundAfterMs` moves to the background by itself, and it sends a status check to a running background call every `agent.tools.backgroundCheckMs`. See [Background calls](#background-calls). | — |
| `agent-profile` | No tools. Three sealed sections, `reply-language`, `vmodel` and `roles`, rendering the system-prompt text that belongs to the agent rather than to a tool: the reply language of a conversation that talks with the user, the model's `prompt` file, and the role files of whichever conversation is asking. Reads the conversation's `sec.agent` record and falls back to config, which is the root's case. See [Agent profile](#agent-profile). | — |
| `subagents` | Other agents as parallel conversations: `spawn_subagent`, `send_message`, `send_reply`, `request_message`, `await_orders`, `finish_work`, `subagent_delete`, the discipline hooks that keep a subagent from ending a turn silently, the boot repair that releases finished agents, and the three focused chat tools (`focused_chat_title`, `focused_chat_archive`, `focused_chat_delete`). It installs those three because they act through its hub, and an install whose `agent.extensions.enabled` list was written out by hand would otherwise load no focused chat tool at all. See [Subagents](#subagents) and [Focused chats](#focused-chats). | — |
| `diagnostics` | `diagnose_conversation` joins a conversation's `entries`, `tasks`, `submissions` and `sec.agent` record at read time and reports the last progress time, the silence since then, the live task count, the last task outcome and the last submission reason, with one judgement line per conversation. Read-only: it writes no document and no entry. See [Diagnostics](#diagnostics). | — |
| `lessons` | `lessons_record`/`list`/`get`/`update`/`reword`/`stats`/`scan`/`import`, one session-scoped store of what an agent learned. The store is the `sec.lesson` document family in `state/sec.sqlite`, and a restatement raises a recurrence count instead of writing a row. See [Lessons](#lessons). In the default enabled list. | — |
| `github-pr` | The pull request dashboard under `/github/pr/`, and the API under `/api/github/pr/`. The only bundled extension with a `routes` function of its own (see [Web routes of a bundled extension](#extension-routes)); it defines no tool and no section. It declares one page link, `PRs` at `/github/pr/`, which the chat page's Pages menu draws (see [Page links of a bundled extension](#extension-pages)). Its settings are the top-level `githubPr` key, which holds the panel's repositories, a single write switch, the poll interval and the disk cap. Not in the default enabled list. See [`githubPr`](#github-pr-config). | — |
| `linear` | Seven tools that read a Linear workspace through its GraphQL API, and three tools that write to it: `linear_status`, `linear_search_issues`, `linear_get_issue`, `linear_list_projects`, `linear_get_project`, `linear_list_teams` and `linear_graphql`, then `linear_create_issue`, `linear_update_issue` and `linear_add_comment`. It has no route, no page and no section. A personal API key in a secret is the only credential, and the tool result shows the key as `[linear key]`. Every request passes an operation check that refuses a mutation or a subscription from `linear_graphql`. A write tool needs a `report_id` whose newest revision the user approved and whose text holds a `linear-write:` grant line for the target. It sends no write if one check fails. The three write tools are registered only while `linear.writes` is true at boot, and each call reads that value again. They are removed from scheduled runs and blocked for them and for focused chats by the kind tables. Each write, refused or sent, leaves one audit row. Not in the default enabled list. See [`linear` settings](#linear-config). | — |
| `conventions` | No tools, no hooks. One sealed section, `conventions`: the standing work rules (roles and flow, approval, reports, jobs and state files, evidence, safety, restarts). The text is a constant with two paths filled at render time, `agent.jobDir` and the pi-sec home. In the default enabled list. See [The conventions section](#conventions-section). | — |
| `language-rules` | No tools, no hooks. Three sealed sections, all constants: `simple-english` for every agent, `fluent-korean` for every agent while the personality names Korean, and `agent-language` for a worker and a scheduled run while the personality names Korean. In the default enabled list. See [Personality and language rules](#personality-and-language-rules). | — |
| `personality` | The `personality` section on the root, a focused chat and the orchestrators, a `beforeRequest` hook that offers the design interview on the root's first request, and the tools `personality_get` and `personality_set`. The document is a markdown file with an optional front matter that names the language and the assistant's name. `personality_set` is root-only. In the default enabled list. See [Personality and language rules](#personality-and-language-rules). | — |
| `message-tags` | No tools and no section. A `beforeRequest` hook wraps every user-role message that carries no envelope in `<pi-message src="...">...</pi-message>`, taking the source from an older tag or a first-line marker and `unknown` when there is none. It also escapes an assistant reply whose first line opens a message tag, and while that reply is the newest one it appends one `system` message that says so. The format and the reading rules are `src/message-envelope.ts`. In the default enabled list. See [The message-tags safety net](#message-tags). | — |
| `read-full` | `read_full`: one whole text file in one call, and a file over `readFull.maxBytes` is refused, not cut. Not in the default enabled list. See [`read_full`](#read-full). | — |
| `remote-machines` | The nine tools an agent uses on another computer, and the `remote-machines` section that says when to reach for one: `remote_machines`, `remote_run`, `remote_run_status`, `remote_run_stop`, `remote_read`, `remote_write`, `remote_edit`, `remote_sync` and `remote_level_tighten`. The tools hold no logic of their own: the level check, the run protocol and the sftp and rsync paths are `src/remote/`, and a refusal is passed on as it stands. `remote_run` is declared `replay: "safe"`, because a run id is a digest of the conversation and the tool call and the remote run directory is created once, so a repeat answers the run instead of starting a second one. The core checks a running run every `remoteMachines.runCheckSeconds` and puts a `[remote run check]` message in the conversation that started it. `remote_level_tighten` is root-only in the tool profile and again in the tool. When a machine the user did not switch off stops answering for longer than `remoteMachines.outageSeconds`, the core makes its level `off` by itself and asks nobody first: one commit writes the level, settles the runs that were live as `stranded` and writes one inbox item for the user, and the root then gets one notice that asks for no action. Not in the default enabled list. See [Remote machines](#remote-machines-tools). | — |

### Web routes of a bundled extension <a id="extension-routes"></a>

A bundled extension can answer web paths of its own. The catalog entry in
`src/extensions/index.ts` carries an optional `routes` field, and the server calls
it once, when it starts.

```ts
export type ExtensionRoutes = (context: ExtensionRouteContext) => void | ExtensionRouteCleanup;

export interface ExtensionRouteContext {
  readonly router: Router;
  readonly deps: AppDeps;
  readonly options: unknown;
}

export type ExtensionRouteCleanup = () => void | Promise<void>;
```

The call order is the whole rule:

1. The server registers the paths it names itself, from its fixed list of
   `registerX(router, deps)` calls.
2. It then walks the catalog in catalog order and calls the `routes` function of
   every entry that has one and whose name is in `agent.extensions.enabled`. The
   function receives the router, the shared dependencies that every HTTP route
   reads (`AppDeps`), and the entry of `ServerOptions.extensionRoutes` that
   carries its own name, or `undefined`.
3. A function that returns a function hands back a cleanup. The server calls it
   once, when it closes, which is where a polling timer stops. A cleanup that
   returns a promise is awaited, so `close` answers only after the work it waits
   for has ended; a cleanup that only stops a timer returns nothing and needs no
   wait.
4. An entry the enabled list leaves out is not called at all, so a path it would
   have registered answers `404` like any unknown path.

Two consequences are worth stating. The fixed routes are registered first and the
router returns its first match, so a path the server names itself cannot be taken
over by an extension. And the enabled list is read while the process boots, so
turning an extension's routes on or off is a cold restart, while the values the
extension reads from the config on every request are not.

`ServerOptions.extensionRoutes` is keyed by extension name. The daemon passes no
value for it, so an extension falls back to its real inputs. A test passes the
fake `gh` path, a temporary repository root and a clock there, instead of
replacing a global that the whole process shares. `ServerOptions.catalog`
replaces the catalog itself, which is how the device is tested without the
extension that fills it. It reaches the page links of the next section too, so a
catalog of a test's own decides both what answers and what the menu offers.

A `routes` function that throws is one `error` line and one admin note, and the
boot carries on: the rest of the server answers, and the paths of that extension
answer `404`. `test/extension-routes.test.ts` holds the checks for the order, the
enabled list, the per-extension options and the cleanup.

### Rich pages <a id="rich-pages"></a>

`share_page` (in the bundled `attachments` extension) lets an agent write a page
on demand: a chart, an interactive demo or a small app. The agent passes `title`
and either `html` (one document) or `source` (a file path), and optionally `name`
and `jobId`. The tool refuses both or neither of `html` and `source`, an empty
document, a document over 1 MiB (1048576 bytes), text that is not UTF-8, and a job
that is not live. It stores the page as a share file with a mark on its record
(`richPage`), and answers `id`, `url` (the `/rich-pages/<id>` address with the
configured mount prefix), `markdown`, `bytes` and `ownedBy`. `attachments_list`
shows `richPage: true` on a page. A page cannot change after it is stored. A new
version is a new page.

The agent pastes `markdown` into a chat answer or a report body. The one markdown
renderer draws it as a sandboxed frame with a caption and a link that opens the
page in a new tab ([ui.md](./ui.md#3-transcript-rendering)). The page follows the
share file lifetime rules: see [Lifetime of stored files](./http-api.md#lifetime-of-stored-files).

The page runs isolated. Its scripts run, but it cannot reach pi-sec, the network or
the page around it ([security.md](./security.md#rich-pages)). So a page follows these
rules:

- Put every script, style and image inline. Use `data:` URLs or inline SVG for
  images. A file that the page loads from any address does not load.
- Size the page by its content. A page that uses `100vh` stays at the starting
  height of the frame.
- A link inside the page does not open.
- Write no secret value into a page. The user and anyone who opens the address can
  read it.
- A library can go into the document text, within the 1 MiB limit. A library that
  loads more files at run time does not work.

A small example, a bar chart with a hover readout. The agent calls `share_page`
with `title: "Weekly tool calls"` and this text as `html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Weekly tool calls</title>
<style>
  body { font: 14px system-ui, sans-serif; margin: 12px; color: #222; }
  .bar { fill: #4a7bd0; }
  .bar:hover { fill: #2b5bb0; }
  #readout { min-height: 1.4em; margin-top: 6px; }
</style>
</head>
<body>
<h3>Tool calls per day</h3>
<svg id="chart" width="100%" height="180" viewBox="0 0 350 180" role="img" aria-label="Bar chart of tool calls per day"></svg>
<div id="readout">Point at a bar.</div>
<script>
  const data = [["Mon", 12], ["Tue", 30], ["Wed", 22], ["Thu", 41], ["Fri", 18], ["Sat", 7], ["Sun", 9]];
  const svg = document.getElementById("chart");
  const readout = document.getElementById("readout");
  const max = Math.max(...data.map((d) => d[1]));
  const ns = "http://www.w3.org/2000/svg";
  data.forEach(([day, value], i) => {
    const h = (value / max) * 140;
    const bar = document.createElementNS(ns, "rect");
    bar.setAttribute("class", "bar");
    bar.setAttribute("x", String(10 + i * 48));
    bar.setAttribute("y", String(150 - h));
    bar.setAttribute("width", "36");
    bar.setAttribute("height", String(h));
    bar.addEventListener("mouseenter", () => { readout.textContent = day + ": " + value + " calls"; });
    svg.appendChild(bar);
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", String(28 + i * 48));
    label.setAttribute("y", "170");
    label.setAttribute("text-anchor", "middle");
    label.textContent = day;
    svg.appendChild(label);
  });
</script>
</body>
</html>
```

The same text is `test/fixtures/rich-page-example.html`, which the browser test
`test/browser/rich-pages.browser.ts` uses.

### Page links of a bundled extension <a id="extension-pages"></a>

A catalog entry can also state the pages it serves, and the chat page's Pages
menu draws one entry per page link:

```ts
export interface ExtensionPageLink {
  readonly label: string;
  readonly path: string;
}

// on BundledExtension
readonly pages?: readonly ExtensionPageLink[];
```

The rule is the same one `routes` follows, and the list is read at the same
moment. When the server starts, it reads the `pages` of every entry whose name is
in `agent.extensions.enabled`, in catalog order, and keeps that list. Every chat
page it serves then carries the list as a JSON data block,
`<script type="application/json" id="pages-links">`. The menu draws its own three
links first (`Reports`, `Usage`, `Chats`) and then the block, each with the mount
prefix the page was served at and each in a new tab. A link appears exactly while
the routes it names answer, because one read of the enabled list at boot decides
both, and a later config read cannot change one without the other. Turning an
extension on or off is a cold restart, as it is for its routes.

`path` is absolute and carries no mount prefix: the page builds the address with
the mount it was served at. An entry whose label is empty after trimming, or
whose path does not start with `/`, is dropped and written as one `warn` line,
`extension page link dropped`, naming the extension, the label and the path. The
line is written once per boot, when the list is read. A dropped entry never
reaches the page, so the page has no rule of its own.

Runtime extensions add links too, and they follow a different rule. An extension
that exports `pages` (see [Pages: the `pages` export](#ext-pages)) can set
`menu: true` on a page. The server builds the list on every page load: the bundled
links first, then the runtime links sorted by extension name and then by declared
order, each as `/ext/<name>/<page>`. One function, `pageLinks` in
`src/server/routes/basic-chat.ts`, builds the list for the data block and for
`GET /api/ui/page-links`. The menu reads that route each time it opens and keeps
the list from the block when the read fails, so a page added after the chat page
loaded appears the next time the menu opens, without a reload. Bundled links keep
the boot rule above.

A page with no block, or with one it cannot read, draws the three links it always
had. `test/pages-links.test.ts` holds the server side of the device, and
`test/ui/chat-page-pages-links.test.ts` holds the menu's reading of it.

### The `[[pi-sec:now]]` marker <a id="now-marker"></a>

An agent that writes a time into a note does not read the clock for it. It writes
`[[pi-sec:now]]`, and the harness puts the instant of the save there. A clock read
a turn earlier, or copied from the wrong line, is a wrong time in a document that
nobody checks.

The rule has three conditions, and all of them must hold:

- The tool is `write` or `edit`. A `js` script that calls either one counts as
  well.
- The path ends with `.md`.
- The resolved path is outside the workspace tree and outside the snapshot tree.
  A relative path resolves against the agent's working directory, which is the
  workspace tree, so a relative path is never changed.

`write` replaces in the whole `content`. `edit` replaces only in
`edits[].newText`, because `oldText` is matched against the file as it stands, and
a replacement there would change the text the call has to find. The replacement
is the minute form with the zone offset: `2030-01-15 16:30 +00:00`.

A call that replaced at least one marker appends one line to its result:
`Replaced [[pi-sec:now]] 2 times with 2030-01-15 16:30 +00:00.` A call that
replaced none changes nothing.

A backslash right before the marker keeps it as text. Markdown renders
`\[[pi-sec:now]]` as `[[pi-sec:now]]`, so a note that explains the marker writes
the backslash, and the saved file keeps it.

The rule does not cover a file that `bash` writes, and it does not cover text that
a tool other than a file tool saves, such as a report draft. The rule is
`src/now-marker.ts`. `coding` installs it as a `ToolTask` hook, which is what a
direct call runs, and `js-tools` applies the same rule to the arguments of a
nested `write` or `edit`, because a nested call runs no hook. See
[the `js` tool's limits](#js-tool-limits).

### Writes that run beside a shell <a id="write-guard"></a>

One response can list several tool calls, and the harness runs them at the same
time. Two of them can reach one file: `edit` or `write` on one side, and a `bash`
command such as `sed -i` on the other. Neither tool can see what the other wrote,
and a shell command is not something the harness can recognize as a write. So the
`coding` extension guards the three tools that can change a file.

`edit` and `write` take one slot, `bash` takes the other, and the slot belongs to
one conversation. A call of one kind waits for the call of the other kind that
asked earlier; the response order decides who that is. Calls of one kind do not
wait for each other, so two shells still run together, and so do two edits of
different files. A tool that only reads takes no slot and never waits. A call that
fails, throws, or is aborted releases its slot, and a call that moves to the
background stops holding one, so the next response is not held up by a shell that
already left the turn. The slots live in memory and die with the process, and two
conversations never wait for each other.

The slot cannot cover a shell that writes while another shell writes, or a file
that another process writes. It buys one guarantee: in one conversation, a file
write and a shell never run at the same time.

`edit` and `write` also write through a temporary file in the same directory and
a rename, so a reader sees the old bytes or the new ones and never a cut file.
The temporary file carries the permissions of the file it replaces, and a write
that fails removes it. `edit` refuses a file that changed between the read its
`oldText` was matched against and the write, with an error that asks for a fresh
read, and it refuses a result that would leave a non-empty file empty. `write`
with empty content is how a file is emptied on purpose. A call that runs in the
background takes no slot, but the rename and the two refusals also hold for it.

The rules are `src/extensions/write-guard.ts`, and `coding` installs them as tool
wrappers rather than as hooks: no hook runs for a nested call, and a `js` script
that calls `edit` or `bash` changes files exactly like a direct call.

### Session seal for system-prompt sections <a id="session-seal"></a>

A provider caches on the exact token prefix of a request. The system prompt leads
every request, so a section that renders a different value than it did on the
previous request invalidates the whole prompt and the whole transcript. On
the DeepSeek Flash model a cache miss costs 50x a hit, and that model accepts no
system messages mid conversation, so every section it is sent leads the request.

One rule holds for every section, whatever its source:

1. The value a session committed is the value that session keeps. `SectionSeal`
   returns the shown value and never the freshly rendered one, so a change cannot
   reach the head.
2. A change is recorded in the seal and is not written into the history. The
   conversation stays as it was, and the model does not read the new value.
3. The root asks `session_stale` whether a source has moved, and opens the
   restart round at its next milestone on its own judgment, without the user's
   approval. Only the user applies the cold restart, and the `New session`
   button stays the control for a session they start by hand.

A session starts at a fresh conversation, at a reset, and at a compaction. The
harness writes one baseline of every section at that point, and the seal reads
that as the moment to take the sources as they stand.

The wrapper is applied in two places, which together cover every section:
`createBundledExtensions()` for the bundled extensions, and
`ExtensionLoaderOptions.sealSections` for runtime extensions. A runtime extension
is wrapped again on every reload, so `reload_extensions` cannot rewrite the head
of a request either.

### Where text that differs per conversation goes <a id="per-conversation-text"></a>

Sections render in install order: the bundled catalog, then the runtime
extensions. The prompt sections a release ships (in this one, `conventions`, with
`language-rules` and `personality` after it) sit at the end of that catalog, so
only an extension an operator keeps in `~/.pi/sec/extensions` renders after them.
Every agent in this system shares these sections.

That makes a section whose text differs per conversation expensive out of
proportion to its size. It cuts the shared instruction text in two. Every agent
whose text follows the cut stops sharing a prefix with the others, and each of
them pays to read the shared tail again on every request.

So a fact that differs per conversation does not go in a section. It goes in the
conversation's `instructions`, which render after every extension section. The
context file path is the shipped example: it differs per agent, so `spawn_subagent`
writes it into the creating commit and `resolveDefaultConversation` writes it for
the root.

The rule has a condition, because `instructions` are not sealed. Write them once,
at conversation creation, or compare the stored value before writing it. A change
made mid-session rewrites the head of the next request, which is the cost the seal
exists to avoid.

This is a rule for new text. `agent-profile` (`reply-language`, `vmodel`, `roles`)
and `agent-role` were written before it and render per conversation themselves;
they are the reason the shared prefix was already cut before this rule existed.

There is **no `guard` extension** and no command/path pattern policy. Safety is
the OS boundary plus secret isolation plus audit. See
[security.md](./security.md#no-text-rule-guard).

### A section reads the conversation's tool list <a id="section-tool-list"></a>

A section can read the tool list of the request it renders for. `input.agent.tools`
holds the tools the conversation is offered, and `agent.tools` in a tool body holds
the same list. Six sections read it and pick their text by it: `self-edit`,
`session-restart`, `async-tools`, `subagents`, `jobs` and `lessons-count`. The tool
filter is written in the commit that creates the conversation, and nothing rewrites
it. The choice is therefore fixed for the session, and the seal records no change.

Two rules hold for the text those sections pick:

1. When a sentence tells the reader to call a tool, that sentence appears only in a conversation that has the tool.
2. A sentence that names a tool the reader does not have stays only when it also says who has the tool. One example is "Only the root has that tool."

`test/section-tool-list.test.ts` holds the five kinds of conversation to these
rules. It reads the backticked tool names of every section and compares them with
the tool list of the same conversation. A name that a sentence scopes in words is
listed in that test with the reason. A new one needs an edit there, and so a
review.

---

### The conventions section <a id="conventions-section"></a>

`conventions` is a bundled extension with one section, no tool, no hook, and no
settings of its own. It is in the default enabled list, and the section renders
on every request.

The text is the constant in `src/extensions/conventions-text.ts`. It carries the
standing work rules: roles and flow, approval, reports, jobs and state files,
evidence, safety, and restarts. Two placeholders are filled when the section
renders:

| Placeholder | Value |
|-------------|-------|
| `{jobsDir}` | `agent.jobDir` from `config.json`, as an absolute path. |
| `{piSecHome}` | The pi-sec home, the directory `PI_SEC_HOME` names. |

`agent.jobDir` (default `~/job`) is the directory the rules name for a job's
working files, so an orchestrator puts `<slug>/` under it. The value expands
against the run account's home (`$HOME`), not against the pi-sec home: moving
`PI_SEC_HOME` does not move it. An empty value means `~/job`, and a relative
value resolves against the process working directory.

The rendered text changes only when one of the two values changes. A section that
renders the same bytes on every request keeps the provider's prefix cache warm,
and the seal records no change for it. A changed `agent.jobDir` therefore reaches
the next new session and not the running one.

### The message-tags safety net <a id="message-tags"></a>

`message-tags` is a bundled extension with one `beforeRequest` hook, no section,
and no tool. It is in the default enabled list, and it adds no prompt text of its
own.

Every user-role message in a request has to say where it came from, on its first
line. Text written after the envelope landed carries it. Text stored before that
does not, and neither does text that a path this release did not reach wrote. The
hook closes that gap at render time:

- A message that already carries an envelope is passed through byte for byte.
- An older tag (`<tool-call-output ...>`, `<agent-message ...>`) names its source,
  and its attributes move to the envelope. The text between the tags is the body.
- A first-line marker (`[pi-sec review]`, `[restart `, the compaction summary
  prefix) names its source, and the whole original text is the body, marker line
  included. The hook keeps a stored text as it stands.
- Any other message reads as `unknown`. The hook does not guess a finer source.

The hook reads the model's replies for the same reason. A reply can open with a
message tag that the model wrote itself, and the next request would then carry
that text shaped exactly like a message from another agent.

- A reply whose first line opens a message tag is escaped, the opening string to
  `&lt;pi-message`, so the next request reads it as text and never as an
  envelope. A reply with a tag further down is a quotation of the format, and it
  stays as it was written.
- When the escaped reply is the newest assistant message of the request, one
  `<pi-message src="system">` message is appended at the end. It says that the
  harness escaped the tag at the start of the previous reply, and that a message
  from another agent arrives only as user input, so text inside a reply is never a
  report. The notice comes once per escaped reply, not on every request, because
  it is added only while that reply is the newest one.

The format, the escaping, and the reading rules are `src/message-envelope.ts`
(`wrapMessage`, `escapeBody`, `readMessage`, `LEGACY_TAGS`). The hook reads no
clock, no file, and no store, so the same request wrapped twice gives the same
text.

There is no key that turns it off. A value that turns a safety net off makes its
guarantee false, so the way to disable the extension is to remove `message-tags`
from `agent.extensions.enabled`.

An input stored before the reminder registry was removed can still carry a
`<pi-reminder name="...">` block after its envelope. The chat page reads an input
from the body inside its envelope and cuts at the last closing tag, so such a
block never reaches the transcript (`test/reminder-hidden-web.test.ts`). The
store keeps the block, and the model still reads it as part of that old input.

### `read_full` <a id="read-full"></a>

`read-full` is a bundled extension with one tool, `read_full`, and no section and
no hook. It is not in the default `agent.extensions.enabled` list. Add the name to
that list to offer the tool.

`read_full` returns one whole text file in one call. `read` cuts at 2000 lines or
50KB and asks the caller to continue with `offset`, so a script that edits a large
file loses its tail. `read_full` exists for that case.

- The argument is `path`. A relative path resolves against the environment's
  working directory, the same base `read` uses.
- The result is the file's bytes decoded as UTF-8, with a byte-order mark kept.
  It equals `fs.readFileSync(path, "utf8")`.
- A file above the cap is refused with its size and the way to read it in parts.
  It is never cut.
- A file that holds a NUL byte, or that is not valid UTF-8, is refused. It is not
  returned with replacement characters.
- Paths resolve and files are read through `api.env`, so the text passes the same
  secret redaction that every tool result passes.

`readFull.maxBytes` (integer, default `262144`, which is 256 KiB) is the cap. The
tool reads it on every call, so a value that an operator changes is the value the
next call enforces. The result bound the tool declares to the Harness
(`outputLimits`) is fixed when the extension is installed, because a tool
declaration cannot change between calls. That bound is the cap plus 4 KiB, and a
line count that the cap cannot reach. Raise the key and restart to move both.

### Remote machines <a id="remote-machines-tools"></a>

`remote-machines` is a bundled extension with nine tools and one section. It is not
in the default `agent.extensions.enabled` list: a fresh install has no machine
registered. Add the name to that list, register the machine under `remoteMachines`
in `config.json` (see [runtime-layout.md](./runtime-layout.md)), and restart.

The tools are thin. Every decision lives in `src/remote/`: `RemoteMachines.access`
runs the level check, `RemoteRuns` starts and reads a run, `RemoteFiles` reaches a
file over sftp or rsync. A tool names no command line of its own, and a refusal is
returned as the core wrote it.

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `remote_machines` | `machine` (optional) | The registered machines with their level, the users and each user's reachability, a level change still being applied, and why connections are stopped. With a machine name it also reads that machine's load, memory and logged-in sessions, which is one ssh call. Without a name it calls no ssh. |
| `remote_run` | `machine`, `command`, `user` (optional), `cwd` (optional) | Starts a detached run. A command that ends inside the 20 second wait returns its output and exit code; a longer one returns a run id and the core reports on it. |
| `remote_run_status` | `run` | Reads one run now: its state, exit code, output size, when the output last grew, and the end of the output. |
| `remote_run_stop` | `run` | Stops one run: every process in the run's session gets the stop signal, and a process still there ten seconds later is killed. |
| `remote_read` | `machine`, `path`, `user` (optional), `maxBytes` (optional) | Reads a file over sftp. A file over the cap is refused and not cut. |
| `remote_write` | `machine`, `path`, `content`, `user` (optional) | Writes a file over sftp through a temporary file in the same directory and a rename. It creates no directory. |
| `remote_edit` | `machine`, `path`, `oldText`, `newText`, `user` (optional) | Replaces exactly one occurrence. Zero occurrences, more than one, or a file that changed between the read and the rename refuse the edit. |
| `remote_sync` | `machine`, `direction`, `source`, `destination`, `user` (optional), `delete` (optional) | Copies a tree with rsync. `push` copies from this machine, `pull` to it. `delete` is off unless named. |
| `remote_level_tighten` | `machine`, `level`, `reason` | Makes a level stricter, to `off` or to `restricted`. The root alone calls it, and it cannot widen a level. |

The level check runs inside the tools' own path, not beside it. `RemoteMachines.access`
answers every call before it touches a machine: it refuses a machine at `off`
without an ssh call, refuses a stopped machine or one with no pinned host key, and
refuses `remote_sync` at `restricted`, because the size of a copy is not known
before it starts. `remote_run` at `restricted` runs as
`ionice -c3 nice -n 10 timeout -k 5 <seconds>`; at `on` the command runs as it is.

Two of the tools are narrowed by `src/agent/tool-profile.ts`. `remote_level_tighten`
is removed from every subagent and every scheduled run, and the tool checks the
conversation against the root as well, so a conversation whose stored filter was
written before the profile existed is still held. A scheduled run also loses
`remote_run`, `remote_run_stop`, `remote_write`, `remote_edit` and `remote_sync`: it
leaves one answer and ends, so no conversation stays to read the checks of a run it
started. `remote_machines`, `remote_run_status` and `remote_read` stay. A focused
chat keeps none of the nine, because its tool list is an allow list.

`remote_run` is the one tool declared `replay: "safe"`. Its run id is a digest of
the conversation id and the tool call id, and the remote `mkdir` of the run
directory is what makes a repeat harmless: a second execution finds the record and
answers the state of the one run. The two ids are what a tool execution is handed
(`api.conversationId`, `api.callId`), and the harness reads the tool call from the
stored assistant entry when it runs an interrupted call again, so both are the same
value after a daemon restart as before it.

A run that outlives the 20 second wait is checked by the core, and every check that
says something new arrives in the conversation that started the run as a message
from the `system` source with `via="remote-machines"`. There are six texts, for a
run that is running, finished, lost, stopped, cannot be read, or is stranded
because the core made its machine `off`; they are `src/remote/run-texts.ts`. A
check that cannot reach the machine sends nothing and tries again 60 seconds later,
and the scheduled check after it still reports. The message goes to the root when
the starting conversation is gone.

The section is `remote-machines`, tagged `<remote-machines>`. It renders only for a conversation whose tool list holds
one of the nine names, which is why the same section serves the root, a subagent and
a scheduled run. It names no machine and no level: a section is sealed when a
session starts, so a level written there would be the level of that moment for the
life of the session, and `remote_machines` is where an agent reads the level.

The core watches a machine that stops answering while the user did not set it to
`off`. After `remoteMachines.outageSeconds` without an answer it makes the level
`off` itself, and it asks the user nothing: one commit writes the level, settles
every run that was live on that machine as `stranded`, cancels those runs' checks
and writes one inbox item for the user, and the root then receives one notice that
asks for no action. The user raises the level again with the sidebar slider when
the machine is back, and that raise puts each stranded run back to live and reads it
once, so the conversation that started it learns what became of it. The rule for
these messages is in the root role file.

### `githubPr` settings <a id="github-pr-config"></a>

`github-pr` is a bundled extension with web routes and no tool and no section. It
is not in the default `agent.extensions.enabled` list. Add the name to that list
and add the top-level `githubPr` key in the same edit.

```json
{
  "agent": { "extensions": { "enabled": ["github-pr"] } },
  "githubPr": {
    "writes": true,
    "repos": ["owner/repo"]
  }
}
```

| Key | Type | Required | Default | Rule |
|-----|------|----------|---------|------|
| `writes` | boolean | yes | none | Whether this install may write to GitHub at all. |
| `repos` | string array | yes | none | At least one entry, each `owner/repo`. |
| `fetchIntervalSeconds` | integer | no | `300` | 60 or more. |
| `diskLimitMegabytes` | integer | no | `2048` | 0, or 100 to 4096; 0 means no limit. |

Every other key under `githubPr` is refused as an unknown key.

`writes` and `repos` have no default. A default for `writes` would decide on your
behalf whether the install may write to GitHub, and a default for `repos` would
name repositories you did not ask for. A file that leaves either key out is a
config error that names the missing key. The two numbers do have defaults,
because neither of them decides anything about GitHub. `fetchIntervalSeconds`
starts at 300 and cannot go below 60: one poll cycle is seven GitHub searches per
repository, and a shorter cycle would spend the 5000-point hourly GraphQL budget
on a handful of repositories. `diskLimitMegabytes` caps everything the extension
keeps under `~/.pi/sec/gh-repo/`, and 4096 is its ceiling so that no setting
reaches the 5 GB disk mark that the pi-sec rules treat as heavy use. The value 0
means no limit: the extension then does not measure the directory, and the store
has no bound, so it can pass that 5 GB mark.

One switch covers the six write actions (thread reply, pull request comment,
reaction, review submission, thread resolve, and the edit of the description or of
the account's own comment). With `writes` false, the write API answers `403`
and sends nothing to `gh`, and the pages show no input for a write.

A `repos` entry follows the GitHub name rule: the owner is up to 39 characters of
letters, digits and hyphens, and the repository is up to 100 characters of
letters, digits, `.`, `_` and `-`, and is neither `.` nor `..`. Two entries that
differ only in case name one repository, because GitHub compares the two parts
without regard to case. That is not an error: the extension folds them into one
when it reads the list, and the first spelling is the one it keeps.

The load refuses a config whose enabled list names `github-pr` and which has no
`githubPr` key, and a config whose `githubPr` values break a rule above. The key
is accepted while the extension is off, and its values are then unused: a stale
key must not stop a boot over a value nothing reads.

Turning the extension on or off needs a cold restart, because the enabled list is
read at boot. The four `githubPr` values do not: the extension reads them on
every request and every poll, so a reload of the config is enough. A restart that
is not made leaves the pages answering `404`.

The extension also writes into `~/.pi/sec/gh-repo/` without a request. The boot
cycle and every list read reconcile the configured repositories, and a diff read
reconciles them too. A reconcile is due at the first call, when the configured
list changed, or when 24 hours passed. One reconcile reads each configured
repository once with `gh api repos/<owner>/<repo>`, a REST read that answers
whether the repository is a fork, which repository is at the root of its fork
network, and GitHub's size for it in kilobytes. The fork network decides which
repositories share one bare repository, and the size is what the disk cap is
checked against. That read is outside the GraphQL budget above.

When the server closes, the extension stops the poll, starts no further
reconcile, and waits for the reconcile that is running and for the list read in
the queue. The server awaits that cleanup, so a caller that removes the
repository root after a close finds nothing writing into it.

### `linear` settings <a id="linear-config"></a>

`linear` is a bundled extension with tools and no route, no page and no section.
It is not in the default `agent.extensions.enabled` list. Add the name to that
list and add the top-level `linear` key in the same edit.

```json
{
  "agent": { "extensions": { "enabled": ["linear"] } },
  "linear": {
    "apiKeySecret": "linear.api-key",
    "writes": true
  }
}
```

| Key | Type | Required | Default | Rule |
|-----|------|----------|---------|------|
| `apiKeySecret` | string | yes | none | The name of the secret file that holds a Linear personal API key. Same name rule as an uploaded secret. |
| `writes` | boolean | yes | none | Whether the three write tools exist. |

Every other key under `linear` is refused as an unknown key. Neither value has a
default, for the reason given under [`githubPr`](#github-pr-config): a default for
`writes` would decide on your behalf whether the install may write to Linear.

Store the key with the web page secret upload, under the name that
`apiKeySecret` gives. Each call reads the file `<secrets>/<apiKeySecret>` and
keeps the value only for the length of that call. A missing file gives the answer
`No Linear key`. The key goes in the `Authorization` header and in no other place.
Before a result goes back, every copy of the key becomes `[linear key]`, and no
error text, log line or audit row holds a header, a request body or the key.

The seven read tools send queries only. The check in front of every request is a
small GraphQL lexer: only the first word of a top-level definition counts, so the
word `mutation` in a string, a comment or a field name does not refuse a query,
and a mutation, a subscription, two operations or text that does not parse is
refused with `Nothing was sent to Linear.` The read tools are declared
`replay: "safe"`. The write tools keep the default, so a restart never runs a
write again.

A write tool takes a required `report_id` and runs seven steps in order. The
first four send nothing.

1. `linear.writes` is true in the configuration read now.
2. `checkApprovedReport`, the check that the routine gate and `request_restart` use, accepts the report: its newest revision carries the user's approval, the approval names that revision's sha256, the report is not a briefing, and its job is live.
3. The text of the newest revision can be read, and its sha256 is the recorded one.
4. The text holds a grant line.
5. One read of the target from Linear.
6. A grant line names the target.
7. Names (state, assignee, labels, project, parent) are resolved with reads, and one mutation is sent.

A grant line is a line that starts with `linear-write:` once list marks, spaces
and backticks are taken off its front. It lists targets separated by commas. A
target is an issue identifier such as `ENG-123`, or `team:` and a team key such as
`team:ENG`. A target counts only as a whole entry, so `ENG-12` does not grant
`ENG-123`. An identifier in a sentence, a placeholder such as `team:<KEY>` and a
lower-case identifier grant nothing. A create needs `team:<KEY>`. An update and a
comment need the issue identifier, or `team:<KEY>` of the issue's team. A refusal
in steps 1 to 4 ends with `Nothing was sent to Linear.` A refusal in step 6 ends
with `No write was sent to Linear. One read was sent.`

Every write call leaves one audit row in the audit log, of type `linear_write`
for a write that was sent (with `outcome` `sent`, or `unknown` after a network
failure, a timeout, or an answer that does not show whether the write happened:
HTTP 5xx with no data, or no data and no error) and `linear_write_refused` for a refusal (with the step). A row holds
the conversation id, the tool, the report id and revision, the target, the names
of the fields, and the length of a title, description or comment, and never their
text.

The load refuses a config whose enabled list names `linear` and which has no
`linear` key. The key is accepted while the extension is off. Turning the
extension on or off needs a cold restart, because the enabled list is read at
boot. `writes` is read again by every write call, so a reload that sets it to
false stops writes before the next restart, and the write tools leave the tool
list at that restart.

The kind tables keep the write tools from other conversations. The three names
are in `SCHEDULED_TOOL_REMOVALS`, so a scheduled run is not offered them, and in
`TOOL_KINDS` with the kinds `root` and `subagent`, so the live kind gate blocks a
call from a scheduled run or a focused chat even when its stored tool list is
older. A focused chat gets the read tools only when the names are in
`agent.focusedChat.extraTools`, and it never gets a write tool.

### Personality and language rules <a id="personality-and-language-rules"></a>

Two bundled extensions work as a pair, and both are in the default enabled list.

`personality` gives the installation a personality document: a language, a name,
a character, a voice, and the words the agent uses for the user and for itself.
The document is an ordinary markdown file, so a person can read it and edit it
without touching code.

`language-rules` carries the writing rules. `simple-english` holds the rules for
documents and replies, and every agent receives it. `fluent-korean` holds the
rules for Korean sentences, and every agent receives it while the personality
names Korean. `agent-language` names the language an agent writes to other agents
in: a worker and a scheduled run receive it while the personality names Korean,
and the root, a focused chat and an orchestrator read that rule in their
personality introduction instead.

#### The personality file

`personality.file` (string, default `memory/personality.md`) is the document. A
relative path resolves under the pi-sec home, and an absolute path is used as
written.

The file starts with an optional front matter of three or four lines: the opening
marker, one or two key lines, and the closing marker. The keys are `language` and
`name`, in either order.

```text
---
language: ko
name: 테스트봇
---
# the document follows here
```

The `name` line is the assistant's own name, on one line. The web page reads it
and draws it as the title of the root chat. When the front matter names no name,
the page shows `pi-sec`. The line is written between the `language` line and the
closing marker, and `personality_set` writes it only when a name is registered, so
a file with no name keeps the three-line front matter this release wrote before
the key existed.

A file with no front matter, or with a language that is neither `en` nor `ko`,
reads as English. The body is the text after the front matter, trimmed. The front
matter never reaches the prompt, because the introduction in front of the body
already states the language in a sentence a model can act on. The name does not
reach it either: it is metadata for the page.

A three-line block is front matter whatever its middle line says, as it was
before the `name` line existed: a middle line that is neither a `language` line
nor a `name` line is dropped, and the language reads as English. A four-line
block counts as front matter only when both key lines are ones this release
reads, each once. Any other four-line block stays in the body as text, so the
file is never half understood.

`personality_set` writes the file with the front matter, at mode 0600, through a
temporary file and a rename. A reader never sees half a document.

#### Which agent receives which section

An orchestrator is a subagent whose agent record holds a role that
`personality.roles` names. The default list is `["orchestrator"]`, so an
orchestrator receives the document with the orchestrator's introduction and the
writing rules. A planner is a subagent whose record holds the role `planner`, and
it receives neither the personality nor `fluent-korean`. A subagent with no
record, or with a role that matches nothing, is a worker.

| Section | Root | Focused chat | Orchestrator | Planner | Worker | Scheduled run |
|---------|------|--------------|--------------|---------|--------|---------------|
| `personality` (introduction and document) | yes, with the root's introduction | yes, with the focused chat's introduction | yes, with the orchestrator's introduction | no | no | no |
| The interview directive | on the first request while no personality is registered | no | no | no | no | no |
| `fluent-korean` | when the language is Korean | when the language is Korean | when the language is Korean | no | when the language is Korean | when the language is Korean |
| `agent-language` | no | no | no | when the language is Korean | when the language is Korean | when the language is Korean |
| `simple-english` | always | always | always | always | always | always |

A worker and a scheduled run answer their parent and never write to a person, so
a personality in their prompt would put a voice into instructions nobody reads as
conversation. Their messages to other agents are still text, and an installation
that names Korean asks for Korean in those messages, so they receive the two
Korean sections and no personality. An orchestrator writes the reports and the
titles a person reads, which is why it receives the document and the language,
and not the voice. A planner writes the working document of a plan or a result report in English,
and it writes no text the user reads, so it receives neither the personality nor
`fluent-korean`; it takes `agent-language` for the notes it sends its
orchestrator, as a worker does. A focused chat talks with the user directly, so it
receives the root's document with an introduction of its own, and it never
receives the interview: that question asks the user to settle the personality of
the whole installation, and a focused chat is not the conversation that keeps it.

#### The interview

`personality.interview` (boolean, default `true`) offers the design interview.
The hook adds one request-scoped system message, and only when all four hold:

- The setting is true.
- No personality is registered.
- The conversation is the root.
- The request has a user message and no assistant message.

The directive is in the language of the user's first message. The count takes
Hangul characters (U+AC00 to U+D7A3, U+1100 to U+11FF, U+3130 to U+318F) against
Latin letters (A to Z, a to z), and Korean needs a majority, not a presence. The
source envelope is removed before the count: `<pi-message ...>`, `<agent-message
...>`, and `<tool-call-output ...>` are written in Latin letters, so counting them
would push every short Korean message to English. The core reader
(`readMessage` in `src/message-envelope.ts`) undoes the envelope.

#### Fixed at session start

A section's value is fixed when the session starts. A personality that is
registered or changed during a session does not reach that session's prompt, so
the change needs a session restart, and `personality_set` says so in its result.

`personality_set` has two results, and the difference is the restart instruction:

- The first registration of an installation tells the root to restart at once,
  without asking the user. The order is `restart_cascade_start`,
  `restart_cascade_close`, then `restart_session`, because a first run has no
  children and the new session will not know the round id.
- A replacement tells the root to open a restart round once the work unit in
  flight is finished, as the session-restart rules say.

#### Tools

`personality_get` reads the document back and is open to every kind. Its result
is `Language: <en|ko>`, an empty line, then the body. When the document names a
name, a `Name: <name>` line follows the language line. When it names none, there
is no name line at all: an empty one would read as a name that is there and empty.
When the document names no language the first line says so and English applies.

`personality_set` is root-only. It is in `SUBAGENT_TOOL_REMOVALS` (and so in the
scheduled list) and it is gated to the root in `TOOL_KINDS`. The personality is
the root's own: it decides the language and the voice of everything the user
reads, and a subagent that registered one would change the prompt of the next
session without the user ever choosing it. The call takes `content`,
`language`, and an optional `name`, refuses a language other than `en` or `ko`,
refuses an empty document, a document over 8000 characters, and a document with
no markdown heading. A `content` that carries its own front matter has that front
matter dropped, and the `language` argument decides.

The `name` argument has three values, and the page shows the difference:

- Left out, it keeps the name already in the file, so replacing the body of the
  document does not rename the agent.
- An empty string removes the name, and the page goes back to `pi-sec`.
- Any other value is the new name. The value is trimmed, it must be on one line,
  and it may hold at most 40 characters, counted as code points. A line break or
  a longer value is refused, because the page draws the name in one line of a top
  bar.

The result names the name as well: `Personality registered (<n> characters,
language <en|ko>, name <name>, <path>)`, and `no name` in place of `<name>` when
the file holds none.

---

### Held conversations <a id="usage-freeze-holds"></a>

A model provider answers HTTP 429 when the account is over its quota. The
harness retries a few times, settles the run `unanswered` with `model_error`, and
leaves the agent record saying `running`. That record is a lie with three costs:
the stall watch reports the conversation half an hour later, the boot repair
reports it as ended without awaiting orders, and the chat page draws it as busy.
`usage-freeze` gives the one answer that fixes all three, `held`, and ends it when
the provider does.

| Piece | Where | What it says |
|-------|-------|--------------|
| `held` | `AgentStatus` (`src/documents.ts`) | Not `running`, so the stall watch, the boot repair and the idle notice pass it over; not `stopped`, so nothing retires the record and the agent keeps its slot. |
| Hold | `sec.usageHold`, session-scoped, keyed by conversation id | The provider, the model, the submission that failed, the hold time, and how many retries this hold has asked for (`retryTaskId` is the run of the newest one). |
| Probe clock | `sec.usageProbe`, session-scoped, keyed by provider id | When the newest short request went out, what it came to, and when this provider first refused. |
| Gate | `src/agent/hold-gate.ts` | An in-memory set the extension fills from the documents, read by `submitEnveloped`: an input to a held conversation becomes a transcript write. |

The watch runs on a 60-second constant interval, started beside the stall watch
and stopped beside it, with `unref()` on the timer so a one-shot command exits. One
pass does three things.

1. **Settle finished retries.** A retry creates no submission, so the submission
   table cannot say how it ended. The generation task it created can: `completed`
   ends the hold, a failure whose message starts with `429` holds it again, and any
   other failure ends the hold too, because the provider answered.
2. **Judge new refusals.** A conversation whose newest submission is `unanswered`
   with `model_error`, whose detail starts with `429`, that has no live task, whose
   agent record still says `running`, and whose newest assistant entry is that
   refusal with a real provider id, earns a hold. A virtual provider that failed
   before choosing a target names itself, and that is no account's usage limit.
3. **Judge each held provider.** The provider's own usage card says whether its
   window has room: a subscription window with utilization below 100, or a prepaid
   balance above zero. A provider with no readable card is judged by the probe
   alone. Then, if ten minutes have passed since the last probe, one goes out:
   `Models.completeSimple` with a single `ping` user message, `maxTokens` 16, a
   30-second deadline and no retry. `stop` and `length` are success, which sends
   every conversation that provider held as one generation task with no inputs of
   its own; `429` is a refusal and holds them again; anything else is a failure,
   recorded with its reason.

The retry writes `run` into `pi.live` and creates the generation task in one
commit, which is what the library's private `startRun` does: the library exports
no way to run a failed generation again. That is the one internal shape this
extension leans on, and `test/usage-freeze.test.ts` holds it.

Rolling back is a smaller fault than it looks. An older build does not know
`held`, so a conversation held when it starts belongs to no status branch and
simply stops; the two documents are left unread. Nothing breaks, and nothing ends
until the newer build runs again.

### Subagents <a id="subagents"></a>

A **subagent** is another conversation running beside the one that started it.
That is the whole of its identity: it has its own transcript, its own `pi.agent`,
its own usage, and its own run tasks, so it compacts, retries, and spends on its
own account.

The parent edge is **not** pi-durable's ownership tree. A conversation owned by
the parent's run task would keep that task from ever going idle, and the parent's
`abort()` would cascade into work it never started. So a subagent conversation is
**ownerless**, exactly like a scheduled run, and the tree lives in `sec.agent`.
The cost is that pi-durable does not know the edge: `harness.watchTaskGraph()` shows
the subagent as a root, and deleting a parent is something `pi-sec` does rather
than something a cascade does.

`spawn_subagent(name, vmodel, roles, initialPrompt, jobId?, forJobId?)` does its work in one
commit. `harness.createConversation({ init })` runs inside the commit that creates
the conversation, so the name index, the agent record, the tool profile, and the
job handover all land with it or not at all. The **limit is checked there too**:
`toolExecution` is `parallel`, so a check made before the commit cannot see a
parallel spawn in the same tool round, and with one slot left both would fit
through. The check reads `sec.agentHub`, which lives in the same commit.

**Every spawn names its model.** `vmodel` is required, and it is a key of
`config.vmodels`. A spawn without one, or with a key the config does not hold, is
refused with the list of keys, and nothing is created. `roles` and `vmodel` are
independent values: a role file does not choose a model, and a new kind of agent
names both. There is no default alias, so no rule can pick one for the caller.

**The root hands over top-level jobs, one agent each.** When the root spawns with
a `jobId`, two checks run. A job that has a parent is refused, and the refusal
names its top-level job: a subjob belongs to the agent that holds its top-level
job. A job that a live agent the root started already holds is refused too, and
the refusal names that agent, so the root sends the request there instead. Live
means any status but `deleted`, `stopped` and `failed`, so a parked agent still
holds its job. The second check runs inside the creating commit, beside the
limit, and reads the store directly: commits run one at a time, so of two spawns
of one job in one tool round only one passes. A spawn without a job and a
scheduled run are not counted, and a spawn by a subagent is not checked.

**A job can be linked without being handed over.** `forJobId` records the job in
the child's own record and changes nothing else: the job keeps its `conversationId`,
so its owner is unchanged, and the reports rule keeps the child to the same job
scope it had. The one reader is the derived `working` list, which joins both
fields, so the Jobs panel shows the job as being worked on while the child runs.
The pair is exclusive: a call that gives `jobId` and `forJobId` together is
refused, because a handover already produces that marker. A `forJobId` that names
no job is refused and nothing is created. The link is written in the creating
commit and never changes.

A subagent is **idempotent by name**: the parent's `sec.agentChild` entry is keyed
by the name, so a repeat of the same spawn reports the child that already exists
instead of making a second one.

**The discipline.** A subagent must not end a turn by answering, because no person
is reading it. When it is not answering a model request, not running a tool, and
not waiting on background work of its own or on a working child, it ends the turn
with one of two tools. `finish_work(note)` ends the agent for good (see below).
`await_orders(note)` records the state, tells its parent, and ends the run. The
parent's next order arrives as a tagged input and starts a new run in the same
context. Both tools run only as the only tool call of their batch, because the
durable layer ends a run only when every call of the batch ends it: a batch that
holds another call is refused with a result that ends nothing, and the agent calls
the tool again on its own. A parent also hears about a wait once, not once per
park: an agent that parks again with nothing new from another agent in between,
neither a message nor an answer to a request it sent, records the wait and sends
no second notice. That record is kept in memory only, so a daemon restart
announces the next wait again. Which of the two fits is the role's decision, not
the code's. The
`GenerationTask.onYield` hook enforces the rule: it returns `{ continue }` to push
the model back, three times at most, and then marks the agent `stopped` and tells
the parent.

The exemptions are the agent's own background work and a **working** child. A
working child has the status `running` and has a task that is not terminal, a
background call of its own, or a working child of its own. Such a child will send
a message, and that message starts the parent's next run, so the parent's turn
simply ends. `await_orders` is refused while a working child exists, because
parking would wake the parent's own parent for nothing. A `waiting` child is not
counted: it has reported already. A child that the user stopped on the screen is
not counted either: its record still says `running`, but nothing is live under
it, and nothing will come from it. The boot repair uses the same rule, and leaves
a `running` agent with no task alone while it has a working child.

**A turn the user started gets text.** The same `onYield` hook covers the root and
a focused chat. When the run began with a message the user wrote, which is an
envelope with `src="operator"` and no `via`, and none of the run's answers holds
text, the hook pushes the model back once with a text that asks it to answer the
user. An answer with no text is one the chat screen hides: either no text at all,
or the no-response line `[pi-sec no-response]` as its whole answer. Both sides read
that judgement from `src/shared/silent-turn.ts`, so an answer the screen hides is
an answer the hook nudges. A copy of the line with quotes, backticks, other
brackets, a period, or a sentence around it is drawn on the screen, so the hook
counts it as text and does not nudge. An approval input (`via="approval"`), a
question card's answer (`via="ask-user"`), and a message from an agent or from the
harness get no nudge: a silent answer to those is the correct answer. A run gets
the nudge once, because the nudge is itself a user entry inside the run, so a
second silent answer ends the run as it is.

**A woken agent is `running` again.** The `GenerationTask.beforeRequest` hook puts
a `waiting` subagent back to `running` before its first request. An order, a note,
a background result and a reset handoff all reach the model through a request, so
the hook covers every way a parked agent is woken. The nudge, the stall watch, the
restart gate and this rule all read the status, and a woken agent that kept
saying `waiting` was invisible to them.

**Finishing.** `finish_work(note)` is refused while the agent has any child, a
`waiting` one too, or a background call of its own: an agent that ended with work
below it would leave that work nobody to report to. Otherwise it writes the status
`stopped` with the note `finished`. Then it retires the record, the name index
entry and the slot in one commit, sends the parent the final report, and ends the
run. The
parent does not have to delete the agent, and the name can be spawned again. A
later message to the name fails as an unknown subagent. A draft report the agent
wrote stays with its job. The root and a scheduled run do not have the tool.

`finish_work` is also refused while a message is queued for the agent, such as a
note that arrived while the run was in flight. A queued message starts the next
run when the current run ends, so the agent ends its turn without a tool call,
reads the message in the next turn, and calls `finish_work` again. Ending a turn
with a message queued is not counted as a nudge. `await_orders` is refused by the
same rule and writes nothing: a park would tell the parent that this agent stands
at a safe point before it read the message, so the agent ends its turn, reads the
message, and calls the tool again. When `finish_work` succeeds, it
withdraws any input still queued for the agent and tells each sender that the
agent had already finished and that nobody read the message.

**A finished agent stays finished.** A conversation with no agent record is told
apart by the tool filter that the creating commit wrote into `pi.agent`: a spawn
writes the subagent list, which keeps `finish_work`, and the scheduler writes the
scheduled list, which drops it. So a subagent whose record was retired is still a
subagent, and is not read as a scheduled run. A focused chat's filter is an
allow list, and the only allow list that holds `focused_chat_title` is a focused
chat's, so a deleted chat whose record is gone is still read as a focused chat.
A conversation with no filter is read as a scheduled run, as before. A message to a finished subagent is not
delivered: `send_message` and `request_message` answer with `delivered: false`
and say that the agent already finished. If an input still slips in and opens a
run, the run tells each sender that nobody read the message, and the tool gate
refuses every tool (the agent tools, and `bash`, `read`, `write`, `edit` and
`js` too) with a text that says the agent already finished.
That run costs one model request, because a hook cannot refuse a run.

**Messages.** `send_message(to, body, kind?)` writes a `sec.message` row into the
*receiver's* conversation scope and delivers it as a tagged input. A `reply` is
never delivered as input: the requester is blocked inside a tool call waiting for
it, and a second copy would arrive as a stray message. `request_message` blocks
with a deadline when it runs directly, and has no deadline when `async_call` runs
it as a background task — the recommended form, because a directly blocking
requester is a busy conversation that takes no other messages, and two agents
blocking on each other stop for good. A request whose target finishes or is
deleted while the requester waits ends at once with a result that says no answer
is coming. A request whose requester stopped waiting (the deadline passed, the
call was aborted, or its background task ended) is withdrawn: `send_reply` then
refuses the answer and names `send_message`, so a late answer is never stored
unread. `await_orders` and `finish_work` refuse to run under `async_call` or
`js`, because ending the run is the point of them.

**The user's channel is the root's.** A subagent and a scheduled run lack
`ask_user`, `questions_open` and `question_withdraw`: a subagent answers to its
parent, so it neither opens a question for the user nor withdraws one, and a
scheduled run has no user turn to wait on. Two gates hold this. The tool
profile written when a conversation is created leaves the names out, and the live
gate (`TOOL_KINDS` in `src/extensions/subagents.ts`) reads the conversation kind
at call time and refuses a caller of another kind, which is what covers a
conversation that already holds the tool in its stored filter.

A worker is offered `spawn_subagent` and `subagent_delete` on purpose. The
subagent roles a worker may start are still to be added. The two tools stay in its
list so that such a role can use them then. Until that role exists, two texts keep
a worker from spawning. The worker role file, `prompts/role/worker.md`, says "You
do not spawn another worker or an orchestrator." The conventions say "A worker
finishes one instruction and reports the result. It does not start other agents."
The tool profile does not stop it, because `spawn_subagent` is offered to the
`subagent` kind, and a worker is that kind.

**How a message appears.** The body is wrapped in the envelope
`<pi-message src="agent" at="2030-01-15T16:30:05Z" from="..." from-kind="..." id="..." kind="...">`
(see `src/message-envelope.ts`) and delivered as user input, because user input is
the only admission that starts a run. `at` is the time the harness wrote the
message, in the harness timezone with that zone's offset. Two readers tell it
apart from what the user typed: the model is told by the envelope and by a
prompt section, and the
chat UI gives a user's row to `src="operator"` alone. Every other source
folds into one collapsed group, so a message between agents never reads as the
user's own turn, and the user can still open the group and read it. Only
the drawing changes: the entry stays in the conversation and the receiver still
reads it. Entries stored before the envelope existed still carry the older
`<agent-message ...>` tag, and every reader still reads it. A stored message
keeps the `at` it was written with: the instants an older transcript holds stay
as they are.

**Message sources.** `src` names the door a message came through, and it is
always the envelope's first attribute. The attributes after it stand in name
order, so two calls with the same arguments write the same bytes
(`src/message-envelope.ts`). Nine sources exist: `operator`,
`operator-scheduled`, `tool-output`, `agent`, `restart`, `section`, `system`,
`compaction`, and `unknown`, which is what a reader answers for text that carries
no known label. A `via` attribute narrows a source further, and the
implementation uses eight values: `ask-user` (the user's answer to an
`ask_user` question, chosen or typed), `report-feedback` (feedback written in the
report viewer), `approval` (a user's approval of one report revision),
`continuation` and `handoff` (the two texts a session restart writes),
`round-watch` (the harness's half-hourly notice about an open restart round,
which `src/extensions/session-restart.ts` writes), `idle` (the harness's advice
to a conversation that has been quiet for `agent.contextRestart.idle.minutes`,
which the sweep writes), and `review` (the older bare marker line, which a reader
maps to `operator`).

**Idle notice.** The stall watch runs a sweep every 30 seconds, and the sweep
also reads the children that wait for orders. When a child has waited longer
than `agent.subagent.idleNoticeMs` (default 300000, which is 5 minutes, and 0
turns the notice off), its parent gets one note: send a decision or an order,
or, when there is nothing for the child, read its state file and delete it with
`subagent_delete`. The note names that state file and says how long before the
child parked the file was last written, or that it was written after the child
parked, or that it does not exist. The note changes nothing about the child. A
child that works and parks again earns a new note. The record of notes sent
lives in process memory, so after a daemon restart a parent can get one more
note for the same wait.

While a restart request is up, the note is held. A note is submitted as input,
and input is the only thing that starts a run, so the note would wake a parent
that is parked at the safe point the restart needs. The hold records nothing as
told, so the note goes on the first sweep after the request is withdrawn, or
after the restart.

**Stall note.** The same sweep judges a child that still says `running` while
nothing of its own is live, whose newest task ended without completing, and that
has written nothing since that task ended. Its parent gets one note: it names
the child, says how many minutes it has not moved and how its last task ended,
and says that nothing was stopped, restarted or deleted. One note covers one
episode, and a child that moves again earns a new one if it stalls again. While
a restart request is up, this note is held for the same reason as the idle
notice, and it goes on the first sweep after the request is withdrawn.

**The round note.** `restart_cascade_start` sends each target one note, over the
same delivery path an agent's message takes but with `whenBusy: "steer"`. The
difference is the boundary the note waits for: `followUp` places a note at the end
of the run in flight, and `steer` places it between two tool rounds of that run, so
a child inside one long run reads the note, finishes the unit it is in, and
restarts. `followUp` kept a round open until that run ended, which is how a round
once stayed open for hours while nobody was told. Delivery never interrupts the
run: the note lands as one user message between tool rounds and the model reads it
with its next request. Delivery takes the boundary as an argument and defaults to
`followUp`, which is what every other delivery still uses.

**Open rounds.** The same sweep also reads the restart round of every live
conversation, before it skips the root: the conversation that opens a round is
usually the root. A round is open when it has a `startedAt` and no `closedAt`, and
it is worth a notice while at least one target is not counted ready. The watch
measures the round in cells of 30 minutes from the instant it opened, and each
cell from the first earns the owner one notice. The notice says how long the round
has been open and how many of its targets are not counted ready, then one line per
target that is holding it:

- a target inside a live run is described by its work: when its current step
  started and how long ago that was, the sentence that says the run is older than
  the step, the notice, and the count of its own open round when it has one;
- a target that waits for orders is described by that wait;
- every other target is described by its agent record.

Each line also says how far the round note got: still queued in that
conversation, placed in it, or never accepted by the harness. The first is the
case the watch exists for, because a note that stays queued is a target that has
not heard about the round at all. The notice is a `restart` input with
`via: "round-watch"`, it goes to the owner and never to a target, and it writes
one `restart_round_watch` audit row with the round id, the owner's conversation,
the count of targets not counted ready, and the cell number.

One cell, one notice. The request id is
`restart-round-watch:<roundId>:<cell>`, so the harness refuses a second
submission for the same cell even after a daemon restart has cleared every
in-memory mark, and the round document gains no field for this. A cell whose
notice was held is not sent late: the next notice leaves on the next cell, so the
gap between two notices is between 30 and 60 minutes and never less than 30.

The notice is held in two cases. While a daemon restart request is up, it is held
for the same reason as the idle notice: it is input, input starts a run, and a run
in a parked owner costs the restart its safe point. While the owner itself has a
live task, the notice is left to the next pass, because an owner that is working
can count its own round and a notice is worth sending to one that is not.

The watch reads and says only. It never stops, restarts or deletes a target, and
it never closes a round: those are the owner's calls.

**The idle restart advice.** A second advice rides on the same sweep, and it is
time-based rather than size-based. A conversation that is a target of the size
advice (the root, and a subagent whose roles are `agent.contextRestart.roles`)
earns one message when it has been quiet for `agent.contextRestart.idle.minutes`
(default 55, and 0 turns it off). The message is submitted without waiting for an
input, so that the agent can decide while the provider's prompt cache is still
warm instead of paying for the whole context on the next input. Five more
conditions hold with it: the conversation itself is not working (a background
call it started is not counted), no input of it is waiting to be placed, its
newest answer answered a request of at least `agent.contextRestart.idle.minTokens`
tokens (default 100000, and 0 ignores the size), and this quiet stretch carries no
advice yet. That last one is read from the log: the newest user-role entry of the
session is the advice when it arrived with `via: "idle"` from the `restart`
source, so the advice itself is not a new quiet stretch and the next one comes
after a new input. The request id carries the conversation and the newest entry
the pass saw, so two passes that decide at once submit once. The advice is held
while a daemon restart request is up, for the same reason as the notes above. It
changes nothing by itself: no status, no session and no round move, and the agent
decides whether to restart.

**Deletion.** A child that called `finish_work` has released itself. A child that
waits for orders is deleted by its parent once its work is over. The gate is
its status plus its own `background_list`: a `waiting`, `stopped` or `failed`
child with nothing live under it goes, and anything else needs `force`, which
deletes the subtree. `stopped` and `failed` are retired in the commit that writes
them, so a finished agent cannot hold a slot because somebody forgot — a full
limit fails a spawn, and a leak would therefore be permanent.

### Focused chats <a id="focused-chats"></a>

A **focused chat** is a conversation the user opens from the web page to talk
about one topic at length. It is a sub-session of the root, and the fourth agent
kind beside `root`, `subagent` and `scheduled` (`AgentKind` in
`src/documents.ts`). It has its own transcript, its own `sec.agent` record under
the root, and its own row in `state/focused-chats.sqlite`, and it holds one slot
of the same limit a subagent counts against while it is open.

`src/focused/` owns it. `store.ts` holds the title, the archive time and the
tombstones of deleted chats, because one answer to "what is this chat called"
has to exist. `service.ts` owns opening, archiving, deleting and the user's
rename, and both the HTTP routes and the root's tools call it, so a route cannot
create a chat the tools do not recognize, and a tool cannot archive one the
routes do not show.

**The prompt.** A focused chat receives:

- the `subagents` identity section, with text of its own: it is a focused chat
  named for it, the user reads and writes it, and it asks the root for anything
  that changes the system;
- the `personality` document with an introduction of its own, because the user
  talks with it as directly as with the root;
- `fluent-korean` on the root's condition, which is a personality that names
  Korean;
- `simple-english`, like every agent.

It receives neither the interview directive nor the root's own introduction.
Each of them tells the agent to settle the installation's personality and to
restart, and neither is a focused chat's act.

**The roles are fixed in code.** A focused chat always takes `focused-chat.md`
and then `user-facing-agent.md` (`FOCUSED_CHAT_ROLES` in
`src/focused/service.ts`), and no setting names them. It runs on the
installation's model, `agent.vmodel`, the same one the root runs on.

**The tools are an allow list.** `FOCUSED_CHAT_TOOLS` in
`src/agent/tool-profile.ts` is written into the creating commit, and a tool it
does not name cannot be reached at all, not through `js` and not through
`async_call`. The rule is one sentence: a focused chat reads, answers, and asks
the root. Its list is:

- reading: `read`, `read_full`, `jobs_list`, `jobs_get`, `reports_list`,
  `reports_get`, `lessons_list`, `lessons_get`, `attachments_list`,
  `attachment_open`, `personality_get`, `usage`, `expiry_check`,
  `diagnose_conversation`, `fetch_url`, `background_list`;
- asking the root: `send_message`, `request_message`, `async_call`,
  `async_cancel`;
- a restart: `await_orders`, `restart_session`;
- its own title: `focused_chat_title`;
- a picture in an answer: `share_image`;
- an HTML page in an answer: `share_page`;
- shell and files: `bash`, `write`, `edit`, `js`. The role file restricts the
  shell to reading commands and the file tools to the chat's own state file.
  That is a prompt rule, not a gate.

**`agent.focusedChat.extraTools`** adds names to that list. It is an array of
tool names and it is empty by default. A runtime extension's tool is the
operator's decision for this installation, so the tool is closed to a chat until
this list names it. A name that nothing registers is kept and offers nothing,
exactly like a removed name. The list is fixed when the chat opens, so a
change reaches the next chat and not one that is already open.

**The three tools.** One kind gets each:

| Tool | Kind | What it does |
|------|------|--------------|
| `focused_chat_title` | focused | Sets this chat's title, once, while it has none. A second call is refused, and after the first one only the user renames the chat. |
| `focused_chat_archive` | root | Ends an open chat: the run in flight stops, the record and the transcript stay, the slot and the parent's name index go, and every focused chat write route answers `409 chat_archived`. The user's permission is the prompt's rule, so the root asks before it calls this. |
| `focused_chat_delete` | root | Removes a chat that an agent opened for a test. It needs `reportId`: the newest revision of that report carries the user's approval of that revision's own sha256, and the revision's text names the chat's conversation id as a whole number. A chat that was not opened with the test flag is refused with `not_test_chat`. The transcript entries stay in the state database. |

The kinds are enforced twice. The stored tool filter decides what is offered,
and `TOOL_KINDS` in `src/extensions/subagents.ts` is the live gate, which is what
covers a conversation created before the gate existed. The checks inside the
tool bodies are the third layer, and they turn a wrong call into a sentence a
model can act on. No HTTP route archives or deletes a chat: both end a
conversation the user is reading, and the page offers no button for either.

**The inbox notice.** Opening a chat writes one `sec.inbox` item of kind
`focused_chat`, whose title names the chat and whose `source.conversationId` the
page opens from. The notice is the only way back to a chat whose address the user
lost.

**Restart.** A focused chat is treated like a subagent everywhere a conversation
is judged:

- **The safe point.** Every open focused chat is a target of the daemon restart
  gate, working or idle, because the user can write to it at any moment. It
  receives the same note a busy child receives, and `await_orders` is how it
  parks. It counts as parked only after a park that came after the note: the
  record says `waiting`, it carries a note, and its `updatedAt` is at or after the
  time the note went out. The `waiting` status a chat is opened with never passes
  the gate on its own, and an archived or deleted chat is never a target.
- **The restart watch.** A model request by a focused chat is judged the way a
  subagent's is, so a chat that goes back to work under a request that is up
  tells the root.
- **A session restart round.** A round includes the open focused chats, and the
  note names each child's own kind. Readiness is read from the chat's own entry
  log. An archived or deleted chat is not a target, because both retire the
  parent's index entry.

**The places that skip it.** The stall watch and the idle notice skip a focused
chat, because the user reads it and can leave it alone for days. Its slot is
still counted, so the skip cannot quietly free a slot. `background_list` lists an
open focused chat as `kind="focused"` with its title, and lists neither an
archived nor a deleted one. `subagent_delete` refuses a focused chat for every
caller, with or without `force`, and names `focused_chat_archive` and
`focused_chat_delete` as the two tools that end one. `diagnose_conversation`
never judges one stalled, and its rule is `focused-chat`.

### Diagnostics <a id="diagnostics"></a>

`diagnose_conversation` answers the question a parent had to answer by hand after
a provider outage: is this conversation still working, or did it
stop? The facts were all present and were split across `entries`, `tasks`,
`submissions` and the `sec.agent` record, and each was reachable only by id.

`diagnose_conversation(conversationId?, staleMs?, limit?)` reads those four in
one pass and prints one `<item kind="conversation" ... />` line per conversation:
the agent status, kind, parent and job, the newest model-message time, the
silence since then, the count of tasks that are not terminal, the last task and
what it ended as, the last submission with its reason, and the newest tool that
returned a result. Then it prints one `<judgement ... />` line per conversation
with `stalled` (`yes`, `no` or `unknown`), the `rule` that decided it, and
`silentMs`.

A conversation is `stalled="yes"` when it has been silent longer than `staleMs`,
has no task left to run, did not end its last task as `completed`, and still
reports `running`. A focused chat is never stalled: the user opens it, leaves it
and comes back, and its rule says `focused-chat`. The kind is read from the record
or, for a deleted chat whose record is gone, from the creating commit. It is `stalled="no"` when the agent is `waiting` for orders or
when a task is still to run. Everything else is `unknown`, and the rule name says
which reading was used. `staleMs` defaults to 1800000 (30 minutes) and `limit` to
20; without `conversationId` the tool walks the conversations with the most
recent progress.

The tool is read-only by construction. Every value it reports is computed at call
time and none is stored, so the runtime document families stay at their version
and a rollback stays cheap. It is `replay: "safe"` for the same reason.

`No-agent-record` means the read found no live `sec.agent` record. Either the
conversation never had one, or its record was retired when its agent was deleted.
A read at the current revision does not see a retired incarnation, so the tool
never calls such a conversation stalled. The tool does not report the instant a
record was retired, because `retiredAt` is a commit sequence and not a
wall-clock time.

### Agent profile <a id="agent-profile"></a>

`agent-profile` exists so the model's extra prompt and the agent's roles reach the
request **sealed**. `pi.agent.instructions` looks like the obvious place for them
and is not: it is not wrapped by the section seal, so changing it mid-session
rewrites the head of the next request and costs the provider's whole prefix cache.
A section is sealed, so a role file edited mid-session is recorded as a change and
applies from the next session.

Both sections read the conversation's `sec.agent` record, and fall back to
`agent.vmodel` and `agent.roles` when there is none — which is the root's case, and
is why `basicChat.conversationId` was removed: the root is `harness.root()`, and a
configurable root would have silently moved the gates keyed on it. A daemon
in setup mode (an empty `agent.vmodel`) has no root conversation yet, so no
section reads this fallback until a model is chosen.

`reply-language` comes first. It renders only for the root and a focused chat, the
two conversations that talk with the user, and only while a personality is
registered. It names the language of every text the user reads, in that language,
and says that the rule holds when the thinking or a tool result is in another
language. It sits second in the prompt, right after `preamble`, because a rule
that only the last sections state can be missed when the root plans a reply in
one language and writes it in another. It adds no new cut to the
shared prefix, since `vmodel` and `roles` already differ per conversation at the
same place.

### Tool tags <a id="tool-tags"></a>

Two facts make a tool eligible for a background call: it may take a long time,
and it observes its own invocation's `context.abortSignal`, so cancelling it stops
something. A tool that says both carries the `complex` tag. The tag is resolved
from `src/extensions/tool-tags.ts` at **call time**, never at install time.

- A tag is keyed by the pair (extension, tool), not by the tool name. A runtime
  extension that registers a tool called `bash` does not inherit the bundled
  `bash`'s tag, and a declaration counts only for the extension that provides the
  tool. Resolution therefore does not depend on install order.
- An extension declares tags for its own tools with an extra export:

  ```js
  export const toolTags = { my_long_task: { complex: true } };
  ```

  The loader reads it at install time and replaces what the extension declared
  before, so a reload that drops a declaration drops the tag with it. Unreadable
  entries are reported as a load warning, never swallowed.
- The user can add and remove names with `agent.tools.complex.add` and
  `agent.tools.complex.remove`. A tag on *another* extension's tool is only
  reachable this way: a code declaration is for your own tools.
- Bundled tags: `{coding, bash}`, `{js-tools, js}`, `{subagents, request_message}`,
  and `{self-edit, request_restart}`.

### The `js` tool's limits <a id="js-tool-limits"></a>

A `js` call has two caps, and both come from config on every call:

- `agent.tools.js.maxResultBytes` (default 102400) and
  `agent.tools.js.maxResultLines` (default 2000) cap the result. The tool keeps
  the beginning of a result and drops the end, and the harness appends one
  `truncated` diagnostic that names the dropped line and byte counts. A value
  below 1 is a load error: it would keep nothing, or cut from the end.
- `agent.tools.js.maxToolCalls` (default 32) caps the nested calls of one script.
  The call that passes the cap fails and the calls before it keep their effects,
  so the cap limits the blast radius of a script, not its length.

Both are read while a call runs, not when the extension is registered, so
`POST /api/admin/reload` reaches them without a restart. The tool description and
the `js-tools` section name the keys instead of the numbers, so the prompt does
not carry a value that a reload moves. The section is sealed per session like
every other section; see [Session seal](#session-seal).

### Background calls <a id="background-calls"></a>

`async_call(title, tool, args)` reserves a durable record for the title in one
commit and creates a `background: true` task owned by the conversation, then
returns. The title is the record's family key, so it is unique per conversation
by construction, and a prior reservation is read from the row's
`status: "unused"`. Only complex tools may be started this way.

The result arrives as **user input**, because that is the only admission that
starts a run; a passive entry write would sit until something else woke the
agent. Its first line is `<pi-message src="tool-output" status="..." title="..."
tool="...">`, and the tool description and prompt section both say that such a
message is tool output and not input from the user. The older `<tool-call-output ...>`
form is still read where it was stored. The chat UI draws it as a tool
call. Delivery uses a deterministic request id, so the completion path and the
cancel path cannot both land; `whenBusy: "followUp"` keeps a result that arrives
mid-run waiting for the next boundary instead of dropping it. One tool is the
exception: the result of a `request_message` travels with `whenBusy: "steer"`, so
it is placed at the boundary between tool rounds and the agent reads the answer
while its run goes on. The answer is what that call was for, and a result placed
only at the end of the run makes the agent ask the same question again. The names
of the tools that take this path are one constant in the extension, so a second
one is added in one place. A delivery that fails writes an inbox item and an
audit entry.

The background path does not run a `ToolTask`, so it has no `afterTool` hook:
everything it stores or delivers is passed through the redactor explicitly, and
nothing the script or the tool emits is streamed to the live output channel.

`async_cancel(title)` commits the task's abort mark through `abortTask`, waits
for its receipt within `agent.tools.async.cancelTimeoutMs`, and reports what it
found. The task's abort handler records `cancelled` and delivers the notice
through the same request id, so a cancel that has to give up waiting still ends
with exactly one message. Cancellation is a stop, never an undo: work a tool
already finished stands, and the message says so.

A restart in the middle of a background call leaves the task with an uncommitted
run phase. `bash` and `js` are `replay: "unsafe"`, so the run is not repeated: it
settles as `interrupted` and that report is delivered, which is the point.

#### A call that runs too long moves by itself <a id="auto-background"></a>

A direct tool call that outlives `agent.tools.backgroundAfterMs` (default 600000,
ten minutes; `0` turns the move off) becomes a background call instead of holding
the turn. The mechanics are three facts about the harness.

- A `pi.tool` task owns its call's abort signal and its api, and both end when the
  task settles: `#end(invocation)` aborts the signal, and `api.output`,
  `api.diagnostic` and `api.details` throw `Tool call <id> has settled`. So the
  `async-tools` extension wraps every tool and runs it against
  `withAbortSignal(own, withoutAbortSignal(ctx))`, with its own collected output
  channel. The wrapper forwards to the real api only while the task is live, so a
  call that finishes inside the limit returns exactly what it returned before the
  wrapper existed: `tool.outputLimits` and the `afterTool` redaction still apply,
  because the result is the tool's own result.
- The wrapper races the call against the limit. At the limit it writes the same
  reservation row `async_call` writes, with the title `auto-<tool>-<n>`, and
  creates a `background: true` task owned by the conversation. The turn gets a
  placeholder that names the title. The task takes the call's api over, so a
  `commit` or a `memo` keeps working across the move, and it settles the call
  through the same delivery path as `async_call`: redaction, the delivered-size
  cap, and one message per ending.
- Before the move the turn's abort reaches the call through a listener that
  aborts the wrapper's own signal. At the move that listener is dropped, so from
  then on only `async_cancel` stops the call, exactly like a call the agent
  started. A cancel reaches the work through the task's own `context.abortSignal`,
  which aborts at the abort mark; the task's abort handler runs only after its run
  phase returns, so the phase stops the work itself and the handler settles it.

The tools whose result ends the turn never move: `await_orders`, `finish_work`,
`restart_session`, `request_restart`, `ask_user`, `async_call`, `async_cancel`
and `background_list`. A call inside `js` never moves on its own, because the
script is one unit and the `js` call moves as a whole; the wrapper recognises the
nested calls by their `callId` (`js:<tool>:<n>`). A scheduled run never moves a
call either: its tool list has no background tools, so there is no turn that could
receive the result later. A moved call is not counted against
`agent.tools.async.maxConcurrent`, because the work is already running and
refusing the row would only block the turn it was meant to free.

A restart in the middle of a moved call goes through the same rule as any
background call: the task's run phase was committed as started, the work is
`replay: "unsafe"`, so it settles `interrupted` and is never repeated.

#### The status check of a running background call <a id="background-check"></a>

While a background call runs, the extension sends its conversation a status check
every `agent.tools.backgroundCheckMs` (default 1800000, thirty minutes; `0` turns
the check off), counted from the moment the call started. Both kinds of call are
checked: one the agent started with `async_call`, and one the wrapper moved. The
message travels the tool-output channel with `whenBusy: "followUp"`, so it starts
a run when the conversation is idle and waits for the next boundary when it is
busy. Each check carries its own request id, so two checks cannot collapse into
one. The checks stop when the call settles or is cancelled.

The check names the call's title and tool, and says how the call reached the
background, because that is what tells the agent whether it chose the wait. It
reaches the agent only: a call that is stuck is reported by the rules of the
agent's own role, and nothing here writes an inbox item.

`background_list` lists the conversation's background work. Each item carries a
`kind` field (`async_tool_call`, `subagent` or `focused`) so other kinds and other
fields can be added without breaking a reader, and the tool description tells the
model to ignore fields it does not know. A `focused` item carries the chat's
`title` as well, and only an open chat is listed: an archived chat gave its edge
back, and a deleted one is gone from both.

An `async_tool_call` item carries two fields about its result, because they say
two different things. `delivered` is when the submission was accepted, and an
accepted submission can still wait in the queue. `placed` is how far the result
got: `no` while the call has produced none, then the submission's own state,
`queued` while it waits for a boundary, `placed` once a run owns it, and `done`
once a run answered it. The row reads the submission at read time with
`storage.submissionByRequest` and the call's own request id, so it stores
nothing.

A `subagent` item carries three fields that say how far the child has got.
`updated` is when its record last changed. `progress` is the newest of its last
entry time and its last task end. `outcome` is how its newest task ended, or the
state it is in while that task is live. The row reads these values at read time
instead of storing them, so a parent can tell a child that is working from one
that went quiet.

### Lessons <a id="lessons"></a>

`lessons` keeps one store of what an agent learned, so the same correction is not
paid for twice. One lesson is one `sec.lesson` document, and the store is
`state/sec.sqlite`. The family is session-scoped, so a lesson outlives the
conversation that produced it and every agent reads what every other agent
learned. The archive sweep moves job documents and the reports that belong to a
job, so it never touches a lesson.

Eight tools share the store.

- `lessons_record` records one lesson. `source` defaults to `agent` and `status`
  to `open`. The call returns the id, the action, the recurrence count, and the
  three closest existing lessons.
- `lessons_list` lists lessons, most repeated first by default.
- `lessons_get` reads one lesson in full.
- `lessons_update` changes the standing: the status, the severity, the promotion
  target, the promotion evidence, or the notes. It cannot change the statement.
- `lessons_reword` replaces the statement of a stored lesson, for the case where
  the wording is wrong and the row itself should stay. Only the sentence moves:
  the id, the recurrence count, the evidence, the notes, the origin, the tags,
  the category and the promotion stay as they are. The fingerprint moves with the
  sentence, so a later record with the new wording folds into this lesson and the
  old wording stops matching it. The tool refuses a call that names no lesson, an
  empty statement, a statement over 600 characters, a statement that still holds
  a secret after the redaction, and a statement another lesson already carries.
  The reply names the lessons the new wording resembles, and an optional `note`
  records why the wording changed.
- `lessons_stats` counts lessons by status, category, and recurrence. It returns
  the stored counter beside that live count, and says whether the two agree. Pass
  `refresh: true` to recount the store and write the counter again.
- `lessons_scan` reads recent conversations and returns excerpts. It takes
  user messages that carry a review mark, and tool calls that failed, in the
  turn or as a background call (an envelope with `src="tool-output"` and
  `status="failed"`, or the older `tool-call-output` tag with that status).
  Each excerpt is under 600 characters and has registered secrets removed.
  The tool reads and never writes. Its arguments are `since` (default the last
  24 hours), `before` (an exclusive upper bound on the candidate time), `limit`
  (default 20, at most 50), `kinds` (`review` and `failed_tool`, both by
  default), and `markers`. The response carries `nextBefore`, one count per
  kind, and `conversationsExamined`, the number of conversations in which it
  found an entry inside the window. Candidates come newest first across every
  conversation in the window. One call reads every conversation that holds an
  entry at or after `since` and stops after 150000 entries. When it stops
  there, `windowsCut` names the conversation it stopped in,
  `conversationsUnread` counts the conversations it never opened, and no
  `nextBefore` comes back, so the caller raises `since` to read a smaller
  window. A page can hold more than `limit` candidates when they share the
  millisecond at its end. Pass `before: nextBefore` to read the next page. A
  candidate that an agent records twice is absorbed by the recurrence rule.
- `lessons_import` seeds the store from a list, or from a JSON file in the
  workspace tree. The default is a dry run. A dry run writes nothing, so it
  cannot detect a duplicate inside the same batch. An item the preview reports as
  `created` can fold into a recurrence in the real run, or be ignored there.

Seven of them are open to every agent. `lessons_import` is the root's alone, and
the tool itself reads the conversation kind and refuses every other caller.

**What the store refuses.** The write path first replaces each registered secret
value with its placeholder, in the statement, the file paths, the tags, the note
and `promotionRef`. It then refuses the write when a `⟦secret:…⟧` placeholder is
left in any of them, whether the redaction left it or the caller typed it. So a
lesson that carries a secret value is refused. The guard looks for registered
values only and does not guess from shape: a credential assignment such as
`token=abc123`, the word `api_key`, a long random-looking run, a commit sha, a
sha256 and a ULID in a path are stored as written.

**Repeat and near repeat.** Two lessons with the same sha256 over the normalized
statement are the same lesson. No second row is written, and the recurrence count
of the first one goes up. A repeat call from the same conversation and the same
evidence point collapses into the first call, and that count does not move. A
character 2-gram similarity of 0.9 or more counts as a recurrence. A similarity
between 0.6 and 0.9 writes the row and marks it as a merge candidate.

**Promotion.** A `promoted` status needs a `promotionRef`, which is a file path, a
commit hash, or a report slug. The creation path holds the same rule, so a seed
cannot claim a promotion without evidence.

**The count section.** The store also carries one short section into the session
prompt. That section shows two numbers only: how many lessons are open, and how
many proposals nobody has confirmed yet. A section renders on every request, so
this one does not walk the lesson documents at render time. It reads one
singleton counter document instead. That singleton is what unblocked the
section, because the older design read one document per row on every request.
The section shows the numbers its session started with, because a section keeps
the value its session committed. Call `lessons_stats` for the live count.
The same commit that writes a row updates the counter, so a counter that exists
cannot disagree with the store. Rows stored before the counter did are counted by
a recount, and the extension runs that recount on its own: a write, or a
`lessons_stats` call, that finds the counter missing or never written counts the
store and writes the counter before it answers. `lessons_stats` returns the
counter alongside the live count, and `refresh: true` recounts the store and
writes the counter again.

### The repository registry <a id="registry-tool"></a>

`registry` is a bundled extension with one tool, `repos_list`, and no section and
no hook. It is installed in the app phase, after the harness exists, and it is in
the default `agent.extensions.enabled` list. It goes in that phase because the
listing reads the title and the status of a worktree's job from the job store the
extension context holds. A job that cannot be read leaves those two fields empty
and every other field as it is.

The tool reads the git repositories, worktrees and buildfs caches that the
registry holds. It writes nothing and reaches no network, and it starts no
install: the git commands it runs only read the worktree list and the status of
each worktree. The same call answers the same value while the registry is
unchanged, which is what its `replay: "safe"` declares, and why a call that an
interrupted run repeats is harmless.

| Tool | Arguments | What it does |
|------|-----------|--------------|
| `repos_list` | `repo` (optional) | Returns the listing of the registry: its root, the storage method in use, and one entry for each repository, each worktree and each cache. `repo` narrows it to one repository. |

The answer is the same value as `repos list --json`, because both call one
function, `listRegistry` in `src/registry/store.ts`. The fields of the listing
are in [registry.md](./registry.md), section 5.

The settings are the top-level `registry` key of `config.json`: `root`,
`cacheKeep`, `refreshHours`, `buildDirs` and `mode`. The tool reads them from the
live config, so a reloaded `registry` key is the value that the next call uses.
See [registry.md](./registry.md), section 2.

## 6. Hot reload

Triggered by:

- `POST /api/admin/reload` (`{ "extensions": true, "config": true }`),
- the `self-edit` extension after a successful runtime-extension change,
- a debounced file watcher on `~/.pi/sec/extensions` and `~/.pi/sec/prompts`,
- `SIGHUP`.

Algorithm:

```text
for each changed runtime extension (by mtime/hash):
  read + validate config.json
  import with cache-busting URL
  call create(config)
  registry.install(extension)      # replaces by name
  register cards (`ui`) and pages (`pages`)
  record diagnostics
for each changed runtime prompt: reload and re-render sections
emit `extension_reloaded` SSE event
```

Guarantees:

- **In-flight safety**: pi-durable resolves the agent and hooks once per task
  phase, so running calls finish under old code.
- **No conversation rewrite**: conversations reference names.
- **Append-only context**: a reloaded prompt/section is appended as a positional
  `pi.system` entry and takes effect from that point forward; it never rewrites
  prior entries. New sessions start clean. See
  [architecture.md](./architecture.md#prefix-cache).
- **Pages**: a reload replaces an extension's pages, a failed reload keeps the
  previous ones, and a removed directory takes them away on the next load pass
  (see [Pages: the `pages` export](#ext-pages)).
- **Config rollback**: on a failed reload the previously installed instance is
  retained, so the last-working behavior continues.

Only **runtime** extensions and prompts participate. Editing `src/extensions/`
has no effect until a cold restart, by design.

---

## 7. Self-improvement loop <a id="self-improvement-loop"></a>

Two paths depending on the kind of change. Before you choose a path, decide with [boundary.md](./boundary.md) whether the change belongs to the core or to the instance side.

The loop starts at the lesson store. An improvement request reads the open
lessons with `lessons_list` and works on the most repeated and most severe of
them. When the change lands, the loop writes the result into the lesson's
`promotionRef` and moves the lesson to `promoted`, so the evidence that a rule now
exists stays beside the lesson that asked for it.

### Hot path (new/changed runtime extension)

```text
1. Agent decides it needs a capability change.
2. The agent creates or patches ~/.pi/sec/extensions/<name>/{index.js,config.json}
   with the ordinary file tools (`write`, `edit`). They write a temporary file in
   the same directory and rename it into place, so the loader never reads half a
   file. `self_edit` does not reach this directory: it writes only inside
   code.workspace (the modification tree), and every write it makes counts as a
   core change. No secret scan runs on this write.
3. The loader watches the extensions directory and reloads every runtime
   extension about 250 ms after a file changes. `reload_extensions` runs the same
   reload on request. The reload imports, validates config, and
   registry.install()s each extension. The import *is* the smoke test: an
   extension that does not load is reported and logged as a warning, and the
   previous instance stays installed.
4. Only the admin route `POST /api/admin/reload` emits `extension_reloaded`.
   The watcher and `reload_extensions` emit no event, and no reload path writes
   an audit entry.
5. Optionally promote it into core: **ask the user to confirm**, then commit
   the code into code.workspace (the modification tree) as a core candidate and
   `request_restart` for the next cold restart.
```

The gate below does **not** run on this path. A runtime extension reaches the
running process through a reload, not through a restart, so typechecking and
testing the modification tree would say nothing about what is now loaded.

No restart; the capability is usable in the same session.

### Cold path (core/server/config change)

```text
1. Agent edits files in code.workspace on a feature branch.
2. Validation gate (`request_restart`): typecheck, tests, and a secret scan of the change, against the workspace tree.
3. The agent commits in code.workspace (the modification tree); record commit in
   sec.selfEdit.
4. Emit `restart_required` and tell the user to run the user-tools script.
5. The user runs `user-tools/update-and-restart`. The composer menu's
   `Restart server` runs the same script. It advances the snapshot to the new
   HEAD, stops the old process, and starts a new one (a **cold restart**) from the
   updated snapshot tree.
6. New process boots; health check; on failure the user uses
   `user-tools/rollback` (git, plus the user's own storage copy).
```

There is **no in-process core rollback and no self-restart**. The agent cannot
change the running process's code; git and the user are the recovery path.
This is simpler and safer than a supervisor that mutates its own modules.

### Safe point before the gate <a id="safe-point"></a>

A child conversation may still be working when the parent closes the batch. A
cold restart ends every turn and every background call in flight, so
`request_restart` asks the working children to stop at a safe point first. It does
not refuse the request, and it does not raise the request yet.

A child is **busy** when both conditions hold:

- its agent record is `starting` or `running`;
- its conversation holds a task that is not terminal, a background call with
  status `running`, or a child that is working by the rule `await_orders` uses
  (`SubagentHub.workingChildren`).

The last condition covers a parent that ended its turn to wait for a working
child: `await_orders` is refused to it, so it has not parked, and the work under
it still runs. The check walks the child tree, so a busy grandchild is found as
well. A child that is `waiting` (parked), `stopped`, `failed` or `deleted` is
not busy and does not hold the gate. The calling conversation is not a target,
and neither is the `request_restart` task itself. A build with no subagent hub
has no children to read, and the check passes there.

**An open focused chat is a target whether it is busy or idle.** The user can
write to it at any moment, so an idle chat is not a chat a restart must skip. It
is parked only after a park that came after the note, which the gate reads as
`status: "waiting"`, a note, and an `updatedAt` at or after the time the note
went out. The `waiting` status a chat is opened with never passes the gate on its
own. An archived or deleted chat is not a target, and the store is asked as well
as the parent's index, because an archive retires the edge and the record in two
steps. The waiting row and the bypass line count a focused chat like a busy
child.

**The note.** `request_restart` sends one note to each busy child over the
delivery path that `send_message` uses. It then returns with `isError` set. The
note asks the child to finish the block in flight, start no new work, and write
its state and next step to its context file. Then it names three cases, and the
child does the one that fits:

1. If a subagent of the child is still working, the child ends its turn without
   a tool call. That subagent's message starts the next turn, and the child reads
   the note again then.
2. If the child's work is done, it ends with the tool its role names for that:
   `finish_work` or `await_orders`.
3. Otherwise, it parks with `await_orders` and tells its parent that it stands at
   a safe point and where it stopped.

The note opens by saying that a cold restart is being
prepared, and it does not say the user was asked, because in this state no
request may be out yet.

Delivery is not an interruption. A busy conversation takes the note as a
`followUp` message, so the note arrives at the end of the run in flight and opens
the next run. A parked child never receives one, because it is not busy.

**The second call.** Call `request_restart` again after the children report their
safe points. When no child is busy, the check passes and the call goes on to
the validation gate. When a child is still busy, the tool waits again with the
same message shape, and the child lines say how long ago each note went out. The
approval check runs first, so an unapproved request is refused before any note
goes out.

**What the wait says about the restart.** The first line of the wait message names
the restart state the call found, because the three states are different facts:

- `ready` set: a request already went to the user for this batch, and this
  call left it as it is.
- `required` set without `ready`: a core change is recorded, but no request has
  gone to the user, because the batch is open or an earlier gate run failed.
- neither: no request is recorded.

All three say that this call raised no request, and that the children have to
report a safe point before the next call. The wait never withdraws and never marks
the restart ready: the state it found is the state it leaves.

One note per child per episode. A child that has been sent a note is not sent
another until it is no longer busy, or until 10 minutes pass with it still busy.
The marks live in process memory, so `reload_extensions` and a cold restart clear
them, and the next call sends one more note. A note that the delivery path could
not deliver is reported as failed in the message and in the audit row.

**The waiting row.** A waiting call writes the `restart_refused` row with code
`safe_point_waiting`. `reasons` holds one entry per child: the name, the
conversation id, the last tool, the count of live tasks, the count of running
background calls, and when the note went out or why it failed.

**The bypass.** `allowBusyReason` is the way past a child that cannot reach a safe
point. A non-empty string skips the check and sends no note. The `restart_required`
row of the passing call then carries two `reasons` entries: `busy bypass: <reason>`,
and the children the check skipped, or a line that says none was busy. An empty
string is refused as `busy_bypass_reason_invalid`, and that refusal names the
argument because the empty value is the error. The tool description is the only
other place that names it: the waiting message does not, because an escape hatch
offered at the point of failure becomes the normal path.

**The limit.** The user's `POST /api/admin/restart-request` and
`POST /api/admin/restart` do not pass this gate. The first one records the request
and the second one starts the update script, so a restart asked for on either
route can end a turn that is in flight. See [security.md](./security.md#network).

### Validation gate

Run by `request_restart`, against the workspace (modification) tree, in
`runtime/validation.ts`:

- `tsc -p tsconfig.json --noEmit` over `src/`.
- The project's test suite (`vitest --run`).
- A secret scan of the whole change, checked against the live redactor. The
  change is every commit from the execution tree's HEAD to the workspace HEAD
  (`git diff -U0 <snapshot HEAD> HEAD`), the uncommitted change
  (`git diff -U0 HEAD`), and the contents of untracked files. So a commit that is
  not yet applied is scanned too. The gate reads `git -C <snapshot> rev-parse
  --verify HEAD` first, and a HEAD it cannot read, or a diff that fails, fails
  the scan.

Rules that matter more than the checks:

- **A missing dependency fails the run.** "Could not check" is never a pass.
- **A truncated read fails the run.** A scan of part of a change cannot conclude
  that the rest of it is clean. The scan reads each command's whole output up to
  8 MiB (`SCAN_LIMIT_BYTES`), not the shortened text a tool result shows, and a
  change or a list of untracked files larger than that fails the run.
- **An unreadable untracked file fails the scan.** The scan lists untracked files
  with NUL-separated names, so a name that is not ASCII is read as it is. An
  untracked file that the gate cannot read fails the scan and names the path. A
  symbolic link whose target does not exist holds no content and is skipped.
- **Each command has a hard timeout** (`validation.timeoutMs`, 600 s by default).
  A gate that can hang is a tool call that can hang.
- **A failure reverts nothing.** The tree is not executed, git is the source of
  truth, and reverting would destroy edits made after the one being checked. The
  failure blocks the *request* and reports its output to the agent instead.
- **No smoke check.** There is none, and the `validation` record has no `smoke`
  field: a declared field nothing fills reads as a check that passed.

What it cannot do: it says "this compiles and the tests pass", not "this is
correct". It also cannot catch a fault that only exists in the running tree —
vitest resolves a bare specifier from the project root, so a module production
cannot import still passes here. And **`test/` is outside the typecheck**
(`tsconfig.json` includes only `src/**`), while vitest strips types without
checking them, so a type error in a test file is invisible to the gate.

### Guardrails

- The agent can never acquire privilege (see [security.md](./security.md)).
- **No hard limit on self-edit.** The agent may create and change runtime
  extensions and prompts freely.
- Every change records conversation, run, files, diff hash, validation result,
  commit, and restart notice in `sec.selfEdit` and the audit log.
- Secrets never appear in edited files or diffs. The gate refuses to ask for a
  restart when a registered secret value appears in the change.

### Core-candidate review queue <a id="core-candidates"></a>

A **core candidate** is a proposed change to the bundled code plus its review
metadata. Candidates are stored as `sec.candidate` documents (session scope,
latest), one per candidate:

| Field | Meaning |
|-------|---------|
| `id` | ULID. |
| `title` / `summary` | What changed and why. |
| `origin` | `runtime-promotion` (a runtime extension proposed for core; requires user confirmation) or `core-edit`. |
| `files` | Paths touched. |
| `diffHash` / `commit` | Content hash and branch/commit in `code.workspace`. |
| `validation` | `{ typecheck, tests, secretsClean }` from the gate. |
| `status` | `proposed` \| `accepted` \| `rejected` \| `applied` \| `superseded`. |
| `createdAt` / `updatedAt` | Timestamps. |

- The **queue** is managed by the **agent**, not a UI. It creates and stages
  candidates, reviews and consolidates entries, and **defers adding new ones when
  the queue is deep**. There is no dedicated UI or API; queue depth may appear in
  `/api/admin/status` as a diagnostic.
- Applying = the user runs `user-tools/update-and-restart`. Nothing writes a
  candidate's `status` after the entry is recorded: `self-edit` sets it to
  `proposed` when the gate lets the change through, and no path changes it
  after that. The record shows what the gate checked, not what booted.
- A runtime extension may only be promoted into core after the user confirms.
- `sec.selfEdit` remains the per-conversation operation log (proposals,
  validation, commits, restart notices); `sec.candidate` is the
  model-managed, cross-conversation review queue.

### Rules for changing pi-sec <a id="change-rules"></a>

These rules apply to every change to this repository, whether a person who forked it makes the change or the agent's own self-improvement work does.

- Before you plan a change, decide with [boundary.md](./boundary.md) whether it belongs to the core or to the instance side. Write that side, and the step of its section 2 that decided it, in the plan.
- The `pre-commit`, `commit-msg` and `pre-push` hooks that `user-tools/install-git-hooks` installs run this scan on every commit, with the word list `scan-words.txt` in the pi-sec home. `pre-commit` and `pre-push` also refuse an author or committer that `commit-identities.txt` in the pi-sec home does not list. See [install.md](./install.md#commit-hooks).
- Before you publish a change, run `npm run scan`. It must report 0 findings. It looks for the secret values that your install registered, your home path, your host name, the personality name and the account name of your install, a generated id (a ULID), and an e-mail address that is not on an example domain. To also look for the names of your own install, give it a word list that you keep outside the repository: `npm run scan -- --words <file>`.
- Write commit messages as `<area>: <summary that starts in lowercase>`, for example `server: check the origin of write requests`.
- Write code, comments, documents, and commit messages in English.

---

## 8. Self-knowledge in the initial prompt

Because `pi-sec` is self-improving, its system prompt starts with a map of
itself so the model can navigate and modify its own structure:

- `docs/README.md` — the project's high-level structure (this design set),
  which transitively links every subsystem document.
- `docs/introduction.md` — a plain-language orientation to the system.
- The runtime layout (`~/.pi/sec`) and config schema.
- The snapshot and workspace tree paths, and the `user-tools/` scripts.
- **The pi-durable documentation** shipped in
  `node_modules/@earendil-works/pi-durable/README.md` (and its `docs/spec.md`),
  which is the authoritative description of the runtime it is built on.
- The current registry: installed extensions, their versions, and their config
  paths.

A `section` renders this as a bounded, stable directory map. It points rather
than embeds, so it stays small and preserves provider prompt caches. The map is
the first thing an autonomous agent needs: "here is who you are and where your
parts live."

---

## 9. Writing an extension (template)

The canonical shape is a factory so config can be injected; a config-free
extension may `export default` a `defineExtension(...)` result instead.

```ts
// src/extensions/example.ts (core) or ~/.pi/sec/extensions/example/index.js (runtime)
import { obj, str } from "@earendil-works/pi-schema";
import { Type } from "typebox";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

const hello = defineTool({
  name: "hello",
  description: "Say hello to someone.",
  parameters: obj({ name: str() }),
  replay: "safe",
  execute: async (args, api) => {
    api.output(`Hello, ${args.name}!\n`);
    return {};
  },
});

export const name = "example";
export const configSchema = Type.Object({ greeting: Type.String() });
export function create(config) {
  return defineExtension({
    name,
    sections: [section("example", () => `${config.greeting}: use \`hello\` to greet people.`)],
    tools: [hello],
  });
}
```

Tool schemas use the pi-schema builders. `configSchema` stays a TypeBox schema,
because the loader fills its defaults with TypeBox's `Value.Default`, and
pi-schema has no function that fills in defaults.

Rules for contributors (human or agent):

- Extension name must be globally unique (it is the replacement key).
- Tools must declare `replay`; default to **not** replay-safe unless idempotent.
  (This is tool-call replay, not extension reload — see §1.)
- Read state through `api.read`; treat absence as the default.
- Sections should be stable across calls to preserve provider prompt caches.
- No module-level side effects that assume a single run.
- Never embed a secret value; write a script that reads it from
  `~/.pi/sec/secrets/<name>` (redaction is irreversible).
