# Security Model

Companion to [README.md](./README.md). `pi-sec` is an autonomous agent with shell
and file access. Its security model is intentionally simple: **run unprivileged,
never authenticate inside the daemon, isolate tmp, isolate secrets, and audit.**

---

## 1. Operating model

### The security model

- pi-sec can do everything that the Linux account that runs it can do. This is
  intended.
- The only gate is access to the web server of the daemon. A person who can reach
  that server can direct the agent.
- The threat is a person without permission who reaches that server.
- pi-sec does not stop that person. You stop that access with tools outside
  pi-sec, for example an authenticating reverse proxy, or a host where only
  localhost reaches the daemon.

Other accounts on the same host can reach a loopback port. On a host that has such
accounts, block them with an outside tool or trust them.

The Host and Origin checks of the daemon make it harder for other pages in a
browser to reach the server. They do not replace the outside access control.

### How it runs

- `pi-sec` runs as a **dedicated, unprivileged Linux user created for it at
  install time** — not the user's login account. Paths derive from that
  user's `$HOME` / `os.homedir()` and config; the account name is chosen at
  install and is not hardcoded.
- That dedicated user is **unprivileged**. This is an **intended restriction**,
  not a limitation to work around. The guarantee is "never root", not "only these
  commands".
- `pi-sec` **never** runs `sudo`, `su`, `pkexec`, setuid/setgid helpers, or a
  privileged broker. It has no path to elevation.
- The web server binds loopback, and it performs **no authentication**: no
  token, no session, no login flow. Who may reach the port is decided outside
  the daemon (§8). The `Host` and `Origin` checks narrow the path another page in
  a browser has to the server. They are not a login.
- **Every `pi-sec` command runs as the dedicated `pi-sec` user**, never as the
  user's own account (`sudo -u pi-sec …`, a login shell, or the systemd unit).
- There is **no text-rule-based tool guard**. Command/path pattern matching is
  not used and is not considered a security control (see §4).
- There is **no per-tool sandbox or container**. Tool calls run in the same view
  as the agent — same user, filesystem, and namespaces. The dedicated user is the
  security boundary.
- **The dedicated user's account is the workspace.** Directories `pi-sec`
  manages may live anywhere that user can write, not only under `~/.pi/sec`. Only
  the control structure is fixed under `~/.pi/sec`.

Rationale: the agent is powerful by design, and the user has chosen to run it
as themselves. Containment is at the OS privilege boundary, and credentials are
kept out of the model entirely (see [secrets.md](./secrets.md)).

---

## 2. Filesystem and privilege

The dedicated `pi-sec` user is the boundary. The user keeps their own login
account and reaches the agent only through the web UI; the agent cannot read the
user's files unless explicitly granted (shared group, ACL, or a bind mount
set up by the user).

| Path | Access | Notes |
|------|--------|-------|
| `~/.pi/sec/snapshot` | read (convention) | Execution tree (running code); read-only by convention, not enforced by the OS. |
| `~/.pi/sec/workspace` | read/write | Modification tree; self-edit target, never executed. |
| rest of `~/.pi/sec` | read/write | Control structure: config, secrets, logs. `0700`/`0600`. |
| anywhere the pi-sec user can write | read/write | Model-managed dirs (job state, projects, notes) may live outside `~/.pi/sec`. |
| `~/.pi/sec/auth.json`, `~/.pi/sec/models.json`, `~/.pi/sec/secrets/model-auth.*` | read/write (0600) | `pi-sec`-owned model credential shapes and catalog; the credential values are secret files, and all of them are registered for redaction. |
| user's own files | none by default | Separate account; grant access explicitly if needed. |

Because the agent runs as its own account, there is real privilege separation
between it and the user. Running `pi-sec` as the user's own login account is
possible, but the intended install is a dedicated account.

---

## 3. Service and sandbox <a id="service-and-sandbox"></a>

The service runs as the dedicated, unprivileged `pi-sec` account. Example system
unit (change the account name and the home `/home/pi-sec` if you chose different
ones):

```ini
[Unit]
Description=pi-sec autonomous personal agent
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
NotifyAccess=all
User=pi-sec
Group=pi-sec
WorkingDirectory=/home/pi-sec/.pi/sec/snapshot
Environment=PI_SEC_HOME=/home/pi-sec/.pi/sec
Environment=PI_SEC_PRIVATE_TMP=1
ExecStart=/usr/bin/node /home/pi-sec/.pi/sec/snapshot/dist/cli.js start --watchdog
Restart=on-failure
RestartSec=3
TimeoutStopSec=30
WatchdogSec=60

# --- sandbox (no privilege, private tmp) ---
NoNewPrivileges=true
PrivateTmp=true                       # private /tmp for the whole daemon
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/pi-sec             # the pi-sec account is the workspace
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0077

# --- resources ---
MemoryMax=2G
TasksMax=512
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
```

`NoNewPrivileges=true` plus an empty `CapabilityBoundingSet` plus no setuid path
is what makes "never root" structural rather than aspirational.
`ReadWritePaths=/home/pi-sec` lets the agent use the dedicated account (job
state, projects) while leaving the rest of the system read-only. (Write scope
is covered under Deployment below.)

### Deployment

There are three ways to run the daemon. The first two are what `user-tools/install`
sets up; the third is the system unit shown above, kept for a host that wants the
service managed outside the account.

