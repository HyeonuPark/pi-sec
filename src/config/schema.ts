import { Type, type Static } from "typebox";

const ThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

/**
 * One entry of the top-level `vmodels` table: a model alias.
 *
 * Every field is required, `prompt` included. A default would turn "what is
 * actually applied" into a fact you learn by reading the code instead of the
 * config. `prompt` names a file under `prompts/vmodel/`; an empty file is a
 * legitimate value, and it means "no addition to the system prompt".
 */
const VmodelSchema = Type.Object(
  {
    provider: Type.String(),
    modelId: Type.String(),
    thinkingLevel: ThinkingLevelSchema,
    prompt: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * One entry of the top-level `judges` table: a judgement model.
 *
 * A judge is a pi-ai **classifier** model: it reads one piece of text and
 * answers fixed questions about it (true or false, one of several choices, or a
 * score), each with a probability. `provider` and `modelId` name that model, and
 * nothing else is needed: a classifier has no thinking level and no prompt file
 * of its own, which is why this entry is smaller than `VmodelSchema` above.
 *
 * `timeoutMs` bounds one judgement, in milliseconds. Absent means 5000, the
 * default in `src/judges.ts`. A judgement that runs longer is reported as a
 * timeout, and the caller never waits past this value.
 *
 * `reviewBelow` is a threshold a caller may read: an answer whose probability of
 * yes is below it is one that caller marks for review. It is a number from 0 to
 * 1, and it means nothing on its own: the caller decides what a mark for review
 * does, and a caller that reads no threshold uses its own default. The
 * `report_check` tool is the one caller today, and its default is 0.95.
 *
 * The model named here is looked up among classifier models only. A chat model
 * of the same id in the same provider is a different catalog entry and is never
 * used, so `{ "provider": "openai", "modelId": "gpt-6-luna" }` means the
 * Decisions classifier and not the chat model of that name.
 */
const JudgeSchema = Type.Object(
  {
    provider: Type.String(),
    modelId: Type.String(),
    /** Deadline of one judgement, in milliseconds. Absent means 5000. */
    timeoutMs: Type.Optional(Type.Number({ minimum: 1 })),
    /**
     * The review threshold: an answer whose probability of yes is below this is
     * one the calling code marks for review. A number from 0 to 1. Absent means
     * the caller's own default, which for `report_check` is 0.95.
     */
    reviewBelow: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  },
  { additionalProperties: false },
);

/**
 * One entry of `scheduler.jobs`.
 *
 * Only the fields the load and the migration read are here. `jobId`,
 * `background`, and `notify` were declared and never implemented: the scheduler
 * created a job on demand and matched it by its `schedule:<name>` label, so a
 * configured job id could not be honoured even in principle, and neither of the
 * other two had a reader. The migration now matches the record by that same
 * label (and by the title, for a record made by hand) and fills `routine`.
 *
 * This list is not a schedule any more. The boot migration reads it once, moves
 * each entry onto a job record's `routine`, and empties it; after that the
 * scheduler refuses a non-empty list and says which entries it ignored. The type
 * stays because the migration reads the list before the process that empties it
 * can run, and because refusing the shape at load would stop the very boot that
 * performs the move.
 *
 * The model is named as a `vmodel` key, like every other model choice here, so
 * there is one way to say which model a piece of work runs on.
 */
const ScheduleJobSchema = Type.Object(
  {
    name: Type.String(),
    /**
     * A five-field cron expression, checked for shape here and parsed by the
     * scheduler's own `parseCron` at load (`src/config/load.ts`). The pattern is
     * not the authority: a value can match the shape and still name a minute of
     * 99, and only the parser knows that.
     */
    schedule: Type.String({ minLength: 1, pattern: "^[0-9*,/-]+(\\s+[0-9*,/-]+){4}$" }),
    timezone: Type.Optional(Type.String()),
    catchUp: Type.Optional(Type.Union([Type.Literal("skip"), Type.Literal("once"), Type.Literal("all")])),
    overlap: Type.Optional(Type.Union([Type.Literal("skip"), Type.Literal("queue"), Type.Literal("allow")])),
    prompt: Type.String(),
    /**
     * A key of the top-level `vmodels` table. Absent stays absent: this list is
     * migrated to a job record once, and a run whose vmodel is missing fails
     * instead of borrowing the root agent's.
     */
    vmodel: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

/**
 * One entry of `githubPr.repos`: the GitHub name of a repository, `owner/repo`.
 *
 * The pattern is the whole name, not the parts, so an error names one string.
 * owner is up to 39 characters of letters, digits and hyphens; repo is up to 100
 * characters of letters, digits, `.`, `_` and `-`, and it is neither `.` nor
 * `..`. Neither part may start with a hyphen: `git remote add` reads such a name
 * as an option (`git remote add -n/app <url>` fails on `-n`), so a repository the
 * extension could not clone as a remote is refused at load time instead. GitHub
 * forbids a leading hyphen in an owner as well. GitHub compares both parts
 * without regard to case, so two entries that differ only in case name one
 * repository. That is not a load error: the list is kept as the file wrote it,
 * and the extension folds the duplicates into one when it reads them.
 */
const RepositoryName = Type.String({
  pattern: "^(?!-)[A-Za-z0-9-]{1,39}/(?!-)(?!\\.{1,2}$)[A-Za-z0-9._-]{1,100}$",
});

/**
 * Settings of the `github-pr` extension, which is not in the default enabled
 * list.
 *
 * The key sits at the top level rather than under `agent`, like `readFull`: it is
 * one optional extension's own settings, and a key that is absent is clearer
 * than an entry under `agent` that says nothing while the extension is off. Add
 * `githubPr` to `config.json` only together with the extension name in
 * `agent.extensions.enabled`; the loader refuses the config when the name is
 * enabled and the key is absent, and accepts a key whose extension is off (its
 * values are then unused).
 *
 * `writes` and `repos` have no default on purpose. A default for `writes` would
 * decide on the operator's behalf whether this install may write to GitHub, and
 * a default for `repos` would name repositories nobody asked for; a file that
 * omits either one fails the load and says which key is missing. The two
 * numbers do have defaults, which the load applies, and neither of them decides
 * anything about GitHub.
 */
const GithubPrSchema = Type.Object(
  {
    /**
     * Whether this install may write to GitHub at all: thread replies, pull
     * request comments, reactions, review submissions, thread resolves, and edits of
     * the description and of the account's own comments. One switch for all of
     * them, because the user named one. Off means the write API answers 403 and
     * sends nothing to `gh`, and the pages show no input for a write.
     */
    writes: Type.Boolean(),
    /** The repositories the dashboard shows. At least one. */
    repos: Type.Array(RepositoryName, { minItems: 1 }),
    /**
     * How long one poll cycle waits after the previous one finished, in seconds.
     * The floor is 60: a shorter cycle spends the GitHub GraphQL budget (5000
     * points an hour) on a handful of repositories.
     */
    fetchIntervalSeconds: Type.Optional(Type.Integer({ minimum: 60, default: 300 })),
    /**
     * Cap on everything the extension keeps under `~/.pi/sec/gh-repo/`, in
     * megabytes. The ceiling of 4096 keeps any setting below the 5 GB mark that
     * the pi-sec rules treat as heavy use. 0 removes the cap.
     */
    diskLimitMegabytes: Type.Optional(
      Type.Union([Type.Literal(0), Type.Integer({ minimum: 100, maximum: 4096 })], { default: 2048 }),
    ),
  },
  { additionalProperties: false },
);

/**
 * One entry of `remoteMachines.machines`: a machine this install may reach over
 * ssh, and the users it reaches on that machine.
 *
 * `id` is the machine's name rather than its address, and three things are keyed
 * by it: the pinned host key (`HostKeyAlias`), the level the operator chose, and
 * the socket of the connection kept open to each of its users. So an address may
 * change without losing the level or the pinned key.
 *
 * `users` names the ssh users on that machine. The first one is the main user and
 * the rest are secondary users: the same machine reached as another account, with
 * its own home directory and its own permissions. They share the machine's level,
 * which is why the level is stored per machine and not per user.
 *
 * A name that starts with `-` is refused, for `address` and for every entry of
 * `users`: ssh reads such a value as an option, so `-oProxyCommand=...` in place
 * of a host name would run a local command instead of connecting.
 */
const RemoteMachineSchema = Type.Object(
  {
    /** The machine's name: lower-case letters, digits and `-`, up to 32 characters. */
    id: Type.String({ pattern: "^[a-z0-9-]{1,32}$" }),
    /** An IP address or a host name. */
    address: Type.String({ pattern: "^(?!-)\\S+$" }),
    /** The ssh port. */
    port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, default: 22 })),
    /** The ssh users of that machine. The first one is the main user. */
    users: Type.Array(Type.String({ pattern: "^(?!-)[A-Za-z0-9._][A-Za-z0-9._-]*$" }), { minItems: 1 }),
    /**
     * The `/etc/machine-id` this install expects. Absent means the first value
     * read over a connection with a pinned host key is recorded and compared from
     * then on (`src/remote/machines.ts`). Naming it here is how an operator accepts
     * a new value after a mismatch.
     */
    machineId: Type.Optional(Type.String({ pattern: "^[0-9a-fA-F]{32}$" })),
  },
  { additionalProperties: false },
);

/**
 * Settings of the `linear` extension, which is not in the default enabled list.
 *
 * The key sits at the top level, like `githubPr`: it is one optional extension's
 * own settings. Add `linear` to `config.json` only together with the extension
 * name in `agent.extensions.enabled`; the loader refuses the config when the name
 * is enabled and the key is absent, and accepts a key whose extension is off.
 *
 * Neither value has a default on purpose. A default for `writes` would decide on
 * the operator's behalf whether this install may write to Linear, and a default
 * for `apiKeySecret` would name a secret nobody stored.
 */
const LinearSchema = Type.Object(
  {
    /**
     * The name of the secret file that holds the personal API key, under the
     * secrets directory. Same name pattern as an uploaded secret.
     */
    apiKeySecret: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$" }),
    /**
     * Whether the three write tools exist. Read at boot to register them, and read
     * again by every write call, so a reload that sets it to false stops writes
     * before the next restart. Each write also needs an approved report.
     */
    writes: Type.Boolean(),
  },
  { additionalProperties: false },
);

/**
 * Settings of the `remoteMachines` feature.
 *
 * The key sits at the top level, like `githubPr`: it is one optional feature's own
 * settings, and a key that is absent says "this feature is off" more clearly than
 * a switch that is `false` by default. With the key absent the sidebar draws no
 * Machines panel, the server opens no connection, and no ssh process is started.
 *
 * Every value here is read on use and never copied at boot: the heartbeat cycle
 * reads the key each time it runs and the HTTP routes read it on each request. So
 * an operator adds a machine, or changes an address, and one config reload reaches
 * a running daemon (`src/remote/machines.ts`).
 */
const RemoteMachinesSchema = Type.Object(
  {
    /** The private key file used for every connection. `~` and `$HOME` expand. */
    identityFile: Type.Optional(Type.String({ default: "~/.ssh/id_ed25519" })),
    /**
     * Seconds between two heartbeat rounds. The floor of 15 keeps a round from
     * spending more time connected than disconnected, and the ceiling of 3600 keeps
     * a dead machine from being noticed an hour and a half late.
     */
    heartbeatSeconds: Type.Optional(Type.Integer({ minimum: 15, maximum: 3600, default: 60 })),
    /**
     * Seconds between two scheduled checks of one run.
     *
     * The core reads a detached run at least this often, starting thirty seconds
     * before the interval so a message lands inside it. The floor of 60 keeps a
     * check from costing more than the work it watches, and the ceiling of 1800 is
     * the promise the feature makes to the user: a run is looked at every half hour.
     */
    runCheckSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 1800, default: 1800 })),
    /**
     * Seconds the core waits after a tightening before it stops what is left.
     *
     * A run that the new level does not allow is announced to the root, whose
     * agents get the chance to stop their own runs. What is left when this passes is
     * stopped by the core, which is the one irreversible step of the feature, so
     * the wait is a setting an operator can lengthen.
     */
    tightenDeadlineSeconds: Type.Optional(Type.Integer({ minimum: 30, maximum: 3600, default: 300 })),
    /**
     * Seconds a command gets at level `restricted`.
     *
     * The command is started as `ionice -c3 nice -n 10 timeout -k 5 <seconds>`, so
     * this is the clock on a run the operator allowed as light work.
     */
    restrictedSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 86_400, default: 600 })),
    /**
     * Seconds a machine may stay unreachable before the core makes its level `off`.
     *
     * A machine the user did not set to `off` that does not answer for longer than
     * this is made `off` by the core itself, and the core asks nobody first: the user
     * gets one inbox item and the root gets one notice about the change, and the
     * sidebar slider raises the level again when the machine is back. The floor of 60
     * is about one heartbeat round, because a shorter threshold is answered at the
     * next round anyway; the ceiling of a day keeps the change from arriving after the
     * user has stopped caring about the machine.
     */
    outageSeconds: Type.Optional(Type.Integer({ minimum: 60, maximum: 86_400, default: 3600 })),
    /** The machines, in the order the panel shows them. */
    machines: Type.Array(RemoteMachineSchema),
  },
  { additionalProperties: false },
);

