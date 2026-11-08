# Shipped prompt text

Core prompt sections live in code (`src/extensions/*.ts`), because core changes
are cold-only: they are part of the running program and apply after a restart.

This directory holds prompt text that is easier to review as markdown than as
string literals. `npm run build` copies it to `dist/prompts/`, so a built daemon
reads the shipped copy from `<install>/dist/prompts/`.

## What the repository ships

- `role/` holds five English role files: `root-agent.md` for the root agent,
  `user-facing-agent.md` for every conversation that talks with the user (the
  root and a focused chat), `focused-chat.md` for a focused chat,
  `orchestrator.md`, and `worker.md`.
- `vmodel/` holds the extra prompt text of one model alias per file. The file
  here is empty, so an installation writes its own.

## Which copy answers

The harness looks for a prompt file under two roots, in this order:

1. `~/.pi/sec/prompts/<area>/` in the instance home.
2. `<install>/dist/prompts/<area>/` in the install.

The first file it finds answers. A file with the same name in the instance home
therefore replaces the shipped file, and the shipped file stays as it is. An
installation that puts no file in its home reads the shipped text and needs no
copying step.

A prompt file edited during a session applies from the next session, because
`agent-profile` renders `vmodel` and `roles` as sealed sections.

See `docs/extensions.md` for the extension model and
`docs/architecture.md#prefix-cache` for why context is append-only.