| Way | What supervises the daemon | How it is set up |
|-----|---------------------------|------------------|
| systemd user unit | the account's own user manager | `user-tools/install --run systemd` writes `~/.config/systemd/user/pi-sec.service` from `user-tools/pi-sec.service` |
| the runner, no systemd | `user-tools/run` in a terminal that stays open | `user-tools/install --run manual` prints the command to run |
| system unit (the example above) | PID 1, with `User=pi-sec` | by hand, with root, once |

The user unit is rendered from `user-tools/pi-sec.service`, a template with four
placeholders (`@HOME@`, `@PI_SEC_HOME@`, `@NODE@`, `@PATH@`), and the install
script fills them from the account. It names no `User=` and no `Group=`, and it
differs from the system unit above in one way that matters:
`WantedBy=default.target` instead of a system target. Both units set
`NotifyAccess=all`, because the daemon notifies through a child process. It keeps
these sandbox lines:
`NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`,
`ReadWritePaths=@HOME@`, `PrivateDevices=true`, an empty `CapabilityBoundingSet`,
`UMask=0077`, `RestrictNamespaces=true` and `SystemCallFilter=@system-service`.
Its resource lines are `MemoryMax=4G` and `TasksMax=512`. The example system unit
above adds `ProtectHome`, the `ProtectKernel*`, `ProtectClock` and
`ProtectHostname` lines, `RestrictRealtime`, `RestrictSUIDSGID`,
`LockPersonality`, `SystemCallArchitectures`, `RestrictAddressFamilies`,
`AmbientCapabilities` and `LimitNOFILE`.

A user unit starts at boot only with `loginctl enable-linger <account>`. Without
linger it starts with the first login session and stops with the last one.

**What the unit provides.** `NoNewPrivileges=true` and an empty
`CapabilityBoundingSet` remove the path to elevation. `ProtectSystem=strict` with
`ReadWritePaths=@HOME@` makes the rest of the system read-only to the daemon.
`PrivateTmp=true` gives the daemon its own `/tmp` and `/var/tmp`, cleared when the
unit stops, and `PI_SEC_PRIVATE_TMP=1` is what tells the daemon to clean that tmp
itself. `SystemCallFilter=@system-service`, `RestrictNamespaces=true`,
`PrivateDevices=true` and `UMask=0077` narrow what a command can reach.
`MemoryMax` and `TasksMax` cap memory and processes. `WatchdogSec=60` with the
`--watchdog` flag restarts a daemon that stops answering, and `Restart=on-failure`
with `RestartSec=3` restarts one that crashed.

**Without systemd.** The runner starts a plain child process in the account, and
nothing outside the daemon enforces anything:

- There is no private `/tmp`. The daemon skips tmp cleanup, so it never removes
  another program's files, and temporary files its agents write stay in the shared
  `/tmp` until something else removes them.
- There is no sandbox and no resource cap. The daemon and every command its agents
  run have all the permissions of the account.
- There is no watchdog, no automatic restart after a crash, and no start at boot.
  A daemon that stops stays stopped. The runner ends with the daemon's exit code,
  except for code 75, which it reads as a restart request and applies.
- The restart button works under the runner, and it refuses when `pi-sec start`
  runs on its own, because nothing above that process would start it again.

