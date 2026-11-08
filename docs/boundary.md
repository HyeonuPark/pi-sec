# Core and instance extensions: where a feature belongs

This document gives the rule that decides where a new or changed feature of
`pi-sec` goes. Read it before you add a feature, move a feature, or promote a
runtime extension. The rule uses the properties of a feature, not a list of
features, so it stays valid when features are added.

Section 2 of [extensions.md](./extensions.md) describes how the two kinds of
code load and change. This document describes which kind a feature is.

## 1. Terms

- Core: the code, prompts, documents, tests and scripts in this repository. Every
  install gets the core. A core change is a commit in the modification tree and
  takes effect after a cold restart.
- Bundled optional part: a core part that an install turns on or off by
  configuration. It ships in the repository and follows every core rule.
- Instance side: everything that one install keeps under its own home
  (`~/.pi/sec`) and that the repository does not ship. This includes runtime
  extensions, configuration values, secrets, and the data that the agent keeps
  for its user.
- Instance extension: a runtime extension under `~/.pi/sec/extensions/<name>/`.

## 2. The rule

Decide in this order. The first step that matches decides.

1. If the feature needs something that only one install has, it is an instance
   extension. These things count:
   - an account, a credential, or a contract with an outside service, other than
     the model provider that the install signs in to;
   - a service that charges per use, other than the model provider;
   - software, files, paths, or hardware on one host, beyond the prerequisites
     in [install.md](./install.md);
   - the tasks, data, routines, or preferences of one user.
2. If the agent flow or another core part cannot work without the feature, it is
   core. The agent flow is the work of the root, orchestrator, planner and worker
   roles, the asynchronous review of their plans and results, and the rules that
   keep the agent inside its own permissions.
3. If the feature works on any install without step 1's needs, but not every
   install needs it, it is a bundled optional part.
4. Otherwise, it is core.

If one feature has parts that fall on both sides, split it. The core part is a
general extension point: a tool, a prompt section, a hook, a task, a model
provider export, or a configuration key that names no outside service. The
instance part is an instance extension that uses that point.

## 3. What the core text may say

These rules apply to every file in this repository: code, comments, prompts,
documents, tests, scripts, and commit messages.

- The core does not name an instance extension, the outside service it uses, or
  its tools, files, or configuration keys. This also holds for examples, sample
  paths, and test values that check for the absence of such a name.
- The core describes an extension point in general terms. An example in a core
  document uses a made-up name that no real extension or service has.
- The core does not import, detect, or special-case one instance extension. It
  reaches instance extensions only through the extension interface in
  [extensions.md](./extensions.md).
- The core does not hold the values of one install: user names, host names,
  domain names, account paths, e-mail addresses, or secrets. The copyright
  holder and the repository address are the one exception.
- A check that looks for a forbidden name keeps its word list on the instance
  side, not in the repository. The repository ships the check only. The check
  looks for known values: the values the install registered, the values it reads
  from the machine (the home path, the host name, and the account name), the
  personality name of the install, and the instance word list. It also looks
  for two shapes, a generated id and a real-looking e-mail address. It reads the
  install values when it runs, so the repository holds the rule and never the
  value.

## 4. Moving a feature

- Instance extension to core: remove every need from step 1 of section 2 first.
  Then the feature must match step 2, 3 or 4. The user confirms the promotion,
  as section 2 of [extensions.md](./extensions.md) says.
- Core to instance side: a core part that matches step 1 moves out. Its general
  extension point can stay in the core.

## 5. When to check

An agent that changes `pi-sec` itself applies this rule before it writes a plan.
The plan names the side of each change and the step of section 2 that decided it.
A review of such a plan checks that answer. Work that only uses `pi-sec` for
other tasks does not need this document.
