# Web UI

Companion to [README.md](./README.md). The UI is `pi-sec`'s only first-party
interface. It is small, static, and good-looking — a real app, not a debug
textarea.

---

## 1. Goals

- **One page per channel.** `/basic-chat` is the conversation: transcript,
  composer, the questions that wait on an answer, the inbox, and jobs in one view,
  with `system prompt updated` drawn as a divider in the transcript.
  `?chat=<id>` puts one focused chat in that same page, and `/chats` is the page
  that lists the focused chats. `/report` is a second page for long documents
  (section 10), `/chats` is a third for the chat list (section 11), and `/usage`
  is a fourth for what each service has spent (section 12), with `/usage/stats` under it for model speed. An extension adds a
  fifth set of three pages for pull requests (section 13), and those pages carry
  GitHub's own theme rather than pi-sec's. The remote machines this install may
  reach over `ssh` are a panel of the chat page's sidebar (section 14), not a page
  of their own.
- **An answer arrives whole.** While the model writes, the transcript shows a
  short "writing…" row. The answer appears once, complete, so the user never
  reads a half-written sentence. The row is always the last row of the list and
  keeps its height while it is hidden, so the list does not move when the row
  appears or disappears. A reconnect restores a consistent baseline
  without flicker.
- **An update never resets what the user did not touch.** A stream event, a poll,
  a reconnect or a snapshot changes only the values it carries. Typed text and
  its caret, focus, a text selection, a scroll position, and an open or chosen
  state stay as they were, and the element that holds them stays the same
  element. Page code never replaces a region's contents wholesale. The one
  exception is the markdown view, which draws again only when its text changes.
- **Good-looking by default.** A coherent theme (spacing, type, color, motion),
  light/dark, and responsive down to a phone.
- **Accessible.** Semantic HTML, keyboard-first operation, an ARIA live region
  for streaming text, visible focus, and sufficient contrast.
- **One build step, one view library.** The pages are TypeScript (TSX) modules
  under `src/ui/`, drawn with Preact and `@preact/signals`, and bundled by one
  esbuild step inside `npm run build`. The CSS files, `base.js` and
  `ui-cards.js` are served as written. Another dependency in the page needs a
  plan of its own.

---

## 2. Layout

```text
┌──────────────────────────────────────────────────────────────┐
│  pi-sec            ● live        root                 ◐ theme │  header
├───────────────────────────┬──────────────────────────────────┤
│                           │  Awaiting you                    │
│   transcript              │   Which account?  [work][other]  │
│   ┌───────────────────┐   │                                  │
│   │ you: …            │   │  Inbox                    (3)    │
│   └───────────────────┘   │   • 07:00 Brief ready            │
│   ┌───────────────────┐   │   • …                            │
│   │ assistant: …      │   │                                  │
│   │  [tool: bash ▸]   │   │  Jobs                            │
│   └───────────────────┘   │   ▾ routine-c          ● active  │
│   ── compressing context… │     ▸ fetch-news       ○ planned │
│                           │   ▸ routine-b          ◐ waiting │
├───────────────────────────┴──────────────────────────────────┤
│███                                                           │  context
│  [ message…                                              ] ⏎  │  composer
└──────────────────────────────────────────────────────────────┘
```

- **Header**: the π mark, the chat's name, the SSE connection indicator, an
  activity ring, the active model (not drawn on a screen 860px wide or
  narrower), the banners, and the sidebar toggle as the last thing in the bar,
  at its right end. The mark is the one the companion pages carry beside their
  own name, and it is not a press. The ring turns while the agent
  is working: blue while the model is waited on or is answering, green while
  a tool call runs. It turns red while the connection to the server is lost, and
  red wins over the other two. If the connection stays lost for more than 5
  seconds, the page also shows a toast. It is not drawn at rest, so it takes no
  room until it has something to say. The name is the chat's own: the
  personality's name on the root conversation, or `pi-sec` when the personality
  has none, and the chat's title on a focused chat, where the `Focused chat` mark
  stands in front of it in the accent's pale wash and the bar takes the same wash
  as its fill (see section 11).
- **Transcript**: the active context, rendered from the snapshot plus streamed
  events. The page draws the last screen of a snapshot first and the rows above
  it when the browser is idle. While you read the newest entry, the transcript
  stays at the bottom, also when a row changes its height after it is drawn. If
  you scroll up, the page keeps your place, also when rows are added above.
- **Sidebar** (shown in flow on a wide screen, a drawer over the transcript below
  the breakpoint): pending `ask_user` questions, the inbox, the live job tree, the
  remote machines, and the footer. The footer holds the context readout
  (`10.7k / 983.6k`), then the theme control, then the Pages row, and the
  `sidebar.bottom` slot comes below all three (section 8). The theme control cycles
  `auto`, `light` and `dark`. The mode is shared: the server stamps it into
  `<html data-theme>` of every page it serves, so the first paint already uses it,
  and a press on one machine changes every open page that has a stream.
  The inbox heading holds the count and `hide all` and no link, because the chat
  list and its New chat button are reached from the Pages row below. The header
  toggle collapses the panel; on a narrow screen the drawer covers the transcript
  with a scrim behind it, and the scrim or `Esc` closes it.
  A panel's own heading also folds that panel: the name and a caret are one
  button, and a press hides the list under the heading while the heading, its
  badges and its controls stay. The caret is drawn, a triangle pointing down
  while the list is open and pointing right while it is folded, the way the
  composer's tool marks are drawn. The inbox, the job tree and the Machines panel
  fold. Awaiting you and Notes do not: one asks for an answer and the other
  reports a failure, and both are read as they arrive. The server keeps which
  panels are folded, in two lists: one for wide screens and one for narrow
  screens. A reload opens the page the way the operator left it, every wide
  screen shows the same folds, and every phone-width screen shows the same folds.
  The theme is shared the same way. Section 4 has the detail.
