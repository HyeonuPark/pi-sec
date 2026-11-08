# Role files

A role is a named file of system-prompt text. The harness reads `role/<name>.md`,
and the whole file reaches the conversation through the sealed `roles` section.
The root agent takes its roles from `agent.roles` in `config.json`. A subagent
takes its roles from the `roles` argument of `spawn_subagent`.

## The six shipped roles

The repository ships six English role files.

- `root-agent.md` is the root, the user's main conversation. It takes `user-facing-agent.md` too.
- `user-facing-agent.md` holds the rules for any conversation that talks with the user. The root and a focused chat take it.
- `orchestrator.md` owns one top-level job and divides a request into sub-jobs
  and the agents that take them.
- `planner.md` works out the content of one plan or one result report for its
  orchestrator, in a working document it writes in the job directory, and
  answers the points that come back. It ends when that report is approved or
  its work is cancelled.
- `worker.md` finishes one instruction and reports the result.
- `focused-chat.md` is a focused chat: a read-only sub-session of the root, where the user talks about one topic at length. It takes `user-facing-agent.md` too.

A focused chat always takes `focused-chat` and `user-facing-agent`, in that
order. The server writes that list when it opens the chat, and no configuration
key changes it.

## Which copy answers

The harness looks for a role file in `~/.pi/sec/prompts/role/` first. When the
instance home holds no file of that name, the harness uses the shipped copy in
`<install>/dist/prompts/role/`. A file with the same name in the instance home
replaces the shipped file.

## Adding a role of your own

An installation can add a role file of its own. Write it in the instance home,
for example `~/.pi/sec/prompts/role/instance-root.md`, and add its name to
`agent.roles` in `config.json`:

    "roles": ["root-agent", "user-facing-agent", "instance-root"]

The harness reads the files of all named roles in the order given and joins them
with a blank line. The root of that example reads the shipped root file first,
the shipped user-facing file second, and the installation file third.

A role name has 1 to 64 characters of letters, digits, dot, dash or underscore,
and starts with a letter or digit.

`root-agent.md` refers to an installation role file for standing jobs. Some
requests always go to the same job, and that installation file is where an
installation names the jobs that always take a kind of request. Name it in
`agent.roles` after `root-agent`, so that the root reads both files.

## This file

This file is a document, not a role. The harness reads a role file only when a
name in `agent.roles`, or in the `roles` argument of `spawn_subagent`, matches
its file name without the `.md` suffix.
