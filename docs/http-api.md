# HTTP & SSE API

Companion to [README.md](./README.md). The web server is `pi-sec`'s primary
interface. It speaks **HTTP + Server-Sent Events**. WebSockets are out of scope.

---

## 1. Design rules

1. **Server-Sent Events for anything streaming.** pi-durable's commit-derived
   event stream maps one-to-one onto SSE.
2. **Everything is committed state.** A reconnecting client receives a fresh
   `snapshot` and continues; nothing needs replay.
3. **No authentication in `pi-sec`.** The server binds loopback only. A reverse
   proxy (or localhost-only access) controls who reaches it. There are no tokens,
   sessions, or login flows inside the daemon.
4. **Idempotent writes.** `POST` bodies accept a `requestId`.
5. **No default timeouts.** Tool calls run until they complete or are aborted,
   and an open `ask_user` question waits until someone answers it or withdraws
   it. Durable tasks survive restarts.
6. **Small payloads, few dependencies.** JSON in/out; `EventSource`-compatible.

---

## 2. Transport and binding

| Setting | Default | Notes |
|---------|---------|-------|
| `server.bind` | `127.0.0.1` | Loopback only; `0.0.0.0` is an explicit opt-in behind a firewall. |
| `server.port` | `8787` | |
| `server.basePath` | `""` | e.g. `/sec` behind a subpath reverse proxy. A **path**, never a URL: the incoming path is expected to still carry it. A value that is not a plain absolute path fails config load. |
| `server.publicUrl` | — | The mount point as a URL. Used to build absolute links, to derive the prefix when nothing else declares one, and to name the `Host` and `Origin` values the server accepts (see §3.1). |
| `server.trustedProxies` | `[]` | IPs or CIDR blocks (`10.0.0.0/8`, `::1/128`) — **no ports**. Only these peers may set `X-Forwarded-*`. An entry that is neither an address nor a block fails config load. |

The **mount point** — the path the app is served under externally — is resolved
per request, first match wins:

1. `X-Forwarded-Prefix`, when the peer is listed in `trustedProxies`;
2. else `server.basePath`;
3. else the path component of `server.publicUrl`.

The forwarded and configured sources are not interchangeable, because they
describe different things about the incoming path:

- A **forwarded prefix** means the proxy already stripped it. The incoming path
  must *not* carry it, or every request would 404. The prefix is re-applied to
  the URLs the server emits (the root redirect) and stamped into the page as
  `<meta name="pi-sec-base">`, so the UI builds its API and SSE URLs for the path
  it is really served from.

  **It is a correctness input, not a display one.** A peer in `trustedProxies`
  that announces a prefix decides every URL the app uses: the page's stamped
  mount, its API and SSE targets, the root redirect. A wrong value there is not
  a cosmetic problem — the app will faithfully ask for paths that do not exist,
  and the proxy answers 404 before the daemon sees anything, which reads as a
  client bug. When this disagrees with the configured mount, the daemon logs
  `mount conflict` once and records it in `/api/admin/status` (`notes`).
- A configured **`basePath`** is still on the incoming path. It is *required* —
  anything outside it is `404` — and stripped before routing. It is a path, never
  a URL: putting `https://host/sec` here used to be discarded in silence, which
  cost the mount point entirely and sent the root redirect to `Location:
  /basic-chat` — outside the proxy. That value is now a config-load error that
  names `publicUrl` as the right home for it.
- **`publicUrl`** declares the mount without saying anything about the incoming
  path, so it is what a stripping proxy that announces nothing needs. It is also
  the fallback that keeps the root redirect correct when neither of the other two
  sources is usable.

A bare `/` is redirected to `<prefix>/basic-chat` regardless of arrangement —
including when the prefix is still attached (`/sec/`) and when a `basePath` is
configured and the request arrives without it. Both used to be a `404`.

A proxy that forwards the prefix *without* stripping it also works: the prefix
is stripped from the path when it is present.

A forwarded prefix that is not a plain absolute path (`//host`, `..`, embedded
whitespace, a scheme, percent-escapes) is **rejected and ignored**. This matters:
the value lands in a `Location` header and in the served HTML, so a
misconfigured proxy must not be able to steer either.

The forwarded client identity (`X-Forwarded-For`) is recorded in the access log
as `remote`, with the proxy socket kept as `peer`. It is used **only for display
and audit** — never as a security gate. `X-Forwarded-*` is ignored entirely
unless the peer matches `trustedProxies`, which is empty by default.

### Reverse-proxy requirements (SSE)

- Disable response buffering (`proxy_buffering off;`) and honor
  `X-Accel-Buffering: no` (server sends it). The daemon compresses a stream that
  asked for gzip (§3.2), so a proxy must not compress `text/event-stream` again:
  disable gzip for that type there.