/**
 * The default registry root, before `applyHomeDefaults` moves it under the home.
 *
 * It carries the `~/.pi/sec` prefix so that `PI_SEC_HOME` relocates it with the
 * rest of the control structure (`underHome`). The registry modules read the
 * same constant for a config that names no `registry` key at all.
 */
export const REGISTRY_ROOT_DEFAULT = "~/.pi/sec/repos";

/**
 * One entry of `registry.buildDirs`: a build directory of a repository.
 *
 * `dir` is the folder inside a worktree, `lockfile` the file that decides when
 * the folder is stale, and `install` the command that fills it. `repo` absent
 * means every repository. `src/registry/layout.ts` explains how a rule
 * replaces or adds to the built-in rules.
 *
 * `dir` may not be absolute and may not hold a `..` part: it becomes a folder
 * name under `<root>/buildfs/...`, and a value that walked out of that folder
 * would put a cache where the registry never looks for one, next to something
 * the registry may delete.
 */
const BuildDirRuleSchema = Type.Object(
  {
    repo: Type.Optional(Type.String({ minLength: 1 })),
    dir: Type.String({ minLength: 1, pattern: "^(?!/)(?!.*(^|/)\\.\\.(/|$)).+$" }),
    lockfile: Type.Optional(Type.String({ minLength: 1, pattern: "^(?!/)(?!.*(^|/)\\.\\.(/|$)).+$" })),
    install: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  },
  { additionalProperties: false },
);