- **Pages row**: the row is named `Pages`, and its button reads `↗ Open`. The
  button opens a dropdown upward with the other first-party pages, in this order:
  `Reports` (`/report`), `Usage` (`/usage`), `Chats` (`/chats`), and then one entry
  for each page link that an enabled bundled extension declares (see
  [extensions.md](./extensions.md#extension-pages)). The `github-pr` extension
  adds `PRs` (`/github/pr/`) that way while it is on, and a link is absent while
  its extension is off, because the address behind it would answer nothing. Both
  follow the enabled list the server read when it started, so turning an
  extension on or off changes the menu at the next daemon restart and not
  before. Each
  link opens a new tab, so a document, the usage dashboard and the chat list never
  replace the conversation. An outside click or `Esc` closes the dropdown, and so
  does a press on one of its links: the dropdown closes once the browser has taken
  the link's address, so the new tab opens the page the link names. A middle-button
  press closes it the same way, and the browser's own right-click menu leaves it
  open, because the page sees no press there. Every link carries the mount
  prefix, and the row sits above the slot so an extension's card stays the lowest
  thing in the sidebar.
- **Composer**: multiline; `Enter` sends, `Shift+Enter` newlines. An `Enter`
  that commits an input method composition (Korean, Japanese, Chinese) sends
  nothing, and neither does the second `Enter` keydown some browsers fire for the
  same press, nor the repeat keydowns of a held key. Three actions
  stand beside the field at every width: Stop, the `⋯` dropdown, and Send. Stop is
  inert until a run is active.
  `Enter` sends nothing while a run is active, because the agent cannot take a
  message at once then. The text stays in the field until the run ends.
  While a run is active on a connected page, Send keeps its faded look and gets a
  dark ring, and it is not disabled. A press on it queues the message: the field
  gets the same ring, and the page sends the text once, by the same path as a
  press on an idle page, when the agent is next idle. A queued message has a
  hidden status text for screen readers, and the busy Send carries a tooltip.
  Stop does not cancel the queue: the run ends and the queued text is sent. Any
  input in the field and any change to the attachments cancel the queue. A reload
  or a move to another conversation drops it, because it lives only in the page.
  An empty field is not queued, and neither is a message while a file uploads.
  A lost connection, a model that is not set up, and a send on its way keep Send
  disabled and queue nothing.
  New session, Compact, Restart UI, Restart server,
  and Force reinstall and restart live in the dropdown, which opens upward from
  its own button. New session asks for confirmation. If a sub-agent of the
  conversation is working, the server refuses the reset, and the page asks a
  second time with the names of the working agents. If a reset fails for another
  reason, the page shows the server's error in a toast. The menu takes its width from its longest label, so the
  longest label stays on one line. The page edge is the only cap, and below
  about 315px it folds that label onto two lines. At 400px and below the menu
  anchors to the composer instead of the button, which no longer leaves room for
  the label.
  Below the breakpoint the field takes the whole row with the actions under it.
  The field grows to `12rem` and then scrolls, with the scrollbar not drawn.
  One line of text keeps the height of the empty field, so the composer and the context bar do not move when typing starts.
- **Unsent text in the composer.** The text typed and not sent is kept in the
  browser's `localStorage`, so a reload, a closed tab or a phone that drops the
  background tab brings it back. One entry belongs to the root conversation and
  one to each focused chat, so a draft written in one chat never appears in
  another. The entry also carries the mount the page is served from, so two
  installs behind different prefixes never read each other's drafts. A send the
  server accepts clears the entry, a send it refuses keeps it, and an entry
  nobody touched for 14 days is dropped when a page opens. A store that refuses
  the write shows one notice on the page and leaves the text in the field. The
  store is `src/ui/state/drafts.ts`, and the same one keeps the feedback field
  (section 10). Attachments, the snippet panel, the model login code and the
  chat title field are not kept. Two tabs on one conversation share one entry:
  the later keystroke wins, and the other tab shows it after its next reload.
- **A chat this page cannot write to.** An archived focused chat keeps its
  transcript and loses the composer, and a number the server does not know has
  neither. The composer's place then carries one line that says which of the two
  it is, with an `All chats` link to `/chats`. Neither opens a stream: the page
  reads the chat first and stops at the notice.
- **Attach buttons**: four, beside the field. None of them sits in the action
  row. The first opens the browser's own picker for images. The second opens
  the camera at once through `capture` on a phone, and takes one photo, with no
  video and no sound recording. A desktop browser ignores `capture`, so there
  it opens a picker for one image. The third opens the picker
  for any file. The fourth opens the snippet panel instead of a picker, so it
  has no hidden input. On a screen 860px wide or narrower, the field takes a row
  of its own, the attach buttons start at the left end of the row below it, and
  Stop, the dropdown, and Send stay at its right end.
- **Context**: a thin bar directly above the composer, filled by the fraction of
  the usable context in use. The denominator is the model's window less the tokens
  the harness holds back for the answer, which is where compaction fires, so a full
  bar means compaction is next rather than that the window is full. The sidebar
  readout prints the same two numbers in thousands, and both carry the exact counts,
  the window, and the percentage as hover text. One server route answers for both
  (`GET /basic-chat/context`, see [http-api.md](./http-api.md) §5.6), so the page
  and the `usage` tool cannot disagree. It is drawn empty until an answer has been
  measured, and it holds the same green at every fill: this is a reading, not an
  alarm. It is refreshed when a page opens, when a snapshot arrives, and when an
  answer, a reset, or a compaction is committed, at most one read in flight.
- **Restart server** (in the composer dropdown): asks for confirmation, then calls
  `POST /api/admin/restart`, which runs `user-tools/update-and-restart` outside the
  daemon. The confirmation names what it costs: the daemon is down for a few
  seconds, committed updates are applied, and a running turn is cut off. While a
  core change is staged but its batch is open, the confirmation says that the
  daemon may come back running a half written change. It is not disabled: the
  user is the authority. The page then polls `/healthz` and reloads as soon as
  a process with a small `uptimeMs` answers, which is how it avoids reloading into
  the old process during the seconds before it stops. A minute of answers from the
  old process means the restart never happened, and the page says so with the log
  path.
- **Force reinstall and restart** (in the composer dropdown, under `Restart
  server`): the same handoff with `--reinstall`, asked for with
  `POST /api/admin/restart` and a `{"reinstall": true}` body. The confirmation
  names what it costs: the execution tree's `node_modules` is deleted and
  installed again from `package-lock.json`, the stop is longer than a plain
  restart, and the install uses the network when the package cache is cold. What
  follows is what `Restart server` does: the page polls `/healthz` and reloads
  into the new process.
- **Restart UI** (in the composer dropdown, under `Compact`): asks for
  confirmation, then calls `POST /api/admin/ui-restart`. The route builds the
  workspace's pages and swaps the result over the directory this page is served
  from, so an edit under `src/ui` or `src/web` reaches the screen and the daemon
  keeps running. The question says what that means: the process stays up, so a
  turn in progress is not cut off. The answer carries the file count, and a
  second question prints it as `UI files applied (7).` and asks whether to
  reload now. Only that second yes reloads the page. Across the reload the text
  in the composer and the open report panel come back, kept in `sessionStorage`
  under `pi-sec-ui-restart` and read once at startup. The scroll position, the
  open dropdown and the expanded groups do not come back. The conversation, the
  jobs and a running turn stay, because no process was touched. Server code is
  not part of the swap: the route compares the worktree's HEAD with the one the
  running process came from, and the second question names up to three changed
  paths under `src/` outside `src/web` and `src/ui`, with a note that those wait
  for a cold restart. When git cannot be read, that sentence is replaced by one
  that says the drift is unknown, rather than by the sentence a level tree gets.
  The build takes the worktree as it is, so an uncommitted edit goes live, and
  nothing typechecks or tests it. The next `npm run build` in the execution tree
  writes the served folder again from that tree's own copy.
- **Report panel**: a report opened from the inbox covers the left of the
  transcript rather than taking a column, so opening one never reflows the
  conversation or moves the reader's place in it. It holds the title, a meta line
  with the revision, the owning job, and the approval state (`v3 · <job title> ·
  approved 5m ago`), and the newest revision as markdown. Its header has two controls, `Close` and `Open page`, and
  `Open page` opens `/report/<slug>` in a new tab. Its foot carries the same
  feedback bar the viewer has, built by the same module, so the two surfaces
  cannot disagree about what a click does: a result report shows Done and Feedback
  there too, and a press is recorded with `via: "panel"`. The close button and `Esc` close it,
  and so does `Open page` itself: the panel closes once the browser has taken the
  link's address, so the new tab opens that report rather than the report list. A
  middle-button press closes it the same way, and the browser's right-click menu
  leaves it open. On a narrow screen it covers the transcript from the left, and
  opening it closes the sidebar drawer it was opened from.
- **Snippet panel**: the third attach button opens it over the same place the
  report panel uses. The two are never open together: opening either one closes
  the other, and `Esc` closes the open one. It holds a name, a `Store as a secret`
  switch, a body, and one button. The name starts empty and shows `snippet` as a
  muted placeholder.
  With the switch off the button reads `Attach`. A press cleans the name to its
  last path segment, keeps `snippet` when nothing is left, and makes one
  `text/plain; charset=utf-8` attachment out of the body. That attachment takes
  the path a picked file takes: a chip appears above the field, and the Send
  button sends it with the next message. The body is cleared and the panel is
  closed, so the agent reads the text only if it looks at the file. An empty body
  is refused before it reaches the server.
  With the switch on the button reads `Upload secret`, the name field is emptied,
  and the form asks for a name. The body is posted to
  `POST /api/admin/secrets/write` as JSON, so the text becomes a file under the
  secrets directory and a name that already exists fails. The line under the
  switch names the path the file will be written to. A press with no name is
  refused with `name required` and nothing is sent. On success the line reads
  `uploaded <name>`, the body is cleared, and the name is kept. A refusal prints
  one fixed sentence that names the code, and the body is not part of that
  sentence.
- **Setup card**: while the daemon has no model (`agent.vmodel` is empty), the
  status route answers `modelSetupRequired: true` and the chat page shows a card
  in the chat area, above the empty transcript. The card is hidden otherwise, and
  no menu or screen opens it outside setup mode. While it shows, the message box
  and Send are disabled, the connection pill reads `setup`, and the page does not
  say `offline` for the missing chat stream. The card has three steps.
  1. `Open model login` opens the Model login panel. When the panel closes, the
     card reads the model list again.
  2. The model form. It lists the chat models of the signed-in providers in one
     list grouped by provider, from `GET /api/admin/model-setup/models`. With no
     signed-in provider it says to finish step 1 and shows no list. The thinking
     level (`off`, `minimal`, `low`, `medium`, `high`) starts on `medium`. A
     closed section, `Workers on another model`, holds a second list. A checkbox,
     `Replace existing vmodels`, shows only when config.json already declares
     `root`, `orchestrator`, `planner` or `worker`; its label says that the four
     entries are replaced and that a scheduled job that names one of them runs on
     the new model too. The prompt file and the root roles are not shown. `Save`
     sends one `POST /api/admin/model-setup` that writes config.json and loads
     the configuration, with only the fields the operator chose. On success the
     page loads again and the chat works. On a refusal the form shows the route's
     own sentence and keeps the choices. A line under the form names the other
     way, `pi-sec setup-model --provider <id> --model <id>` on the server, with a
     copy button.
  3. `Load configuration` sends `POST /api/admin/reload`, for the operator who
     ran `pi-sec setup-model` on the server. On success the page loads again.
     On failure the card lists the `issues` sentences the route answered.

---

## 3. Transcript rendering

- **Markdown** with syntax-highlighted, copyable code blocks, rendered by
  **markdown-it**, the npm package at the version `package.json` pins. The build
  bundles it into the page (see `THIRD_PARTY_NOTICES.md`). It covers what a
  transcript carries: fenced code, headings, nested lists, pipe tables with
  alignment, blockquotes, rules, strikethrough, autolinks, and inline
  code/emphasis/links. It runs with `html: false`, so raw HTML in a message
  stays text, and its link validation refuses `javascript:` URLs. Both matter
  here: the transcript renders model and tool output. A link in message content
  opens a new tab: every link whose address does not start with `#` carries
  `target="_blank"` and `rel="noopener noreferrer"`, whether it is an outside
  address, a bare URL or one of the page's own routes. A `#` link stays in the
  same tab. The report name in a feedback card head and in an approval card head
  follows the same rule. A message bubble is never
  wider than the transcript, so a narrow screen does not scroll sideways. A long
  line in a code block wraps at the bubble's edge, a long word included, and
  keeps its line breaks and indentation. A wide table scrolls inside its own
  box.
- **A generated page** (rich page) is a markdown image whose address ends in
  `/rich-pages/<id>`. The one markdown renderer draws it as a block: a sandboxed
  frame (`sandbox="allow-scripts allow-forms"`, never `allow-same-origin`), a
  caption with the label `Generated page`, the title and a link `Open in new tab`.
  The frame starts at 360 pixels. The page reports its content height with
  `postMessage`, and one listener (`src/ui/components/rich-page-frames.ts`) sets
  the height of the frame that sent it, between 80 and 1200 pixels. The listener
  finds the frame by `event.source`, so a message from anything else changes
  nothing. Any other image stays an `<img>`, and raw `<iframe>` text stays text.
  The tool and the isolation are in [extensions.md](./extensions.md#rich-pages) and
  [security.md](./security.md#rich-pages).
- **Far images and page frames do not load in the chat.** In the chat page (the
  root chat and a focused chat), a markdown image, an uploaded image and a page
  frame carry `data-defer-src` and no `src`. Two `IntersectionObserver`s, with the
  transcript pane as root, decide (`src/ui/chat/transcript/deferred-media.ts`).
  An element loads when it comes within one pane height of the visible part
  (margin `100% 0px`). A page frame that has loaded goes back to `about:blank`
  when it is more than three pane heights away (margin `300% 0px`), and its box
  keeps its last height. Whatever the reader did inside that page starts over when
  it loads again. A picture is never unloaded. A markdown image of unknown size
  and an uploaded image without a size keep a 160 pixel box (class
  `defer-media-pending`) until they load. Without `IntersectionObserver`, every
  address is set at once. The report viewer and the chat's report panel do not
  defer: a report loads its page frames when it is drawn.
- **Tool calls** draw one small panel per call inside the folded card of their
  stretch: the tool's name and its status, then its output. A panel's output is
  clamped by its own height and scrolls.
- **Structural markers** rendered as thin dividers, not messages: `reset`, and
  `compaction_start`/`compaction_end` as a transient "compressing context…" line.
  A page that reconnects or opens fresh draws the running tool rows and the
  "compacting" row from the snapshot's `tools` and `compactions`, and it draws no
  row for a pending call. When a reset or compaction marker arrives as a live
  frame, the page opens its stream again and takes the new snapshot. The snapshot
  holds that marker, so the page keeps the rows it showed before the snapshot's
  first entry and draws the snapshot below them: the old rows, the `new session`
  (or `context compacted`) divider, and the new rows, in that order. A reader
  who follows the foot stays at the foot. A page that opens fresh draws the
  active context alone.
- **One earlier session, on request.** A session is the stretch of a conversation
  between two session restarts (a reset that starts the conversation again under
  the same number). The transcript draws the session the model is in, so the top
  of the transcript is its `new session` line. Above that line, the page draws a
  `Load previous session` button while the server says something is stored before
  the context on screen, which the snapshot carries as `hasEarlier`; a
  conversation with one session has no button at all. A press reads one session
  with `GET /basic-chat/history?before=` (or the chat's own
  `/api/conversations/<id>/history`), and puts it above the rows with its own
  `new session` line first. The button stays one press from the top: another
  press reaches the session before that one, and the press that reaches the
  conversation's first entry takes the button away. A press is one read and never
  two, so the button refuses a second press while one is in flight.
  A press draws only. No entry is written, and the model's context is unchanged:
  the session on screen is a view of stored entries, not a change to the
  conversation. A new snapshot keeps the rows before its first entry when the
  page already holds the snapshot's head marker (the entry with a `head` field,
  a reset or a compaction). That covers a restart, a compaction, and a
  reconnect to the same session, so what a press brought stays. In that case the
  button keeps the state it had, because it sits over the rows that stayed. If
  the page does not hold the head marker, for example after a restart that came
  while the connection was down, entries could be missing in between. The page
  then draws the snapshot alone, and the button follows the snapshot's
  `hasEarlier`.
  The reader's place does not move: the distance from the foot is measured before
  the rows are added, the draw is put back to the first row so the first paint's
  limit does not leave the new rows out, and the rows are matched by entry id so
  an entry already drawn is not drawn twice. A failed read keeps every row and
  the button, and says so once in the page's notice.
  A row a press brought carries `aria-live="off"`, because the transcript is one
  live region and a press that brings hundreds of rows must not read them out.
  The button describes what a press does with `aria-description`, since the label
  alone does not say that the transcript is about to grow above the reader.
  Whether a screen reader honours the flag is not measured, and nothing here
  depends on it.
- **An answer is drawn once, complete.** The transcript shows a "writing…" row
  while the model writes, and the whole answer when the turn ends. Each draw
  touches only the rows that changed: a row whose markup is the same keeps its
  element, and a fresh `snapshot` is the same comparison against a new list. No
  partial text is ever reconciled. The writing row is always the last row of the
  transcript. While the model is not writing, the row carries the `idle` class,
  which sets `visibility: hidden`: the row keeps its height, so the transcript
  does not move when the indicator appears or disappears. The idle row's dots are
  paused; the row that is writing runs them, and a reduced-motion setting stops
  them the way it stops every other animation on the page.
- **One entry is rendered once.** A draw used to classify and render every entry
  again: envelope and marker parsing, markdown, escaping, for every row in the
  conversation. Those results cannot change while the entry stays the same, so
  each entry's markup is kept by entry id and read back on the next draw. Two
  things make it stale. An entry's revision rises when a `snapshot` hands the page
  an entry it already holds with a different body, which only a snapshot can do,
  because entries are append-only otherwise. A page-wide generation rises when
  the page learns what an attachment id is, which is what redraws a bubble that
  was drawn before its descriptor arrived and can now show its picture instead of
  a chip. A folded run's card is kept too, keyed by its items, its open state and
  whether it is still running; a run with a call in flight is never kept, because
  its output changes with every frame. `window.piSecTranscriptStats` counts the
  markup builds and the full draws, and `window.piSecTranscriptCache.enabled`
  turns the cache off, which is how a test compares a cached page with an uncached
  one.
- **Tool output is drawn once per animation frame.** The server sends an output
  frame several times a second, and each one used to draw the whole transcript.
  The frames are collected and drawn once in an animation frame. When only live
  tool output moved and its panels are on screen, the new text is written into
  the live panel (a tool item carries `data-tool-call-id` while its call is in
  flight) and no row is rebuilt; the result is the DOM a full draw would make.
  Anything else in the same frame falls back to the full draw, and a full draw
  cancels the frame that was waiting.
- **Rows far from the viewport cost no layout.** A transcript row (`#transcript >
  [data-row-key]`) carries `content-visibility: auto` and
  `contain-intrinsic-size: auto 80px`: a row that is off screen is laid out again
  when it comes near, and until then it keeps the height it had the last time it
  was on screen, or 80px, which is a typical row, when it never was.
- **User queries**: the sidebar card holds the offered choices plus an "Other"
  field. The chat draws the answer as a card with the question and the answer that
  came back. The choices stay on the sidebar card, so the answer card holds those
  two lines only. Either answer is input from the user, so a chosen choice and typed
  words read the same way.
- **One working stretch is one folded card.** A stretch holds the tool calls that
  ran and the messages that are not the user's, in the order they arrived, and
  both kinds go into the same card. Only `src="operator"` keeps a bubble, because
  that source alone is the user's own turn in this chat. Every other source
  folds, whatever it is, and `operator-scheduled` folds with them: a scheduled run
  carries the user's words, but the user is not in the room when it starts.
  The head states the tool count and the message count first, then the tools that
  ran, then the sources of the messages: `3 tool calls · 6 messages · bash, read ·
  tool-output, agent, unknown`. A count of zero is left out, so a stretch of tool
  calls alone reads just as it always did. The card starts folded, and the
  user's own choice to open it survives a re-render. Nothing is deleted: the
  entry stays in the conversation and the agent still receives it.
- **A stretch ends when something draws a row of its own**: a user bubble, a
  bubble for an assistant turn with text, a review card, or a divider (`new
  session`, `context compacted`, `system prompt updated`). A folded message draws
  no bubble, so it does not split a run of tool calls, and a tool result does not
  split the messages. A `pi.system` entry and an assistant turn with no text draw
  nothing either, so sequential calls behind such a turn stay in one card. An
  answer whose whole text is the no-response line `[pi-sec no-response]` draws
  nothing for the same reason. The judgement is `isSilentAssistantTurn` in
  `src/shared/silent-turn.ts`, which the server reads as well when it decides
  whether a turn the user started owes them an answer.
- **A call still in flight** joins the card of the stretch it continues, whether a
  tool call or a folded message opened that stretch, because nothing drawn has come
  between them. The head marks it with a trailing `…` after the tool count.
- **An opened item** states its source first. Then come the attributes that place
  it, three at most, in one fixed order: `via`, `kind`, `tool`, `from`, `title`,
  `key`, `job`, `round`, `status`. Then comes the body with the envelope taken
  off, in a `<pre>` block, because a body can be tool output as easily as prose.
  An item keeps the order it arrived in, whatever kind it is.
- **`unknown` is named in the card head** like every other source, so a message
  whose `src` could not be read shows rather than hides. The source list is never
  capped, so a name cannot be pushed off the head. Folding is not hiding, and
  an unreadable source is worth showing.
- **A review is not a folded message.** Feedback written in the report viewer
  draws as a review card: the report name with a link to it, the version when
  there is one, and the feedback as markdown. The card head reads `feedback`,
  then the slug. The server labels the message `src="operator"`, so it is
  the user's text, but it is not the user's turn in this chat and it does not
  get their bubble. Section 9 has both delivery routes.
- **An approval is its own line.** An approval arrives the same way, as input from
  the user with `via="approval"` and a `[pi-sec approve] report=<slug> v=<n>
  sha=<sha256>` first line. A press of Done carries `button=done` on that line and
  draws `Done` in place of `Approved`, with the words the user wrote under the
  card; the paragraph that asks the root to hand the request on is not drawn. The
  card itself is one line: the verb, then
  the report title with a link to it, then the revision. The title comes from the
  sentence after the marker, `The user approved revision <n> of "<title>"` or `The
  user pressed Done on revision <n> of "<title>"`, and entries written before that
  wording say `The operator approved ...`, which the card reads too. Without either
  sentence the card shows the slug. The marker line is the
  machine-readable half and stays off the screen, because the approval is a record
  and not something a person wrote. It is not a folded message and it gets no
  bubble for the same reason a review gets none.
- **Where a stored message goes, by its first line:**
  - `<pi-message src="operator">` gives a bubble. It shows the body without the
    envelope.
  - `<pi-message src="<any other source>">` folds into the card under that
    source. A `src` outside the module's list reads as `unknown` and folds too.
  - `<pi-message ... report="<name>">` and the older `[pi-sec review]
    report=<name>` marker line draw a review card, whatever the source is.
  - `[pi-sec approve] report=<name> v=<n> sha=<sha256>`, or an envelope marked
    `via="approval"` whose body starts with that marker, draws an approval card.
    This is read before the review card, so an approval never draws as feedback.
  - An envelope marked `via="ask-user"` whose body carries the `Question:` and
    `Answer:` lines draws an answer card with those two lines. This is read after
    the approval card, so an approval never draws as an answer.
  - `<tool-call-output ...>` and `<agent-message ...>` fold into the card, as
    `tool-output` and `agent`.
  - `[restart ...]` folds into the card, as `restart`.
  - The compaction summary line folds into the card, as `compaction`.
  - The bare `[pi-sec review]` marker with no `report=` field gives a bubble,
    which is the source the server's reader gives it as well.
  - No label at all gives a bubble, for a message stored before the envelope
    existed.
  The list matches the two readers: `readMessage` in `src/message-envelope.ts` and
  `readEnvelope` in `src/ui/chat/transcript/envelope.ts`. The page imports only
  from `src/shared/`, which holds no Node code and no import of `src/server`, so a
  change in either reader belongs in the other by hand.

---

## 4. Jobs & inbox

- **The inbox, the job tree and the Machines panel fold from their headings.**
  The heading is one button: the panel's name and a drawn triangle, pointing down
  into the list while that list is open and pointing right into the panel while it
  is folded. A press hides what the panel holds and one more press brings it back.
  The heading itself stays, badges and controls included, so a folded panel still
  says what it hides:

    - A folded inbox keeps the unread count and keeps it current: a notice that
      arrives while the panel is folded raises the number at once. The `hide all`
      button goes while folded, because it hides a list the operator cannot see.
    - A folded job tree shows `N working` for the jobs that have an agent on them,
      counted once per job however many agents it holds. Nothing working draws no
      badge, and an open panel draws none either: its rows carry the marker
      themselves. Section 14 has the same rule for a stopped machine.

  The choice is shared state. The server keeps it in `sec.settings` as two lists
  of panel names, `foldedWide` and `foldedNarrow`, and stamps both into the page
  (`<meta name="pi-sec-preferences">`), so the first draw is already folded. The
  page draws the list of its own screen class. The boundary is the drawer's
  breakpoint, `(max-width: 860px)`, and a page that crosses it draws the list of
  its new class. A press saves the new list for the current class only, so a fold
  on a computer folds every wide screen and leaves the phones alone. The fold
  itself is drawn by one attribute: `body[data-folded]` holds the folded names,
  space separated, and the stylesheet hides the content of a named panel. That is
  the shape the whole-sidebar toggle uses (`body[data-sidebar]`).

  `localStorage` under `pi-sec-folded-panels` stays as a cache. The page reads it
  only while the server holds no list for its class. The first page that finds
  the server without a list carries the browser's value into the list of its own
  class, and the server takes it only while it holds none. A cached value this
  page cannot use, one that does not parse or that names a panel this build does
  not fold, is dropped whole and every panel is drawn open, as on a first visit.
  A browser that keeps no storage still folds and unfolds on screen.

  Every open page follows a change. The server emits one `preferences_updated`
  frame for each write that changes shared state, and the frame carries the
  revision only. A page that is behind reads `GET /api/preferences` and draws the
  answer. Applying an answer never saves, so two open pages cannot start a loop.
  A page also reads the state after a stream reconnect and when its tab becomes
  visible. The report page and the two usage pages have no stream, so they take a
  new theme when the tab is shown again or when the page reloads.
- The **job tree** shows parent/child nesting, a status chip per job
  (`planned`/`active`/`waiting`/`paused`/`done`/`failed`/`cancelled`), and run
  stats. A job whose record carries `routine` or `once` shows a
  schedule badge beside its title. A firing creates a conversation and no job, so
  a routine stays one row and its runs never add rows under it.
- A **working marker** fills a job's status chip while an agent is running on that
  job. The list is derived by the server and read on every job read, so the mark
  follows the work rather than the record's status: a job keeps whatever status it
  holds, and a worker that waits for orders is not working. The chip keeps one
  shape, a filled background in the status colour, and the tooltip says which
  agent it is: `Working: <name>`. A folded row is the only row that can hide work
  below it, so a folded job whose subtree holds a running agent fills as well, and
  its tooltip adds a second line, `Working below: <name>`. A row that is both
  worked on itself and folded over work carries both lines. An open row draws only
  its own work: its children are on screen and each chip speaks for itself.
- The **inbox** shows unread items with a badge. A row is one line: the severity
  dot, the title (elided when it does not fit), and how long ago it arrived, with
  its own hide button. Clicking the title opens the item and reads it; clicking it
  again folds it shut. Hiding is a separate button, so reading and clearing never
  share a click. A hidden item leaves the list, and the server keeps every item.
  The age is rewritten in place every minute. A hidden tab skips the tick, and one
  tick runs when the tab comes back, so the list never redraws to age a row.
  The inbox heading carries a `hide all` button at its right end. One press hides
  every item the list holds, and the button is disabled while the list is empty.
  The line under the list is a revert button, `↩ revert (N)`. One press restores
  the item hidden most recently, and `N` counts the presses the button can still
  undo, not the items they removed. The list remembers the last ten presses,
  oldest first, so an eleventh drops the oldest one from memory. One `hide all`
  press takes one cell of that memory, and one revert press brings that whole
  group back. The button is disabled while that memory holds nothing. An item
  whose hide has left the memory stays hidden; the UI offers no way to bring it
  back.
- A **report notice** — an item whose `source.reportId` is set — opens in the
  report panel instead of folding open. The row starts with an inline SVG mark,
  and the title that follows it is the report's own title: no text prefix such
  as `Report published:` comes before it. The mark is one sheet of paper, and
  its color names the event: `--approve` for a published report, `--accent` for
  a new revision, and `--feedback` for an answer to feedback. A report notice
  with no `source.reportEvent`, such as one the `notify` tool raises, takes
  `--text-muted`, and a notice about anything else draws a bell in
  `--text-muted`. The mark names itself: `role="img"`, an `aria-label` such as
  `Report published`, and a `title` with the same words, while the SVG inside is
  `aria-hidden`. The `▾` or `▸` caret next to the mark shows on every row
  whether the row is open.
- Report notices are written for a new report, for each new revision, and for an
  answer that brings a report back from feedback. The `notify` tool raises one
  too, for a report that already exists: that item carries the agent's own title
  and words, and no revision is written. Feedback written in the viewer is *not*
  announced: it arrives in the conversation, which is where the agent reads it.
  A notice about a report that is set aside as `pending` is listed like any
  other, and it does not count towards the unread badge: the user set that
  report aside, by approving it or by leaving feedback on it, so the row is
  drawn the way a read row is and its meta line says `· pending`. The notice
  itself stays in the inbox, whatever the flag does later.
- A **focused chat notice** — an item whose `kind` is `focused_chat` — is raised
  when a chat is opened, and its title is `Focused chat opened: <title or
  Untitled>`. The row starts with the bell mark in `--text-muted` and names itself
  `Focused chat`. Its title opens the chat: the item is marked read first, then
  the page goes to `/basic-chat?chat=<id>`, the way a report notice opens its
  report. A notice whose `source.conversationId` is not a number folds open in
  place like any other item.
- The **job tree** clears the same way: clicking a closed job's status badge takes
  that row, subtree included, off the list. The revert button below the tree
  restores the job hidden most recently, one press for one hide, and a parent's
  subtree returns with the parent. The tree keeps its own memory of the last ten
  hides, separate from the inbox memory, and the button is disabled while that
  memory holds nothing. A child hidden on its own before its parent stays hidden
  when the parent returns. When a live job has subjobs, its chip is a button: one
  click folds the subjobs away and one more click opens them again, and
  `aria-expanded` says which state the row is in. A live job with no subjobs
  keeps a plain label, and a closed job keeps the clear button above, because
  hiding work in progress is not tidying. A fold is saved on the server
  (`collapsedJobs`), so a reload keeps every folded group folded and every open
  page folds the same groups. No group starts folded. The default folds name
  no job, because a schedule is a field on the record and not a container.
- A schedule badge comes from the record's field and never from a label: it
  reads `routine` for a job with a `routine` field, and `once` for a job with a
  `once` field. A one-off row shows its run time and its state (`pending`,
  `done`, `cancelled`, `missed`). A routine row shows the result of its last run,
  which reads `success` or `failed`. Every row draws that result from `lastRun`,
  which the API already carries, together with `stats.runs` and
  `stats.failures`.
- Cancelling a one-off takes one press and needs no approval. Switching a routine
  off needs an approved report, and a refusal is drawn as it arrives: the report
  and revision it asks for, and what to press.
- When the boot migration left an error, the jobs panel shows it in a banner above
  the tree. The error names the entries it ignored and says to fix `routine` on
  the record.
- Clicking a job title opens it. The row keeps the `▾` caret and drops the title
  text, and the title moves into a block under the row that spans the jobs panel,
  so a long title wraps there and not in the row. The block is a button and the
  caret stays a button: either press folds the job, and both save the same
  preference, so the panel holds one rule for which jobs are open.
- **Awaiting you** lists the questions that wait for an answer: one card per open
  `ask_user` question, with a button per choice and an `Other…` field. The field
  follows the composer's `Enter` rule: an `Enter` that commits a composition, the
  second keydown of that press, and a held key's repeats send nothing. While one
  answer is on its way to the server, the same answer to the same question goes
  out once, even when the card is redrawn and pressed again. Several can
  wait at once and each is answered on its own. A card also says when the question
  was asked and how long ago. The age is read rather than ticking: the panel draws
  it at the reading, and redraws the cards it holds, with no new read, when the
  tab comes back. The age carries no deadline wording, no colour and no countdown,
  because the same stamp would then read as pressure to answer. The list is read
  from `GET /api/user-queries` when the page opens, and again on every list event.
  The event carries no whole list, so it cannot fill the panel by itself.
  A reload after the event left the panel empty while the question stayed open.
- **The chat page opens one stream.** Its one `EventSource` is the conversation
  (`/basic-chat/events`, or `/api/conversations/<id>/events` for a focused chat).
  The job events arrive on that stream: `job_created` and `job_updated` are
  control events beside the transcript's own, and the page no longer opens a
  second stream on `/api/jobs/events`. The server keeps that route for other
  clients.
- **Job reads are coalesced.** A job event names the change, not the list, so the
  page reads `GET /api/jobs?shape=tree` and draws `data.tree`. All job reads go
  through one coalescer: events inside one second cost one read, one read runs at
  a time, and a request that arrives while a read runs causes exactly one more
  read after it, so the last state is the one that is drawn. A hidden tab reads
  nothing; one read runs when it becomes visible again, which also covers a run
  that ended under the harness and published no job event. The page's first
  `open` of the conversation stream reads nothing, because the load read already
  answered; a later `open` is a reconnect and reads the tree once.
- The **inbox** is read from `GET /api/inbox?cleared=exclude`, so the server
  leaves out the items the operator cleared and the page does not read back a
  list it has mostly hidden. The page keeps its own copy of the cleared list while
  the items it names are on screen. Both panels update live from SSE (`job_*`,
  `inbox_item`).
- A job row's **time stamp** is formatted once per instant per tab: a job's
  `once.at` and its `lastRun.at` are read on every redraw, and the formatted
  calendar fields of one instant are kept by their millisecond value. The
  transcript draws no time stamp of its own.

---

## 5. Theming and type

- **CSS custom properties** for color, spacing, radius, and shadow; one token
  file, `src/web/theme.css`.
- **Light and dark** follow `prefers-color-scheme`, with a manual toggle stored
  locally.
- System font stack for UI; a monospace stack for code.
- Subtle motion only (200 ms ease); respects `prefers-reduced-motion`.
- A restrained accent color for status and focus.
- `--send-queue-ring` is the ring of a busy Send button and of a queued message:
  the accent at 60% toward black in the light theme, and toward white in the dark
  theme, where a darker blue would not show beside the faded fill.

---

## 6. Assets and delivery

```text
src/ui/
├── pages/          # one entry module per page: chat, report, chats, usage,
│                   #   usage-stats,
│                   #   and the pull request list an extension adds
├── state/          # signal stores, one module per area
├── streams/        # one client per server event stream, with the reconnect rules
├── api/            # the one request function, through basePath
├── github-pr/      # the pull request pages' shared parts
└── components/     # components that more than one page draws
src/shared/wire/    # request, answer and event types the server and the UI share
src/web/
├── index.html      # chat page shell
├── report.html     # report page shell
├── chats.html      # chats list page shell
├── usage.html      # usage page shell
├── usage-stats.html # model speed page shell (`/usage/stats`)
├── github-pr-*.html # the three pull request page shells (extension)
├── base.js         # piSecMount, read before any module
├── ui-cards.js     # extension slot cards, served as written
├── styles.css      # layout + components
├── theme.css       # design tokens
├── usage.css       # the usage page's cards, scoped to `.usage-page`
├── usage-stats.css # the model speed page, scoped to `.usage-stats-page`
└── github-pr.css   # the pull request pages' GitHub theme (extension)
```

- `npm run build` runs `tsc`, then `scripts/build-ui.mjs`. The script bundles each
  page entry with esbuild as an ES module, puts code that two pages share in
  split files, and writes the bundles to `dist/web/` beside the shells, the CSS,
  `base.js` and `ui-cards.js`. A split file is imported by a relative path, so the
  same files load under `/report/assets/`. The same run copies one stylesheet out
  of an installed package into `dist/web/`: `ui-highlight-github.css`, the
  code-block palette of the pull request pages, which comes from the highlight.js
  package the lockfile pins and is not tracked in this repository.
- Served statically by the HTTP server under `server.basePath`, with `no-cache`.
- The SSE client is `EventSource`, and it resumes with `Last-Event-ID` while
  the browser retries by itself. A stream that ends CLOSED is opened again by the
  page after 1 s, each failed attempt doubles the wait up to 30 s, and nothing is
  opened while the page is hidden. A page hidden for 30 s or more, a page
  restored by `pageshow` with `persisted`, and an `online` event each open a new
  stream, which starts from a snapshot. From the second snapshot on, the page
  reads the inbox, the pending questions, the open report pane and the record of
  a focused chat again, and a focused chat whose record answers 404 is not
  reopened. A tab hidden for one minute closes its stream, and the return opens a
  new one; the close can come later, because a hidden tab's timers can be slowed.
  A snapshot is matched to the current state by id, and only what changed is
  drawn again.
- All API calls go through `basePath`; the UI assumes no authentication (the
  reverse proxy, if any, is transparent to it).
- CSP includes **no inline script** and no inline style, and no page code uses
  `eval` or `Function`. Every bundle is an external module.
- `POST /api/admin/ui-restart` runs the same build script on the workspace tree
  and swaps the result into `dist/web/`.
- Every package bundled into a page is listed in `THIRD_PARTY_NOTICES.md`. The
  list is read from the bundle's own input list, so a new import cannot be
  missed.

---

## 7. Accessibility

- Semantic landmarks (`header`, `main`, `nav`, `form`); the transcript is an
  `aria-live="polite"` region.
- Full keyboard operation: `Enter`/`Shift+Enter`, `Esc` to abort, a shortcut to
  focus the composer, and focus trapping in dialogs.
- A panel's heading is a `<button>`, so `Tab` reaches it and `Enter` or `Space`
  folds and unfolds the panel. Its `aria-expanded` says whether the list is open
  and its `aria-controls` names that list, so the pair reads as one control. The
  caret repeats the state for the eye and is `aria-hidden`. A press keeps the
  focus on the heading, so the operator can press it again without hunting for
  it.
- Visible focus rings; text contrast meets WCAG AA. The opened title block is a
  keyboard stop of its own, and it draws a 2px outline when it takes focus.
- Status is never conveyed by color alone (chips carry a label).
- The **activity ring** is the one exception: it is colour and motion only, and it
  is marked `aria-hidden`. Nothing depends on it. The transcript shows the same
  thing as it happens, and the connection pill carries its own label.

---

## 8. Slots <a id="slots"></a>

A slot is a named place in the page where an extension can put a card. The core
opens the slots, and an extension declares which card goes in which slot (see
[extensions.md](./extensions.md#ui-cards)).

| Slot | Page | Where it sits |
|------|------|---------------|
| `sidebar.bottom` | Chat (`/basic-chat`) | The bottom of the right sidebar, below the core rows (Context, Appearance, Pages). |
| `usage.cards` | Usage (`/usage`) | Below the provider cards, at the end of the page. |

Two pages open a slot today: the chat page and the usage page. The chat page's
slot is in the sidebar; the usage page's slot is the end of the page, after the
cards the core draws itself. A card reads the same in both places: the server
fills it, and the browser script runs its controls.

- **The core adds no frame.** A card gets no border, no title and no padding
  from the core. It draws what its extension returns, and the core holds only
  the place.
- **The slot stacks its cards** with the gap of the sidebar footer, and a slot
  with no card takes no room at all.
- **A new slot gets one row in this table.** A card whose slot is not in the
  table is registered and never drawn, and that is not an error.
- **A card can fail.** A card that does not render within 2 seconds, or whose
  markup the server refuses, shows one line of small muted text in its place.
  The other cards and the page stay as they are.
- **A card draws in its own shadow root.** The core's theme variables reach it,
  and the core's styles do not.

### Extension pages <a id="extension-pages"></a>

A runtime extension that exports `pages` draws whole pages under `/ext/<name>/`
(see [extensions.md](./extensions.md#ext-pages)). The core builds the document from
`src/web/ext-page.html`: the mount prefix, time zone and theme stamps, the core
`theme.css`, a small base style (`ext-page.css`: the body font and colors) and the
helper `ext-page.js`, which adds `window.piSecPage`. The core `styles.css` is not
loaded, so no core selector reaches the extension's markup. The extension's html
becomes the body, and its declared stylesheet and module script load from the
extension's `ui/` directory. The page follows the core theme and carries the core
policy: no inline script, no inline handler and no `style` attribute.

The Pages menu in the sidebar draws the three core links, the bundled links the
server planted in the page, and the runtime extension links that declare
`menu: true`. When the menu opens, it reads `GET /api/ui/page-links` and redraws
the list. If the read fails, the menu keeps the list from the page's data block, so
a page an extension added after the chat page loaded appears the next time the
menu opens, without a reload.

---

## 9. Non-goals

- No mobile/desktop native clients; the web UI is the only first-party UI.
- No multi-user or per-user views.
- No plugin-defined layout beyond the slots in section 8. An extension fills a
  slot, and it cannot move or reshape the core panels.
- No offline mode; the daemon is the source of truth.

---

## 10. Reports

`/report` is a second page, deliberately not a pane in the chat: a report is a
document, and reading one should not compete with a transcript.

The report body is drawn by the same markdown renderer as the transcript (section
3), so a link in it follows the same rule: a link whose address does not start
with `#` opens a new tab, and a `#` link stays in the same tab. A generated page
tag in a report body draws the same sandboxed frame as in the chat, and the report
viewer loads it when the report is drawn.

A generated page also has its own address, `/rich-pages/<id>`, which the caption
link opens in a new tab. That page is a small core page (the shell): a bar with
the label `Generated page`, the title, the creation time and a link back to the
chat, and the page itself in a sandboxed frame below the bar. The shell holds no
script. A browser that opens the raw frame address `/rich-pages/<id>/frame` as a
top-level page is sent to the shell.

- **`/report`** lists reports in six groups — the briefing (the morning briefing
  report, at the top under `Briefing`), active plans, results (a result report
  that still waits for the user's Done or Feedback), pending (set aside by an
  approval, or by user feedback that the owner still has to answer), finished
  (their job ended), and the archive. The briefing section is not drawn when there
  is none, and it holds the one briefing report the live store keeps: a newer one
  moves the briefing before it to the archive, and an archived briefing is left
  out of the archive section, so the reader sees the newest briefing alone. A
  briefing keeps the word `briefing` in its chip for as long as its job lives, and
  the chip has a colour of its own. Results sits directly above Pending, because
  a result report waits for the user exactly as a plan under Active does. A
  section with no rows is not drawn, and its line reads `Work that ran. Press Done
  to close it, or write Feedback for more in the report.` `?job=<id>` narrows it to one job, which is
  where the `▤` on a job row in the sidebar goes. Its header carries `↻ reload`,
  which reads the list again in place, so a job that ended or an approval recorded
  elsewhere shows up without leaving the page.
- **`/report/<slug>`** is the viewer: the owning job, a revision selector, a
  "compare with previous" toggle that swaps the prose for a unified diff, and the
  feedback left on the report. Long lines wrap inside the diff column instead of
  scrolling sideways, and only the words that changed are marked. Its header
  carries `▤ all reports`, and the list hides it. The list draws no link back to
  a report: the browser's back button returns to the report the reader came from.
  The body and the comparison always belong to the revision on screen: an answer
  for a revision the reader left is not drawn, and a report read again keeps the
  revision the reader chose last.
- **Feedback and approval share one bar.** On the viewer the page is a shell of a
  fixed height: the header and the bar are rows, and the report column between
  them is what scrolls. The bar is the last row of that shell, so a browser that
  shrinks the viewport for the on-screen keyboard takes the bar with it. It is one
  row until the field outgrows it. The chat's report panel mounts the same bar
  (`src/ui/components/feedback.tsx`) and keeps it pinned to the viewport, so the
  two cannot drift apart. One button holds both actions: with the field empty it
  is green and reads `Approve`, and with text in it the button is orange and
  reads `Feedback`.
  Whitespace does not count as text, so the button returns to `Approve`.
- **A briefing has one button.** It asks for no approval, so its bar draws no
  Done and no Approve: the one button is `Feedback`, and it stays off until there
  is text to send. The line under the bar reads `A briefing needs no approval.
  Feedback goes to the root.` The press goes to the report's feedback route like
  any other feedback, and the note reaches the conversation as a review card.
- **A result report has two buttons.** Done closes the result and goes to
  `/api/reports/:id/done`; with text in the field, that text travels with it as
  the user's request for follow-up work. Feedback sends the field's text to the
  report's feedback route, and it stays off until there is text to send. Done is
  offered whether the field is empty or not, and it is off on an older revision,
  on a finished job, and on a revision that already carries an approval, by the
  same rule Approve followed. Both buttons sit on one row. On the viewer's
  narrow screen the field takes a row of its own, and the two buttons share the
  row under it half each and are at least 44px tall. On the viewer's wide screen
  the two buttons stay beside the field, on the field's row. In the chat's report
  panel they are on the row under the field at every width, because a row of
  field and buttons does not fit the panel. The sentence that explains the
  buttons (`Done closes this result. Text with Done asks for follow-up work.
  Feedback asks for more in this report.`) is hidden at every width, and the
  button labels carry what it says. Every other line under the bar is shown at
  every width: the approval record (`Done v2 · 5m ago`), the reason a press is
  refused, the newer revision to press, and the job that ended. The field is
  emptied when the server takes a press and kept when it refuses one. A plan's
  bar is unchanged. The list page has no bar: feedback belongs to one report.
- **The feedback field keeps what was not sent.** The text typed into the bar and
  not sent is kept in the browser's `localStorage` by the same store the composer
  uses (`src/ui/state/drafts.ts`), so a reload brings it back. There is one entry
  per report, and the revision number is not part of it: a new revision published
  while the field is being written does not drop the text. The viewer and the
  chat's report panel read the same entry for one report, so text typed on one
  surface appears on the other. Switching the panel to another report loads that
  report's entry instead of leaving the old text in the field, and switching back
  brings the first text again. The field cannot be edited while a press is sent,
  so a send the server accepts clears exactly the text that was sent. A send the
  server accepts clears the entry, a send it refuses keeps it, and an entry nobody touched for 14 days is dropped when a
  page opens. Restored text is text, so the button reads `Feedback` until the
  field is emptied, and an empty field still approves the revision on screen.
- **Approve confirms one revision.** A press with the field empty approves the
  revision on screen, and the server records it on that revision. On a result
  report the press is Done, which records the same approval and says which button
  made it. A press the
  server accepts — feedback or approval — opens `/report` with a fresh read, so
  the list shows what just landed, and the browser's back button returns to the
  report. A press the server refuses stays on the page, and the bar is redrawn
  from the server's answer rather than from what the screen hoped: the button goes
  inert, reading `Approved` when an approval is already recorded and `Approve`
  when the revision is older or the report is no longer active. Only the newest
  revision can be approved, so a viewer left on an older revision has an inert
  `Approve` and a line naming the newest revision, and a report whose job has
  finished cannot be approved at all. The server decides this, not the screen. A
  refused press (`409 stale_revision`, `409 already_approved`, `409 not_active`)
  is redrawn the same way, instead of waiting for a reload to disagree with the
  screen. An empty field is the default state, so the button on a fresh report is
  the one that starts a run.
- **One page for both.** The viewer reads the slug off its own path rather than a
  query parameter, so a report can be linked, bookmarked, and pasted into the
  transcript as itself.
- **Feedback and an approval reach the agent** as input submissions pushed into
  the conversation. Feedback is labelled `<pi-message src="operator"
  via="report-feedback">` (see [http-api.md](./http-api.md#reports)), and it is
  rendered there as a review card rather than a user message. An approval is the
  same shape with `via="approval"`, and it is rendered as a one-line `Approved ·
  <title> · v<n>` card with a link to the report. A press of a result report's
  Done is the same shape with `button=done` on the marker line, and its card reads
  `Done · <title> · v<n>`, with the user's own words under it. None of the three
  writes an inbox item, because each already arrives in the chat, which is where
  the agent reads it. The inbox carries the other direction — a report that was
  published or revised (see section 4).
- **`{{base}}` placeholders** in `report.html` are stamped by the server, because
  the page is served both at `/report` and at a nested slug where a relative asset
  URL would resolve to the wrong directory. Assets come from `/report/assets/*`,
  not from the static fallback, for the same reason.

---

## 11. Focused chats

A focused chat is a conversation the user opens from the web page to talk about one
topic at length. It is a sub-session of the root: it reads and answers, and it asks
the root for anything that changes the system. The chat page shows one, and
`/chats` lists them.

### The chat page

The address carries the chat number, `/basic-chat?chat=<id>`, and the page reads it
once. Every conversation route it uses becomes `/api/conversations/<id>/...`, so a
message, a reset or a compaction cannot land in the root while the page shows a
focused chat. An address with no `chat` value is the root conversation, which is
what the page has always shown.

The chat is read with `GET /api/focused-chats/:id` before any stream opens. A
number the server does not know, or a chat that was deleted, opens no stream at
all, and the page says so rather than retrying a 404 for as long as the tab stays
open.

- **The top bar.** The root shows the personality's name, or `pi-sec` when the
  personality has none. A focused chat shows its title, or
  `Untitled` while it has none, with the `Focused chat` mark in front of it. The
  bar takes the accent's pale wash as its fill and a border in the same family, so
  the conversation on screen is visible before the title is read. The browser tab
  reads `<title> · pi-sec`, and `pi-sec` on the root. A `focused_chat_updated`
  frame from the conversation stream redraws the bar and the notice.
- **Renaming.** A press on the title asks for a new one and sends it with
  `PATCH /api/focused-chats/:id`. The page refuses an empty title and one over 80
  characters before the request. A `409 chat_archived` makes the chat read-only on
  screen, because the refusal is the newest fact about it. The root's name is not a
  title, so it is never a press, and neither is the title of an archived chat or of
  a chat that was not found.
- **An archived chat.** The transcript stays and the composer goes. One line takes
  the composer's place: `This chat is archived.` with an `All chats` link.
- **A chat that is not there.** One line takes the composer's place as well: `This
  chat does not exist or was deleted.` with the same link.
- **The New session confirmations name the chat.** Both of them, the first press
  and the second one after the server's `agents_working` refusal, say which chat
  the reset acts on, because one press away from the root looks the same.

### The chats list (`/chats`)

`/chats` is a page of its own, served like `/report`. It is where the `Chats`
entry in the sidebar's Pages row and the inbox notices lead, and it is the only
place a chat is opened from, because the top bar carries no chat picker.

- **Active** lists the open chats that are not tests, newest opened first, with
  the count in the heading. A row is the title (or `Untitled`), when the chat was
  opened, a `running` marker while an answer is being written, and a `Rename`
  button. The title is the link to `/basic-chat?chat=<id>`.
- **Test** lists the open chats an agent opened with `{"test": true}`, with the
  count in the heading. The section is closed on every page load, so the heading
  and its count are all a reader sees, and the count is drawn even at zero. A
  press on the heading opens the section and a second press closes it. A redraw
  from the stream, the `↻ reload` button or a rename keeps the section as the
  reader left it, and the open state is not stored in the browser. A row is an
  active row, `Rename` included. Archived test chats stay in `Archived`, because
  the server pages that list and the page does not filter it. No other screen marks
  a chat as a test.
- **Archived** lists the archived chats, newest archived first, with the count in
  the heading and a `+` while more pages exist. A row carries when the chat was
  archived in place of the `Rename` button. An archived chat cannot be renamed.
- **New chat** opens a chat with no title (`POST /api/focused-chats`) and goes to
  it. The chat's own agent names it after the first message.
- **Search** is a form over the archived titles. A search runs when the form is
  submitted, not on every keystroke, because half a word is a read of half the
  list. The same term is the same list and reads nothing. A new term starts at the
  first page. `Load more` appends the next page of 20 rows under the rows already
  read.
- **Live updates** come from one light stream, `GET /api/focused-chats/events`,
  which carries the `focused_chat_updated` control event and no transcript. On
  `opened` and `titled` the page reads the open list again. On `archived` and
  `deleted` it reads both lists, because those move a row between them. The search
  term and the number of archived pages already loaded are kept. A change that
  arrives during a read is answered by one read after it, so a burst costs one read
  per burst. A search, a `↻ reload` press or a change that arrives during a read is
  answered the same way, and a page read with an older term is not drawn. Window focus, `pageshow` and the `↻ reload` button stay as the
  fallback for a stream that was down, and a reconnection that arrives as a
  `snapshot` reads both lists again. A tab hidden for one minute closes the
  stream, and the return opens a new one and reads both lists.
- The header carries a `← root chat` link back to the conversation page and the
  theme toggle. The page holds no composer and writes nothing except a new chat and
  a rename.

---

## 12. Usage <a id="usage"></a>

`/usage` is a fourth page. It answers one question: what has been spent, and how
much is left, at each service the agent uses. It is not a pane in the chat,
because a reader opens it on its own from the sidebar's Pages row.

**The page carries the answer the server already holds.** The server builds the
page with the provider values it received in the last ten minutes, and with
pi-sec's own usage windows from its records. It asks no provider while it builds
the page. The page draws that answer as it loads, so the cards and the windows
appear with the page rather than after a second request. A provider value that is
not in the answer says `Reading…`, and only then does the page ask
`GET /api/usage` for the rest. A provider with no reader says `WIP` and is never a
reason to ask. The answer travels in a JSON data block that the browser reads and
never runs, so the page's own policy needs no exception for it.

**One card per provider that has a login.** The server asks the model catalog on
every request which providers have auth. A provider that `models.json` or an
extension added, and a provider logged in a moment ago, has its card on the next
page load. Such a provider needs no restart and no code change. A provider
without auth has no card.

**A virtual provider has no card.** An extension may declare a provider
`virtual: true`, which says that the provider answers no request itself and hands
each one to another provider. pi-sec records a call under the provider that
answered it, so the usage of that call already sits on that provider's card, and
a card for the virtual provider would state zeros beside it. So the page draws no
such card: the answer carries none, on the page load, on `GET /api/usage`, at the
daemon's own read and on a refresh. The virtual provider is still listed in the
model login panel and in `pi-sec models`, because it is a model the agent can
use.

**Two shapes.** A subscription login draws a subscription card. That card holds
the 5-hour utilization and its reset time, the weekly utilization and its reset
time, and the credits. Every other login draws a prepaid card. Every other login
means an API key, an OAuth login that is not a subscription, or cloud
credentials. The prepaid card holds the prepaid balance, the usage of the last 24
hours, 7 days and 30 days, and one column per day of those 30 days. Each window
states its call count, its token count and an estimated cost. The subscription
cards come first. Inside one shape the order is the provider's display name.

**A subscription card can carry pi-sec's own rows too.** Under its own three rows,
the synthetic.new card draws the usage of the last 24 hours, 7 days and 30 days and
one column per day of those 30 days, and the Anthropic card draws the daily
columns. The rows are the prepaid card's rows, word for word: `Last 24 hours`,
`Last 7 days`, `Last 30 days` and `Usage per day`. Which of them a card has comes
from the server, which takes it from the provider's own reader. A card whose answer
does not hold a row draws no such row, so a subscription card without them looks
exactly as it did.

**A subscription card states what its cost is.** One line sits under the fields of
each of the two cards. The synthetic.new card says `pi-sec calls only · estimated
credit use at subscription rates`. The amount in its windows and columns is the
weekly credit those calls used, at synthetic.new's subscription rates, and it is
not a bill. The Anthropic card says `pi-sec calls only · API-equivalent cost`. Its
amount is what the same calls would cost at the Anthropic API list price, and it is
not a bill either. The amounts and the utilization above them count different
things, and they do not have to agree.

**One card per row.** The provider cards and the cards an extension puts in the
slot below share one column. Every card starts at the same left edge and has the
same width, on a phone and on a wide screen. The column stops at 72rem, and it
stays in the middle of the page. A card never grows wider than the screen, and
long text wraps inside it. The head of a card holds the provider name on the
left, then the badge that names the login kind. It holds the time the value was
received and the refresh button on the right. When the line runs out of room, the
badge, the time and the button move to the next line. The name keeps its letters
and never ends in an ellipsis.

**A bar carries each number.** The 5-hour limit and the weekly limit each draw a
horizontal bar. The bar is as long as the utilization, cut to 0 to 100 percent,
and the percent and the reset time sit beside it. The credits draw a bar of used
over limit, and only when the answer states both a monthly limit and a used
amount. A limit of none has nothing to measure, so that card draws no bar. A bar
names the level of its share in a `data-level` attribute: `ok` below 70 percent,
`warn` from 70 to 89, and `danger` from 90. The stylesheet colours the fill from
that attribute. A prepaid balance has no maximum, so it draws no bar, and the
balance is the large number on the card.

**A field with no reader says `WIP`.** The balance, the utilization and the
credits come from a reader keyed by provider id. The core ships one reader for
Anthropic, which reads the subscription's own usage, and one for DeepSeek, which
reads the account balance. Every other provider keeps its card and leaves those
fields at `WIP`. Its usage windows come from pi-sec's own records like every other
provider's. A subscription login of a provider with no reader therefore shows
three `WIP` fields. An API-key login of one shows a `WIP` balance over three
filled windows. A field at `WIP` draws its word and no bar.

**A balance no API states says so, and links the page where it is bought.** The
OpenAI card states `No API for the balance` in the prepaid balance row and links
the OpenAI billing page under it. The card states no amount, because no address
pi-sec may call returns the prepaid credit balance: the balance endpoint takes a
browser session key, and the cost endpoints take an admin key that pi-sec does
not hold. The row is the same row a balance with an amount uses, so the card's
other rows keep their places. The other rows of that card are pi-sec's own calls,
counted like every other card's, and the card asks OpenAI for nothing.

**The decision models card counts the judgement calls.** One more card sits below
the provider cards, named `Decision models`, and it is drawn only when the config
names a judge or the audit trail holds a judgement. Each row names one judge and
the provider and model it uses, for example `report-check · openai/gpt-6-luna`,
and under the name it states three lines, one for the last 24 hours, one for the
last 7 days and one for the last 30 days. A line reads
`12 calls · 3,400 tokens · $0.0042 · 1 unanswered`. `unanswered` counts the
judgements that gave no answer, which is a failed one and a skipped one, so a
judge whose credit ran out shows a number rather than a silence. The numbers come
from the audit trail and not from pi-sec's records, because a judgement runs
outside every conversation. They are not added to any provider card's windows, so
one call is never counted twice. The card carries no refresh button and no
received time: there is no provider to ask and the rows are read from a file. No
text a judgement was shown appears on it.

**The windows count pi-sec's own calls.** Each window is a rolling window that
ends at the moment the page is read. The numbers come from the record pi-sec
writes for every model call, and not from the provider. A call made with the same
key from another machine is not in them, and a prepaid card says `pi-sec calls
only · estimated cost`. The first read of the daemon's database sums the whole ledger
once and keeps per-minute sums in memory. Every later read adds only what arrived
since. A window starts on a whole minute, so its boundary is accurate to one
minute. Nothing older than 30 days stays in memory.

**A card with a daily field draws every day of the last 30.** The daily field of
the answer holds 30 slots, oldest first. The last slot is the last 24 hours, the last
7 slots sum to the 7-day window, and all 30 sum to the 30-day window. The card
draws one column per slot. The height of a column is its cost over the largest
cost of the 30. When the whole month costs nothing, the height follows the call
count and the label `by calls` sits under the columns. When the month holds
nothing at all, the 30 columns stay and have no height. The last seven columns
are darker, because they are the 7-day window. The tooltip of a column names its
window, its cost and its call count. A daily field at `WIP` or a failure draws no
columns.

**DeepSeek's cost follows the clock.** The catalog's price for a DeepSeek model is
the peak price, and DeepSeek's off-peak price is half of it. A call whose record
time is a weekday in UTC, inside 01:00-04:00 or 06:00-10:00, keeps its recorded
cost. Every other call costs half of it. Chinese holidays are not considered, and
the card says `Peak/off-peak rates applied · holidays ignored`.

**A card reads again on its own.** Every provider card carries one refresh button
in its head. The button asks for that provider only, and the answer replaces that
card. Every other card keeps the element it has, so a reader who refreshes one
provider does not lose the place of another. While the request runs the button is
disabled. A failure brings the button back and adds one line to the card, and the
values the card already shows stay. The header's reload button reads the whole
list again, as it always did.

**The page calls out only when a reader asks it to.** The daemon asks each
provider once when it starts, beside the first requests rather than before them,
so a page opened after a restart usually has the values already. A provider's own
value is kept for ten minutes, so the header's reload does not multiply calls. The
providers of one answer are asked together, and each call stops after ten seconds:
a provider that does not answer in time costs its own card a failure line and
leaves every other card as it was. A refusal (HTTP 429) stops that provider for
thirty minutes, and no refresh bypasses that backoff. The refresh button keeps a minimum interval of its own, counted from
that provider's last attempt: five minutes for Anthropic and one minute for
DeepSeek. A press inside that interval answers with the value the card already
holds. A held card says why: a refusal reads `rate limited until HH:mm`, and a
kept value reads `kept value from HH:mm · next refresh after HH:mm`. The time is
shortened from the label the server wrote, so the card never formats a clock of
its own. A failure never empties a card. That field states the reason, and the
rest of the card and every other card still draw. Each card states the time its
value was received, in pi-sec's own time zone.

**No secret is in the answer.** `GET /api/usage` carries no key, no token and no
account or organization id. The server uses the credential and never sends it. A
failed call is reported as its status and not as the provider's own sentence,
because that sentence can name an account.

**The slot below the cards.** `usage.cards` is the one place an extension adds a
service the core does not know. The server fills it when it builds the page, the
way the chat page fills `sidebar.bottom`. Each card gets a host element and 2
seconds. A card that does not render leaves one failure line. The response's
policy names the style nonce only when a card rendered. A card's controls go
through `POST /api/ui/call`, the route the chat page's cards use. A card that
wants a refresh button of its own builds it as its own control, with
`data-action`, the way the slot's other controls work. The core draws no button
for it.

**This page opens no event stream.** A card in `usage.cards` therefore hears no
`ui_event`. That event travels on a conversation's stream, and this page has no
conversation. Such a card draws what its `render` answers at page load, and it
changes through the answer of its own control. A card that must follow something
live belongs in `sidebar.bottom`.

### 12.1 Model speed (`/usage/stats`)

`/usage/stats` is a second page under the usage dashboard. The `/usage` header links to it, and its own header links back. The shell is `usage-stats.html`; the page reads `GET /api/usage/stats` (http-api.md section 8.3) and draws three inline SVG line graphs from it, with no chart library: generation speed (tokens per second after the first token, one line), time to first token (TTFT, one line per prompt length group), and time per output token (TPOT, one line per group). The pickers for provider and model are filled from the answer's `providers`, and the first read shows the pair the server chose. The pickers name only the providers that answered a call. The range picker offers 24h, 7d, 30d and 90d and starts at 7d; the step is the server's default. A p50 / p90 switch changes all three graphs. A p90 of speed is the fast side, and a p90 of TTFT or TPOT is the slow side. A slot with fewer than three calls has no value, and its line breaks there. Hovering a point shows the slot time, the value and the call count. On the speed and TPOT graphs the hover also shows how many calls the slot left out, when that number is not zero. A call faster than 1000 tokens per second arrived all at once, and those two graphs leave it out while the TTFT graph keeps it. A note under the graphs says this. With no calls at all, the page says so. Data exists only from the day the recording was added.

## 13. Pull requests <a id="pull-requests"></a>

The dashboard is three pages under `/github/pr/`: the list of pull requests that
wait on the reader, one pull request with its conversation and its review
threads, and the diff of one pull request. An extension serves them, and the
extension is off until the operator turns it on, so a page that is not enabled
answers 404. This chapter describes the pages and the parts they share. The
routes, the payloads and the event are in [http-api.md](./http-api.md), and the
settings are in [extensions.md](./extensions.md).

**Three addresses, not one page with a fragment.** The list is
`/github/pr/`, one pull request is `/github/pr/<owner>/<repo>/<number>`, and its
diff adds `/diff`. The diff of one commit of a pull request is
`/github/pr/<owner>/<repo>/<number>/commits/<sha>`, where `<sha>` is the full
commit id. Every row and every link is a real link, so a reader opens a
pull request in a new tab, copies its address and sends it on, and the browser's
back button means what it looks like. A review thread has an anchor of its own,
`#thread-<id>`, which opens on the thread, scrolls to it and marks it.

**The theme is GitHub's.** The three pages load `github-pr.css` and nothing else
of pi-sec's: no `theme.css`, no `styles.css`. Colour, type and spacing are the
ones GitHub's own light theme uses, and there is no dark palette, because the
dashboard is a window on a site that is light. The pull request and the diff also
load `ui-highlight-github.css`, the code-block palette, which the build copies out
of the installed highlight.js package instead of tracking a copy in this
repository. A label's colour is drawn from a style object the script sets rather
than from a `style` attribute, because the pages are served under a policy that
refuses an inline style.

**The page carries what the server already holds.** Three JSON data blocks are in
the list shell and the server fills them. `github-pr-meta` is on all three pages and
names the login gh answers as, the repositories the operator configured, and
whether the write routes answer at all. `github-pr-list-first` is on the list page
only and holds the list the server had in memory, so the rows are drawn with the
page rather than one request later. `github-pr-pending-first` is on the list page
only too and holds the saved reviews, so the Pending reviews section is drawn with
the page. The blocks are data, not code: their type is
`application/json`, so the browser parses them and never runs them, and the
policy needs no exception for them. The pull request and diff pages read their
repository and number from their own address, and draw the answer this tab kept
from the last visit before they ask again.

**The list draws from the first block, then follows the stream.**
`/api/github/pr/events` sends one frame, `prs`, when the server's cached list
changed, which happens when the daemon's own poll found something or when a tab
asked for a forced refresh, and also when a saved review file is created or removed.
A frame means one more read of the list route and of the saved reviews, and the
read that started last is the one that draws, so an answer that arrives late
cannot put an older list over a newer one. `⟳ Reload` in the bar is the one
control on this page that costs a GitHub request: it reads the list with
`?refresh=1`, which makes the server read GitHub now and replace its cache. A
failed read leaves the rows that are drawn where they are and prints the server's
own sentence in the strip under the bar.

**A row says where a pull request stands.** It is an `<a>` that holds the draft
mark, the title, the labels in their own colours, then one line with the number,
the author, the two branches, how long ago it moved and, when the dashboard
watches more than one repository, which one it came from, and finally the head
commit's CI mark. A section with no row is not hidden: it says `No pull requests`
in its own box, because an empty `Mentioned` section is the answer to "does
anything wait on me". The sections are the server's, in its order, and a pull
request appears in one section only. A pull request that has a saved review is in
`Pending reviews` and in no other section: the server leaves it out of the list, so
the head count of its original section drops with it.

**Pending reviews is the first box of the list page.** It lists every pull request
that has a review saved on the server, whatever its state (open, closed or merged)
and whether or not its repository is still in the settings, newest saved first. The
head shows the count. With no saved review the box stays and says `No saved
reviews`. A row is a `div` and not an `<a>`, because it holds a link and a button.
It shows a state mark (Open, Draft, Closed, Merged, or Unknown when the server does
not know the pull request yet), the title or `Pull request #<number>`, and one line
with the number, the repository, the count of comments, `overall comment`, the verdict
when it is Approve or Request changes, `not in settings` for a repository that left
the settings, and how long ago it was saved. The title links to the diff page, where
the review panel is. A repository that is not in the settings has no dashboard page,
so its title links to GitHub when the server knows the address and is plain text
otherwise. A file that could not be read says `This saved review cannot be read`
and has no link. The page reads the section again at each stream frame, after
`⟳ Reload` and after a delete. A page whose server sent no block draws no box.

**Delete removes one saved review.** Each row has a Delete button, drawn whether the
write switch is on or off, because a delete never reaches GitHub. A press opens the
browser's confirmation, which names the pull request and what is lost, and a cancel
sends nothing. On OK the page sends the repository, the number and the saved time
the row showed, or the file name of a file that could not be read. The server refuses
when the review changed after the row was drawn, and the server's sentence appears in
the strip under the bar while the row stays. After a success the page also drops this
tab's own copies of that review (the collected comments and the unsent changes), so
the next diff page load does not send them again. Another open tab keeps its own copy,
and a change that tab still has unsent makes the draft again. A delete cannot be
undone.

**The bar is on all three pages.** It holds the way back to the list, the
repository names and the login, `syncing…` while a read runs, and `⟳ Reload`. On a
screen narrower than 768 pixels it also holds `☰`, which slides a page's sidebar
out as a drawer over the content. That button toggles one class on `body` and the
stylesheet decides what the class opens, so it never has to know which page it is
on, and a page with no sidebar draws no button.

**The tab keeps what it read.** The three pages are separate addresses, so a
reader who goes from the list to a pull request and back asks for the same data
twice. The last answer per key is kept in this tab under the prefix
`github-pr:v1:`, in memory and in `sessionStorage`, and a page draws it before its
own request answers. An answer too large for the tab's storage quota is kept in
memory and not persisted, which is what a large diff is. The page still draws it,
and only the copy that outlives the tab is missing. The comments a reader collects
on a diff's lines and has not submitted are kept the same way, under the pull
request they belong to. The diff of one commit is kept under its own key.

**The unsubmitted review is saved on the server.** The comments a reader collects
with Add to review, the overall comment and the verdict are kept, as one file for
each pull request, under `state/github-pr/review-drafts/` (see
[http-api.md](./http-api.md#github-pr-draft)), so they come back after the tab is
closed and on another browser. The tab's own copy is still drawn first, and the
server's draft then replaces it. Each change is one small request (add, remove, set,
discard), sent one at a time in order. The overall comment is sent one second after
the last key press, when its field loses focus and when the page closes, and the
verdict is sent at once. When a request fails, the comment stays on the page and in
the tab, the review panel says `Not saved to server` with a Retry button, and the
next change, the Retry press or the next page load sends what waited. A review that
the page submits removes its comments from the draft. Discard all removes the
comments and sends the overall comment again, so the draft stays while that comment
is not empty. The draft file goes away when nothing is left in it. The server never
deletes a draft on a timer, when its pull request leaves the dashboard list, or when
its repository leaves the settings. Another open tab sees the change at its next
change or load, not at once.

**A comment keeps the text of its line.** Each comment saves the head commit of the
diff it was written on and the text of its first and last line. When the diff has
another head, a comment whose saved text differs from the text now at that line
number is marked `Line changed since it was written`, shows the saved text, and sits
at the top of its file. A comment on a file that is no longer in the diff is listed
in the review panel under `Comments on files not in this diff`, with a Remove
button. The panel shows how many comments point at changed lines above Submit, and
Submit sends them as they are.

**The review cannot change while it is being sent.** From the press on Submit review until the answer arrives, the overall comment, the verdict, Discard all and the Remove buttons in the panel are disabled, and Add to review, a new line selection and Remove on a line comment do nothing. An open comment box keeps its text. A success removes only the comments that the review carried, so a comment that another tab saved in the meantime stays pending.

**The review panel links to each comment.** Between the count and the overall
comment the panel lists one button for each comment, in the order of the diff. Its
text is the path, the side and lines, and the first 60 characters of the body. A
press unfolds the file when it is folded, opens the whole folded stretch that holds
the line (no other stretch, and none for a marked comment), scrolls the comment row
to the middle of the view, moves the focus to the row and highlights it for about 1.5
seconds. Under `prefers-reduced-motion` the row keeps a static outline until the next
press. A press on a comment that is already drawn writes no state and draws no
component. On a screen 768 pixels wide or narrower the panel closes after a press.

**The sidebar folds, and lists the commits.** The heading of the CI status
section and the heading of the Commits section are buttons: a press hides or shows
the rows under them. The CI mark stays in its heading while the rows are hidden.
Both panels start open, and the fold lives in the page only, so leaving the page
forgets it, as it does for a resolved thread and for a file of the diff. The
Commits section sits under CI status. It lists the newest 100 commits of the pull
request, oldest first, each as a link with the short id, the first line of the
message, the author and the age. A pull request with more commits shows a line
that names the count and links to the commits tab on GitHub. An answer that an
older build stored has no commit list, and the panel says `Loading commits…` until
the new answer arrives. Each of the two lists scrolls inside its own box after
about 320 pixels, so a long list does not push the links below it out of the
window.

**One commit has a diff page that looks like the pull request diff page.** The
commit address is served by the same shell and the same script as the diff page,
and the script reads its address to choose between the two modes. The commit mode
keeps the file tree, the side-by-side panes, folding a file, opening folded
context, the disk-limit notice, `⟳ Reload` and the tab's copy of the answer, which
is kept under the key `commit:<repo>:<sha>`. Its header shows the commit headline,
the short commit id, the parent (`first parent` for a merge commit, `root commit`
for a commit with no parent), the file count, three links, the author, the age,
and the rest of the message as plain text. The commit mode leaves out the thread
marks and every review control, and it never reads the pull request. A thread sits
on a line of the head version, so on a commit's diff the same line number usually
names another line. A review belongs to the whole pull request diff, so a comment
on one commit's line would be a write that this dashboard does not make. The page
draws no write control in this mode even while `writes` is on.

**An action on the diff page draws only what it changes.** The page component
that holds the diff (`DiffBody`) reads the answer and what the file layouts are
built from (the opened stretches, the collected comments, the open comment box,
the opened outdated threads and the threads), and nothing else. The marked file
and the folded directories are read by the file tree, the review fields are read by
the review bar, the fold of a file is read by that file, and the drag is read by
the grid of the file it is in. So a drag step draws the cells whose selection
changed in one file, a key in the overall comment draws the review bar, a scroll
past a file header draws the tree, and folding a file draws its header. Each file
keeps its layout object until its own inputs change, and a cell, a wide row, a
grid and a file draw again only when the values they draw change (the small helper
in `src/ui/github-pr/memo.ts`; the page does not use `preact/compat`). A drag that
enters the line it is already on writes nothing. The highlight of a line, with the
darker marks on the changed characters of a paired line already in its HTML, is
computed once per line text and cached, so no step edits the code after it is
drawn. Two tests keep this: `test/ui/github-pr-diff-render-scope.test.ts` counts
the components that draw for each action, and the timing script
`test/browser/pr-diff-perf.bench.ts` measures the actions on a large diff in
Chromium. The script is in neither suite. Run it after `npm run build` with
`BENCH_OUT=<directory> npx vitest --run --config test/browser/pr-diff-perf.vitest.config.ts`
under the heavy-work lock. `BENCH_NO_PROFILE=1`, `BENCH_DRAG_LINES`,
`BENCH_KEYS` and `BENCH_STEP_CAP_MS` shorten it, and the head of the script lists
every knob.

A file thread is a review comment on a whole file (`subjectType` `FILE`). The
pull request page draws its card with the path alone, a "File comment" flag and a
note in the place of the code table. The diff page draws no mark for it and no
outdated row. It draws one full-width row at the top of the file, with the flag
and a "View thread" link.

**A control that writes is drawn only when writes are on.** The page reads
`writes` from `github-pr-meta` and draws no reply box, no comment box, no reaction
button, no "Resolve conversation" button, no Edit button and no line selection while it is false. `writes` off is also what a page
does when the block is missing or unreadable: a control that the server refuses is
not drawn. The side that reads is unaffected, so a reaction count and a CI mark
still appear.

**A reply leaves its box once GitHub took it.** The reply box empties when the write succeeds, also when the read of the pull request after it fails. That failure shows its sentence in the strip and does not bring the text back, so a second press cannot post the reply twice. A refusal by GitHub keeps the text in the box.

**The description and the account's own comments can be edited.** The header of
the description card, of a conversation comment and of a comment inside a review
thread shows an Edit button when writes are on and GitHub says that the account
may update the text and wrote it. A review summary has no Edit button. Edit
replaces the rendered text with a text box that holds the raw markdown, with Save
and Cancel and no preview. Cancel, and Save with unchanged text, close the box and
send nothing. Save sends the new text and the text the page started from. While
the request is in flight, the button says `Saving…` and a second press sends
nothing. On success, the card shows the text that GitHub answered, closes the box,
and the page reads the pull request again. If the text changed on GitHub after the
box opened, the strip shows the server's sentence, and the box stays open with the
typed text so that the reader can copy it. Any other refusal leaves the box open
in the same way.

---

## 14. Machines <a id="machines"></a>

A remote machine is another computer this install reaches over `ssh`. The sidebar
draws one row per machine, with a slider that says how much this install may do
there and one line per ssh user on that machine. The row is the whole of what the
panel shows. The level the slider sets is what the remote tools obey, and those
tools are how an agent works on the machine. They start a command, read and write
a file, and copy a tree, so an agent does not assemble `ssh` by hand. A command
that takes long keeps running on the machine after the `ssh` connection drops, and
the core reads a run that is still going at least once every thirty minutes and
sends what it finds to the conversation that started the run. The routes are in
[http-api.md](./http-api.md), and the state the panel reads is in
[runtime-layout.md](./runtime-layout.md).

**The panel appears only while a machine is registered.** `config.json` decides:
with no `remoteMachines` key, or with an empty list of machines, the sidebar draws
no Machines panel. The heading is part of what the panel draws, so a hidden panel
leaves no empty box behind. The panel sits below the job tree, where a subject that
is not the conversation's own work belongs.

**A row is three things.** The machine's name and its address, with the port added
only when it is not 22. A slider of three buttons, `off`, `restricted` and `on`,
with the level the machine holds pressed in; the lowered or raised position is what
the slider is for, and the word on the button is what says which one it is, so the
fill is never the only sign. Then one line per ssh user, the main user first, in
the form `alice · reachable` or `bob · unreachable since 16:20 (No route to host)`.
A machine at `off` says `not checked (off)` for each of its users: no heartbeat was
sent, which is a different fact from a check that failed.

**A press applies at once and says what happened.** A press sends one `POST` with
the level it names, and the pressed mark moves before the answer arrives, so a
press that the server is slow to answer does not look ignored. When the request is
refused, the reason is written under the slider in the server's own words and the
mark goes back to what the server last said. A press on the level the machine
already holds sends nothing.

**A tightening is shown before it is applied.** A move to a stricter level is
stored at once and then takes time: the runs that no longer fit the new level are
stopped first, and the core stops whatever is left at a deadline. While that wait
lasts, the slider draws the level it is moving to in the waiting colour, with a
dashed edge, and one line under the slider says what waits: `pending: stopping 2
runs`, or `pending: stopping 1 run` for one. The line ends with `, no connection`
while every user of that machine is unreachable, because nothing can be stopped
until a check gets through. The answer carries the wait in `pending`, and the
panel returns to the applied shape when that value turns back to null on the same
read that follows `remote_machine_updated`, so the line keeps no timer of its own.

**Two more lines appear only when they are true.** `host key not pinned` says that no
host key has been put in place for this machine yet, so nothing was tried. A red
line says every connection to the machine is stopped, and why: `host key mismatch:
connections stopped` or `machine-id mismatch: connections stopped`, with the
moment it happened. The red line is the panel's only alarm, and it clears itself
when the operator pins a new key or edits that machine's configuration. The panel
folds from its heading like the inbox and the job tree, and a folded panel keeps
the alarm: a red `stopped` badge sits in the heading while any machine has a
stopped connection, and it goes when the connection comes back or the panel is
opened again, where the red line says the same thing and why.

**The list is read once and redrawn on one frame.** The panel reads
`GET /api/remote-machines` when the page opens, on a return to the tab, and when
the `remote_machine_updated` frame arrives. The frame names nothing the panel
needs: the list is one read for a level change, a link state and a block alike, and
a burst of frames inside half a second costs one read. A frame that arrives while
the tab is hidden is remembered and read once when the tab comes back, so a page
nobody looks at pays nothing. A read that fails leaves the last list on screen.