- Raise `proxy_read_timeout` (e.g. 1h); the server sends heartbeats every 15s.
- Preserve the path prefix and set `basePath` to it; **or** strip the prefix and
send `X-Forwarded-Prefix` (with the proxy's address in `trustedProxies`); **or**
strip the prefix, send nothing, and set `publicUrl` to the external URL. Any of
the three works; see above for how they differ.

Reference nginx snippet in [security.md](./security.md#reverse-proxy).

---

## 3. Common response conventions

- JSON errors: `{ "error": { "code": "…", "message": "…", "requestId": "…" } }`
  with status `400`, `403`, `404`, `409`, `413`, `415`, `421`, `500`.
- `409` with `code: "conversation_busy"` maps pi-durable's `ConversationBusy`.
- `202 Accepted` for admitted async work: `{ "requestId": "…", "status": "accepted", …ids }`.
- `201 Created` for new resources: the created resource, e.g. `{ "id": "…" }`.
- Every response carries `X-Request-Id`. There is no `Retry-After` header: the
  daemon has no request rate limit and no queue the client is asked to wait for.
  A proxy in front of the daemon can add a rate limit, and that is where one
  belongs.

### 3.1 `Host` and `Origin` refusals

Two checks run before any route, after the mount point is resolved and before the
body is read. A request that either check refuses runs no handler.

| Status | Code | When |
|--------|------|------|
| `421` | `misdirected` | The hostname in `Host` is neither the hostname of `server.publicUrl` nor a loopback name (`127.0.0.1`, `localhost`, `::1`). With no `server.publicUrl`, or with a value that is not a URL, only the loopback names pass. The body is `{ "error": { "code": "misdirected", "message": "host not allowed", "requestId": "…" } }`. |
| `403` | `origin_forbidden` | The method is not `GET` or `HEAD`, and the `Origin` header is present but is not the origin of `server.publicUrl` nor a loopback origin on the port the request arrived on. The message is `origin not allowed`. |

A request with no `Origin` header passes the second check. The CLI, the scripts and
the tests send none. A browser sends `Origin` on every cross-site write, so the
exception opens no browser path. A value that is not an origin is refused, and
that includes `null`. `OPTIONS` takes the check like any other method, because the
server answers no preflight.

`GET /basic-chat/events`, `GET /basic-chat/context` and `GET
/basic-chat/history` stay outside the `Origin` check like every `GET`, and they
write nothing. The daemon prepares the root conversation at boot, and the write
routes of §5 prepare it before they act. If the root conversation is missing, all
three `GET` routes answer `503` with the code `root_missing`.

An install whose browser reaches the daemon by another name or port sets
`server.publicUrl` to that address. Without it, `Host` accepts loopback names only
and `Origin` accepts loopback origins only.

### 3.2 Compression and validators

A response is compressed with gzip when the request carries an `Accept-Encoding`
that accepts it: `gzip`, or `x-gzip`, with a quality value above zero.
`gzip;q=0` is a refusal and is answered uncompressed. Brotli is not offered.

| Body | Compressed when |
|------|-----------------|
| A page (`/basic-chat`, `/chats`, `/report`, `/usage`, `/usage/stats`) | The type is HTML. |
| A static asset (`*.js`, `*.css`, `*.svg`, `*.json`, `*.map`) | The type is one of those, and the file is at least 1 KB. |
| A JSON answer | The body is at least 1 KB. |
| An event stream (SSE) | Always, once the request accepts gzip. |

A compressed response carries `Content-Encoding: gzip` and the length of what is
actually sent. An answer over a compressible type carries `Vary:
Accept-Encoding` whether it was compressed or not, so a cache cannot hand a
gzipped body to a client that cannot read it. The stream's
`Cache-Control: no-cache, no-transform` and `X-Accel-Buffering: no` are sent
either way: the framing is the server's, and a proxy must not buffer it.

A static asset also carries a weak `ETag` built from its content. A request whose
`If-None-Match` names that tag (one tag, a comma list, or `*`) is answered `304`
with no body, and the `ETag`, `Cache-Control` and `Vary` headers are repeated.
`Cache-Control: no-cache` stays on a `200`, so the browser asks again every time
and a file that changed by a Restart UI or a daemon restart reaches the next load
at once.

The compressed bytes of an asset are kept for one version of the file, keyed by
its modification time and size, so a refresh neither hashes nor compresses
anything.

---

## 4. Health

```http
GET /healthz
200 { "status": "ok", "version": "0.1.0", "apiVersion": 1, "uptimeMs": 123456, "scheduler": "running" }
```

The answer is the same for every caller: the route reports that the process is
answering. It checks no store and no model. It never returns another status, and
it reveals no secret.

---

## 5. Basic chat (MVP) <a id="basic-chat"></a>

The simplest chat surface, backed by one fixed default conversation. It is the
first thing a human uses.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/basic-chat` | Serve the chat UI (see [ui.md](./ui.md)). |
| `GET` | `/basic-chat/events` | SSE stream of the default conversation. |
| `GET` | `/basic-chat/context` | How full the context is, for the UI's bar and readout. |
| `GET` | `/basic-chat/history` | One earlier session of the default conversation (`?before=`). |
| `POST` | `/basic-chat/messages` | Admit a user message. |
| `POST` | `/basic-chat/abort` | Abort the current run. |
| `POST` | `/basic-chat/reset` | Start a new context (session restart). |
| `POST` | `/basic-chat/compact` | Compress older context (manual compaction). |

The two `GET` routes only read. If the root conversation is missing, they answer
`503` `{ "error": { "code": "root_missing", ... } }`. The daemon prepares the root
conversation at boot, so this happens only when that preparation failed. A `POST`
route of this table creates the root conversation before it acts.

In setup mode (see §11, "Model setup") no root conversation exists and none can be
created. The `GET` routes answer `503 root_missing`. Every `POST` route of this
table, and `POST /api/focused-chats`, answers `409` with the code
`model_not_configured` and the message ``No model is set up yet. Choose one on the web page, or run `pi-sec setup-model --provider <id> --model <id>` on the server and then load the configuration.`` The daemon keeps running, and `pi-sec send` prints the same refusal.

### 5.1 Messages

```jsonc
// POST /basic-chat/messages
{
  "content": "summarize my unread mail",
  "whenBusy": "follow-up",     // "follow-up" | "steer" | "reject"
  "requestId": "uuid"          // optional idempotency key
}
// 202
{ "requestId": "uuid", "status": "accepted", "submissionId": "01J...", "conversationId": "01J...",
  "held": true }                // present only while a usage limit holds the conversation
```

While a provider's usage limit holds the conversation, the message is stored in the
transcript and starts no run: the retry that follows the provider's recovery carries
it in order. The answer adds `"held": true` then, so the page can tell the operator
that the text waits. The field is absent otherwise. Only these two operator routes
carry it: a note from another agent, a scheduled run and a tool result are recorded
the same way and announce nothing, because nobody reads a page for them.

### 5.2 Reset (session restart)

`reset` starts a new model context. Older entries are **not deleted** — they stay
in durable storage and can be revisited; the model simply stops seeing them.

```jsonc
// POST /basic-chat/reset
{ "handoff": "We were debugging the backup script.",  // optional note into new context
  "force": true }                                       // optional: reset while sub-agents work
// 202 { "requestId": "uuid", "status": "accepted" }
```

While the conversation is busy, the reset is queued like a write and placed at the
next boundary; during a tool round it ends the current run. The stream then carries
the reset entry as a live frame, not a new snapshot. The web page reopens its stream
when such an entry arrives, so it redraws from a fresh `snapshot` whose `entries`
begin at the reset.

If a sub-agent under the conversation is working, the server refuses the reset
unless the body carries `"force": true`. A sub-agent counts when its agent record
has kind `subagent`, it descends from the conversation (a child, a grandchild, and
so on), and it has a run in progress now. An agent that waits for orders does not
count, but a working agent under it does. The refusal names the working agents:

```jsonc
// 409
{ "error": { "code": "agents_working", "message": "2 sub-agents are working", "requestId": "uuid" },
  "agents": [{ "conversationId": "12", "name": "orch-example" }, { "conversationId": "14", "name": "worker-example" }] }
```

Send the request again with `"force": true` to reset anyway. The agents keep
running and report to the new session.

`GET /basic-chat` exposes a **New session** button that calls this. When the answer
is 409 `agents_working`, the page asks a second time and names the working agents.
If you confirm, the page sends the reset again with `"force": true`. The UI can
also offer "keep a handoff note" for continuity.

### 5.3 Compact (context compression)

pi-durable compaction summarizes older entries and appends a `pi.compaction`
entry that heads the first entry it keeps. Older entries remain in storage.

- **Automatic (threshold)**: when context approaches the window, generation
  compacts before the request.
- **Background**: pi-durable also starts a compaction ahead of the blocking
  threshold (`backgroundTokens`) while the conversation keeps working, so a
  summary is usually ready before the context fills. Running background
  compactions are listed in `pi.live.compactions` and emit
  `compaction_start`/`compaction_end` (`reason: "threshold"`). This is a systemic
  harness task, not a job.
- **Overflow**: if the provider rejects an over-long request, generation compacts
  and retries once (`reason: "overflow"`).
- **Manual**: `POST /basic-chat/compact` with optional instructions.

```jsonc
// POST /basic-chat/compact
{ "instructions": "Keep the failing test names" }   // optional
// 202 { "requestId": "uuid", "status": "accepted", "taskId": "01J..." }
```

The UI renders `compaction_start` / `compaction_end` events as a status line
("compressing context…"). A summary that would cut before the current context
settles as `stale` and is ignored (the furthest cut stays in effect). `abort`
cancels a manual compaction.

### 5.4 Basic chat event flow

```text
GET /basic-chat/events
→ 200 text/event-stream
id: 1
event: snapshot
data: {"type":"snapshot","entries":[...],"inbox":[],"agent":{...},"usage":{...}}

POST /basic-chat/messages {"content":"hello"}
→ 202 {"requestId":"uuid","status":"accepted","submissionId":"01J..."}

event: run_start
event: message_start
event: message_end
event: run_end
```

The chat streams do not send `message_update`. The page draws the answer whole at
`message_end`, and every frame wakes the browser, so the per-partial frame told
the page nothing. `message_start` marks the start of an answer and `message_end`
carries the whole message. A client that needs the text written so far reads
`generation.message` from the snapshot, and reconnecting gives a fresh snapshot.
The event exists in pi-durable. pi-sec does not forward it on these streams.

#### The entries on the stream are slimmed

The conversation stream (`/basic-chat/events` and
`/api/conversations/:id/events`) serves the chat page, and the page draws far
less than an entry holds. The five frames that carry an entry or a message
(`snapshot`, `entry_appended`, `message_end`, `message_start`, and
`tool_execution_end`) therefore carry a copy with these fields removed:

- the `model` of a `pi.system` entry is empty. The entry keeps its place, because
  the page orders and keys rows by entry id, but its `sections` and `toolsAdded`
  are gone.
- on a `system` message: `sections` and `toolsAdded`.
- on an `assistant` message: every `thinking` block (the thinking text and its
  `thinkingSignature`, redacted thinking included), the `arguments` of every
  `toolCall` block (the call keeps `type`, `id` and `name`), and the message's
  `usage`.
- on a `toolResult` message: `details`. An edit result holds the same change
  twice there, as `diff` and `patch`.

A `tool_execution_update` frame drops the `details` of its partial result too,
because the page reads only the result's text.

Tool-result text is kept whole, because the page shows it inside a fold. The
snapshot's own fields (`tools`, `compactions`, `usage`, `agent`, `generation`,
`run`) are unchanged, and the attachment descriptors are computed from the same
entries. A frame whose shape is not named here is sent as it arrived. The stored
transcript is not touched: `GET /api/conversations/:id` still returns the full
entries.

### 5.5 Compaction event flow

```text
POST /basic-chat/compact
→ 202 {"requestId":"uuid","status":"accepted","taskId":"..."}

event: compaction_start
data: {"type":"compaction_start","taskId":"01J...","reason":"manual","blocking":false}
event: compaction_end
data: {"type":"compaction_end","taskId":"01J...","reason":"manual"}
```

If the conversation is busy, the summary is placed at the next turn boundary;
`compaction_end` arrives when it is applied. Automatic compaction emits the same
events with `reason: "threshold"` or `"overflow"`.

### 5.6 Context usage

`GET /basic-chat/context` reports what the `usage` tool reports, for the page:
the size of the last request the provider answered in this context, against the
point where compaction fires.

```jsonc
// GET /basic-chat/context
{
  "used": 10659,        // input + cacheRead + cacheWrite of the newest answer; null before one
  "max": 983616,        // contextWindow - reserveTokens: the usable maximum, where compaction fires
  "window": 1000000,    // the model's contextWindow; null when the model is not in the catalog
  "reserveTokens": 16384
}
```

The page fills a thin bar above the composer with `used / max` and prints both
numbers in the sidebar. `max`, not `window`, is the denominator: a full bar means
compaction is next, and the window is in the bar's hover text for when the
difference matters. A caller that only wants the numbers can read them here; the
agent reads the same values with the `usage` tool.

### 5.7 The page and its card slots

`GET /basic-chat` answers the shell of the chat page, and the server fills the
page's card slots before it sends the shell (see
[extensions.md](./extensions.md#ui-cards)). `GET /usage` does the same for its own
slot (§8). A card that renders nothing puts nothing in its slot.

The chat page carries one more JSON data block, `<script type="application/json"
id="pages-links">`. It holds the page links of the enabled bundled extensions, in
catalog order, as a list of `{ "label": …, "path": … }` objects, and it is empty
when none declares one. The server builds the list once, when it starts, from
the same read of `agent.extensions.enabled` that decides which extension routes
it registers, so a link is written exactly while the page behind it answers. The
server writes every `<` in the block as `\u003c`, the way §8's `usage-first` block
does, so no label can end the element early. The sidebar's Pages menu draws one
link per entry after its three own, and a page with no block draws the three
alone. [extensions.md](./extensions.md#extension-pages) has the rules an entry
follows.

A response that renders at least one card adds one value to the policy:

```http
Content-Security-Policy: default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'nonce-<value>'; script-src 'self'
```

The value is new for every response, and it appears in `style-src` only, for the
card styles the server inserted. `script-src` and every other directive stay as
they are. A response that renders no card carries the policy without the value,
`style-src 'self'`.

### 5.8 The page for a focused chat

The chat page shows one focused chat when its address carries `?chat=<id>`:
`GET /basic-chat?chat=42`. The route serves the same shell for every value and
reads no query parameter. The page reads the number itself, and every conversation
route it uses becomes `/api/conversations/<id>/...` (§6): the events stream, the
context read, messages, abort, reset and compact.

An address with no `chat` value is the root conversation, as before. A number the
server does not know as a focused chat opens no stream: the page reads the chat
first with `GET /api/focused-chats/:id`, and a 404 draws the not-found view (see
[ui.md](./ui.md)). The root's own number is refused there, so a page cannot show
the root through the focused chat route.

The chats list is a second page, `GET /chats`. It is served the way `/report` is,
with its assets stamped with the mount prefix, and it reads the lists and the
event stream over the routes in §6.

### 5.9 One earlier session

The chat page draws the active context alone: the snapshot it opens with starts
at the newest head marker, so everything a session restart left behind is stored
and not sent. This route hands one of those sessions back, so the transcript can
show it above the session on screen without touching the model's context.

| Method | Path |
|--------|------|
| `GET` | `/basic-chat/history?before=<entry id>` |
| `GET` | `/api/conversations/:id/history?before=<entry id>` |

`before` is the smallest entry id the page holds. The server walks back from the
entry just before it and stops at a session restart (`pi.reset`); that entry
opens the session, and the conversation's first entry ends the walk when no
restart is left. A compaction's marker is not a boundary: the entries a
compaction dropped sit inside the session that holds them, so the press brings
them along.

```jsonc
// GET /api/conversations/42/history?before=481416
{
  "entries": [ /* oldest first, the session restart first of all */ ],
  "attachments": { "<attachment id>": { "name": "…", "mime": "…", "bytes": 0 } },
  "hasMore": true,   // something is stored before the first entry answered
  "apiVersion": 1
}
```

The entries are slimmed exactly as the stream slims them (§5.4), so a page that
draws a loaded session and a page that draws a live one hold the same shape. The
`attachments` map is what lets a picture in a loaded message be drawn as a
picture rather than as a chip.

One answer holds 4 MB of entries at most. A session larger than that is answered
newest first in as many pieces as it takes, with `hasMore` true, and the page puts
its button back above the part it received so the next press fetches the rest. At
least one entry is always answered, so a press always moves.

Both routes read and write nothing: no entry is created, and the model's context
is unchanged. `before` that is missing or not a positive entry id answers `400
invalid_request`; a conversation that is not stored answers `404 not_found`; a
place with nothing before it answers an empty list with `hasMore` false.

The conversation stream's `snapshot` frame also carries `hasEarlier`, which is
whether the conversation stores anything before the first entry the frame holds.
It is optional, and a page that does not read it draws the transcript it drew
before. It exists so the button is drawn with the rows instead of being added
above them afterwards, which would push what the reader was reading down by the
button's own height. Adding an optional field is an additive change, so it does
not move the API revision (§13).

---

## 6. Conversations (full API)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/conversations` | List (`?cursor=`). |
| `POST` | `/api/conversations` | Create. |
| `GET` | `/api/conversations/:id` | Structural snapshot (`?cursor=`, `?limit=` for older entries). |
| `GET` | `/api/conversations/:id/events` | SSE stream. |
| `GET` | `/api/conversations/:id/history` | One earlier session (`?before=`). Same answer as `/basic-chat/history` (§5.9). |
| `POST` | `/api/conversations/:id/messages` | Submit input. `attachmentIds` can ride beside `content`. |
| `POST` | `/api/conversations/:id/abort` | Abort current work. |
| `POST` | `/api/conversations/:id/reset` | Reset context. Same body and same 409 `agents_working` answer as `/basic-chat/reset` (§5.2). |
| `POST` | `/api/conversations/:id/compact` | Manual compaction. |
| `GET` | `/api/conversations/:id/context` | How full the context is. Same answer as `/basic-chat/context` (§5.6). |
| `PATCH` | `/api/conversations/:id/agent` | `configure()` model/thinking/extensions/tools/cwd. |
| `POST` | `/api/conversations/:id/forks` | Fork at an entry: `{ atEntryId, title? }` → `201 { conversationId, forkedAtEntryId }`. |
| `GET` | `/api/conversations/:id/tasks` | Task graph. |

`GET /api/conversations/:id` returns the conversation's agent and its stored
entries, so clients can render without opening a stream. The answer has seven
fields: `id`, `apiVersion`, `agent`, `attachments`, `entries`, `entriesCursor`,
and `hasMore`. It is not the stream's snapshot: the snapshot's `tools`,
`compactions`, `usage`, `inbox`, `generation`, and `run` come only on the stream.
Its `entries` are the full stored ones; the stream of the same conversation
carries slimmed copies (§5.4). The `entries` are a bounded recent window (newest
last) with `entriesCursor`/`hasMore`; page older entries with `?cursor=`. A
**fork** is a new conversation whose initial context is the immutable entry
prefix up to `atEntryId` — no entries are copied, the source conversation is
unchanged, and append-only entries are shared by reference.

`GET /api/conversations/:id/context` answers `{ used, max, window, reserveTokens }`,
the same four fields as `/basic-chat/context` (§5.6), for any conversation. It
answers for an archived focused chat as well, because reading a finished chat is
allowed, and it answers `404 chat_deleted` for a deleted one.

`POST /api/conversations/:id/messages` takes `attachmentIds` beside `content`,
`whenBusy` and `requestId`: an array of the ids that `/api/attachments` upload
returned. The route builds the same envelope attribute as `/basic-chat/messages`,
so a message carries its files on either page.

The answer is the same 202 body, `held` included when the conversation waits for its
provider (§5.1).

Four write routes refuse a focused chat that stopped taking writes, and they
answer alike because a chat that refuses a message but accepts a reset is a chat
the user cannot trust to be finished: messages, abort, reset and compact. An
archived chat answers `409 chat_archived`. A deleted chat answers `404
chat_deleted`.

A conversation made with `POST /api/conversations` carries no model, so a message
sent to it cannot be answered: every turn fails with `no_model`. A conversation
that has to answer is created by a spawn, by the scheduler, or as a focused chat,
and each of those writes a model into the creating commit.

This is the general API used by `/basic-chat` and by future channels.
**`/basic-chat` is the only first-party channel for now**; the conversation API
underneath exists so additional channels (CLI, bots, alternate UIs) can be added
later without changing the core.

### Jobs

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/jobs` | Job list and tree (`?status=`, `?parentId=`, `?cursor=`, `?shape=tree`). |
| `GET` | `/api/jobs/:id` | Full job record: subjobs, memory anchors, state dir, conversation/task links, run stats. |
| `GET` | `/api/jobs/events` | SSE job lifecycle events. |
| `POST` | `/api/jobs` | Create `{ title, description?, parentId?, labels?, memoryAnchors?, stateDir?, conversationId?, routine?, once?, reportId? }` → `201 { id, ... }`. |
| `PATCH` | `/api/jobs/:id` | Update fields/status, `routine`, `once`, and `reportId`. Takes no `parentId`. The tool `jobs_update` is what moves a job under another parent. A status that ends the job drops its pending drafts, and the reply carries them as `droppedDrafts`. |
| `POST` | `/api/jobs/:id/cancel` | Cancel a job and its descendants that are not finished. A job that carries `routine` needs `reportId`, and so does a cancel that reaches an open descendant that carries `routine`. A cancel drops the pending drafts of every job it cancelled, and the reply carries them as `droppedDrafts`. |

A job is the highest unit of work the agent has taken on; `parentId`/subjobs are
the only hierarchy. See [architecture.md](./architecture.md#job-registry).

A job record carries the schedule. `routine` is a recurring schedule and `once`
is a single run at `at`. `POST /api/jobs` and `PATCH /api/jobs/:id` accept both,
every read returns them as stored, and a job carries one of them or neither. A
write that sets both is refused. `config.scheduler.jobs` is a migration input:
the boot migration moves it onto records once, empties it, and the scheduler reads
records only. See [architecture.md](./architecture.md#scheduling).

`GET /api/jobs`, the `snapshot` event that opens `/api/jobs/events`, and the
response to `POST /api/admin/reload` carry `legacyScheduleProblem` (`string |
null`). A non-null value means `config.scheduler.jobs` is not empty, so the
scheduler ignored that list: the text names the entries it ignored and says to
fix `routine` on the record. The jobs panel draws it as a banner.

A write that creates, changes, or removes `routine` takes `reportId`, and so does
a status change on a job that carries `routine`, including a cancel. The report
must have an approval on its newest revision, and the approval must carry the
same `sha256` as that revision. A job with `once` only, and a job with no
schedule, needs no `reportId`. A refused write changes nothing and returns the
reason: which report and revision is missing, or that the approval is stale.

A refusal for a missing or a stale approval answers `403`, in the JSON error shape
every route uses, and `code` is one of `report_id_required`,
`report_not_found`, `report_not_active`, `no_approval`, `stale_revision`,
`approval_sha256_mismatch`, and `report_store_unavailable`. A body whose shape is
wrong answers `400 invalid_request`: a cron expression the parser refuses, an
`at` that is not in the future, and a body that carries `routine` and `once`
together.

`POST /api/jobs/:id/cancel` cancels the job and every descendant that is not
`done`, `failed` or `cancelled`, in one commit. A descendant that already
finished keeps its status and its `completedAt`, and an open job below a
finished one is still cancelled. When an open descendant carries `routine`, the
gate counts it as one more reason, so one approved `reportId` closes the job and
that descendant together. Without the approval the route answers `403` and
cancels nothing. The route emits `job_updated` for the job and for each
descendant it cancelled. The tool `jobs_cancel` runs the same cancel, with one
difference: it refuses the whole call when an open descendant carries
`routine`, so that job is closed first with its own approval.

`routine` and `once` follow the tool's validation. `cron` goes through the parser
the scheduler uses at every tick, `timezone` through `Intl`, and `at` must be a
future instant on create. A past `at` is refused at create, because a run set for
a time that has passed either fires at once or is dropped as missed.

A job id is `YYYYMMDD-<ULID>`: sortable, and legible when read off the store by
hand. Finished jobs are moved out of the live store after `archive.afterDays`
(default 3) into a separate database. The move runs in a sweep that starts once a
day at `archive.sweepAt` (default `05:00`, read in the harness `timezone`). A
daemon that was stopped at that time skips the day instead of catching up, so the
move happens within one day of the retention window closing. `GET
/api/jobs/:id` still resolves an archived id — `?includeArchived=true` on the
list returns them too. A job that carries `routine` is never moved: the schedule
lives on that record.

`GET /api/jobs` answers the same records twice: the flat `jobs` array and the
`tree` the page draws. `?shape=tree` drops the flat array and answers `tree`,
`legacyScheduleProblem`, and `archived` when `includeArchived=true` was asked
for. The `working` markers are derived from the same set of jobs either way, so
the two forms cannot disagree. Without the parameter both forms come back, which
is what a caller that reads the flat list keeps getting.

A job in `GET /api/jobs` (the `jobs` list and the `tree` nodes), in `GET
/api/jobs/:id` (the record and its `subjobs`), and in the `/api/jobs/events`
`snapshot` carries a derived `working` array: one `{ conversationId, name }` entry
per agent that is **running on that job right now**, and an empty array when
nobody is. The field is read-only and never changes a job's `status`, which keeps
whatever the record says. The entry exists only while the agent is in a model
request or a tool call, so a worker parked on `await_orders` is not listed, and
neither is one whose agent record was retired.

An agent is joined to a job two ways, and both are read. `jobId` is a handover:
the job's `conversationId` moves to the agent. `forJobId` is the same statement
without the handover: the job keeps its owner, and the agent is listed here while
it runs. A planner or a worker started for one job carries `forJobId`, so the
marker appears on that job while the planner or the worker works. The job events
that a run boundary emits (`job_updated` when an agent is created, when a message
starts its run, when it parks, and when it ends) are emitted for both jobs.

### Preferences

The UI state that every browser must show the same is kept on the server, in
`sec.settings`, so it survives a reload, a cleared browser store, and the next
device. It has three parts: the lists that decide what the user does *not* see
(jobs cleared off the list, job titles opened, job groups folded, inbox items
cleared, and the hides each list can still undo), the theme, and the folded
sidebar panels. `localStorage` is per device, and a failed write there was
silent: the rows simply came back on the next load.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/preferences` | The six lists, `theme` and the two fold lists when set, and `uiRevision`. |
| `PATCH` | `/api/preferences` | Replace the fields given, in `{ hiddenJobs?, expandedJobs?, collapsedJobs?, clearedInbox?, revertQueueJobs?, revertQueueInbox?, theme?, foldedWide?, foldedNarrow?, baseRevision?, seedOnly? }`. |

A patch leaves the fields it does not name alone, `sec.settings.notes` included,
so two clients toggling different fields cannot lose each other's work. Ids are
strings that need not exist — an id that names nothing matches nothing — and
duplicates and blanks are dropped. A field that is not a list of strings is
refused with `400` rather than dropped, because dropping it would put the
browser back to showing rows the user had cleared.

The two revert queues, `revertQueueJobs` for the job tree and `revertQueueInbox`
for the inbox, hold the ids a revert button can still restore, oldest first. Each
queue holds at most ten ids: a write that carries more drops the oldest entry,
because a revert reads the newest. The other lists keep the shared cap of
2000 ids and drop the entries over it.

`theme` is one of `auto`, `light` and `dark`. `foldedWide` and `foldedNarrow` are
lists of panel names from `inbox`, `jobs` and `machines`, one for screens wider
than 860px and one for narrower screens. The store keeps a fold list in the
sidebar's order. Any other theme, or a fold name outside the three, is refused
with `400`. `theme`, `foldedWide` and `foldedNarrow` are absent from the answer
until a browser has chosen them, and an absent field means "no shared choice
yet". The document version stays 1 and every new field is optional, so an older
build still reads the document.

`uiRevision` is a whole number that rises by one on every write that changes a
UI field, and stays where it is for a write that changes nothing. A patch may
carry `baseRevision`, the revision the client last saw. If the stored revision is
higher, the server writes nothing and answers `409` with the usual error envelope
(`code` is `preferences_conflict`) and the current state in `current`. The page
applies the same press to `current` and sends again, three tries at most. A patch
without `baseRevision` is accepted as before. The comparison and the write happen
in one commit, so two clients that write together cannot both succeed on the same
revision.

`seedOnly: true` applies `theme`, `foldedWide` and `foldedNarrow` only where the
document holds none yet. A page uses it to carry the value its browser kept
before the server held one, so the first browser wins and the others adopt it.

Every write that changes a UI field emits one `preferences_updated` event, whose
data is `{ revision }` and nothing else. The conversation streams carry it as a
control event, and the chats list stream (`/api/focused-chats/events`) carries it
too. The event names the change and the page reads the state back, as it does for
`inbox_item`.

The pages that carry the theme (`/basic-chat`, `/chats`, `/report`, `/usage`,
`/usage/stats`) are served with the stored theme in `<html data-theme>` and the
theme, the two fold lists and the revision in
`<meta name="pi-sec-preferences">`, both escaped. A store with no theme leaves
`auto`.

### Reports

A report is a long document owned by a job, kept because a plan or a write-up
does not belong in a transcript. It has an append-only revision history, so two
revisions can be compared; the bodies live on disk, one file per revision.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/report` | The report list page (active, finished, archive). |
| `GET` | `/report/<slug>` | The viewer for one report. |
| `GET` | `/api/reports` | `?jobId=`, `?includeArchived=true`. Each entry carries a derived `active` flag and a `status` word (`active`, `result`, `briefing`, `pending`, `inactive`, or `archived`). |
| `POST` | `/api/reports` | Create `{ jobId, title, content, name?, note?, kind? }` → `201`, publishing revision 1. `kind` is `plan`, `result` or `briefing`, and an absent value is a plan. A `briefing` moves every earlier briefing into the archive, as `reports_create` does. |
| `GET` | `/api/reports/by-name/:name` | Resolve a slug. Live first, then the archive. |
| `GET` | `/api/reports/:id` | Record, revisions, and feedback. |
| `GET` | `/api/reports/:id/versions/:n` | One revision's body, as `text/markdown`. Absent body → `410`. |
| `POST` | `/api/reports/:id/versions` | Append `{ content, note? }` and clear the `pending` flag. Revisions are never overwritten. |
| `GET` | `/api/reports/:id/diff?from=&to=` | Unified-style line diff between two revisions. A line paired with one on the other side carries `segments`, its pieces in order with a `changed` flag, and joining them gives the line back. `wordDiffTruncated` says a size limit left some pairs whole. |
| `POST` | `/api/reports/:id/feedback` | Record `{ body, version? }`, then push it into the conversation as a review input. The same commit sets the report aside as `pending`. See below. |
| `POST` | `/api/reports/:id/approve` | Record `{ version, via? }` as an approval of that revision, then push it into the conversation. The same commit sets the report aside as `pending`. See below. |
| `POST` | `/api/reports/:id/done` | The approve button of a result report. Record `{ version, via?, text? }` as an approval of that revision, and push it into the conversation. Refuses a plan. See below. |

A report has one of **three kinds**, `plan`, `result` or `briefing`. A plan asks
the user to approve work that has not started, and the viewer shows it with the
Approve button. A result report tells the user about work that already ran, and
the viewer shows it with Done and Feedback from the start. A briefing report
carries the morning briefing: the root writes it with `reports_create`, it asks
for no approval, so the viewer shows Feedback alone, and the list shows it at the
top under `Briefing`. The kind is stored as an optional `kind` on the record and
on a draft, `plan` is the absent value, and the family schema version does not
change: a report written before the field reads as a plan. The author of a draft
names the kind, the root can set another one when it publishes, and a revision
inherits the kind of its report. Only `reports_create` and `POST /api/reports`
take `briefing`: `reports_draft` and `reports_publish_draft` refuse it, because
the root writes a briefing itself and no draft stands behind one. The kind travels
with the report into the archive. Nothing derives it from the title.

A briefing asks for no approval, so both approval routes refuse it with the code
`briefing` (409), and so does `reports_set_pending` with `pending: true`; an
`answer` is accepted. A briefing also cannot clear a gate that asks for an
approved report: the gate answers `report_is_briefing` rather than `no_approval`.

Writing a briefing report **moves every earlier briefing report** into the archive,
with the inbox notices that point at it and with every inbox notice of kind
`briefing`. The steps are the ones the archive sweep takes, one report at a time:
a copy of the record and the notices into the archive database, a rename of the
body directory, and a retire of the live records. The archived record carries
`archivedAt`, which is what tells `reportStanding()` the report left on its own
rather than with its job; an archived briefing still resolves by its id through
`reports_get` and `GET /api/reports/:id`, and it takes no feedback and no answer.
A crash between the copy and the retire leaves the report live and archived at
once, and the next briefing moves it again: every step is idempotent. Each move
writes one `report_archived` audit row with the reason `briefing-archived`.

The archive database holds inbox notices as well. Nothing reads them out, and no
screen shows them, so a moved notice is a record rather than an item on screen.

A report's name is `YYMMDD-<slug>`: the local day of its creation, then the
title. The day is in the slug and never in the title, so a title that repeats
on another day gets its own address instead of a `-2`. A report keeps the name
it was created with: existing reports are not renamed, and a draft published
later is stamped with the day it is published.

A report has **one stored fact about its standing**: the `pending` flag. Everything
else is derived from its job and from the text the user has already answered. A
report is live exactly while its job is live, so a finished or cancelled job
deactivates it with nothing to keep in step, and a reopened job reactivates it. A
report goes to the archive when its job does.

The word `result` is a result report that still waits for the user: its newest
revision carries no approval, and no feedback on it waits for an answer. A result
report in that state is not pushed below the pending section, because the user has
something to do with it, and `reports_set_pending` refuses to set it aside.

`pending` means the user has set the report aside: it is not finished, and the
Active list stops asking about it. An approval sets it in the same commit that
records the approval, and user feedback on the report sets it in the same
commit that stores the note. An agent's own note on the report does not: it is not
the user's answer. `reports_set_pending` sets or clears it. Appending a
revision clears it, and so does bringing the report back with an answer, which
writes a notice of its own. A new revision carries no approval, so the report is
waiting on an approval again. One commit writes the revision and clears the flag,
so no read sees the two disagree. No job transition touches the flag, and it ranks
below the job in the derivation, so a finished report stays finished whatever the
flag says and a reopened job brings the flag back. The five words are derived by
`reportStanding()` in `src/reports/store.ts`, which is the one place they are
decided: `status` in the API and the list groups in the UI both read it from
there. The order is the whole meaning: archived, inactive, `briefing` for a
briefing report whose job is live, `result` for a result report that still waits
for the user, `pending` for the flag, and then `active` or `result`. A report
carrying `archivedAt` is archived whatever its job says.

A notice about a report that is set aside is marked `pending: true` in
`/api/inbox`, and the chat UI does not count it towards the unread badge. The mark
follows the report's current flag, so all the notices of that report carry it
together. A revision or an answer clears the flag, and those notices count
again. The item stays in the inbox: it is the record of a write, not a request for
an answer.

Publishing a report and appending a revision each write **one inbox notice**
(`kind: "report"`, `source.reportId`), in the same commit as the report itself. A
notice of kind `briefing` is what the inbox kept for the morning briefing before
reports carried one; the next briefing report moves each of those into the
archive as well. A
report is written for the user to read and the write is usually the last
thing a run does, so the notice is what says a document appeared or moved on.
Bringing a report back from feedback with an answer writes **one inbox notice** as
well, in the same commit that clears the flag, and its body is the answer itself.
Feedback written in the viewer writes no notice: it is pushed into the
conversation, which is where the agent reads it.

Feedback written in the viewer is **pushed into the conversation as an input
submission**. That admission starts a run, so the agent acts on the feedback
without the user relaying it. The durable layer stores that as an ordinary
`pi.user` entry, so the category travels in the text: the first line carries a
`[pi-sec review]` marker, the viewer's UI renders those entries as a review card
rather than a user message, and the agent sees which report the feedback came
from. A `whenBusy: "followUp"` submission queues it behind a run in flight
instead of dropping it. Delivery failing is logged and noted in
`/api/admin/status`. The feedback itself is stored either way.

That makes this route **instruction-bearing** in the same sense the chat is — see
[security.md](./security.md#authentication-is-external) before exposing it.

The word the product shows for this has moved from "note" to "feedback". Nothing
else moved with it: this route, the `ReportFeedback` shape, the `[pi-sec review]`
marker and the stored records are unchanged, and feedback written before the
rename stays where it is, in the same shape. `note` still names one other thing on
a revision: the short description the author writes for it (`ReportVersion.note`).

#### Approvals

An approval is the user confirming that one revision, unchanged, can be
carried out. It is the report's own copy of a confirmation the viewer and the
chat's report panel offer as a button.

A plan offers one button, Approve. A result report offers two, Done and Feedback,
and Done is its approve button: it writes the same record, and every gate that asks
for an approved report accepts it.

```jsonc
// POST /api/reports/:id/approve
{ "version": 2, "via": "viewer" }   // "via": "viewer" | "panel", default "viewer"
// 201
{ "id": "01J...", "version": 2, "approval": { "at": 1760000000000, "via": "viewer", "sha256": "…" } }

// POST /api/reports/:id/done
{ "version": 2, "via": "panel", "text": "run the same check on the second machine" }
// 201
{ "id": "01J...", "version": 2, "approval": { "at": 1760000000000, "via": "panel", "sha256": "…", "button": "done", "text": "run the same check on the second machine" } }
```

The record is written into the revision it is about, as an optional `approval`
field on the revision (`{ at, via, sha256 }`, and on a Done also `button: "done"`
and the user's `text`). The family schema version does not change: an older
document simply lacks the fields. An approval is never rewritten.

The `text` a Done carries is the user's request for follow-up work. It is kept on
the record, and the input the route pushes into the conversation ends with a
paragraph that holds the report id, the job id and the user's words, so the root
hands it on as a new request. An empty field sends no `text` at all: one Done, and
nothing else.

Only the newest revision can be approved. A later revision is a new proposal and
carries no approval, so approving v2 never approves v3.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_request` | `version` is not a positive whole number, or `via` is neither of the two surfaces. |
| `404` | `not_found` | No live report has this id. A report in the archive is here too: the archive is the record of finished work, not a surface to confirm anything on. |
| `409` | `not_active` | The report's job is done, failed, or cancelled, or it is gone from the live store. The body also carries `status` when the job's status is readable. |
| `409` | `stale_revision` | `version` is not the newest revision. The body also carries `latest` and `latestSha256`. |
| `409` | `already_approved` | This revision already carries an approval. The body also carries `approval`. |
| `409` | `not_a_result` | `/done` was pressed on a plan. Done is a result report's approve button, and a plan is approved with Approve. |
| `409` | `briefing` | The report is a briefing, which asks for no approval: neither button means anything on it. |
| `500` | `delivery_failed` | The approval input was not delivered. Nothing was recorded, so the press can be taken again. |

On a refusal the fields beside `error` sit at the top level of the body, not
inside it: `status`, `latest`, `latestSha256`, `approval`.

The approval is **pushed into the conversation as an input submission**, the
same way feedback is, and that admission is what starts the run. The input
carries `src="operator"` with `via="approval"`, and its first line is a `[pi-sec
approve] report=<slug> v=<n> sha=<sha256>` marker, which ends with ` button=done`
when the user pressed Done. The report and the revision
stay in that line, because an input that carries a `report` attribute is read as
feedback. The sentence after the marker reads `The user approved revision <n> of
"<title>" (/report/<slug>) from <surface>.` A Done's sentence reads `The user
pressed Done on revision <n> of "<title>" ...` instead, and adds that this is the
approval of the text hashed above. Entries written before that wording say `The
operator approved revision ...`, and the chat UI reads both. One submission id is
derived from the report and the revision, so a retry does not put a second approval
in the transcript. See
[security.md](./security.md#authentication-is-external) before exposing this
route: consent to start work is a heavier thing than feedback.

### Inbox

`pi-sec`'s notification inbox (`sec.inbox`), distinct from pi-durable's
per-conversation submission queue (`pi.inbox`, surfaced as `snapshot.inbox` and
`inbox_update`).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/inbox` | List notification items (`?unread=true`, `?cleared=exclude`, `?cursor=`). |
| `POST` | `/api/inbox/:id/read` | Mark an item read (`readAt`); does not delete it. |

`?cleared=exclude` answers with the items the page draws. The server reads
`clearedInbox` from the UI preferences (§6, Preferences) and drops those items,
except the ones `revertQueueInbox` still holds: a queue entry is one item id, or
a group written as `hide-all:` followed by the ids joined with commas, which is
the form the page's revert button writes. It combines with `unread=true`.
Without the parameter every item comes back.

Items are durable asynchronous messages (job results, briefings, subagent
reports). An item may carry a `source` naming what it is about: `jobId`,
`conversationId`, or `reportId`. A `reportId` marks a **report notice**, which the
chat UI opens in the report panel rather than folding open in place. A report
write sets it, and so does the `notify` tool when it is given a `reportId`: that
path raises a notice for a report that already exists, without writing a
revision. See [architecture.md](./architecture.md#inbox).

A report write also sets the optional `source.reportEvent` to `published`,
`updated`, or `answered`. The field names the write that raised the notice, and
the item's `title` is the report's own title: no text prefix comes before it. The
`notify` path writes no report revision, so its item carries `reportId` alone and
no `reportEvent`. `source` travels whole on the API and on the `inbox_item`
event, so the added field needs no migration.

An item whose `kind` is `focused_chat` is the notice that a focused chat was
opened. It carries `source.conversationId`, the notice is the only way back to a
chat whose address the user lost, and the chat page's title opens the chat from
it (see [ui.md](./ui.md)).

### Focused chats

A focused chat is a conversation the user opens from the web page to talk about
one topic at length. It is a child of the root, so it counts against the same
slot limit as a subagent, and the root reaches it by name like any other child.
Its transcript is an ordinary conversation, so the conversation routes above
apply to it, with the two refusals they make for a chat that is archived or
deleted.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/focused-chats` | Open a chat (`{ "title"?, "test"? }`). |
| `GET` | `/api/focused-chats` | List: `?state=active`, or `?state=archived&q=&cursor=`. |
| `GET` | `/api/focused-chats/events` | SSE stream of focused chat changes (§12), and of `preferences_updated`. |
| `GET` | `/api/focused-chats/:id` | One chat. |
| `PATCH` | `/api/focused-chats/:id` | Change the title (`{ "title" }`). |
| `GET` | `/chats` | Serve the chats list page (see [ui.md](./ui.md)). |

There is no route that archives a chat and none that deletes one. Both are the
root's tools, `focused_chat_archive` and `focused_chat_delete` (see
[extensions.md](./extensions.md#focused-chats)), because both end a conversation
the user is reading, and the page offers no button for either.

```jsonc
// POST /api/focused-chats   the body is optional, and an empty object is the page's New chat button
{ "title": "Backup script" }
// 201
{ "conversationId": 42, "name": "focused-1", "title": "Backup script", "openedAt": 1793..., "test": false }

// POST /api/focused-chats   a focused chat an agent opens for a test
{ "test": true }
// 201
{ "conversationId": 43, "name": "focused-2", "title": null, "openedAt": 1793..., "test": true }
```

A title is trimmed and holds 1 to 80 characters. `title` is `null` while the chat
has none, which is how a chat opened by the New chat button starts. Its own agent
names it after the first message.

`test` is `true` or `false`, and the key is optional. `true` opens a test chat,
which a test of the send path or of the upload path opens for itself. `false` and
an absent key both open a normal chat. The flag reaches the answers and nothing
else: the chat page, the inbox notice, the event and the chat agent's own prompt
are the same as for a normal chat, so only the chats list tells the two apart.

A refusal carries one code:

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_request` | The body is not an object, `title` is not a string, the trimmed title is empty or over 80 characters, or `test` is present and is neither `true` nor `false`. |
| `409` | `capacity` | The subagent limit is full. The message quotes `live/limit`. |
| `409` | `model_not_configured` | The daemon is in setup mode: no root model is set (§11, "Model setup"). |
| `503` | `root_missing` | The root conversation does not exist, so a chat cannot hang under it. |

`GET /api/focused-chats` answers the open chats by default (`?state=active`),
newest opened first:

```jsonc
// GET /api/focused-chats
{ "items": [
  { "conversationId": 42, "name": "focused-1", "title": "Backup script",
    "openedAt": 1793..., "archived": false, "archivedAt": null, "running": true,
    "test": false }
] }
```

`running` is true while a run is going on inside that chat. It is read at
request time, so it is not stored anywhere. `test` is the flag the open request
carried, and it is read from the store, so an archived chat keeps it too.

`?state=archived` answers the archived chats, newest archived first, 20 rows per
page. `q` keeps the rows whose title contains the term, compared as a plain
substring, and a chat with no title never matches. `cursor` is the `next` value
of the page before. The answer carries `next` only while more rows exist, and a
cursor this server did not write is `400 invalid_request`:

```jsonc
// GET /api/focused-chats?state=archived&q=backup
{ "items": [ ... ], "next": "MTc5MzAwMDAwMDAwMDo3" }
```

Any other `state` is `400 invalid_request`.

`GET /api/focused-chats/:id` answers one chat in the shape of a list item, with
`test` and without `running`. A number that is not a focused chat answers
`404 not_found`, and so does the root's own number. A deleted chat answers
`404 chat_deleted`, so a reader can tell "never existed" from "deleted".

`PATCH /api/focused-chats/:id` is the user renaming the chat, and it takes
`{ "title" }`. It answers `200` with the chat. An archived chat keeps the title it
had, so it answers `409 chat_archived`. A deleted one answers `404 chat_deleted`.
The same title rules as the open route apply, with `400 invalid_request`.

`GET /api/focused-chats/events` streams the `focused_chat_updated` control event
and nothing else, on a channel of its own (§12.3). A fresh connection receives
one `snapshot` frame that carries `apiVersion` and no list, because the page
reads the lists over HTTP. The endpoint is registered before the `:id` route, so
`events` is never read as a conversation number.

---

### Remote machines

A remote machine is another computer this install reaches over `ssh`. A machine's
level says how much this install may do there: `off` means no connection at all,
`restricted` allows light work, and `on` allows heavy work. The remote tools check
that level before they act, and a move to a stricter level is stored at once while
the runs that no longer fit it are stopped. The machines themselves — address,
port, users, key file and interval — are named in `config.json` under
`remoteMachines`, which is described in [runtime-layout.md](./runtime-layout.md).
The panel that draws this list is in [ui.md](./ui.md#machines).

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/remote-machines` | The machines of the config, with their level, the wait a tightening spends, their block and the state of each user's connection. |
| `POST` | `/api/remote-machines/:id/level` | Change one machine's level: `{ "level": "off" \| "restricted" \| "on" }`. Answers with the changed machine. |

`GET` answers `{ enabled, machines }`. `enabled` is false while `config.json`
declares no `remoteMachines` key, and the list is empty then too: the panel hides,
and a caller learns the difference between "the feature is off" and "no machine is
registered". Each machine is:

```json
{
  "id": "box-a",
  "address": "192.0.2.10",
  "port": 22,
  "users": [
    { "name": "alice", "state": "reachable", "since": 1793430000000, "error": null },
    { "name": "bob", "state": "unreachable", "since": 1793430000000, "error": "No route to host" }
  ],
  "level": "restricted",
  "levelChangedAt": 1793430000000,
  "pending": null,
  "hostKey": "pinned",
  "blocked": null
}
```

`users` is in config order, and the first entry is the machine's main user. A
`state` is one of four words: `reachable` means the last heartbeat answered and the
machine-id matched, `unreachable` means it did not and `error` carries the last
line `ssh` wrote, `not-checked` means the machine is at `off` so nothing was
tried, and `unknown` means no check has run since the level rose. `since` is the
moment that state was written, or null while nothing has been checked.

`pending` is the wait that a tightening spends. A move to a stricter level is
stored at once; the runs that no longer fit it are stopped after that, and the
core stops whatever is left at a deadline. While the wait lasts, `pending` holds
the level the user chose, which is the value `level` already carries, the moment
the wait started (`since`), the moment the core stops whatever is left
(`deadline`), and how many runs still do not fit (`runs`). The two instants are
epoch milliseconds. `pending` is null while nothing waits, and a reader treats a
missing field as null: an answer from a server that predates the wait carries no
such field.

`hostKey` is `pinned` once that machine's host key is in the install's own
known_hosts file, and `unpinned` before that; an unpinned machine is not contacted
at all. `blocked` is null, or the reason every connection to that machine is
stopped: `{ reason, at, detail }`, with `reason` either `host-key-mismatch` or
`machine-id-mismatch`. A block ends by itself when the pinned key or that
machine's configuration changes.

`POST` answers with the changed machine, in the shape above. It refuses three
cases before it changes anything:

| Case | Status | `code` |
|------|--------|--------|
| The request carries no JSON content type | `415` | `json_required` |
| `level` is not one of the three words | `400` | `invalid_level` |
| The config names no such machine, or the feature is off | `404` | `not_found` |

Every change writes one row to the audit trail, `remote_machine_level`, with the
machine, the previous level, the new level and the instant, and emits one
`remote_machine_updated` frame. Choosing the level a machine already holds changes
nothing: no row, no frame, and no `ssh` call. A change away from `off` checks the
machine at once rather than waiting for the next heartbeat, so the answer already
carries the state of each user.

The route is not a security boundary. pi-sec's server has no authentication of its
own (`security.md` section 8), so anything that reaches the port can call this path,
and a shell on the same account can call it as easily as the page can. The JSON
content type stops a form on another site, and the audit row records that the path
was called; neither says who called it. The level holds the user's intent, and the
remote tools and the prompt rules are what keep that intent.

---

## 7. User queries (`ask_user`) <a id="user-queries"></a>

The `ask_user` tool lets the agent ask the user a question with fixed choices
plus an "Other" free-form field. The tool **returns at once**: it does not wait for
the answer, so the turn continues and the conversation is not blocked. The question
joins the active list and stays there until the user answers it or the agent
withdraws it.

The item an answer names is the one whose `key` matches. The key is computed by
`userQueryKey`: a sha256 over the conversation id, the question with each run of
whitespace collapsed to one space, and the options, joined with NUL bytes. Two
calls with the same question and the same options in one conversation therefore
carry one key, and the second call reports the question that is already open, with
its id and key, instead of opening a second item. `ask_user` also takes an
optional `supersedes` key: that open question leaves the list in the same commit,
the stream carries `user_query_resolved` with `reason: "supersede"`, and the new
item is opened.

The answer is a real **input from the user**, not a tool result. Both ways of answering
read the same, so a chosen choice also creates a `pi.user` entry that drives the
next turn. The entry carries `src="operator"` and `via="ask-user"`, with the
attributes `key`, `mode`, and `id`. It carries `choice` when the user picked a
listed choice. Its body holds the question, the choices, and the answer:

```text
Question: Which account?
Options:
1) work
2) personal
Answer: work
```

The body is what the model reads, so it does not have to find the question again.
The chat draws the question and the answer as a card, and the choices stay on the
sidebar card.

Endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/user-queries` | The active questions, as `{queries:[…]}` (for late-joining UIs). An item holds `key`, `id`, `conversationId`, `question`, `options` and `createdAt`. |
| `GET` | `/api/user-queries/events` | SSE stream of list changes (optional; also delivered on the conversation stream). |
| `POST` | `/api/user-queries/:key` | Answer the question that carries that `key`. |

```jsonc
// POST /api/user-queries/:key
{ "choice": 0 }                       // index into the offered options, counted from 0
// or
{ "other": "actually, do X instead" } // free-form words
```

An answer is `202` with `{"status":"resolved","mode":"choice"}`. The `mode` is
`"other"` when the user typed words. The answer also deletes the item from the
list. The refusals are `404 not_found` for a key that no open question carries, and
for a question whose conversation is gone. A body that is not an object is
`400 invalid_request`. The same code answers a body that carries neither field, and
a `choice` outside the offered options.

The route delivers the answer entry first and takes the item out of the list
second. The answer is what the agent acts on, so it must not be lost to a failed
delete; a retry of the same answer folds into the first one by its request id,
`ask-user-answer:<id>`.

SSE events on the conversation stream:

```jsonc
{ "id": "01J...", "key": "2f81...", "conversationId": "1", "question": "Which account?", "options": ["work","personal"], "createdAt": 1760000000000 }
{ "id": "01J...", "reason": "answer", "conversationId": "1" }
```

`reason` is `answer`, `withdraw`, or `supersede`. For these two events the name is
the SSE `event` field, and the body does not repeat it. A `user_query` body carries
the item that joined, with the same fields `GET /api/user-queries` gives it. A
`user_query_resolved` body carries `id`, `reason`, and `conversationId`. Neither
carries the list, so the page reads `GET /api/user-queries` again when it receives
one.

`/api/user-queries/events` sends one `snapshot` event first when the connection
needs it, `{ "type": "snapshot", "apiVersion": "…", "userQueries": [ … ] }`, and
only then the two events above. A client that joins late can draw the list from
that array, without a second read.

Durability: the active list is the session document `sec.userQueryList`, and it is
the only record of which questions are open. The answer route reads that document
to find the question, so a restart loses neither the question nor the ability to
answer it. **There is no default timeout**: a question stays in the list until it is
answered or withdrawn.

**The agent's side.** `questions_open()` takes no arguments and lists the open
questions of the caller's own conversation, one line each:

```text
<item id="01J..." key="2f81..." question="which account?" options="2" created="2026-10-15T19:00:00.000Z" />
```

`question_withdraw(key)` closes one. It takes the item out of the list, writes a
`question_withdrawn` audit row, and emits `user_query_resolved` with
`reason: "withdraw"`. A key that is not open in the caller's conversation is an
error, so withdrawing the same item twice fails the second time. Both tools read
and write only the caller's own conversation.

---

## 8. Usage page <a id="usage"></a>

`/usage` shows what the agent has spent at each service it uses, and how much is
left. The page is served like the chat page: the mount prefix is stamped, the
`usage.cards` slot is filled by the server (§5.7), and the provider cards are
drawn by the page's own script from an answer the page itself carries.

The served page holds that answer in a JSON data block,
`<script type="application/json" id="usage-first">`. The server builds it from the
provider values it already holds, from pi-sec's ledger, and from its audit trail,
and it calls no provider while it builds the page. The page draws the block at
load, and asks `GET /api/usage` only when the block marks a provider value
`reading`: a reader exists for that provider and its value has not arrived. A page
without the block, or with one that is not a usage answer, asks for the whole
answer as before.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/usage` | The usage page. |
| `GET` | `/api/usage` | One card per provider that has auth now, and the judgement models card. A provider an extension declares virtual has no card. |
| `POST` | `/api/usage/refresh` | One card, asked to read its provider again. |
| `GET` | `/usage/stats` | The model speed page: three graphs of generation speed, TTFT and TPOT over time. It is the shell only, stamped like `/usage`, and it reads `GET /api/usage/stats` (§8.3). |
| `GET` | `/api/usage/stats` | Timing statistics of model calls, by time slot (§8.3). |

### 8.1 `GET /api/usage`

```jsonc
// GET /api/usage
{
  "generatedAt": 1894696200000,          // epoch ms, when this answer was built
  "timezone": "UTC",              // the zone every label below is written in
  "cards": [
    {
      "provider": "anthropic",
      "name": "Anthropic",
      "shape": "subscription",
      "receivedAt": { "at": 1894692600000, "label": "2030-01-15 07:30" },
      "fields": {
        "fiveHour": {
          "state": "value",
          "value": { "utilization": 28, "resetsAt": { "at": 1894..., "label": "2030-01-16 20:59" } }
        },
        "weekly": { "state": "value", "value": { "utilization": 72, "resetsAt": null } },
        "credits": {
          "state": "value",
          "value": {
            "enabled": false,
            "used": { "amount": 0, "currency": "USD" },
            "limit": null,
            "disabledReason": "out_of_credits",
            "balance": null
          }
        },
        // This provider's entry names the daily slots only, so there is no `day`,
        // `week` or `month` here.
        "daily": {
          "state": "value",
          "value": {
            "slots": [
              // The first of the thirty slots, oldest first; 28 more follow.
              {
                "from": { "at": 1758..., "label": "2026-09-25 08:30" },
                "to": { "at": 1759..., "label": "2026-09-26 08:30" },
                "calls": 640, "tokens": 28000000, "cost": 62.5
              }
            ]
          }
        }
      },
      "note": "pi-sec calls only · API-equivalent cost"
    },
    {
      "provider": "deepseek",
      "name": "DeepSeek",
      "shape": "prepaid",
      "receivedAt": { "at": 1894692600000, "label": "2030-01-15 07:30" },
      "note": "Peak/off-peak rates applied · holidays ignored",
      // Present only when the provider value did not refresh.
      "hold": { "kind": "rate_limited", "until": { "at": 1894694400000, "label": "2030-01-15 08:00" } },
      "fields": {
        "balance": { "state": "value", "value": { "amount": 11.25, "currency": "USD" } },
        "day": { "state": "value", "value": { "calls": 12, "tokens": 21000, "cost": 0.37 } },
        "week": { "state": "value", "value": { "calls": 90, "tokens": 250000, "cost": 3.5 } },
        "month": { "state": "value", "value": { "calls": 300, "tokens": 900000, "cost": 12.25 } },
        "daily": {
          "state": "value",
          "value": {
            "slots": [
              // The first of the thirty slots, oldest first.
              {
                "from": { "at": 1758..., "label": "2026-09-25 08:30" },
                "to": { "at": 1759..., "label": "2026-09-26 08:30" },
                "calls": 4, "tokens": 12000, "cost": 0.2
              },
              // 28 more slots follow.
              {
                "from": { "at": 1894..., "label": "2030-01-14 08:30" },
                "to": { "at": 1894696200000, "label": "2030-01-15 08:30" },
                "calls": 1, "tokens": 900, "cost": 0.03
              }
            ]
          }
        }
      }
    }
  ]
}
```

**Which cards exist.** The route asks the model catalog on every request which
providers have auth. A provider with auth has a card, and a provider without auth
has none. A provider that `models.json` or an extension added, or that was logged
in a moment ago, appears on the next request. One provider is the exception: an
extension may declare a provider `virtual: true` (see
[extensions.md](./extensions.md#model-providers)), which says that it answers no
request itself and hands each one to another provider. Such a provider has no
card, and its spending is counted on the card of the provider that answered, so
no number is lost. The answer orders the subscription cards first, then each
shape by the provider's display name.

**Two shapes.** `shape` is `subscription` when the provider is logged in with a
subscribing OAuth credential, and for a provider whose own reader states that its
API key draws the subscription shape (`synthetic.new`, below). It is `prepaid` for
every other login. A subscription card's own `fields` are `fiveHour`, `weekly` and
`credits`, and a provider with no five-hour window has no `fiveHour` field at all.
A subscription card also carries pi-sec's own `day`, `week`, `month` and `daily`
fields when the provider's entry in the reader registry names them: `synthetic`
carries all four, and `anthropic` carries `daily` alone. Those fields sit after
the provider's own, they are counted exactly as a prepaid card counts them, and
they are absent when the entry names none. A prepaid card's `fields` are
`balance`, `day`, `week`, `month` and `daily`.

**A subscription card states what its cost is.** `note` is a line under the card.
The `synthetic` card states `pi-sec calls only · estimated credit use at
subscription rates`, because its recorded cost is the weekly credit a call used,
at synthetic.new's subscription rates, and not a bill. The `anthropic` card states
`pi-sec calls only · API-equivalent cost`, because its recorded cost is the
Anthropic API list price of the same calls. Both lines say that only the calls
pi-sec made itself are counted. The `deepseek` line states its own pricing rule.

**The `synthetic.new` card.** synthetic.new sells a weekly credit subscription but
issues an API key, so its card uses the subscription shape although it logs in
with an API key. `fiveHour` is absent or empty, because synthetic.new has no
five-hour window. `weekly` comes from `GET https://api.synthetic.new/v2/quotas`,
which the route calls with `Authorization: Bearer <key>`. Two blocks can hold the
quota, and each is read at the top level of the answer and under `data`.
`planWeeklyLimit` is read first: `utilization` is 100 minus its
`percentRemaining`, `resetsAt` is its `nextRegenAt`, and `regenPercent` is its
`nextRegenPercent` when that is a positive whole number and null otherwise. This
block states no credit amounts, so `used`, `limit` and `balance` are all null, and
the page writes one line, `Amounts not provided`, in place of the amounts. The
fallback is `weeklyTokenLimit`: its `percentRemaining` and `nextRegenAt` fill
`utilization` and `resetsAt` the same way, its `regenPercent` is null, and
`credits` holds used, limit and balance in dollars, from its `maxCredits` and
`remainingCredits`, which are read as a number or as a string such as `"$24.00"`;
`used` is the difference between the two, and is stated only when both arrived.
An answer that holds neither block is a shape this build cannot read. A slot the
answer does not state stays empty, and the rest of the card still draws.
`credits` also carries `billing`, the page where the balance is bought, and the
card links it instead of the vendor console line. The ten-minute reuse and the
30-minute hold after HTTP 429 apply to this card as to the others.

**Every field is one of four states.** `{"state": "value", "value": …}` is a
value, `{"state": "wip"}` is a field no reader fills yet, `{"state": "reading"}`
is a provider value the page was served before it arrived, and
`{"state": "error", "reason": "…"}` is a field whose provider did not answer.
`reading` appears only in the page's own block: an answer to `GET /api/usage` has
called the reader by then, or states why it could not. A
reason is an HTTP status or a short phrase such as `request failed`, and never the
provider's own sentence. A value that is absent inside a value, such as a null
`balance` or a null `resetsAt`, means the provider stated none. The page writes
the sentence that goes with it, for example `Balance not available`.

**The usage windows come from pi-sec's own database.** `day`, `week` and `month`
are rolling windows of 24 hours, 7 days and 30 days that end at `generatedAt`.
They come from the record of every model call pi-sec made, read from
`state/sec.sqlite` through a read-only connection, and never written. A window
starts on a whole minute. A DeepSeek call outside DeepSeek's peak hours (weekdays
in UTC, 01:00-04:00 and 06:00-10:00) costs half of its recorded amount, and
`note` says so on that card. The route never reads the ledger in a write
transaction, and a route that cannot read it answers the three windows with a
reason instead of failing.

**The daily slots hold one day each.** `daily` appears on every prepaid card and on
a subscription card whose provider's entry names it, and its value holds exactly
30 slots. The slots are oldest first, so the last one is the
newest. Each slot has the same three numbers as a window, `calls`, `tokens` and
`cost`, and the two moments `from` and `to` that bound it. A slot boundary sits on
a whole minute. A call in the start minute of a slot is in that slot, and a call
in the minute before that start is in the older slot. The newest slot ends at
`generatedAt` and holds the current minute. The newest slot is the same as `day`,
the last seven slots together are the same as `week`, and all thirty together are
the same as `month`. A subscription card that carries no `daily` field has no
thirty columns. When the ledger cannot be read, `daily` carries the same reason as
the three windows, and a subscription card's `day`, `week` and `month` carry it
too.

**A card says when its value is held back.** A card carries `hold` only when its
provider value did not refresh. The two kinds are `rate_limited`, with `until` the
end of the provider's 30-minute back-off after HTTP 429, and `kept`, with `nextAt`
the first moment a refresh can call again. `rate_limited` wins when both apply. A
card with no hold has no `hold` property at all.

**External calls happen only when someone reads the page, and once when the
daemon starts.** A provider's own value (balance, utilization, credits) is kept
for ten minutes and served from memory, so a reload costs no call. The daemon
asks each provider once when the server starts, without delaying the start, so
the first page after a restart usually has the values already; that read obeys
the same ten-minute reuse and provider interval. An HTTP 429 from a provider
stops calls to that provider for thirty minutes, and its card keeps the last
value with the `receivedAt` it arrived at. Two requests that arrive together
share one call, and the providers of one answer are asked together. Each call
stops after ten seconds: the card states `timeout`, and the other cards are
unchanged. A card's own refresh is the one way to ask for a new value before
those ten minutes are over, and it has a floor of its own (§8.2).

**A balance no API states is a sentence and a link.** A prepaid card whose
provider has no reader for its balance states what is true in place of an amount,
and where the balance is bought:

```jsonc
{
  "fields": {
    "balance": {
      "state": "value",
      "value": {
        "amount": null,
        "currency": null,
        "note": "No API for the balance",
        "billing": { "label": "OpenAI billing page", "url": "https://platform.openai.com/settings/organization/billing" }
      }
    }
  }
}
```

`openai` is the one provider this applies to. Its API key can read neither the
prepaid credit balance nor the organization's spend, so the card states no amount
and links the page where the credits are bought. The entry that states this is
`BALANCE_NOTICES` in `src/server/usage/fetchers.ts`, and it is a table of its own
rather than a reader: a reader would be called, kept for ten minutes, held back
after HTTP 429 and refreshed by a button, and none of that is true of a value that
comes from nothing. A card built from that entry calls no address at all, so the
OpenAI card makes no request to OpenAI. Its `day`, `week`, `month` and `daily`
fields are its own calls, counted from the ledger like every other card's. Its
`receivedAt` is null, because no value was ever received from the provider.

**The judgement models card.** The answer carries `judges` when the config names a
judge or the audit trail holds a judgement, and no `judges` property otherwise:

```jsonc
{
  "judges": {
    "rows": [
      {
        "name": "report-check",
        "provider": "openai",
        "model": "gpt-6-luna",
        "day":   { "calls": 12, "tokens": 3400, "cost": 0.0042, "unanswered": 1 },
        "week":  { "calls": 57, "tokens": 16100, "cost": 0.0199, "unanswered": 9 },
        "month": { "calls": 57, "tokens": 16100, "cost": 0.0199, "unanswered": 9 }
      }
    ]
  }
}
```

A judgement runs outside every conversation, so no provider card counts it. The
rows come from the audit trail (`logs/audit.jsonl`, every line of `type: "judge"`),
including the rotated files its own size limit leaves beside it
(`<file>.<stamp>`); a line outside the last 30 days is dropped by its own `time`.
`calls` counts every judgement line in the window, answered or not. `unanswered`
counts the part of it that gave no answer, which is a failed judgement and a
skipped one. `tokens` and `cost` are the ones the service reported on those lines.
`provider` and `model` come from the config's entry first, because the config is
what the next call uses, and from the audit line of an entry the config no longer
names. A row exists for every judge the config names and every judge the trail
records, so a judge that has not answered yet is a row of zeros. One read of the
trail is reused for ten minutes. No text a judgement was shown is in the answer:
the audit line holds only the name, the provider, the model, the outcome, the token
counts and the cost. These amounts are not added to any provider card's `day`,
`week`, `month` or `daily`.

**The answer carries no credential.** There is no key, no token and no account or
organization id in it. The server resolves the credential, uses it for the
request, and drops it.

### 8.2 `POST /api/usage/refresh`

```jsonc
// POST /api/usage/refresh
// Content-Type: application/json
{ "provider": "deepseek" }
```

The request body holds one provider id. The answer holds one card, built the way
the card of `GET /api/usage` is built:

```jsonc
{
  "generatedAt": 1894696200000,
  "timezone": "UTC",
  "card": {
    "provider": "deepseek",
    "name": "DeepSeek",
    "shape": "prepaid",
    "receivedAt": { "at": 1894692600000, "label": "2030-01-15 07:30" },
    "note": "Peak/off-peak rates applied · holidays ignored",
    "hold": { "kind": "kept", "nextAt": { "at": 1894692660000, "label": "2030-01-15 07:31" } },
    "fields": { "balance": { "state": "value", "value": { "amount": 11.25, "currency": "USD" } } }
  }
}
```

A refresh reads the ledger again, so the windows and the daily slots are as new
as the answer's. It also asks the provider again, which a page load does not do
while its value is younger than ten minutes.

Two brakes can stop that call. The first is the provider's minimum interval,
counted from its last attempt: five minutes for Anthropic and synthetic.new, and
one minute for DeepSeek. A failed attempt counts, so a provider that refuses
quickly is not asked again at the speed of the refusals. A refresh inside the interval makes no
call, shows what the last attempt left, and carries `hold` of kind `kept` with
`nextAt` the first moment a refresh can call. The second brake is the 30-minute
back-off after HTTP 429, and a refresh never bypasses it. A refresh inside the
back-off makes no call and carries `hold` of kind `rate_limited` with `until` the
end of the back-off. Two refreshes of one provider that arrive together share one
call, and so does a refresh and a page load.

A provider with no reader for its own value refreshes its ledger fields only.
The answer holds no key, no token and no account or organization id.

| Status | Code | When |
|--------|------|------|
| `200` | | The card, as the body above shows. |
| `400` | `invalid_request` | The body is not JSON, or `provider` is not a non-empty string. |
| `403` | `origin_forbidden` | The request carries an `Origin` this server does not allow (§3.1). |
| `404` | `unknown_provider` | The model catalog has no such provider, the provider has no auth now, or an extension declares the provider virtual, which means it has no card. |
| `415` | `json_required` | The `Content-Type` is not `application/json`. A cross-site form can send no other type, so this check refuses it. |

### 8.3 `GET /api/usage/stats`

Timing statistics of the model calls that `state/model-calls.sqlite` records. The
route opens that file read-only and never writes it. If the file does not exist
yet, the answer is empty: `provider` and `model` are `null`, `providers` is `[]`,
and every slot has no call.

Query values:

| Name | Values | Default |
|------|--------|---------|
| `provider` | A provider id. | The provider with the most calls in the range. |
| `model` | A model id of that provider. | The model with the most calls in the range. |
| `range` | `24h`, `7d`, `30d`, `90d` | `7d` |
| `step` | `hour`, `day` | `hour` for ranges up to `7d`, else `day` |

A slot starts on a whole hour or a whole day of the `timezone` in config. The first
slot is the one that holds the start of the range, and the last one holds now. If
the answer would need more than 744 slots (for example `range=90d&step=hour`), the
route answers HTTP 400 `range_too_large`. A value that is not in the table gives
HTTP 400 `bad_query`. Both use the error shape of §3. A `provider` that an extension
declares virtual answers HTTP 400 `bad_query` as well, because its calls are
recorded under the provider that answered. A `provider` or `model` that has no
call is not an error: its slots are empty.

The answer:

- `generatedAt` (epoch ms), `timezone`, `provider`, `model`, `range`, `step`.
- `providers`: each provider with a call in the range, `{ provider, calls, models: [{ model, calls }] }`, most calls first. A provider that an extension declares virtual is left out, because its calls are recorded under the provider that answered.
- `buckets`: the prompt length buckets, `{ key, label, from, to }`. Prompt length is input + cache read + cache write, and 1k is 1000 tokens. The buckets are `<64k`, `64k-128k`, `128k-256k`, `256k-512k` and `≥512k` (`to` is `null` for the last one).
- `slots`: `{ from, to, calls, failed, bursts, speed, buckets }`. `calls` counts every call that started in the slot, and `failed` counts the ones with stop reason `error` or `aborted`. `bursts` counts the successful calls that the speed rule below leaves out of `speed` and TPOT. `speed` is `{ p50, p90, count }` in tokens per second after the first token. `buckets` has one `{ ttftMs, tpotMs }` per bucket, in the order of the top-level `buckets`, each `{ p50, p90, count }` (milliseconds, and milliseconds per token).

The rules for the values:

- A failed call is in no `p50`, `p90` or `count`.
- A call with no `ttft_ms` is in no TTFT, TPOT or speed value.
- TPOT = (duration − ttft) / (output − 1). Speed = (output − 1) / ((duration − ttft) / 1000). Both leave out a call with output 0 or 1, or with duration not greater than ttft. Speed is a percentile of the per-call values, not the inverse of the TPOT percentile.
- A call whose speed is above 1000 tokens per second arrived all at once, and its speed says nothing about the model. It is left out of `speed` and of TPOT, it stays in TTFT and in `calls`, and it is counted in `bursts`. A call at exactly 1000 is kept. The rule is the same for every row, old or new.
- A percentile is the nearest-rank value, and it is `null` when fewer than 3 calls make it. `count` still tells how many did.

## 9. Extension cards <a id="extension-cards"></a>

A runtime extension can export `ui`, the cards it puts in a slot of a page: the
chat page's `sidebar.bottom` and the usage page's `usage.cards` today (see
[extensions.md](./extensions.md#ui-cards)). Two routes serve those cards: one call
route for a card's controls, and one file route for the files under its `ui/`
directory.

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/ui/call` | One action of one card. |
| `GET` | `/ext/<extension>/ui/<file>` | A card script or another file of a registered extension's `ui/` directory. |

### 9.1 `POST /api/ui/call`

```jsonc
// POST /api/ui/call
{
  "extension": "demo-cards",
  "card": "switch",
  "action": "start",
  "value": null          // any JSON value, optional
}
// 200, and both keys are optional
{ "value": { "on": true }, "html": "<button type=\"button\">Turn off</button>" }
```

The body passes the `Host` and `Origin` checks that every write route gets
(§3.1), and it has the same size cap (`server.maxBodyBytes`).

| Status | Code | When |
|--------|------|------|
| `200` | none | The extension's `action` answered. `value` is present when it returned one, and `html` when it returned markup. |
| `400` | `invalid_request` | `extension`, `card` or `action` is missing, is not a string, or breaks its name rule. |
| `403` | `origin_forbidden` | The `Origin` check refused the request (§3.1). |
| `404` | `not_found` | The extension is not registered, the card is not registered, or the extension exports no `action`. |
| `413` | `payload_too_large` | The body is over `server.maxBodyBytes`. |
| `415` | `json_required` | `Content-Type` does not include `application/json`. |
| `500` | `ui_action_failed` | The `action` threw, rejected, or returned a value of the wrong shape. The reason is logged. |
| `504` | `ui_action_timeout` | The `action` did not answer within 10 seconds. |

An action name is 1 to 64 characters: a letter or a digit first, then letters,
digits, `_`, `.`, `:` and `-`. The answer's `html` passes the card markup check
before it is sent (see extensions.md). A refusal puts the text
`<extension>/<card>: invalid markup` in `html`, and the server logs the reason.

**The caller is not proved to be the card.** Any program that can reach the
server can post this body, so an extension checks `action` and `value` before it
uses them.

### 9.2 `GET /ext/<extension>/ui/<file>`

The file route serves the card scripts and the other files under the `ui/`
directory of a registered runtime extension. It sits under the mount prefix
(§2), like every other route.

- Only a file inside `ui/` is served, and only with one of these extensions:
  `.js`, `.mjs`, `.css`, `.svg`, `.png`.
- A path traversal, a `\` or a NUL byte in a segment, a symlink that resolves
  outside `ui/`, a directory, and a missing file are all `404 not_found`.
- The headers match the static files: `Content-Type` by extension,
  `Content-Length`, `X-Content-Type-Options: nosniff`, and
  `Cache-Control: no-cache`. The `?v=<mtime>` query on a card script is ignored.
- A card script needs no policy exception: `script-src 'self'` already allows a
  script from this route, because it comes from the page's own origin.

A file in `ui/` is readable by anyone who can reach the server. That is why
[extensions.md](./extensions.md#ui-cards) says what does not belong there.

### 9.3 Extension pages <a id="extension-pages"></a>

A runtime extension can also export `pages` (see
[extensions.md](./extensions.md#ext-pages)). The core serves its pages and its own
api under `/ext/<extension>/`. The extension registers no path: the routes below
are fixed, and each request looks up the live registration, so a reload reaches the
next request and a removed extension answers `404`. `ui/` and `api/` are the only
reserved sub-paths.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/ext/<extension>/ui/<file>` | The file route of 9.2. It also answers for an extension that holds pages and no cards. |
| `GET`, `POST`, `PUT`, `PATCH`, `DELETE` | `/ext/<extension>/api/<path>` | The extension's `api` function. |
| `GET` | `/ext/<extension>/` and `/ext/<extension>/<page>` | One page, as an HTML document. |
| `GET` | `/api/ui/page-links` | The current Pages menu list, as a JSON array of `{ label, path }`. |

**The page.** `GET /ext/<extension>/` is the index page, and
`GET /ext/<extension>/<page>` is a page named by one segment that matches
`^[a-z0-9][a-z0-9-]{0,63}$`. The body is an HTML document the core builds, with the
extension's markup inside. The response carries the core page policy,
`Cache-Control: no-cache`, `X-Content-Type-Options: nosniff` and
`Referrer-Policy: no-referrer`. The policy names a style nonce only when the page
rendered css.

| Status | When |
|--------|------|
| `200` | The page rendered. |
| `404` | `not_found`: the extension, the page or the route is unknown, `render` returned `null`, or the path has more than one segment. All of these answer the same body. |
| `500` | `render` threw, returned a value of the wrong shape, or returned more than 2 MiB of html and css. The answer is a short core error page, and the reason goes to the log. |
| `504` | `render` did not answer within 5 seconds. |

**The api.** The route passes `method`, the path after `api/`, the query string
(first value of each key) and the parsed JSON body to the extension. A request with
a body must send `Content-Type: application/json`. The global `Host` and `Origin`
checks run first for every method except `GET` and `HEAD` (§3.1).

| Status | Code | When |
|--------|------|------|
| the extension's | none | The `api` answered. The status defaults to `200`, and `204` and `205` carry no body. |
| `403` | `origin_forbidden` | The `Origin` check refused the request (§3.1). |
| `404` | `not_found` | The extension is unknown or exports no `api`. |
| `413` | `payload_too_large` | The body is over `server.maxBodyBytes`. |
| `415` | `json_required` | A body was sent with another `Content-Type`. |
| `500` | `page_api_failed` | The `api` threw, returned a value of the wrong shape, returned JSON that cannot be written, or returned more than 4 MiB. The reason is logged. |
| `504` | `page_api_timeout` | The `api` did not answer within 10 seconds. |

An api answer carries `Cache-Control: no-store`. An `api` GET must not change
state.

**`GET /api/ui/page-links`** answers the Pages menu list: the bundled links read
at boot, then the runtime extension links (pages with `menu: true`) sorted by
extension name and then by declared order. The chat page's data block carries the
same list, and the menu reads this route each time it opens. The answer is a read
and carries `Cache-Control: no-store`.

`GET /api/admin/status` lists `pages: { pages, errors }` next to `ui` for each
runtime extension that exports `pages`.

---

## 10. Pull request dashboard <a id="github-pr"></a>

The `github-pr` extension serves three pages and their API. The pages carry a
pull request list, one pull request, and one pull request's diff (see
[ui.md](./ui.md)). The pages and the API exist only while the name is in
`agent.extensions.enabled`: a disabled extension registers no route, so every
path below answers `404`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/github/pr/` | The list page. |
| `GET` | `/github/pr/<owner>/<repo>/<number>` | One pull request. |
| `GET` | `/github/pr/<owner>/<repo>/<number>/diff` | The diff of one pull request. |
| `GET` | `/github/pr/<owner>/<repo>/<number>/commits/<sha>` | The diff of one commit of a pull request. |
| `GET` | `/api/github/pr/list` | The list, from the copy the process holds. |
| `GET` | `/api/github/pr/events` | SSE stream: the cached list changed. |
| `GET` | `/api/github/pr/<owner>/<repo>/<number>` | One pull request. |
| `GET` | `/api/github/pr/<owner>/<repo>/<number>/diff` | The diff of one pull request. |
| `GET` | `/api/github/pr/<owner>/<repo>/<number>/commits/<sha>` | The diff of one commit of a pull request. |
| `POST` | `/api/github/pr/<owner>/<repo>/<number>/reply` | A thread reply, or a comment on the whole pull request. |
| `POST` | `/api/github/pr/<owner>/<repo>/<number>/reaction` | Add or remove one reaction. |
| `GET` | `/api/github/pr/<owner>/<repo>/<number>/draft` | The saved, unsubmitted review of one pull request. |
| `POST` | `/api/github/pr/<owner>/<repo>/<number>/draft` | One change of that saved review. |
| `POST` | `/api/github/pr/<owner>/<repo>/<number>/review` | Submit a review. |
| `POST` | `/api/github/pr/<owner>/<repo>/<number>/resolve` | Resolve one review thread. |
| `POST` | `/api/github/pr/<owner>/<repo>/<number>/edit` | Replace the description, or one of the account's own comments. |

A repository is matched against `githubPr.repos` without regard to case, and
every payload spells it the way the config spells it. A repository the config
does not name and a number that is not a positive integer both answer
`404 { "error": "not found" }`.

### 10.1 Errors

These routes answer a flat body rather than the envelope of §3:
`{ "error": "<message>" }`. The three pages read both shapes, and the flat one is
what they show as the failure line.

| Status | Body | When |
|--------|------|------|
| `403` | `{ "error": "writes are disabled" }` | `githubPr.writes` is false. |
| `404` | `{ "error": "not found" }` | Unknown repository, or a number that is not one. |
| `409` | `{ "error": "disk_limit", "currentMegabytes": n, "estimateMegabytes": n, "limitMegabytes": n }` | A first fetch would pass the disk cap. Nothing was fetched. |
| `409` | `{ "error": "<message>" }` | An edit whose `baseBody` is not the text GitHub holds now. Nothing was written. |
| `415` | `{ "error": "send this request with Content-Type: application/json" }` | A write whose body is not JSON. |
| `400` | `{ "error": "<message>" }` | The body of a write is well-formed JSON and does not carry what the write needs, a resolve names a thread that is not on this pull request or that the account cannot resolve, or an edit names text that the account did not write, cannot edit, or that is empty (a comment) or longer than 131000 bytes. |
| `502` | `{ "error": "<message>" }` | `gh` or `git` failed, or a forced refresh failed. The message is the failure's own. |

The order of the write refusals is fixed. A body type that is not JSON is `415`
first, before anything reads the body as a write. Then the repository and the
number are checked (`404`), then the switch (`403`), then the body's fields
(`400`), then a text that changed on GitHub (`409`, edits only), and last a
failure of `gh` (`502`). A switched-off install starts no
`gh` process, so a `403` is also the proof that no write reached GitHub.

### 10.2 Pages

Each page is a shell from `src/web/` plus two JSON data blocks the server fills,
the same technique as the usage page's `#usage-first` (§8):

- `github-pr-meta` on all three pages:
  `{ "viewer": "<login or null>", "repos": [{ "repo": "owner/repo" }], "writes": true|false }`.
  The viewer is the one in the cached list, and `null` means no list was read
  yet.
- `github-pr-list-first` on the list page only: the list the process held, or
  `null` when it held none. The rows draw with the page instead of one request
  later.

A block is `<script type="application/json">` with every `<` written as
`\u003c`, so no value can close the element early and the page's
`script-src 'self'` policy has nothing to refuse. The pages answer
`Cache-Control: no-cache`, and the pull request page's policy adds `https:` to
`img-src` (see [security.md](./security.md#github-pr-writes)).

### 10.3 `GET /api/github/pr/list`

The answer is the payload the pages draw:

```jsonc
// GET /api/github/pr/list
{
  "viewer": "example-user",
  "repos": [{ "repo": "acme/widgets" }],
  "sections": [
    { "key": "mentioned", "title": "Mentioned", "prs": [ /* one row per pull request */ ] }
  ]
}
```

The list is kept in memory and refreshed by a poll that starts when the daemon
starts. The first cycle reads GitHub at once, and each later cycle waits
`githubPr.fetchIntervalSeconds` after the previous one finished, so two reads
never overlap. A poll that fails keeps the copy and tries again.

`?refresh=1` reads GitHub now and replaces the copy. A refresh that fails answers
`502` and leaves the copy as it was, and the next `GET` still answers the old
list. One repository that cannot be read fails the whole read: the list is all or
nothing.

### 10.4 One pull request, and its diff

`GET /api/github/pr/<owner>/<repo>/<number>` answers the pull request as GitHub
states it, with `repo` added: description, labels, reactions, comments, reviews,
review threads and the check rollup. Nothing is cached, so each open of the page
reads GitHub. The answer also carries `commits`, the newest 100 commits of the
pull request oldest first (`oid`, `abbreviatedOid`, `headline`, `author`,
`committedDate`, `url`), and `totalCommits`, the count GitHub reports. `author`
is the account login when GitHub links one and the git author name otherwise. A
pull request with more than 100 commits has `totalCommits` above the length of
`commits`.

Each review thread of the answer carries `subjectType`, `LINE` or `FILE`. GitHub
sends an empty `diffHunk` and line 1 with a `FILE` thread, which is a comment on
the whole file. A missing or other value counts as `LINE`.

`GET /api/github/pr/<owner>/<repo>/<number>/diff` computes the diff from a bare
repository under `~/.pi/sec/gh-repo/`, not from GitHub. Only the base branch name,
the head commit and the title come from `gh`. The route adds `repo` and `title`
to the answer. A first fetch that would pass `githubPr.diskLimitMegabytes` is
refused with `409` and the three sizes, and nothing is fetched. With the value 0
the limit is off and the route never refuses for size. A `gh` or `git`
failure is `502`.

`GET /api/github/pr/<owner>/<repo>/<number>/commits/<sha>` computes the diff of one
commit of the pull request from the same bare repository. `<sha>` is the full
commit id, 40 or 64 hexadecimal digits, and any other value is `404`, as is a
repository outside the configuration. The one `gh` call is the same small GraphQL
read that the diff route makes, for the head commit and the title. The route
fetches `refs/pull/<number>/head` when the head commit is not local, and it does
not fetch the base branch. It then requires the commit to exist locally and to be
an ancestor of the head commit. A commit that fails either check is `404` with
`commit <short id> is not part of pull request #<number> now. A force-push can
remove a commit. Reload the pull request page for the current list.`, so the page
cannot show a commit that is outside the pull request. The diff is the commit
against its first parent (`git show --diff-merges=first-parent`), which for a root
commit is the creation diff. The answer has the fields of the pull request diff,
with `baseRef` empty, `baseSha` and `mergeBase` set to the parent (an empty string
for a root commit), `headSha` set to the commit, `repo` and `title` added, and one
more field, `commit`: `sha`, `parents`, `authorName`, `authorEmail`, `authoredAt`,
`committedAt`, `headline` and `body`. The disk limit, the `409` and the `502`
answers, the file limits and the lack of a server cache are those of the diff
route. The route reads only: it sends no write to GitHub.

### 10.5 SSE: `GET /api/github/pr/events`

One event name, `prs`, and no payload the page uses:

```
event: prs
data: {}
```

The server publishes it when a read replaced a list that was already there with a
different one, which includes a forced refresh that changed the list. Filling an
empty copy is not a change. A page that receives the frame reads the list route
again. The channel is separate from every conversation's stream, and the endpoint
answers no `snapshot`: the page's first answer is the `github-pr-list-first` block
or a read of the list route.

### 10.6 The write routes

The five write routes take a JSON body, and a body that is not JSON is refused
with `415` before anything else happens. `githubPr.writes` is read again on each
request. With the switch off, every one of them answers `403` and starts no
`gh` process.

```jsonc
// POST /api/github/pr/<owner>/<repo>/<number>/reply
{ "body": "thanks", "threadId": "PRRT_..." }   // threadId absent or null: a comment on the whole pull request
{ "ok": true }

// POST /api/github/pr/<owner>/<repo>/<number>/reaction
{ "subjectId": "PR_node_...", "content": "THUMBS_UP", "add": true }
{ "ok": true }

// POST /api/github/pr/<owner>/<repo>/<number>/review
{ "event": "COMMENT" | "APPROVE" | "REQUEST_CHANGES",
  "body": "",
  "comments": [{ "body": "typo", "path": "src/a.ts", "side": "RIGHT", "line": 12, "startLine": null }],
  "draftCommentIds": ["..."] }   // optional: the ids of the saved draft comments this review sends
{ "ok": true }

// POST /api/github/pr/<owner>/<repo>/<number>/resolve
{ "threadId": "PRRT_..." }
{ "ok": true, "thread": { "id": "PRRT_...", "isResolved": true } }

// POST /api/github/pr/<owner>/<repo>/<number>/edit
{ "body": "new text", "baseBody": "the text the page started from", "commentId": "IC_..." }   // commentId absent or null: the description
{ "ok": true, "body": "the text as GitHub holds it now" }
```

A resolve reads the thread first. It answers `400` when the thread is not a review
thread of the pull request in the address, or when `viewerCanResolve` is false for
the account. A thread that is already resolved sends no mutation and answers the
same `200` body. `viewerCanResolve` is also a field of each thread in the detail
answer.

An edit reads the target first. The description is the pull request in the
address. A `commentId` names a conversation comment (`IC_...`) or a review comment
(`PRRC_...`) of that pull request, and a review summary is not editable. The edit
answers `400` when the target is not on this pull request, when `viewerCanUpdate`
or `viewerDidAuthor` is false (it edits only text that the account wrote), when a
comment text is empty, or when the text is longer than 131000 bytes, which is the
most one `gh` argument can carry. It answers `409` when GitHub's text is not
`baseBody`, compared as exact strings, and writes nothing. A text equal to the
current one sends no mutation and answers the same `200` body. The detail answer
carries `viewerCanUpdate` and `viewerDidAuthor` on the description and on each
conversation and review comment. The read and the write are two requests, so an
edit saved on GitHub between them is overwritten, and GitHub keeps the earlier
text in the edit history.

`content` is one of GitHub's reaction names (`THUMBS_UP`, `THUMBS_DOWN`,
`LAUGH`, `HOORAY`, `CONFUSED`, `HEART`, `ROCKET`, `EYES`). A review needs at
least one comment or a summary body. Each write that reaches GitHub leaves one
row in the audit log with the repository, the number and the kind, and never the
comment's text (see [security.md](./security.md#github-pr-writes)).

`draftCommentIds` is read after GitHub accepted the review. The server then
removes those comments and the summary from the saved draft of that pull request
(§10.7) and deletes the draft file when nothing is left. A comment with another id
stays, because another tab can add one while this tab submits. A review that GitHub
refuses, or that the switch refuses, leaves the draft as it was. A value that is not
a list of strings is `400`.

`POST` takes the `Host` and `Origin` checks of §3.1 like every other write route.
A request with no `Origin` header passes that check, which is how a command line
program on the same host reaches these routes.

### 10.7 The saved review: `/draft` <a id="github-pr-draft"></a>

The diff page keeps the review that a reader has collected and not submitted on
the server, one file per pull request, so the reader finds it again after the tab
closed and on another browser. The two draft routes never reach GitHub, so
`githubPr.writes` does not gate them: with the switch off the page draws no review
control and makes no new draft, and a draft that exists stays until the switch is on
again or the deletion rule below removes it.

```jsonc
// GET /api/github/pr/<owner>/<repo>/<number>/draft
{ "version": 1, "repo": "acme/widgets", "number": 12, "listed": false,
  "createdAt": "...", "updatedAt": "...",
  "summary": "", "event": "COMMENT",
  "comments": [{ "id": "...", "path": "src/a.ts", "side": "RIGHT", "line": 12, "startLine": null,
                 "body": "typo", "headSha": "<head of the diff when it was written>",
                 "anchor": { "first": "<text of the first line>", "last": "<text of the last line>" },
                 "createdAt": "..." }] }

// POST /api/github/pr/<owner>/<repo>/<number>/draft   (answers the whole draft after the change)
{ "op": "add", "comment": { "id": "...", "path": "...", "side": "RIGHT", "line": 12, "startLine": null, "body": "...", "headSha": "...", "anchor": null } }
{ "op": "remove", "id": "..." }
{ "op": "set", "summary": "...", "event": "APPROVE" }   // summary, event, or both
{ "op": "discard" }
```

A pull request with no saved review answers an empty draft: no comments, an empty
`summary` and `event` `COMMENT`. An `add` with an id that exists and a `remove` with
an id that does not exist change nothing, so a retry is safe. A draft with no comment
and an empty `summary` has no file, so a verdict alone is not kept. The refusals are
`415` for a body that is not JSON, `404` for a repository outside the configuration
or a number that is not a number, and `400` for an unknown `op`, a field of the wrong
type, more than 500 comments, or a comment body or summary of more than 65536
characters. Changes to one pull request run one at a time in the order they arrive.
Changes to two pull requests do not wait for each other.

The server deletes a draft file after each successful read of the dashboard list (the
poll and `GET /api/github/pr/list?refresh=1`; a failed read deletes nothing):

- when its repository is no longer in `githubPr.repos`,
- when the pull request was on the list at an earlier read (`listed` is true) and the
  list no longer shows it,
- when it was never on the list and no change touched it for 30 days.

A pull request that the list shows gets `listed: true` and keeps its `updatedAt`.
A file that does not parse is renamed to `<name>.unreadable` and deleted after 30
days. Each deletion writes one log line with the repository, the number, the reason
and the comment count, and never the text. Because `listed` is stored in the file, a
pull request that left the list while the daemon was down is found by the first
successful read after the start.

---

## 11. Admin

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/admin/status` | Registry, extension configs, tasks, the restart state, tmp usage. |
| `POST` | `/api/admin/reload` | Reload config and/or runtime extensions. It also re-reads the secret names, so a secret file removed from disk leaves the status list. A config reload runs the boot's root vmodel checks on the new config and applies it only when they pass, then applies the root vmodel (model, thinking level) and the root instructions to the root conversation. A new config with an empty `agent.vmodel` applies and leaves the daemon in setup mode. |
| `GET` | `/api/admin/model-setup/models` | The signed-in providers and their chat models, for the first-model form. |
| `POST` | `/api/admin/model-setup` | Save the first model into `config.json` and load it. Setup mode only. |
| `POST` | `/api/admin/restart-request` | Record an intended cold restart (does not force one). |
| `POST` | `/api/admin/restart-withdraw` | Retract a pending restart request without clearing the need. |
| `POST` | `/api/admin/restart` | Restart the daemon now: run `user-tools/update-and-restart` outside this process, or end so that `user-tools/run` does it. |
| `POST` | `/api/admin/ui-restart` | Replace the served web assets and leave the daemon running. |
| `POST` | `/api/admin/secrets/write` | Write one secret file. A name that exists is refused, never replaced. |
| `GET` | `/api/admin/audit` | Tail of the audit log (`?since=`). |
| `POST` | `/api/admin/archive` | Run an archive sweep now, instead of waiting for the next daily sweep. The answer is `skipped` when archiving is off or a sweep is already running. |

`runtimeExtensions` in `GET /api/admin/status` lists the runtime extension
directories. A record for an extension that exported `ui` gains
`ui: { cards, errors }`: the card names the registry kept, and one line for each
entry it dropped, with the reason (see
[extensions.md](./extensions.md#ui-cards)). An extension with no `ui` export has
no `ui` key.

### Model setup <a id="model-setup"></a>

Setup mode is the state of a daemon whose `agent.vmodel` is empty. The empty value
alone decides it. `GET /api/admin/status` carries two fields for it:
`modelSetupRequired` (`true` in setup mode) and `vmodelKeys` (the keys that
`vmodels` declares). The existing `config.vmodel` stays the `agent.vmodel` string,
empty in setup mode. A named but unusable root vmodel is not setup mode: it stops
the boot with exit code 2.

The wire shapes are in `src/shared/wire/model-setup.ts`.

#### `GET /api/admin/model-setup/models`

Answers in and outside setup mode, because it only reads. It lists the providers
that have a credential, each with its chat models, as ids and names. It carries no
credential value.

```json
{
  "providers": [{ "id": "anthropic", "models": [{ "id": "claude-haiku-4-5", "name": "Claude Haiku 4.5" }] }],
  "existingVmodels": ["root"],
  "modelSetupRequired": true
}
```

`existingVmodels` lists which of `root`, `orchestrator`, `planner` and `worker`
the file on disk declares. The form shows its replace checkbox when it is not empty.

#### `POST /api/admin/model-setup`

The body is the same choice as `pi-sec setup-model`:

```json
{ "provider": "anthropic", "model": "claude-haiku-4-5", "thinking": "medium",
  "workerProvider": "anthropic", "workerModel": "claude-haiku-4-5", "force": false }
```

`thinking` is one of `off`, `minimal`, `low`, `medium`, `high` (default `medium`).
`workerProvider` and `workerModel` come together or not at all. `force` replaces
vmodels the file already declares, like `--force`. The route runs these steps in
order, and one in-process lock covers steps 2 to 6, so a second request waits and
then gets `model_already_configured`:

1. `Content-Type: application/json` is required. The global `Host` and `Origin`
   guard runs before the route.
2. The daemon must be in setup mode.
3. The fields are validated as the command validates its options.
4. The model must be in the daemon's catalog, and the prompt file `default` must be
   readable. The command only warns on a missing prompt file. The route refuses.
5. `writeSetupModel` writes `config.json` with the plan the command builds, so one
   input leaves the same bytes either way (temporary file, rename, mode `0600`,
   schema check).
6. The configuration reload runs, with no extension reload: the boot's root checks,
   then the root conversation is prepared. Setup mode ends.
7. One `model_setup` audit row records the provider, the model ids and the outcome.

The route adds no HTTPS rule: the body carries model ids and no secret.

| Status | Code | When |
|--------|------|------|
| `200` | none | `{ "status": "saved", "vmodels", "roles", "root", "worker", "thinking" }`. Setup mode is over and the root conversation exists. |
| `400` | `invalid_request` | A missing provider or model, an unknown thinking level, one worker field alone, or a `force` that is not a boolean. |
| `400` | `model_not_in_catalog` | The root or the worker model is not in the catalog. Nothing is written. |
| `409` | `model_already_configured` | The daemon is not in setup mode. `config.json` is unchanged. |
| `409` | `prompt_missing` | No `prompts/vmodel/default.md` in the home or the shipped prompts. Nothing is written. |
| `409` | `write_refused` | `writeSetupModel` refused: the file already declares a vmodel and `force` is not set, the file is not valid JSON, or the result would not be a valid config. Nothing is written. |
| `409` | `config_not_applied` | The file was written but the reload failed, for example after a hand edit. The message carries the problem. The daemon keeps its running config and stays in setup mode. |
| `415` | `json_required` | The content type is not `application/json`. |
| `500` | `reload_unavailable` | The daemon has no configuration loader. Nothing is written. |

### Held providers in `GET /api/admin/status`

`usageHold` is the list the chat page's usage banner draws, one entry per provider
that is holding conversations because it refused a model request for usage (HTTP
429). It is `[]` when nothing is held, and that empty list is what takes the banner
down. The route reads documents and the last signal each provider gave, so a page
load costs no provider call.

| Field | Meaning |
|-------|---------|
| `provider` | The provider id whose refusal holds these conversations. |
| `conversations` | How many conversations are waiting for it. |
| `readable` | Whether this server can read the provider's own usage at all. `false` means the recovery is judged by a short request alone, and the banner says so. |
| `resetsAt` | Epoch milliseconds of the provider's own window reset, when it states one. |
| `lastProbeAt` | Epoch milliseconds of the newest short request that checked the provider. |
| `lastProbeResult` | `ok`, `rate_limited`, `failed`, or `none` before the first check. |
| `lastProbeReason` | Why the last check failed, when it did. A status line, never the provider's own sentence. |
| `nextProbeAt` | Epoch milliseconds when the next check is allowed, ten minutes after the last one. |

The chat page re-reads the route when it receives a `usage_hold_changed` frame
(section 12.3), so an open page follows a hold that starts and one that ends
without polling. The provider cards themselves are in section 8.

### The restart state

A restart is two facts and `status` reports both:

| Field | Meaning |
|-------|---------|
| `restartRequired` | Committed core work is not what this process booted from. Raised by the first recorded core edit; it cannot be withdrawn — only a restart, or reverting the change, clears it. |
| `restartReady` | The batch is closed and its gate passed, so running `user-tools/update-and-restart` now applies a complete change. |
| `restartRequiredAt` / `restartReadyAt` | When each became true, or `null`. |

They are separate because a restart applies whatever is on disk at that moment.
While a batch is still being written, the agent calls `withdraw_restart` (or
`POST /api/admin/restart-withdraw`), which clears `restartReady` only. The UI
shows "core change staged — restart not ready yet" rather than an invitation to
restart onto half a change.

`restart-request` is a user saying to apply it now: it raises both facts.
`restart-withdraw` answers `202 { "status": "withdrawn", … }`.

The restart state is one object shared with the `self-edit` extension, so a
`request_restart` the agent makes is visible here immediately — a page opened
afterwards included. (It used to be a flag only `POST /api/admin/restart-request`
set, so a restart the agent asked for showed a banner only on pages that were
already open to catch the SSE event.)

The tool requires a `reportId`, and it checks the approval with the same rule
the routine gate uses: the report is live, its job has not ended, and the
approval names the sha256 of the newest revision. The gate proves a change is
sound, and the approval is where consent is written. A report that moved to the
archive with its finished job is refused as `report_archived`, an unknown id as
`report_not_found`, and the other refusals carry the routine gate's codes, such
as `no_approval`, `report_not_active`, `stale_revision` and
`approval_sha256_mismatch`. The refusal names the report, its newest revision,
and what to do next. Nothing is staged, and the user is not asked to restart. A
build with no report store has no approval to read, so the check passes there.

### Restarting the daemon (`POST /api/admin/restart`) <a id="restart"></a>

This is the composer menu's `Restart server`, and `Force reinstall and restart`
under it. It does what the user does by hand: `user-tools/update-and-restart`
advances the snapshot to `main`, rebuilds, stops the service, and starts it
again. The script always rebuilds and restarts,
even when the two trees are already in sync, because a restart is sometimes the
whole request.

The daemon does not restart itself, and it cannot. It runs under a systemd unit
whose `KillMode=control-group` stops every process in the unit's cgroup, and a
`setsid` child is still in that cgroup. So the script is handed to systemd as a
transient unit of its own, which gets a sibling cgroup that `systemctl --user stop
pi-sec` cannot reach.

Under `user-tools/run` there is no unit to hand anything to, and the runner is the
process above the daemon. There the daemon writes the marker and answers `202`,
and then, once that answer is on the wire, ends with exit code 75 through the same
shutdown a `SIGTERM` takes. The runner reads 75 as "update and come back": it runs
`user-tools/update-and-restart` and starts the daemon again. The runner flag
`PI_SEC_RUNNER=1` is what picks this path; without it the daemon never takes it.

A bare `pi-sec start` has neither supervisor, so the button refuses with
`no_unit`.

The body is `{}` for a plain restart, or `{"reinstall": true}` to add
`--reinstall` to the script, which deletes the execution tree's `node_modules`
and installs it again from `package-lock.json`. A missing field, or any value
but `true`, is a plain restart. Answers:

| Status | Body | When |
|--------|------|------|
| `202` | `{ "status": "launched", "mode": "systemd", "unit", "script", "logFile", "requestedAt" }` | systemd accepted the transient unit. |
| `202` | `{ "status": "launched", "mode": "runner", "unit": null, "script", "logFile", "requestedAt" }` | The daemon runs under `user-tools/run`. It ends with code 75 after this answer. |
| `409` | `already_requested` | This process already asked once. |
| `409` | `no_unit` | No unit named `pi-sec` is enabled and the daemon does not run under `user-tools/run`: `no systemd unit named pi-sec was found and the daemon is not running under user-tools/run; stop the daemon, run user-tools/update-and-restart, and start the daemon again`. |
| `409` | `system_unit` | The unit is a system one, which needs `sudo` to restart. |
| `500` | `systemd_run_missing` | `systemd-run` is not on the daemon's `PATH`. |
| `415` | `json_required` | The body type is not `application/json`. |

`unit` is `null` under the runner, because there is no unit to name. The page
uses no field of this body: it needs the status, and it shows its own note.

A body that is not JSON is refused on purpose: a cross-site form can POST without
a preflight, and a form cannot send a JSON content type.

Before it hands the script over, or before it ends under the runner, the daemon
writes `run/restart-pending` under the control structure root. The script removes
that file before it starts the service again, and writes it back if it cannot
start the service at all. A file still present at the next boot therefore means
the last restart did not complete, which the daemon reports as a note and an audit
event. The order matters: the process that boots reads this file, so a script that
removed it after the start would report every successful restart as a failure.
The script's output is appended to `logs/update-and-restart.log`.

### Replacing the web assets (`POST /api/admin/ui-restart`)

This is the composer menu's `Restart UI`. The daemon keeps running. The pid and
the uptime do not move, no conversation baseline is read again, and a turn in
progress is not interrupted. The route replaces the directory the static route
serves, so the next page load draws with the new files.

It works because the daemon keeps no copy of its assets. `serveStatic` reads the
file from disk on every request and sends `Cache-Control: no-cache` with no
`ETag` and no `Last-Modified`, so a reload revalidates and gets the current
bytes. The build step for the web tree copies the shells and then bundles the
pages: `scripts/copy-assets.mjs` puts `src/web` into `dist/web`, and
`scripts/build-ui.mjs` writes one `ui-<page>.js` bundle per page entry in
`src/ui/pages/`. The route does both steps itself, so the files a user edits in
the workspace are the files the browser runs.

A bundle is not a file to copy. The page entry modules are TSX, and only a build
turns them into the script the browser loads, so a swap that copied `src/web`
alone would serve new shells with no page code, or with the page code of an older
build.

The source is `<agent.workspace>/src/web` in the working tree, not the committed
revision, because the point of the button is to look at an edit before it is
committed. The target is the `webDir` the daemon serves from, which is inside the
execution tree.

The body is `{}`, and the content-type rule is the one this section describes for
`restart`: a body that is not `application/json` is refused with `415`.

The route does four steps:

1. It checks the two directories. A missing one is refused with `source_missing`
   or `web_dir_missing` before anything is written.
2. It copies `<agent.workspace>/src/web` into a staging directory beside the
   target, named `web.build-<stamp>`.
3. It runs `node <agent.workspace>/scripts/build-ui.mjs --outdir <staging>` with
   the node of the running daemon, so the page bundles land in the staging
   directory that already holds the shells.
4. It swaps the staging directory in. The current tree is moved aside, the
   staging tree is moved into place, and the previous tree is removed. A
   half-written tree is never served.

The build has a limit of 120 seconds. A build that exits with a failure, and a
build that hits the limit, answer `409` with the code `build_failed`: the fix is
in the workspace code, not in the daemon. The served tree is left as it was, and
`restored` is `true`. The build output goes to the daemon log, and the answer
carries no line of it.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "ok": true, "copied", "uiHash", "source", "target", "codeDrift" }` | The new tree is in place. |
| `409` | `source_missing` | The web source directory does not exist. |
| `409` | `web_dir_missing` | The directory to replace does not exist. |
| `409` | `build_failed` | The pages could not be built from the workspace, or the build ran past 120 seconds. |
| `500` | `sync_failed` | The swap failed. |
| `500` | `ui_restart_unavailable` | This daemon has nothing wired that can replace its assets. |
| `415` | `json_required` | The body type is not `application/json`. |

`copied` is the number of files in the new tree. `uiHash` is one sha256 over a
list of every file: its path relative to the root, and the sha256 of its bytes,
in path order. The same content always gives the same hash, so the audit row
names the tree that went out. `source` and `target` are the two directories.

This route changes `dist/web` only and does not change server code. A `.ts` file
under `src/` outside `src/ui` is compiled into `dist/server`, and the process
serves the build it booted from, so that change still needs a cold restart.
`codeDrift` says how much was left out:

| Field | Meaning |
|-------|---------|
| `known` | Whether git could answer. `false` means the other two fields say nothing. |
| `behind` | Commits in the workspace tree that the execution tree does not have. |
| `codePaths` | Changed paths under `src/` other than `src/web/` and `src/ui/`, sorted. Bodies of documentation are not counted. |

`codePaths` also lists paths that are changed or untracked in the workspace
working tree, not only the paths that differ between the two commits, because the
user runs this before committing.

The route runs git with a 5 second timeout. A missing git, a directory that is
not a repository, or any other failure answers `known: false` with a zero count
and no paths, and never refuses the swap, which has finished by then.

The error body of a refusal carries `details: {"code", "restored"}` next to the
usual `code`, `message` and `requestId`. `restored` tells the page what it has to
say next. `true` means the previous tree is still in place at the target, so the
user can fix the reason and press again. `false` means no tree is known to be
at the target: it never existed, the previous tree is now in a `web.prev-<stamp>`
directory beside it, or the swap failed in a way that left no report of a
restore. The log line `ui assets not swapped` names that directory when there is
one, and names the line of the workspace build that failed when the code is
`build_failed`.

The audit log gets `ui_restart` with `source: "ui"`, `copied`, `uiHash` and
`behind`, and `ui_restart_refused` with `source: "ui"` and `code`. The rows of
`restart_launched` and `restart_refused` are unchanged.

Three limits are worth naming. The route does not touch `dist/server`, so an
asset that calls a route the running daemon does not have draws a broken page,
and only a cold restart fixes that. The build runs in the workspace tree, so that
tree needs its `node_modules` with `esbuild` installed; a tree without them
answers `build_failed`. And the swap replaces the whole directory, so a file
removed from `src/web` stops being served on the next press, while the build
keeps it: `scripts/copy-assets.mjs` copies over `dist/web` and never deletes.

### Writing a secret (`POST /api/admin/secrets/write`)

The snippet panel's secret mode calls this route. It is the only route that writes
into the secret directory, which is `~/.pi/sec/secrets`, and `server.ts` registers
it on a line of its own beside the rest of the admin surface.

The body is `{"name": "gh_token", "text": "ghp_…"}`, and the request must carry
`Content-Type: application/json`. The check is the one `restart` and `ui-restart`
make, for the same reason: a cross-site form can POST without a preflight, and a
form cannot send that type. The name comes in the body and not in the query,
because the access log records `req.url`.

| Status | Body | When |
|--------|------|------|
| `200` | `{ "ok": true, "name", "bytes" }` | The file is in place and the registry has reloaded. |
| `400` | `invalid_name` | The name fails the rule below. A `name` that is missing or not a string is an empty name, and it fails here. |
| `400` | `empty_secret` | `text` is missing, is not a string, or holds no character other than whitespace. |
| `409` | `name_exists` | A secret of that name exists. Nothing is written and the existing bytes stay. |
| `413` | `payload_too_large` | The body is larger than `server.maxBodyBytes`, which is 1 MiB by default. |
| `415` | `json_required` | The content type is not `application/json`. |
| `500` | `write_failed` | The write failed, the reload threw, or the name is still absent from the registry after it. |

`bytes` counts the UTF-8 length of `text` as it was sent, so a trailing newline
counts.

A name must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, must not be `env`, and must
not end with a dot. `env` is refused because the registry reads that one file as a
`KEY=value` bundle and would register each line under its own key. A trailing dot
is refused because `name.` and `name` are one file on some filesystems and two on
others, so a duplicate upload would look new. The pattern is ASCII only, so it
admits no path separator, no leading dot, no `..`, no NUL and no control
character. Names are case sensitive.

The secret directory is mode 0700. The write makes a `.upload-<ulid>` file there
at mode 0600, fsyncs it, and links it to its final name. That temporary name
starts with a dot, so the registry skips it and never reads a half-written file. `link` answers `EEXIST` instead of replacing its target, so the
existence check and the write are one action and no window opens between them. The
final file is the temporary file's inode, so it carries 0600 from its first
visible moment. The temporary name is removed on both the success and the failure
path, and one left by a crash is removed by a later write once it is an hour old.

No refusal quotes the text, the name or an error object: an `Error` written into a
body can repeat a path, and a path can carry a name. The audit row is
`secret.write` with `name` and `bytes`, and it holds neither the value nor a hash
of it, because a hash of a low-entropy secret is a guess that can be checked.

Nothing is logged and no answer is sent until `secrets.reload()` returns: before
that call the registry does not know the new value, and redaction does not cover
it. A reload that throws, and a reload after which the name is still not listed,
answer `500` rather than a `200` over a half-done write. The admin surface lists
secret names and never a value, and this route cannot change or remove a secret.

### Model login <a id="model-login"></a>

These routes sign a model provider in from the web UI. The daemon runs the login
flow of its own model runtime: the credential lands in the same secret store with
the same names that any other login writes, `auth.json` keeps only references, and
the daemon reads the new value on its next request. The daemon does not restart.

The panel in the page is one caller. The `curl` sequence at the end of this
section is the other: a daemon behind a proxy that is down can be signed in from
the host.

`server.ts` registers the five routes on a line of their own, like the secret
write route, because they can replace the model credential.

| Route | What it does |
|-------|--------------|
| `GET /api/admin/model-login/providers` | The providers, their login types, their credential state and their last recorded login. |
| `POST /api/admin/model-login/start` | Starts a login and returns the session id. |
| `POST /api/admin/model-login/state` | The current state of one session. |
| `POST /api/admin/model-login/answer` | Answers the question the flow is waiting on. |
| `POST /api/admin/model-login/cancel` | Ends the session. |

Every `POST` requires `Content-Type: application/json`, and answers `415
json_required` with the message `send this request with Content-Type:
application/json` otherwise. The session id and the answer come in the body and
never in the query, because the access log records `req.url`.

#### `GET /api/admin/model-login/providers`

```json
{
  "available": true,
  "rootProvider": "anthropic",
  "sessionActive": false,
  "providers": [
    {
      "id": "anthropic",
      "extension": null,
      "configured": false,
      "types": ["oauth", "api_key"],
      "lastLogin": { "at": "2030-01-15T15:05:00.000Z", "type": "oauth" }
    }
  ]
}
```

`extension` names the runtime extension that registered the provider, or `null`
for a built-in one. `types` lists the login types the provider can actually run,
so an API key that only comes from the environment is not offered. `lastLogin` is
the newest successful login for that provider from `state/model-logins.json`, or
`null`. `rootProvider` is the provider of the root vmodel, and it is absent when
that vmodel cannot be resolved. `available` is `false` when this daemon cannot log
a provider in at all, and the panel then says so instead of offering a button.

The page reads this route on load and shows one line when `rootProvider` has no
credential. It reads nothing from `GET /basic-chat/events` or
`GET /basic-chat/context` for that line, because both answer `503 root_missing`
on a daemon whose root preparation failed, and a fresh install is that daemon.

#### `POST /api/admin/model-login/start`

```json
{ "provider": "anthropic", "type": "oauth" }
```

`type` is `oauth` or `api_key`. The answer is `200` with the session id and the
state at that moment:

```json
{
  "session": "3E1t0m9r0Yb2T0m5n1w6x8kA",
  "state": {
    "status": "running",
    "provider": "anthropic",
    "type": "oauth",
    "prompt": null,
    "events": [],
    "startedAt": "2030-01-15T00:00:00.000Z",
    "finishedAt": null,
    "loginAt": null,
    "reason": null,
    "warning": null
  }
}
```

The session id is 16 random bytes in base64url. Every later request names it, and
prompts, links and the outcome are returned only to a request that carries it.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_request` | `provider` is missing or empty, or `type` is neither `oauth` nor `api_key`. |
| `400` | `login_type_unavailable` | The provider offers no login of that type. |
| `403` | `https_required` | The request arrived under a name that is not loopback and `server.publicUrl` does not start with `https:`. |
| `404` | `unknown_provider` | The catalog has no provider with that id. |
| `409` | `login_busy` | A login session is already running. One at a time is the rule. |
| `503` | `login_unavailable` | This daemon cannot log a provider in. |

The `403` is the transport rule. The sign-in link a login flow returns carries
the proof that binds the browser's answer to that flow, so the daemon refuses to
start a login that a browser would reach over plain HTTP. A loopback name is this
machine and needs no transport, so `http://127.0.0.1:<port>/` is always allowed.

#### `POST /api/admin/model-login/state`

```json
{ "session": "3E1t0m9r0Yb2T0m5n1w6x8kA" }
```

The answer is `200` with the state of that session, in the shape shown above. A
page polls it about once a second.

`status` is one of:

| Status | Meaning |
|--------|---------|
| `running` | The flow is working; nothing is asked and nothing is finished. |
| `prompt` | The flow waits for an answer. `prompt` holds the question. |
| `succeeded` | The credential is stored. `loginAt` holds the time and `warning` is `null` or the record-file warning. |
| `failed` | The flow ended without a credential. `reason` says why. |
| `cancelled` | `POST .../cancel` ended it. |
| `timeout` | Ten minutes passed from the start. |

`prompt` carries `type` (`text`, `secret`, `select` or `manual_code`), `message`,
an optional `placeholder`, and for `select` a list of `{id, label, description?}`.
`events` are the notifications so far, appended in order and never changed:
`auth_url` with `url` and optional `instructions`, `device_code` with `userCode`,
`verificationUri` and optional `intervalSeconds` and `expiresInSeconds`, `info`
with `message` and optional `links`, and `progress` with `message`.

`reason` is `cancelled`, `timeout`, `code_rejected` or `failed`. `code_rejected`
means the flow failed after an answer to a `manual_code` or `text` prompt was
submitted, which is what a wrong or expired code looks like. A library error can
carry the provider's response body, so no route repeats one: these four codes and
the fixed sentences below are all a caller gets.

`warning` is `null`, or the line
`warning: the login time was not recorded in <file>: <reason>` when the record
file could not be read or written. `<reason>` is a short phrase such as
`the file is not a login record` or `the file could not be written (EACCES)`, and
it never quotes a file's content.

A finished session's state stays readable for ten minutes after it ends, and until
the next start. After that the id answers `404 login_not_found`. A `404` also
means the session never existed, or the daemon restarted: sessions live in memory
only.

#### `POST /api/admin/model-login/answer`

```json
{ "session": "3E1t0m9r0Yb2T0m5n1w6x8kA", "value": "code#state" }
```

The answer goes to the login flow and nowhere else. For `select`, `value` is the
id of the chosen option. The answer is `200` with the state after it was taken.
An answer is not stored, not logged, and not repeated in a response.

| Status | Code | When |
|--------|------|------|
| `400` | `invalid_request` | `session` is missing, or `value` is not a string. |
| `404` | `login_not_found` | No session carries that id. |
| `409` | `login_no_prompt` | The session is not waiting for an answer. |

#### `POST /api/admin/model-login/cancel`

```json
{ "session": "3E1t0m9r0Yb2T0m5n1w6x8kA" }
```

Aborts the flow and answers `200` with `status: "cancelled"`. A session that
already finished answers with the state it has.

#### Sessions, the audit log and the login record

One login runs at a time. A session ends when it succeeds or fails, when it is
cancelled, ten minutes after it started, or when the daemon restarts. Nothing of
it is written to disk except the record entry a success writes.

Every finished session appends one audit row:

```json
{ "type": "model_login", "provider": "anthropic", "loginType": "oauth", "outcome": "success" }
```

`outcome` is `success`, `failed`, `cancelled` or `timeout`. The row carries no
other field, and the audit file rotates, so the record file and not the audit log
is where the last login time is read.

A successful login writes one entry per provider to `state/model-logins.json`:

```json
{
  "version": 1,
  "logins": {
    "anthropic": { "at": "2030-01-15T15:05:00.000Z", "type": "oauth" }
  }
}
```

The entry replaces that provider's whole entry, and every other provider's entry
is written back as it was read. A file that cannot be read or is not this shape
is replaced with one holding only the new entry, and the state carries the warning
above. The file is written to a temporary name in the same directory and renamed,
so a reader finds the old bytes or the new ones. Its mode is `0600`. A login that
succeeds stays a success when the file cannot be written: the credential is
already in the secret store, and the audit row still says `success`.

#### The installation ID and the callback port

A login flow can ask the daemon for a stable ID of this installation. The flow
sends that value to the provider as the agent host ID of the installation, and
OpenAI uses it to tell one installation from another. The daemon creates the ID
on the first login that asks for it and writes it to `~/.pi/sec/state/device-id`:
one lowercase UUID and a newline, mode `0600`, written to a temporary name in the
same directory and renamed into place. The daemon never rewrites the file, so
every later login and every daemon restart passes the same ID.

If the file cannot be read, or does not hold one lowercase UUID, the daemon
leaves it as it is and the login fails with `reason: "failed"`. The app log then
carries one warning that names the file, once per daemon run, and no route
repeats the text of a flow's error. To let the next login create a new ID,
delete the file. A provider that knows this installation then sees a new one. The
credentials already stored stay usable, because a token refresh sends no device
ID.

The `openai` and `openai-codex` flows both answer the browser on port `1455` of
the daemon host (`http://127.0.0.1:1455/auth/callback`). Only one of the two
logins runs at a time, and a second one fails while the port is held.

When the browser runs on another computer, the callback cannot reach the daemon.
The `openai` flow then also asks a `manual_code` prompt. Sign in, let the browser
land on the `127.0.0.1:1455` address, copy that whole address from the address
bar, and answer the prompt with it. The daemon reads the code out of that
address.

#### Signing in with `curl` from the host

Use this when the page does not work, for example while the proxy is down. The
daemon accepts loopback names, so an SSH tunnel to the daemon's port is enough.

```bash
BASE=http://127.0.0.1:8787
PROVIDER=anthropic

# 1. Start. The answer carries the session id and the first state.
SESSION=$(curl -sS -H 'Content-Type: application/json' \
  -d "{\"provider\":\"$PROVIDER\",\"type\":\"oauth\"}" \
  "$BASE/api/admin/model-login/start" | sed -n 's/.*"session":"\([^"]*\)".*/\1/p')
echo "$SESSION"

# 2. Read the state until it shows a prompt, and open the link it gives.
curl -sS -H 'Content-Type: application/json' -d "{\"session\":\"$SESSION\"}" \
  "$BASE/api/admin/model-login/state"
```

Open the `url` of the `auth_url` event in a browser, sign in, and copy the code
the provider shows. Then read the code without putting it in the shell history:

```bash
read -r -p 'code: ' CODE

curl -sS -H 'Content-Type: application/json' \
  -d "{\"session\":\"$SESSION\",\"value\":\"$CODE\"}" \
  "$BASE/api/admin/model-login/answer"

# 3. Read the state again: `succeeded` with `loginAt`, or a reason code.
curl -sS -H 'Content-Type: application/json' -d "{\"session\":\"$SESSION\"}" \
  "$BASE/api/admin/model-login/state"
```

A `select` prompt is answered with the id of one of its options, for example
`{"session":"…","value":"copy_code"}`. An API-key login asks one `secret`
question, and the key is the `value` of that answer.

### Attachment files on disk

An attachment is a plain file, and an agent reads one with `read`. The path is
`~/attachments/<id>/<stored name>`, where `<id>` is the ULID the upload answer
returns and the directory holds that one file. The root is `attachments.dir` from
the configuration, resolved against the account running the daemon.

The stored name comes from the uploaded name, reduced to one safe segment:
`basename` first, then each run of characters outside `[A-Za-z0-9._-]` becomes
`-`, then leading dots and dashes are dropped and each run of dashes becomes one.
The result is cut at 120 characters, which can drop the extension of a very long
name.

An image whose MIME is `png`, `jpeg`, `gif` or `webp` takes its extension from
that MIME. Any other file keeps the extension its name ends with, and a name with
none takes `txt` for `text/plain` and `bin` for everything else. When nothing of
the name survives, the file becomes `<id>.<ext>`.

| Uploaded name | MIME | Stored as |
|---------------|------|-----------|
| `snippet` | `text/plain; charset=utf-8` | `<id>/snippet.txt` |
| `run.log` | `text/plain` | `<id>/run.log` |
| `../../etc/passwd` | `application/pdf` | `<id>/passwd.bin` |
| `한글 스니펫` | `text/plain` | `<id>/<id>.txt` |

The record keeps the name the uploader gave, and the `name` in the upload answer,
in the `meta` answer and in the `Content-Disposition` of the download are that
name. A browser therefore saves the file under the uploaded name even when the
stored name had to be reduced. Each upload gets a fresh ULID directory, so two
files of one name are two attachments and neither is renamed.

A row written before this layout keeps `<id>.<ext>` and its own `storagePath`.
Serving, reading and the sweep all use that field, so an old row is read from the
old path and no migration exists. The sweep removes the directory the row points
at, which holds one file in either layout.

### Lifetime of stored files

pi-sec keeps a stored file as long as it has an owner job. This holds for an
upload under `attachments.dir` and for a file an agent published under
`attachments.shareDir`. A file gets an owner job when `share_image` names one or
when `attachments_assign` gives it to one. When the job finishes and later moves
to the archive, the file stays where it is, its record keeps the job id, and its
URL keeps answering. pi-sec does not move the file to the archive and does not
delete it.

A file with no owner job is temporary. The sweep that runs once at each daemon
start deletes it, with its record, when it is 24 hours old or older. Nothing
deletes it between two starts, so an unowned file can stay longer than 24 hours.

The same sweep retires a record whose file is gone. It also deletes a file in
the share directory that no record names, and a ULID-named entry in the
attachment directory that no record names. Each deletion writes an
`attachment_disposed` or `attachment_orphan_removed` entry to the audit log.

No tool or route deletes one kept file. To delete one by hand, remove the file
from its directory. The next daemon start retires its record, and its URL then
answers 404.

### Shared files

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/share/<name>` | Serve a file an agent published, from the share directory (`attachments.shareDir`). This is the route a `share_image` URL names. |
| `GET` | `/rich-pages/<id>` | The shell of a rich page: a core page with a label bar and the page in a sandboxed frame. This is the address `share_page` returns. An unknown id answers `404` with the sentence "This page no longer exists". |
| `GET` | `/rich-pages/<id>/frame` | The page content of a rich page, under the isolation header described below. A request with `Sec-Fetch-Dest: document` answers `302` to the shell. `If-None-Match` with the `ETag` answers `304`. An id that is not a page answers `404` with the same sentence in a small HTML body. |
| `POST` | `/api/attachments` | Store one uploaded file. The body is the bytes and the name comes in `?name=`. The answer is `201` with `id`, `url`, `name`, `mime`, `bytes`, `sha256` and, for an image, the pixel size. |
| `GET` | `/api/attachments/<id>` | Serve a stored file. `<id>/download` sends it as an attachment, and `<id>/meta` answers its name, type, size and host-root `url` without the bytes. |

`/api/share` serves `attachments.shareDir`.
The name is the only thing protecting a file: this server has no authentication,
so `/api/share` is exactly as reachable as the chat is. What it is *not* is a way to
read anything else on the machine — one path segment, no traversal, and an
extension allowlist of raster images only. SVG is deliberately excluded: it is a
document, it would be same-origin, and opening one directly would run whatever
script it carries. Responses carry `X-Content-Type-Options: nosniff`, and a
response that is not a raster image also carries `Content-Security-Policy:
default-src 'none'; sandbox`, so a browser that opens it runs nothing.

A rich page is a share file that `share_page` stored with a mark on its record.
It follows the share file lifetime rules in [Lifetime of stored files](#lifetime-of-stored-files).
`/rich-pages/<id>/frame` serves only a record with that mark, with kind `share` and
type `text/html`. An HTML file that reached the share directory another way, such as
`share_image` with a `data:text/html` source, stays a download at
`/api/share/<name>`, and the page routes answer `404` for it. The frame answer
carries these headers:

```text
Content-Type: text/html; charset=utf-8
Content-Security-Policy: sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: no-cache
ETag: "<sha256 of the stored bytes>-<version of the height script>"
```

The body is the stored bytes followed by one inline script that posts the content
height to the parent page. The shell sends the same policy as the report page,
`nosniff` and `no-referrer`. The isolation and its limits are in
[security.md](./security.md#rich-pages).

`url` in the upload answer and in the `meta` answer is a host-root path, such
as `/api/attachments/<id>`: the page that receives it adds the mount itself. A URL
a tool returns is different, because a reader follows it from a page the tool
never built. `share_image`, `attachment_open` and `attachments_list` answer
`<prefix>/api/share/<name>` and `<prefix>/api/attachments/<id>`, where `<prefix>`
is the mount from §2 (`server.basePath`, else the path of `server.publicUrl`). A
tool call carries no request, so a prefix that only `X-Forwarded-Prefix` declares
does not reach it: under a proxy that strips the prefix and announces it, a URL
from a tool carries no mount.

`/api/admin/status` also carries `notes`: the daemon's recent diagnostics (a
config reload that failed, a review that could not be delivered, a forwarded
prefix that disagrees with the configured mount). Each is `{ at, text }`, the
list is capped at 50 and a repeated message moves to the end instead of stacking,
and the UI shows the newest few in the sidebar — before that they were recorded
and never displayed, so a wrong forwarded prefix had to be found in devtools.

There is no admin authentication. If the reverse proxy exposes these routes, it is
responsible for restricting them.

A reload reads `config.json` and the extension directories. **A config that
cannot load does not half-apply**: the config already loaded keeps serving, and
the answer is `400 { "status": "config_failed", "issues": [ … ] }` carrying the
same reasons that would have stopped the daemon at startup. Those reasons are
also recorded — as `configError` in `/api/admin/status`, in the audit log, and in
the log file — so a page opened afterwards still shows the banner instead of
reporting a successful reload. The restart state is deliberately left alone: a
restart would read the same file and refuse to start.

A reload also runs the boot's root vmodel checks on the new config: a key that
`vmodels` does not hold, a prompt file or role file that cannot be read, and a
model outside the catalog. A config that fails them is not applied. The answer is
the same `400 config_failed` with the problem sentence in `issues`, and a daemon
in setup mode stays in setup mode. An empty `agent.vmodel` is not a failure.

---

## 12. SSE protocol <a id="sse-protocol"></a>

### 12.1 Headers

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

A request that accepts gzip also gets `Content-Encoding: gzip` and `Vary:
Accept-Encoding`. The server writes through a gzip stream and flushes it after
every write (the retry line, each frame, each heartbeat comment, the lagging
notice), so a reader can decode an event as soon as it is written instead of
waiting for the next one. A client that does not ask for gzip reads the stream
uncompressed, framing unchanged.

### 12.2 Envelope

`event` + `id` + `data` (JSON). `id` increases monotonically **per stream** (per
endpoint, and per conversation for conversation streams); `Last-Event-ID` resume
is scoped to the same stream URL.

```
id: 42
event: message_end
data: {"type":"message_end","entry":{"id":"01J...","kind":"pi.assistant","model":[...]}}

: heartbeat 2030-01-15T08:34:00Z

id: 43
event: run_end
data: {"type":"run_end","inputs":["01J..."]}
```

The example carries `message_end` because the chat streams do not send
`message_update`. The event kinds below say where a client reads text that is
still being written.

### 12.3 Event kinds

On a fresh connection the first event is always `snapshot`. Then pi-durable
`AgentEvent`s plus `pi-sec` control events:

| Event | Source | Meaning |
|-------|--------|---------|
| `snapshot` | pi-durable | Bounded state: recent `entries` window (+`entriesCursor`/`hasMore`), run, generation partial, tools, compactions, submission queue (`inbox`), agent, usage. |
| `run_start` / `run_end` | pi-durable | Run lifecycle. |
| `turn_start` / `turn_end` | pi-durable | One model turn. |
| `message_start` / `message_end` | pi-durable | The start of an answer and the whole message. The chat streams do not send `message_update`, which pi-durable still emits as each committed partial changes. A client that needs the text written so far reads `generation.message` in the snapshot. |
| `tool_execution_start` / `_update` / `_end` | pi-durable | Tool lifecycle and streamed output. |
| `compaction_start` / `compaction_end` | pi-durable | Context compaction. |
| `user_query` / `user_query_resolved` | pi-sec | The active `ask_user` list changed (`user_query_resolved` carries `reason`: `answer`, `withdraw`, or `supersede`). |
| `extension_reloaded` | pi-sec | Registry changed. |
| `ui_event` | pi-sec | A card event, with `extension`, `card`, `event` and `value`. Every open chat page receives it, and the page hands it to the card of that extension and card name (see [extensions.md](./extensions.md#ui-cards)). |
| `restart_required` | pi-sec | A core change is committed and awaits a cold restart. |
| `restart_withdrawn` | pi-sec | A pending restart request was retracted (`reason`, or `source: "admin"`), so it must not be applied mid-batch; the restart itself is still required. |
| `job_created` / `job_updated` | pi-sec | Job lifecycle (also on `/api/jobs/events`). |
| `report_created` | pi-sec | A report was published. The payload is its record; an open UI re-reads the inbox. |
| `report_updated` | pi-sec | A report gained a revision, or one of its revisions was approved. The payload is its record, and an open UI re-reads the inbox. |
| `report_feedback` | pi-sec | User feedback on report `id`. `entry` is the feedback, which is delivered into the conversation as a review. An approval emits `report_updated` instead of this event. |
| `sections_stale` | pi-sec | A sealed section's value moved on for a conversation (`conversationId`, `keys`). The session keeps the value it started with. An agent opens a round to move the new value in. |
| `focused_chat_updated` | pi-sec | A focused chat was opened, titled, archived or deleted. It carries `conversationId`, `name`, `title`, `openedAt`, `archivedAt` and `change` (`opened`, `titled`, `archived`, `deleted`). It reaches the chat page and the chats list page. The list page also receives it on `/api/focused-chats/events`. |
| `inbox_update` | pi-durable | The conversation's pending-submission queue changed. |
| `inbox_item` | pi-sec | A new notification item in `sec.inbox`. |
| `preferences_updated` | pi-sec | The shared UI state (theme, panel folds, cleared and folded lists) changed. The payload is `{ revision }` only; the page reads `GET /api/preferences` when it is behind. |
| `remote_machine_updated` | pi-sec | A remote machine's level, its wait for a stricter level, link state or block changed. The payload names the machine (`id`); the Machines panel re-reads `GET /api/remote-machines` for any value. |
| `usage_hold_changed` | pi-sec | The set of providers holding conversations for a usage limit changed. The payload names them (`providers`, a list of provider ids, empty when nothing is held). The chat page re-reads `GET /api/admin/status` for the banner, which draws its `usageHold` list (section 11). |
| `notice` | pi-sec | Human-facing status/errors. |

`pi-sec` wraps pi-durable's event union rather than forking it, so upgrades are
mechanical.

### 12.4 Resume and reconnects

- If `Last-Event-ID` is still buffered for this stream, replay events after it.
- Otherwise send a fresh `snapshot`. A `snapshot` always supersedes partial
  deltas, so clients never reconcile.
- `retry:` is set to 3s.

### 12.5 Backpressure

- The measure is the real backlog: the bytes written but not yet sent to the
  socket, which is `res.writableLength` (the response's own queue plus the
  socket's) plus, when the stream is compressed, what is still inside the gzip
  stream.
- Before a frame is written, a backlog already over the cap (1 MiB) answers with
  `notice` (`code: "stream_lagging"`) and disconnects; reconnect yields a
  snapshot. A single frame larger than the cap on an empty pipe is delivered: the
  rule looks at what is waiting behind it, not at its size.
- `res.write` returning `false` is not a lag signal. It only says the socket's
  high water mark was passed, which one large frame does on its own.
- Heartbeat comment every 15s keeps proxies from idling out.

---

## 13. Versioning

- The API is **path-stable and unversioned**: routes live under `/api/`, and
  `/basic-chat` and `/healthz` are stable too.
- The current API revision is `1`. It is announced in the `X-API-Version`
  response header and in `apiVersion` on the first `snapshot`. The client checks
  it and can show an "update required" notice.
- Additive changes (new events, new optional fields) do not bump the revision. A
  future **breaking** revision moves to `/api/v2/...`; SSE `type` strings follow
  pi-durable, and a breaking event-union change bumps `apiVersion`.