/**
 * Settings of the registry: the bare repositories and worktrees this install
 * manages, and the buildfs cache it keeps for them.
 *
 * Every value carries a default, so a file that names the key with an empty
 * object, or names none of its values, reads as the defaults. The key itself is
 * optional, and `defaultConfig()` carries it, so a config file written before
 * the registry existed loads unchanged.
 *
 * `root` is moved under `PI_SEC_HOME` by `applyHomeDefaults`, like `code` and
 * `secrets.dir`. `cacheKeep` is an integer of at least 1: zero would prune the
 * cache the refresh just made. `refreshHours` is positive for the same reason.
 */
const RegistrySchema = Type.Object(
  {
    /** The registry root. Default `~/.pi/sec/repos`, moved by `PI_SEC_HOME`. */
    root: Type.Optional(Type.String({ minLength: 1, default: REGISTRY_ROOT_DEFAULT })),
    /** Caches kept for each repository and build directory. At least 1. */
    cacheKeep: Type.Optional(Type.Integer({ minimum: 1, default: 2 })),
    /** Hours between two cache refreshes. Positive. */
    refreshHours: Type.Optional(Type.Number({ exclusiveMinimum: 0, default: 24 })),
    /** Operator rules that override or add to the built-in build directories. */
    buildDirs: Type.Optional(Type.Array(BuildDirRuleSchema, { default: [] })),
    /** Which buildfs method is used. `auto` decides per repository. */
    mode: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("subvolume"),
        Type.Literal("copy"),
        Type.Literal("none"),
      ], { default: "auto" }),
    ),
  },
  { additionalProperties: false },
);