The same list, with the commands, is in [install.md](./install.md#without-systemd).

**The restart button does not work under a system unit.** The daemon answers
`409 system_unit`: stopping and starting that unit needs `sudo`, which the daemon
does not have and does not want. The operator runs the script by hand instead.

Two scripts hold `sudo systemctl stop pi-sec` and `sudo systemctl start pi-sec`,
and each of them runs those two commands only when it finds a system unit:
`user-tools/update-and-restart`, which updates and restarts, and
`user-tools/rollback`, which returns to an earlier commit. A human starts either
one, never the daemon. Under a systemd user unit both scripts use
`systemctl --user` instead, and under the runner they touch no unit at all.

Running as the user's login account is not supported.

**Sandbox write scope.** `ReadWritePaths` names the pi-sec account's home
(`/home/pi-sec` in the system unit, `@HOME@` in the user unit template) and
confines writes to it. A job directory outside that home therefore requires
adding that root to `ReadWritePaths` in the unit. The narrower alternative is
to list only the specific project roots the agent needs, at the cost of
home-wide writes.

**The update script runs outside the sandbox.** `POST /api/admin/restart` hands
`user-tools/update-and-restart` to systemd as a transient unit, because the script
has to stop the very unit whose cgroup would kill it. That transient unit is a new
group for the same unprivileged account: it does not inherit `PrivateTmp`,
`ProtectSystem`, or the syscall filter. It needs to write to `~/.pi/sec`, which is
why it is not sandboxed the same way, and the difference is stated here rather than
left to be discovered. It gains no privilege: same account, same uid, still no
`sudo`. Under `user-tools/run` the script is a child of the runner and outside any
unit as well, with the same account's permissions.

---

## 4. No text-rule guard <a id="no-text-rule-guard"></a>

Earlier designs put an allow/deny policy in front of tool calls (command regexes,
path allowlists, approval gates). That is **explicitly removed**:

- String heuristics are trivially bypassed (`rm -fr`, `python -c`, base64
  pipelines) and create false confidence.
- The agent runs as a dedicated, unprivileged Linux user, and the Linux user
  account is the security boundary. Adding a match-based "guard" would suggest a
  security boundary that does not exist.
- The real controls are: unprivileged execution, no elevation path, secret
  isolation, tmp isolation, and an audit trail.

If the user wants to restrict what the agent can touch, they should do it with
OS permissions (account separation, filesystem ACLs, group membership), not with in-process string
matching.

---

## 5. Privileged actions <a id="privileged-actions"></a>

Sometimes a task genuinely needs root (installing a package, editing a system
file). `pi-sec` handles this the only safe way:

1. The agent writes a **script** into the work directory of the job that needs
   it (e.g. `~/job/<slug>/<name>.sh`), with a comment explaining what it does.
   The script never goes into the workspace tree, because that tree is the core
   repository.
2. It tells the user, in plain language, that a privileged action is proposed and
   points at the script.
3. The **user** reviews and runs it, or ignores it. `pi-sec` never runs it and
   never asks for elevation. The user's terminal is the authority.
4. The proposal leaves no audit row. The daemon does not learn that the script
   ran, so it has nothing to record.

This makes privilege escalation a human-in-the-loop, reviewable, last-resort
operation. No `sudo` invocation ever originates from the agent process.

---

## 6. Tmp isolation <a id="tmp-isolation"></a>

The motivation is **hygiene, not secrecy**: agents write many temporary files, and
those must be safely deletable without touching unrelated processes' files.

The mechanism is **systemd `PrivateTmp=true`**. The service gets a private `/tmp`
and `/var/tmp` mount namespace; every process it spawns sees those private
mounts, and the kernel discards them when the unit stops or restarts. Programs
cannot accidentally touch the host `/tmp`, and the user never has to reason
about which files are the agent's.

`TMPDIR`/`TMP` are deliberately **not** used as a control: processes routinely
ignore them, so they are unreliable. `bwrap` is not needed either.

Eager cleanup (janitor, [runtime-layout.md](./runtime-layout.md#7-janitor)):

- delete files older than `tmp.maxAgeHours`;
- delete large files (`> tmp.eagerThresholdBytes`) sooner;
- enforce `tmp.maxBytes`.

Anything that must outlive a restart is stored in known locations under
`~/.pi/sec` (`state/`, `memory/`, `logs/`), never in tmp. If `pi-sec` is run
without systemd, tmp isolation is unavailable; running under the provided unit is
recommended.

---

## 7. Secrets

Covered in depth in [secrets.md](./secrets.md). Summary:

- Secrets never enter model context; they are replaced by fixed dummy tokens.
- Logs, audit entries, documents, and memory are redacted by the same registry.
- Redaction is **one-way and irreversible**: there is no resolution, and a dummy
  passed to a tool is passed literally.
- To use a secret, the model writes a script that reads it from
  `~/.pi/sec/secrets/<name>`. Redacted values are not recoverable.
- **Model credentials are included**: the values live in `~/.pi/sec/secrets/model-auth.*`
  files, and `~/.pi/sec/auth.json` names those files. The registry registers the
  file content, and sensitive fields that `~/.pi/sec/models.json` holds, so the
  same one-way rule redacts them.
- Residual risk: the model can write a script that reads a secret and uses or
  exfiltrates it without ever seeing the value; secret isolation is not an egress
  firewall. Mitigate with scoped secrets and host-level egress controls.

---

## 8. Network and reverse proxy <a id="network"></a> <a id="reverse-proxy"></a>

### The access premise

`pi-sec` assumes one of two arrangements: an authenticating proxy in front of the
daemon, or access limited to localhost. Nothing inside the daemon authenticates
anyone. Two facts belong to that premise:

- **Another account on the same host can reach a loopback port.** The daemon has
  no authentication, so that account can call every route, including the ones
  that write secrets and restart the daemon. Only accounts you trust belong on
  the host.
- **The `Host` and `Origin` checks narrow one path, and they replace no access
  control.** They cannot tell a person apart from a browser page that the person
  opened. The next subsection says what each check does.

### `Host` and `Origin` checks

The server runs both checks on every request. It does this after it resolves the
mount point and before it reads a body or picks a route, so a refused request runs
no handler.

**`Host`.** The server accepts a request only when the hostname in `Host` is the
hostname of `server.publicUrl` or one of the loopback names: `127.0.0.1`,
`localhost`, `::1` and `[::1]`. It compares hostnames, so a port makes no
difference and a suffix does not match. When `server.publicUrl` is unset, or holds
a value that is not a URL, only the loopback names are accepted. Any other name is
refused with `421 misdirected` and the message `host not allowed`. That refusal is
what closes the DNS-rebinding path: without it, a page on another site can point
its own name at `127.0.0.1` and arrive with a `Host` of its choosing.

**`Origin`.** A request whose method is not `GET` or `HEAD` is refused with
`403 origin_forbidden` and the message `origin not allowed` unless its `Origin`
header names one of these origins:

- the origin of `server.publicUrl`, with its scheme and port, when that setting is
  present;
- `http://127.0.0.1:<port>`, `http://localhost:<port>` or `http://[::1]:<port>`,
  where the port is the one the request arrived on.

The server compares origins, so scheme and port count. A header value that is not
an origin is refused, and that includes `null`, which a sandboxed frame and a
`file://` page send. A request with no `Origin` header is accepted: the CLI, the
scripts and the tests send none, and a browser sends one on every cross-site
write, so the exception opens no browser path. `OPTIONS` takes the check like any
other method, because the server answers no preflight.

`GET` and `HEAD` routes stay outside the check because no `GET` or `HEAD` route
writes. `/basic-chat/events` and `/basic-chat/context` read the root conversation
and never create or change it. The daemon prepares the root conversation at boot,
and each write route prepares it before it acts. If the root conversation is
missing, these two routes answer `503` with the code `root_missing`, and a page on
another site cannot read either answer.

**Set `server.publicUrl` when the browser reaches the daemon by another name or
port.** An install that opens the web UI at `https://agent.example.com/sec` sets
`server.publicUrl` to that address. Without it, the `Host` check accepts only
loopback names and the `Origin` check accepts only loopback origins, so that page
cannot write.

### Binding

- Default `server.bind = 127.0.0.1`. Never `0.0.0.0` unless the user
  explicitly opts in behind a firewall.
- `trustedProxies` gates who may set `X-Forwarded-*`; entries are IPs or CIDR
  blocks and never carry a port. A bad entry is rejected at config load rather
  than skipped, because a skipped entry that empties the list looks exactly
  like a working configuration that simply trusts nobody. The default is empty,
  so the daemon trusts no proxy until you list one. A peer in the list can set
  two headers. `X-Forwarded-Prefix` decides the mount point and every URL the
  server emits, and it is validated as a plain absolute path before it reaches a
  `Location` header or the served HTML. `X-Forwarded-For` names the client in the
  access log and the audit trail. Neither header decides an access question.
- **Localhost is fully trusted.** The daemon provides no authentication,
  sessions or tokens. Anything that can reach the loopback port can drive the
  agent. Authentication and authorization exist only
  at the reverse proxy; exposing the daemon beyond localhost without one is
  unsupported. The `Host` and `Origin` checks do not change this: a program on the
  host sends no `Origin` header at all, and the check accepts that.
  One route is narrower than the rest: `POST /api/admin/restart`
  refuses a body that is not `application/json`, because a cross-site form can
  post without a preflight and restarting the daemon on a stray page load is a
  larger accident than asking the agent a question.

### Authentication is external

`pi-sec` has no login, no tokens, no sessions. The user either:

- accesses it on localhost, or
- fronts it with a reverse proxy that authenticates (oauth2-proxy, Authelia,
  mTLS, VPN, etc.) and restricts the admin routes.

**Not every route carries the same weight.** Chat messages and report feedback are
*instruction-bearing*: feedback is pushed into the conversation as input,
exactly as if it had been typed into the chat, so whoever can POST
`/api/reports/:id/feedback` can put words in the user's mouth — for the agent
there is no difference between the two. Read-only views (`/report`, the status
and job APIs) are safe to expose more widely; the input paths are not.

`POST /api/reports/:id/approve` is heavier still, and it has no authentication of
its own. That route does not write a message. It makes **consent to start work**.
The approval is recorded on the revision it names, and it is pushed into the
conversation as input from the user. It is also what the landing gate below reads. Two
consequences follow. First, whoever can reach this route can approve a change the
user has not read. Second, the default state of both bars is an empty field
with a green `Approve` on it. One POST from anyone who can open that screen
starts a run. Write access to `/api/reports` is therefore as sensitive as write
access to the chat. Beyond loopback, the reverse proxy is the only thing in front
of it.

**The landing gate.** `request_restart` requires `reportId`: the report whose
newest revision the user approved. The check is the routine gate's
(`checkApprovedReport`): the report is live, its job has not ended, and the
approval names the sha256 of the newest revision. Without that approval the tool
refuses. It names the report and its newest revision, and it says what to do
next. Nothing is staged, and the user is not asked to restart. An approval on an
older revision does not count, because a newer revision is a new proposal. A
report that moved to the archive with its finished job does not count either:
its approval covered the work that job landed, not the next change.
The guard covers the agent's own path to landing a core change. The user's
`POST /api/admin/restart` is not gated, and is not meant to be, because the
user is the authority. Neither that route nor
`POST /api/admin/restart-request` runs the busy-child check, so a restart started
from either route can end a turn that is in flight. See
[Safe point before the gate](./extensions.md#safe-point). A build with no report
store has no approval record to read, and the check passes there.

Reference nginx (TLS and auth are conceptual here; any proxy works):

```nginx
location /sec/ {
    proxy_pass         http://127.0.0.1:8787/;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   X-Forwarded-Prefix /sec;
    # The proxy's own address must be listed in server.trustedProxies,
    # otherwise the header above is ignored.

    # SSE
    proxy_buffering    off;
    proxy_cache        off;
    gzip               off;
    proxy_read_timeout 1h;
    chunked_transfer_encoding on;
}
```

### Egress

There is no in-process egress policy (that would be a text-rule guard). If the
user needs to constrain outbound network access, enforce it at the host
firewall or by routing tool subprocesses through an HTTP(S) proxy configured in
the service environment. `fetch_url` can reach anything the host can, including
loopback, private ranges, and cloud metadata endpoints (SSRF); because there is
no in-process egress policy, constrain that at the network layer if it matters.

---

## 9. Web security (without auth)

Even without authentication, the server keeps basic hygiene:

- `Host` and `Origin` validation (§8). The `Host` check accepts the hostname of
  `server.publicUrl` or a loopback name. The `Origin` check accepts the origin of
  `server.publicUrl` and the loopback origins on the listening port.
- Bounded JSON bodies (`server.maxBodyBytes`, 1 MiB by default). A subagent
  message is bounded as well (`agent.subagent.maxMessageBytes`, 16 KiB by
  default); a chat message has no cap of its own and is bounded only by the body
  limit. SSE queues are bounded per client (`server.sse.queueBytes`), and the
  frame history kept for `Last-Event-ID` is bounded by count and by age.
- `POST /api/admin/restart` requires a JSON body type, so a form on another site
  cannot trigger it without a preflight.
- Response headers: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Content-Security-Policy` with no inline script
  for the bundled UI. A response that renders an extension card names one nonce
  in `style-src` (see below). `Frame-Ancestors`/HSTS belong at the proxy.

These are robustness measures, not access control.

There is no request rate limit in the daemon. A proxy in front of it can add one,
and that is the place for it: the daemon sees the proxy's address, so a count of
its own would put every client in one bucket.

### The model login routes

Five routes under `/api/admin/model-login/` sign a model provider in. They can
replace the model credential, so they are held to the checks of the other admin
write routes and to one more of their own.

- **They are covered by the `Host` and `Origin` checks** (§8). They are ordinary
  routes: the server checks both before it reads a body or picks a route. A page
  on another site can neither start a login nor answer one.
- **Every `POST` requires a JSON body type.** A cross-site form can post without
  a preflight and a form cannot send `application/json`, so the five write routes
  are out of reach of a form. The same reason and the same sentence as
  `POST /api/admin/restart` and `POST /api/admin/secrets/write`.
- **A start is refused over plain HTTP.** The sign-in link a flow returns carries
  the proof that binds the browser's answer to that flow, so the daemon answers
  `403 https_required` when the request arrived under a name that is not loopback
  and `server.publicUrl` does not start with `https:`. A loopback name is the host
  itself and is always accepted.
- **The session id and the answer travel in the body.** The access log records
  `req.url`, so a session id in the query would be written down.
- **No value reaches a log, an audit row or an error sentence.** The sign-in link,
  the pasted string, the API key, and the tokens the flow writes are credential
  material. The routes answer fixed sentences and reason codes only, because a
  library error can carry the provider's response body. A login writes one audit
  row per session with the provider, the login type and the outcome.
- **The session lives in memory.** A daemon restart ends every login, and a
  finished one is dropped ten minutes later.

The daemon holds one login at a time, so these routes cannot be used to run two
flows against one another.

### Extension cards in the page

A runtime extension can put a card in a slot of a page. Two pages open a slot
today: the chat page's `sidebar.bottom` and the usage page's `usage.cards` (see
[extensions.md](./extensions.md#ui-cards)). The card's script runs inside the
page, and the page has the user's rights. A card on the usage page runs with the
same rights as a card on the chat page: what the page can reach, the card can
reach.

- **The script has every right the page has.** It can read the conversation, send
  a message, send a report approval, and call an admin route. The approval path
  cannot tell that a script sent the press, so an approval a card script sends
  reaches the conversation as the user's approval.
- **The `Origin` check does not limit it.** That check refuses a write from
  another site (§8). A request from a script in this page carries this origin,
  so it passes the check.
- **Shadow DOM is not a security boundary.** A script in a card's shadow root
  runs on the page's global object, and it can change elements outside its card.
  `contain: layout paint` limits where a card draws, not what it can do.
- **The style nonce widens `style-src` only.** A response that renders a card
  names one nonce in `style-src`, and that nonce covers the `<style>` elements
  the server inserted into the cards of that response. `script-src` and the
  other directives stay as they are, and an extension's markup cannot carry a
  `style` element or a `style` attribute.
- **Escaping stays the extension's job.** When a card shows text from outside,
  the extension escapes it on the server or sets it with `textContent` in the
  script. The policy stops a script in that text from running, and it does not
  stop a deceptive link or a formatted passage.

An extension's server code already runs in the daemon's process and can do the
same work from there (see [extensions.md](./extensions.md)). A card script opens
a second way to use those rights, and that way sits in the page the user
watches. The protection is the rule that an extension is not installed or
changed without the user's approval. The code does not enforce that rule: the
daemon cannot tell an approved extension from one that was written without
approval.

### Extension pages <a id="extension-pages"></a>

A runtime extension can export `pages`, and the core then serves its pages under
`/ext/<name>/` (see [extensions.md](./extensions.md#ext-pages)). The extension is
inside the security boundary. Its server code runs in the daemon process with the
daemon's rights. Its page is an ordinary same-origin page: the script runs with the
user's rights and can read conversations, send messages, send approvals and call
admin routes, exactly as a card script can. The protection is the rule that an
extension is not installed or changed without the user's approval. The code does
not enforce that rule.

The core builds the document frame (the head, the core theme and the core policy)
and puts the extension's rendered body into it. The core policy forbids inline
scripts, and it applies to an extension page as it applies to a core page.

- **It runs only scripts from files on this origin.** A `<script>` element or an
  `onclick` attribute inside outside text that a page shows, such as a Slack
  message or a Notion page, does not run. Without the policy, such a script would
  run with the user's rights.
- **It loads images only from this origin or `data:`,** and connects only to this
  origin.
- **It does not limit the extension's own script.** That script is a file on this
  origin, so it runs and can call every core API with the user's rights.
- **It does not stop deceptive markup,** such as a misleading link or a formatted
  passage, in outside text. Escaping outside text stays the extension's job: on
  the server, or with `textContent` in the script.
- **The extension registers no path.** The server fixes the routes under
  `/ext/<name>/`, so an extension cannot answer outside its own prefix. The reserved
  sub-paths are `ui/` and `api/`.
- **Cross-site requests.** A page on another site can send a GET to
  `/ext/<name>/api/`, and it cannot read the answer. Its writes carry a foreign
  `Origin`, which the server refuses (§8). The JSON rule (415) also stops a
  cross-site form. An `api` GET must not change state, because the `Origin` check
  skips GET. The code cannot enforce that rule.
- **Isolation was considered and not used.** A sandboxed frame would give the page
  an opaque origin, so its scripts could not send the login cookies or read core
  answers. That stops scripts hidden in outside text. It does not stop the
  extension, whose server code already has the daemon's rights, so the core policy
  takes over the defense against outside text.

### Rich pages <a id="rich-pages"></a>

A rich page is HTML that a model wrote with `share_page`. The model reads internet
text, so the page is untrusted code. Unlike an extension page, it gets no part of
the user's rights. The frame route (`/rich-pages/<id>/frame`) sends a policy that
holds these parts:

- `sandbox allow-scripts allow-forms` without `allow-same-origin` gives the
  document an opaque origin, also when a browser opens it without a frame. It
  allows no popup, no top navigation, no dialog and no download.
- `default-src 'none'` and `connect-src 'none'` block every request of the page,
  the daemon included: fetch, XHR, WebSocket, EventSource, beacons and every file
  type. Images come as `data:` or `blob:` addresses or inline SVG.
- `script-src 'unsafe-inline' 'unsafe-eval'` lets the model's inline code run.
  Every script in the document is model-written, so a nonce would protect nothing,
  and it would block the `onclick` attributes that models write.
- `form-action 'none'` lets a submit event fire and stops the submission.
- `frame-ancestors 'self'` stops another site from framing the page.

The chat page, the report page and the shell send `default-src 'self'`, which also
stops the page from navigating its own frame to an outside address. The page can
navigate its frame to a same-origin address. That is a `GET` without the Lax or
Strict cookies, and no `GET` route writes (§8).

The page cannot call the daemon API, load a daemon file, read or change the page
around it, navigate that page, open a window, submit a form anywhere, or read
cookies and storage. `test/browser/rich-pages.browser.ts` runs a hostile page in a
real browser and counts the requests at the server.

What the page can still do:

- **Send small data to any host through WebRTC.** CSP does not cover it, and the
  browser used in the probe does not enforce `webrtc 'block'`. The same request shows
  the user's IP address to that host. The agent can already send any data it holds
  to any address (see Egress in §8), so the new exposure is what the user types into
  a page.
- **Draw anything inside its own box,** such as a fake button or a form that asks for
  a secret. The caption (`Generated page`) and the shell bar are drawn by the core,
  outside the frame, and the page cannot change them.
- **Use CPU without limit.** A busy loop can freeze the chat tab when the browser
  runs the frame in the same process as the page. The chat unloads a page frame that
  is more than three pane heights from the view, which limits a runaway page to the
  pages near the screen.
- **Navigate itself to an outside address** when a person opens the raw frame address
  as a top-level page in a browser that does not send `Sec-Fetch-Dest`. The route
  redirects a browser that sends it to the shell, and no core link points to the raw
  address.

The tests ran in Chromium only. A page follows the share file lifetime rules (see
[http-api.md](./http-api.md#lifetime-of-stored-files)). No tool deletes one page.

### The pull request dashboard <a id="github-pr-writes"></a>

The `github-pr` extension reads GitHub and, when the operator allows it, writes
to it. Its pages and its API are the routes of
[http-api.md](./http-api.md#github-pr). Five rules hold the write half.

- **One switch, read per request.** `githubPr.writes` is read from the config on
  every call, never from a value held since boot. Off means every write route
  answers `403` before `gh` is started, so nothing reaches GitHub.
- **A write body is JSON.** The five write routes refuse a `Content-Type` that
  is not `application/json` with `415`. A form on another site cannot send that
  type without a preflight, so a cross-site form cannot reach a write at all.
- **The `Origin` check is the shared one.** The routes take the check of every
  write route (§8). A request with no `Origin` header passes it, which is how a
  command line program on the same host reaches a write. Blocking that is a rule
  the agent follows, not a technical gate: the daemon cannot tell an agent's
  `curl` from the operator's.
- **Every write is audited.** One row in `logs/audit.jsonl` names the repository,
  the pull request number and the kind (thread reply, comment, reaction added or
  removed, review with its verdict, thread resolve with the thread id, edit of the
  description or of a comment with the comment id), and never
  the comment's text. The text is the operator's words, and the audit trail is
  not the place for it. A resolve reads the thread first and refuses one that does
  not belong to the pull request in the address, so a request cannot resolve a
  thread of another pull request or repository. An edit reads its target first,
  refuses text that another account wrote, refuses a comment of another pull
  request or repository, and refuses a text that changed on GitHub since the page
  read it (`409`), so it edits only the account's own text and never overwrites a
  change that the page did not show. The write has no precondition on GitHub's
  side, so an edit saved on GitHub between the read and the write is overwritten,
  and GitHub keeps the earlier text in the edit history.
- **`gh` and `git` are called in halves.** The read half refuses a GraphQL
  mutation and any method that is not `GET`. The write half refuses a `GET` and
  requires a mutation or a method of its own. The git half runs an allow-list of
  subcommands, and `push` is not on the list.

The pages widen one directive. The pull request page allows an image from an
`https:` origin, because a description can embed one on a host of its own. The
list page and the diff page, and every page that existed before, keep
`img-src 'self' data:`. No page allows an inline script, and the two JSON data
blocks a page carries are `application/json`, which the browser parses and never
runs.

The pages show text that came from GitHub: a description, comments, review
bodies. That text is untrusted. The page puts it into the document as text or as
sanitized markup, and the policy stops a script inside it from running. It does
not stop a deceptive link or a formatted passage, and the rule that a person
reads a pull request before acting on it is what covers that.

The dashboard keeps a bare repository per fork network under
`~/.pi/sec/gh-repo/`, at mode 0700. It holds history that came from GitHub and
nothing of the operator's own, so a loss costs a fetch and not a document. The
extension never reads or changes a clone of the operator's own.

### Remote machines <a id="remote-machines"></a>

This install may reach other computers over `ssh`. Three things are true of that
path. The first is the one an operator has to accept, and §11 lists it as a
residual risk.

- **The level is a setting, not a boundary.** A machine's level (`off`,
  `restricted`, `on`) is moved by one route, `POST /api/remote-machines/:id/level`,
  and that route cannot tell who called it. The daemon has no authentication of its
  own (§8), the `Origin` check refuses only a request that carries a foreign one,
  and a shell on the same account reaches the route as easily as the page does.
  The route requires a JSON content type, which a form on another site cannot
  send, and it writes one audit row per change, which records that the path was
  called and not who called it. One other writer exists and it is the core's own:
  a machine that stops answering for longer than `remoteMachines.outageSeconds` is
  made `off` by the watch, without a request and without a question, and its audit
  row says `by: "core-outage"` so the two writers are told apart. Neither of them
  widens a level: only the operator's own act with the slider does. The level holds
  the user's intent, and the tools and prompt rules are what keep that intent. The
  approve route has the same trust model, and §11 states it as an accepted residual
  risk.
- **A host key is pinned by hand.** `ssh` is called with `-F /dev/null`, so no
  configuration file of the operator's is read. The only keys `ssh` will accept are
  the ones in `~/.pi/sec/state/remote-machines/known_hosts`, which is a file of its
  own: the operator's `~/.ssh/known_hosts` is never read and never written. A key
  reaches that file only after the operator checked its fingerprint on the machine's
  own console, and `StrictHostKeyChecking=yes` with `UpdateHostKeys=no` means a
  server cannot add or replace one. `accept-new` is used nowhere.
- **A key that changes stops everything.** An `ssh` call that ends in
  `Host key verification failed.` stops every connection to that machine and puts
  one message in the root conversation. So does a machine-id different from the
  expected one. Both stops last until the pinned key or that machine's
  configuration changes, which is an act of the operator's.
- **The core tools hold the level, and only they do.** The nine tools of the
  `remote-machines` extension reach a machine through `src/remote/`, and every one
  of them runs `RemoteMachines.access` before it touches a machine: a machine at
  `off` is refused without an `ssh` call, `remote_sync` is refused at `restricted`,
  and a refused call is answered with the reason and nothing else. `remote_run` at
  `restricted` starts under `nice`, `ionice` and `timeout`, and `remote_level_tighten`
  can only make a level stricter and only from the root. None of that makes the
  level a security boundary: the check is the core's own code, and a process on the
  same account does not have to go through it.

An agent can still run `ssh` with the same account's key through `bash`, and that
path does not pass the level. The tools remove the reason to build one by hand, but
they do not close the path: what closes it is the prompt rule that an agent does not
call `ssh` itself, and that rule is in the `remote-machines` section and in the
common conventions. A prompt rule is not a boundary either, so both statements stand
together: the tools make the checked way the easy way, and the level carries the
operator's intent and not access.

### Untrusted internet content

**Any data fetched from the internet may contain malicious content**, including
text crafted to manipulate the agent. `pi-sec` treats such content as **data,
never as instructions**: the system prompt says so, and results from the `web`
extension are labeled as external. There is no technical prompt-injection filter;
 the controls are the model's instruction hierarchy and the fact that the agent
cannot exceed its own unprivileged account.

---

## 10. Audit <a id="audit"></a>

`~/.pi/sec/logs/audit.jsonl` — one JSON object per event, appended (by
convention) and placed outside `code.workspace` so the agent has no reason to
touch it. It is redacted by the secret registry. Append-only is a convention, not
an OS-enforced guarantee, because the agent runs under the same UID. Every row
carries `time` in epoch milliseconds and a `type`. The file rotates by size
(`audit.maxBytes`, 64 MiB by default) into `<file>.<timestamp>`. The daemon
deletes no rotated file, so `audit.retainDays` changes nothing today.

Recorded events:

- `ask_user` answers (`question_answered`) and withdrawals (`question_withdrawn`):
  the item's key and id, the conversation, and the mode of the answer.
- A secret written through `POST /api/admin/secrets/write` (`secret.write`): the
  name and the byte count. No row records a secret read, and no row carries a
  value.
- A self-edit (`self_edit`): the path, the diff hash, the kind of change and the
  conversation. The durable self-edit record keeps the whole picture: the list of
  files, the diff hash, the validation result, the commit and the restart flag.
  Of those five, the audit row carries the diff hash alone.
- Jobs, reports, drafts, inbox items and subagents: one row per change, with the
  record id and the action (`job_created`, `report_created`, `report_moved`,
  `report_draft`, `inbox_item`, `subagent_spawned`, `subagent_finished`,
  `subagent_waiting`, `subagent_status`, `subagent_deleted`). A refused routine
  change writes `routine_refused` with its code.
- Session restarts: `session_restart_requested`, `session_restart_opened` and
  `session_restart_closed`.
- Restart notices: `restart_notice`, and `restart_notice_skipped` with its
  reason when the notice cannot go out.
- A `request_restart` call writes `restart_required` with the title the caller
  gives and the conversation id. A call that skipped the safe-point check with
  `allowBusyReason` carries `busy bypass: <reason>` and the children it skipped in
  the row's `reasons`.
- Restart from the UI: `restart_launched` (unit and script), and
  `restart_incomplete` when the previous attempt never finished.
- A refused restart: `restart_refused`, written by both the UI launch route and
  the agent's `request_restart`. Every row carries `source` (the path that
  refused: `ui` or `agent`), `code` (the machine-readable reason) and `reasons`
  (one or more reasons a reader can read). The agent path adds `title` and
  `conversationId`, because only it has them. A call that waits for a busy child
  writes the same row with code `safe_point_waiting`, and `reasons` holds one
  entry per child. That call raises no request of its own and leaves whatever the
  restart state already records in place.
- A restart request and its withdrawal: `restart_requested` and
  `restart_withdrawn`.
- `server_start` (pid and origin) and `server_stop` (the signal).
- `config_reload_failed` with the issues that a reload found. A reload that
  succeeds writes no row, and a reload of an extension writes no row either.
- A remote machine: `remote_machine_level` for each level change, with the
  machine, the previous level, the new level and the instant, and `by: "core-outage"`
  with the start of the outage when the watch made the change itself;
  `remote_machine_auto_off` for each such change, with how many runs it stranded and
  their ids; `remote_run_stranded` for each run it stopped watching; `inbox_item` for
  the item it wrote for the user; `remote_machine_blocked` and
  `remote_machine_unblocked` when every connection to one stops or starts again; and
  `remote_machine_notice` for each message this feature puts into a conversation,
  with what became of it (`sent`, or the reason it was skipped).
- `audit_error`, written in place of a row that cannot be serialized.

The audit log holds no row for a tool call, for a secret read, or for a
privileged script that the agent proposes.

The audit log is read via `GET /api/admin/audit` and `pi-sec audit`.

---

## 11. Threat model

| Threat | Control |
|--------|---------|
| Destructive tool use within the pi-sec account | Bounded: the agent runs as a dedicated unprivileged user, separate from the user's own account, and tools run in the same view as the agent. Secrets/tmp isolation and audit limit fallout; the dedicated user is the boundary. |
| Privilege escalation | No elevation path: `NoNewPrivileges`, empty capabilities, no setuid, no `sudo`; privileged work is a user-run script. |
| Credential theft into model context | Secret registry + irreversible one-way redaction (incl. pi-sec's own model credentials). |
| Credential exfiltration via a command | Residual; egress control is the user's host/firewall responsibility. |
| Tmp files mixing with system files | systemd `PrivateTmp=true` (private, restart-cleared `/tmp`) + eager janitor; durable data goes to known storage. |
| An agent or a shell on the same account sets a remote machine's level | Residual, by design: the level route cannot tell a caller from the user, so the level carries intent and not access. Stage 2's tools and prompt rules honour it, and `bash` with the account's own key is closed only by a prompt rule. |
| A remote host presents a different key, or the address reaches another machine | Keys are pinned by hand and `StrictHostKeyChecking=yes` refuses any other; `UpdateHostKeys=no` stops a server from adding one. A mismatch, and a machine-id that differs, stop every connection to that machine until the operator changes the key or the entry. |
| Malicious content from the internet (prompt injection) | Treated as data, not instructions (prompt guidance); no technical filter. |
| Network exposure: a person without permission reaches the web server of the daemon | Controlled outside pi-sec: an authenticating reverse proxy, or a host where only localhost reaches the port. The `Host` and `Origin` checks are secondary measures. They narrow the way another page in a browser reaches the server, and they do not replace the outside control. |
| A core change lands without the user's consent, or an approval is made by someone who is not the user | `request_restart` needs a stored approval on the newest revision of the report it names, naming that revision's sha256, on a live report whose job has not ended, taken in one commit with a latestness check. Anyone reaching the unauthenticated approve route can still press it, so the proxy remains the gate and `via` records the screen, not the identity. |
| Malicious dependency / supply chain | Pinned versions, lockfile, `npm ci`, review before public release. |
| Audit tampering | Redacted and outside the editable tree; append-only by convention (not OS-enforced under one UID). |
| Runaway cost / loops | Usage budgets, retry/compaction limits, scheduler bounds; self-edit is unlimited but gated by the core-candidate review queue. |

**Accepted residual risk:** a capable model with its dedicated user's access can
cause harm within that access. `pi-sec` minimizes credential exposure and tmp
pollution and provides visibility, rather than pretending to sandbox an agent that
was intentionally given a shell and a whole unprivileged account.