/** The validated shape of `~/.pi/sec/config.json`. Unknown keys are rejected. */
export const ConfigSchema = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    version: Type.Number(),
    /**
     * The harness's own clock, as an IANA zone name.
     *
     * The restart notice, `expiry_check` with no `today`, the web page's schedule
     * stamp and one line of the preamble all read this value. It is not
     * `scheduler.timezone`: that key is the default zone of a routine that names
     * none, which is a property of the schedule and not of the harness.
     *
     * A name `Intl` cannot resolve is refused at load (`requireTimeZone`), because
     * the schema sees a string and every reader would format wrong without saying
     * so.
     */
    timezone: Type.String(),
    server: Type.Object(
      {
        bind: Type.String(),
        port: Type.Number(),
        basePath: Type.String(),
        publicUrl: Type.Optional(Type.String()),
        trustedProxies: Type.Array(Type.String()),
        sse: Type.Object(
          {
            heartbeatMs: Type.Number(),
            queueBytes: Type.Number(),
            bufferMs: Type.Number(),
          },
          { additionalProperties: false },
        ),
        maxBodyBytes: Type.Number(),
        /**
         * Cap on one uploaded file, in bytes. The upload route reads its own
         * binary body, so `maxBodyBytes` above does not apply to it.
         */
        maxUploadBytes: Type.Number(),
        /** Pixel bounds of an image the upload route accepts. Larger is refused. */
        imageMaxWidth: Type.Number(),
        imageMaxHeight: Type.Number(),
      },
      { additionalProperties: false },
    ),
    code: Type.Object(
      {
        snapshot: Type.String(),
        workspace: Type.String(),
      },
      { additionalProperties: false },
    ),
    /**
     * Model aliases. The root agent names one with `agent.vmodel`, and every
     * subagent names one when it is spawned, so a model is chosen by name in one
     * place rather than as a `{ provider, modelId }` pair in several.
     *
     * The default is empty: a key exists only because the file declares it, and
     * no default key comes back after one is deleted.
     */
    vmodels: Type.Record(Type.String(), VmodelSchema),
    /**
     * Judgement models, named the way `vmodels` names a conversation model: one
     * key, one provider and model id. Code calls one by its key
     * (`context.judges.judge(name, { state, questions })`). A judge is called by
     * code and not by a conversation: the one tool that reaches a judge is
     * `report_check`, which is offered to an orchestrator only and calls the judge
     * named `report-check`.
     *
     * The default is empty. A judge entry costs a warning line at every start
     * while its provider has no credential, so an install that judges nothing
     * declares nothing. This file is not written by pi-sec itself.
     */
    judges: Type.Record(Type.String(), JudgeSchema),
    agent: Type.Object(
      {
        /**
         * The vmodel the root agent uses. There is no default. An empty value
         * starts the daemon in setup mode: the web server runs, the chat write
         * routes answer 409 `model_not_configured`, and the web page (or
         * `pi-sec setup-model`) chooses the first model. A key that `vmodels` does
         * not hold stops the boot with a message that names the keys the file
         * does declare.
         */
        vmodel: Type.String(),
        /**
         * The root agent's roles. A subagent's roles come from its spawn call
         * and are never inherited: "what is applied here" must be answerable
         * from one document, not by walking up a tree.
         */
        roles: Type.Array(Type.String()),
        subagent: Type.Object(
          {
            /** Live subagents allowed at once. A spawn over the limit fails. */
            maxTotal: Type.Number(),
            /** Largest message body, in bytes. Over the limit the write fails. */
            maxMessageBytes: Type.Number(),
            /** Deadline of a blocking request-response, in milliseconds. */
            requestTimeoutMs: Type.Number(),
            /**
             * Window of the round-trip signal between two conversations, in
             * milliseconds. Direction changes inside this window are counted.
             */
            roundTripWindowMs: Type.Number(),
            /**
             * Direction changes between the same two conversations in one window
             * that make the next request say so. A notice only: nothing is cut.
             */
            roundTripMax: Type.Number(),
            /**
             * How long a `claimed` reply may sit before the pair's next request
             * names it, in milliseconds.
             */
            claimedStaleMs: Type.Number(),
            /**
             * How long a child may wait for orders before its parent is told
             * once, in milliseconds. 0 turns the notice off. A notice only:
             * nothing is stopped or deleted.
             */
            idleNoticeMs: Type.Number(),
          },
          { additionalProperties: false },
        ),
        workspace: Type.String(),
        /**
         * The request options every model request of every conversation carries.
         *
         * One key so far: `cacheRetention`, how long the provider keeps the
         * prompt cache of a request. `"none"` asks for no cache, `"short"` is the
         * provider's own default of a few minutes, and `"long"` is the longest
         * retention the provider offers, which Anthropic spells as one hour.
         *
         * The key is optional and has no default, because a value this code sends
         * is a value this code chose: with the key absent nothing is passed, and
         * the model library decides from its own default and the
         * `PI_CACHE_RETENTION` environment variable, exactly as it did before this
         * key existed. So an install that does not name the key sends what it
         * always sent.
         *
         * The value is read on every request (`src/agent/settings.ts`), not copied
         * at boot, so a config reload reaches the next request. A long retention
         * costs more to write and less to read: the write is twice the input price
         * against 1.25 times for the short one, and a request that wakes up after
         * the short window instead reads the context from the cache.
         */
        stream: Type.Object(
          {
            cacheRetention: Type.Optional(
              Type.Union([Type.Literal("none"), Type.Literal("short"), Type.Literal("long")]),
            ),
          },
          { additionalProperties: false },
        ),
        /**
         * Settings of the focused chats the user opens from the web page.
         *
         * A focused chat is offered an allow list of tools rather than a removal
         * list, so a tool a runtime extension adds is closed to it until it is
         * named here. That is the whole point of the allow list: an extension
         * installed later must not be able to reach a conversation the user
         * believes is read-only.
         */
        focusedChat: Type.Object(
          {
            /**
             * Tool names added to a focused chat's allow list when it is opened.
             * A name no installed extension registers is kept in the list and
             * offers nothing, exactly as a removed name would.
             */
            extraTools: Type.Array(Type.String()),
          },
          { additionalProperties: false },
        ),
        /**
         * The directory the conventions name for a job's working files.
         *
         * The `conventions` section writes `agent.jobDir` into the prompt as an
         * absolute path, and an orchestrator puts a job's plans, scripts and
         * companion files under `<jobDir>/<slug>/`. It expands against the run
         * account's home (`$HOME`), not against the pi-sec home: a job directory
         * is where a person looks for the job, so `PI_SEC_HOME` does not move it.
         * An empty value means the default, `~/job`.
         */
        jobDir: Type.String(),
        /**
         * Settings of the restart advice: the text the harness puts on one input of
         * a conversation whose context has grown long.
         */
        contextRestart: Type.Object(
          {
            /**
             * The context size, in tokens, above which the next input of a
             * conversation carries the restart advice. The size is the last
             * answer's `input + cacheRead + cacheWrite`, which is the request the
             * provider answered.
             *
             * `0` turns the advice off. The default of 300,000 is above the point
             * where a session's context costs more than a fresh one and below the
             * window of every model this install uses.
             */
            thresholdTokens: Type.Number(),
            /**
             * The roles that make a subagent a target of the advice. The root is a
             * target whatever this list says. A subagent whose roles share a name
             * with it is one, and a planner, a worker and a scheduled run are not.
             *
             * This is a list of its own rather than `personality.roles`, because
             * the two name different things: the personality names the roles that
             * write the text the user reads, and this one names the roles that live
             * long enough for a restart to be worth it.
             */
            roles: Type.Array(Type.String()),
            /**
             * Settings of the time-based advice: the text the harness puts into a
             * target conversation that has been quiet for a while.
             *
             * It sits beside `thresholdTokens` because it asks for the same thing
             * from the same conversations, and because a session that restarts on
             * either advice restarts for the same reason: its next input would carry
             * a context the provider no longer holds in its cache.
             */
            idle: Type.Object(
              {
                /**
                 * Minutes of quiet, measured from the newest recorded activity of
                 * the conversation, after which that conversation is owed one
                 * advice. `0` turns the advice off.
                 *
                 * The default of 55 sits just under the hour a provider keeps a
                 * prompt cache, so the judgment call reads that cache while it is
                 * still there.
                 */
                minutes: Type.Number(),
                /**
                 * The request size, in tokens, of the newest answer, below which a
                 * quiet conversation is not advised. An answer is read as
                 * `input + cacheRead + cacheWrite`, the request the provider
                 * answered, and a conversation with no answer at all is never
                 * advised: its size is unknown.
                 *
                 * `0` turns the size check off, so any quiet target gets the
                 * advice. The default of 100,000 is well above the size a session
                 * begins with after a restart, so a conversation that would gain
                 * nothing from another restart is left alone.
                 */
                minTokens: Type.Number(),
              },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
        extensions: Type.Object(
          { enabled: Type.Array(Type.String()) },
          { additionalProperties: false },
        ),
        compaction: Type.Object(
          {
            enabled: Type.Boolean(),
            reserveTokens: Type.Number(),
            keepRecentTokens: Type.Number(),
            backgroundTokens: Type.Number(),
          },
          { additionalProperties: false },
        ),
        retry: Type.Object(
          {
            enabled: Type.Boolean(),
            maxRetries: Type.Number(),
            /**
             * Window of the global retry budget, in milliseconds. The budget is
             * counted in memory and is forgotten at a restart.
             */
            windowMs: Type.Number(),
            /**
             * Failed model attempts inside one window for the whole process.
             * At this count no further retry starts until the window clears.
             */
            maxFailures: Type.Number(),
          },
          { additionalProperties: false },
        ),
        /**
         * The script tool and the background-call tools. Every key here has a
         * reader: `enabled` gates the extension's tools, the rest are read in
         * `src/extensions/js-tool.ts` and `src/extensions/async-tools.ts`.
         */
        tools: Type.Object(
          {
            js: Type.Object(
              {
                enabled: Type.Boolean(),
                /** `null` means no deadline of its own. A call may still set one. */
                timeoutMs: Type.Union([Type.Number(), Type.Null()]),
                memoryLimitBytes: Type.Number(),
                /**
                 * The `js` tool's result caps, read on every call. The result keeps
                 * its beginning and drops the end, so a minimum of 1 is what keeps
                 * the keys meaningful: 0 would keep nothing and a negative byte cap
                 * reads as a cut from the end. A value below 1 is a load error rather
                 * than a silently empty result.
                 */
                maxResultBytes: Type.Number({ minimum: 1 }),
                maxResultLines: Type.Number({ minimum: 1 }),
                maxToolCalls: Type.Number(),
              },
              { additionalProperties: false },
            ),
            async: Type.Object(
              {
                enabled: Type.Boolean(),
                maxConcurrent: Type.Number(),
                maxArgsBytes: Type.Number(),
                progressBytes: Type.Number(),
                cancelTimeoutMs: Type.Number(),
              },
              { additionalProperties: false },
            ),
            /**
             * Move a tool call to the background when it runs longer than this,
             * in milliseconds. `0` turns the move off. A moved call keeps running
             * and its output arrives later as a tool-output message; see
             * `src/extensions/async-tools.ts`.
             */
            backgroundAfterMs: Type.Number({ minimum: 0 }),
            /**
             * Send a status check to the conversation of a running background
             * call at this interval, in milliseconds, counted from the moment
             * the call started. `0` turns the check off.
             */
            backgroundCheckMs: Type.Number({ minimum: 0 }),
            /** Operator overrides of the `complex` tag, by tool name. */
            complex: Type.Object(
              { add: Type.Array(Type.String()), remove: Type.Array(Type.String()) },
              { additionalProperties: false },
            ),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    /**
     * Settings of the `personality` extension.
     *
     * The document itself is a markdown file the operator can read and edit. The
     * extension renders it into the prompt of the root and of the orchestrators,
     * and the language it names decides the language of the text the user reads
     * and whether the Korean writing rules are in the prompt.
     */
    personality: Type.Object(
      {
        /**
         * The personality file: relative to the pi-sec home, or absolute. An empty
         * value means the default, `memory/personality.md`.
         */
        file: Type.String(),
        /**
         * Offer the design interview when no personality is registered. It runs on
         * the root's first request and only while the conversation has no answer
         * in it, so a setting here never interrupts a conversation under way.
         */
        interview: Type.Boolean(),
        /**
         * Subagent roles that make an orchestrator for this extension: a subagent
         * whose roles share a name with this list receives the personality and the
         * Korean writing rules. A worker and a scheduled run receive neither.
         */
        roles: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    /**
     * Settings of the optional `read_full` tool (the `read-full` extension).
     *
     * The extension is not in the default `agent.extensions.enabled` list, so
     * these values do nothing until an operator adds that name.
     */
    readFull: Type.Object(
      {
        /**
         * Largest file, in bytes, that `read_full` returns whole. A larger file
         * is refused with its size, not cut.
         */
        maxBytes: Type.Integer(),
      },
      { additionalProperties: false },
    ),
    /**
     * Settings of the `github-pr` extension.
     *
     * Optional, and absent from `defaultConfig()`: the extension is off until an
     * operator adds the name, so a key that exists only because the file
     * declares it is the honest shape. The loader refuses a config whose enabled
     * list names `github-pr` and whose `githubPr` key is missing.
     */
    githubPr: Type.Optional(GithubPrSchema),
    /**
     * Settings of the `linear` extension.
     *
     * Optional, and absent from `defaultConfig()`: the extension is off until an
     * operator adds the name. The loader refuses a config whose enabled list names
     * `linear` and whose `linear` key is missing.
     */
    linear: Type.Optional(LinearSchema),
    /**
     * Settings of the registry: the bare repositories and worktrees this
     * install manages, and the buildfs cache it keeps for them.
     *
     * Optional so that a config file written before the key existed, and a
     * config a test builds by hand, still load; `defaultConfig()` carries the
     * key with its defaults.
     */
    registry: Type.Optional(RegistrySchema),
    /**
     * Settings of the `remoteMachines` feature. Optional, and absent from
     * `defaultConfig()`: a machine is registered by naming it in the file, and a
     * key that exists only because the file declares it is the honest shape.
     */
    remoteMachines: Type.Optional(RemoteMachinesSchema),
    auth: Type.Object(
      {
        authPath: Type.String(),
        modelsPath: Type.String(),
      },
      { additionalProperties: false },
    ),
    secrets: Type.Object(
      {
        dir: Type.String(),
        dummyFormat: Type.String(),
        redactEncodings: Type.Array(
          Type.Union([Type.Literal("raw"), Type.Literal("base64"), Type.Literal("url")]),
        ),
        includeModelCredentials: Type.Boolean(),
        modelCredentialPaths: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    tmp: Type.Object(
      {
        cleanup: Type.Boolean(),
        maxAgeHours: Type.Number(),
        maxBytes: Type.Number(),
        eagerThresholdBytes: Type.Number(),
      },
      { additionalProperties: false },
    ),
    /**
     * Where uploaded and published files live, and where a published file is
     * served from.
     *
     * Both resolve against the run account's home (`$HOME`), not against the
     * pi-sec home, so `PI_SEC_HOME` does not move them: an operator finds an
     * attachment where they left it. `~/`, `$HOME/`, and an absolute path are
     * all accepted; `src/attachments/store.ts` expands them on every read, so the
     * store, the routes, and the tools cannot disagree about where a file is.
     */
    attachments: Type.Object(
      {
        /** Operator uploads: one directory per attachment, named by its ULID. */
        dir: Type.String(),
        /** Files an agent published, served at `/api/share/<name>`. */
        shareDir: Type.String(),
      },
      { additionalProperties: false },
    ),
    archive: Type.Object(
      {
        /** Move finished jobs out of the live store. */
        enabled: Type.Boolean(),
        /** Days a job stays in the live store after it reaches a terminal status. */
        afterDays: Type.Number(),
        /**
         * The wall-clock time of the one sweep a day, `HH:MM` in the harness
         * `timezone`. A daemon that is down at that time skips the day instead of
         * catching up, so the sweep reads a clock and not an interval.
         */
        sweepAt: Type.String({ pattern: "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$" }),
        /**
         * Ignored, and kept so an older file still loads.
         *
         * The sweep used to run on this interval, in milliseconds. A config that
         * still carries it is read and warned about once at boot rather than
         * refused: refusing it would stop the boot of every install that copied
         * an older default, and a key nothing reads is cheaper than that.
         */
        sweepMs: Type.Optional(Type.Number()),
      },
      { additionalProperties: false },
    ),
    scheduler: Type.Object(
      {
        enabled: Type.Boolean(),
        tickMs: Type.Number(),
        timezone: Type.String(),
        jobs: Type.Array(ScheduleJobSchema),
      },
      { additionalProperties: false },
    ),
    logging: Type.Object(
      {
        level: Type.Union([
          Type.Literal("debug"),
          Type.Literal("info"),
          Type.Literal("warn"),
          Type.Literal("error"),
        ]),
        redact: Type.Array(Type.String()),
        maxBytes: Type.Number(),
        retainFiles: Type.Number(),
      },
      { additionalProperties: false },
    ),
    audit: Type.Object(
      { maxBytes: Type.Number(), retainDays: Type.Number() },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type Config = Static<typeof ConfigSchema>;
export type GithubPrConfig = Static<typeof GithubPrSchema>;
export type LinearConfig = Static<typeof LinearSchema>;
export type RegistryConfig = Static<typeof RegistrySchema>;
export type BuildDirRuleConfig = Static<typeof BuildDirRuleSchema>;
export type RemoteMachinesConfig = Static<typeof RemoteMachinesSchema>;
export type RemoteMachineConfig = Static<typeof RemoteMachineSchema>;
export type ScheduleJobConfig = Static<typeof ScheduleJobSchema>;
export type VmodelConfig = Static<typeof VmodelSchema>;
export type JudgeConfig = Static<typeof JudgeSchema>;

/** Built-in defaults; `config.json` is merged over these. */
export function defaultConfig(): Config {
  return {
    version: 1,
    timezone: "UTC",
    server: {
      bind: "127.0.0.1",
      port: 8787,
      basePath: "",
      trustedProxies: [],
      sse: { heartbeatMs: 15000, queueBytes: 1048576, bufferMs: 60000 },
      maxBodyBytes: 1048576,
      maxUploadBytes: 8388608,
      imageMaxWidth: 1920,
      imageMaxHeight: 1080,
    },
    code: {
      snapshot: "~/.pi/sec/snapshot",
      workspace: "~/.pi/sec/workspace",
    },
    // No default alias and no default root model: a model is named by the file,
    // never inherited from the code. An empty root vmodel is what a file that
    // names none leaves behind, and the daemon starts in setup mode with it.
    vmodels: {},
    // No default judge either: a key exists only because the file declares it,
    // and a judge nothing calls would warn at every start.
    judges: {},
    agent: {
      vmodel: "",
      roles: [],
      subagent: {
        maxTotal: 500,
        maxMessageBytes: 16384,
        requestTimeoutMs: 600_000,
        roundTripWindowMs: 600_000,
        roundTripMax: 15,
        claimedStaleMs: 1_200_000,
        idleNoticeMs: 300_000,
      },
      workspace: "~/.pi/sec/workspace",
      // No default retention: an absent key passes nothing to the model library,
      // which is what this install did before the key existed.
      stream: {},
      contextRestart: {
        thresholdTokens: 300_000,
        roles: ["orchestrator"],
        idle: { minutes: 55, minTokens: 100_000 },
      },
      jobDir: "~/job",
      focusedChat: { extraTools: [] },
      extensions: {
        enabled: [
          "coding",
          "jobs",
          // The read-only registry tool. It needs no key and no service, and the
          // registry itself is created by `pi-sec repos register`.
          "registry",
          "reports",
          "scheduler",
          "self-edit",
          "ask-user",
          "web",
          "notify",
          "secrets",
          // Directly after `secrets`: both extensions hook the same request, and the
          // install order is the catalog order, which keeps redaction first.
          "attachment-context",
          "usage",
          // Holds a conversation whose provider refused it for usage, and sends it
          // again when that provider accepts requests. One timer, no setting.
          "usage-freeze",
          "js-tools",
          "async-tools",
          "agent-profile",
          "subagents",
          "diagnostics",
          "attachments",
          "lessons",
          "session-restart",
          // The prompt section extensions, in the catalog order that decides
          // where their text lands. `read-full` and `expiry-check` are not here:
          // they are opt-in.
          "conventions",
          "language-rules",
          "message-tags",
          "personality",
        ],
      },
      compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, backgroundTokens: 32768 },
      retry: { enabled: true, maxRetries: 3, windowMs: 600_000, maxFailures: 30 },
      tools: {
        js: {
          enabled: true,
          timeoutMs: null,
          memoryLimitBytes: 268435456,
          maxResultBytes: 102400,
          maxResultLines: 2000,
          maxToolCalls: 32,
        },
        async: { enabled: true, maxConcurrent: 4, maxArgsBytes: 8192, progressBytes: 4096, cancelTimeoutMs: 10000 },
        backgroundAfterMs: 600_000,
        backgroundCheckMs: 1_800_000,
        complex: { add: [], remove: [] },
      },
    },
    personality: { file: "memory/personality.md", interview: true, roles: ["orchestrator"] },
    // `applyHomeDefaults` moves `root` under `PI_SEC_HOME`, like `code.snapshot`.
    registry: { root: REGISTRY_ROOT_DEFAULT, cacheKeep: 2, refreshHours: 24, buildDirs: [], mode: "auto" },
    readFull: { maxBytes: 262144 },
    auth: { authPath: "~/.pi/sec/auth.json", modelsPath: "~/.pi/sec/models.json" },
    secrets: {
      dir: "~/.pi/sec/secrets",
      dummyFormat: "⟦secret:{name}⟧",
      redactEncodings: ["raw", "base64", "url"],
      includeModelCredentials: true,
      modelCredentialPaths: ["~/.pi/sec/auth.json", "~/.pi/sec/models.json"],
    },
    tmp: { cleanup: true, maxAgeHours: 6, maxBytes: 1073741824, eagerThresholdBytes: 67108864 },
    attachments: { dir: "~/attachments", shareDir: "~/share" },
    archive: { enabled: true, afterDays: 3, sweepAt: "05:00" },
    scheduler: { enabled: true, tickMs: 30000, timezone: "UTC", jobs: [] },
    logging: {
      level: "info",
      redact: ["authorization", "apiKey", "token"],
      maxBytes: 16777216,
      retainFiles: 5,
    },
    audit: { maxBytes: 67108864, retainDays: 90 },
  };
}
