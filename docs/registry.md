# Git repository registry

The registry keeps the git repositories this install manages, the worktrees that
agents work in, and a cache of the build directories those worktrees need. It is
one folder on disk, one set of commands, and one read-only agent tool.

Four words come back in every section below.

- A **bare repository** is a git directory with no working folder of its own. It
  holds the refs, the tags and the hooks of one repository, and every worktree of
  that repository shares them.
- A **worktree** is a second working folder of one repository. It has its own
  files, its own checked-out branch and its own build directory, and it shares
  the refs of the bare repository.
- A **build directory** is the tree that an install writes inside a worktree, for
  example `node_modules`, `.venv` or `target`. It is large, and a lockfile can
  rebuild it.
- A **cache** is a copy of one build directory, taken from a worktree and stored
  under the registry root. A new worktree fills its build directory from that
  copy, so it runs no install.

A repository is registered in one of two ways. The registry makes a bare copy
under its root, or the repository stays where it is and the registry writes one
record that names its git directory. The second form serves a repository that
already has a working folder this install uses.

## 1. Where the registry keeps its files

```text
<registry root>/
  repos/<owner>/<repo>.git/                         a bare repository
  repos/local/<name>.git/                           a repository that GitHub does not hold
  repos/local/<name>.inplace.json                   the record of a repository registered where it lives
  worktrees/<owner>/<repo>/<worktree name>/         a worktree
  buildfs/<owner>/<repo>/<build directory>/<time>/  one cache
  state/last-refresh.json                           the moment of the last cache refresh
  state/refresh.lock/                               the lock that one refresh holds
```

The default root is `~/.pi/sec/repos`. The variable `PI_SEC_HOME` moves that path
with the rest of the control structure, and the setting `registry.root` names
another path. Every command that writes creates the folders it needs, with mode
0700.

The listing reads three sources. The `repos` folder says which repositories
exist, `git worktree list --porcelain` says which worktrees a repository has, and
the job store answers the title and the status of a job whose id a worktree name
carries. The registry writes only what git does not keep: the record of an
in-place registration and the cache meta file. The moment an install finished
comes from the file times of the build directory.

### 1.1 Names

- A repository is named `<owner>/<repo>`, in lowercase. A name without a slash
  belongs to `local`. Each part holds lowercase letters, digits, `.`, `_` and
  `-`, does not start with a dot, and does not hold `..`.
- Upper case becomes lower case. GitHub does not tell `Owner/Repo` from
  `owner/repo`, so one repository must have one folder.
- A worktree name holds lowercase words joined by single hyphens, at most 80
  characters. It becomes the folder name and the branch `wt/<name>`.
- A worktree name that starts with a job id carries that job.
  `20261103-01m6ef23h50000000000005rpq-fix-hook` names the job
  `20261103-01M6EF23H50000000000005RPQ`, and the listing shows that job's title
  and status. A name that starts with no job id carries no job.
- A cache folder is named after the moment it was made, in UTC:
  `YYYYMMDDTHHMMSSZ`, and `-2`, `-3` and so on when two caches fall in the same
  second. The listing orders
  caches of one second by that number, so `-10` is newer than `-9`.

## 2. Settings

The `registry` key of `~/.pi/sec/config.json` holds these values.

| Key | Default | Meaning |
| --- | --- | --- |
| `registry.root` | `~/.pi/sec/repos` | The registry folder. `PI_SEC_HOME` moves it, and a value here replaces it. |
| `registry.cacheKeep` | `2` | How many caches one repository keeps for one build directory. The value is at least 1. |
| `registry.refreshHours` | `24` | How many hours pass before the daemon refreshes the caches again. |
| `registry.mode` | `auto` | How a build directory is stored: `auto`, `subvolume`, `copy` or `none`. Section 4 explains the four values. |
| `registry.buildDirs` | empty | Rules that replace or add a build directory rule. The rest of this section explains one rule. |

A config file that names the `registry` key with an empty object reads as these
defaults.

The registry knows three build directories without a rule.

| Lockfile in the worktree | Build directory | Install command |
| --- | --- | --- |
| `package-lock.json` | `node_modules` | `npm ci` |
| `uv.lock` | `.venv` | `uv sync` |
| `Cargo.lock` | `target` | none |

A rule of `registry.buildDirs` has four fields: `repo`, `dir`, `lockfile` and
`install`. `repo` is absent for a rule that applies to every repository, and
holds one repository name otherwise. `dir` is the folder inside a worktree,
`lockfile` names the file that decides when the folder is stale, and `install` is
the command as an argument list, for example `["pnpm", "install"]`.

A rule that names the `dir` of a built-in rule replaces that rule, so an npm
project becomes a pnpm project. A rule with a new `dir` adds a build directory. A
rule that names a `lockfile` applies only while that file is in the worktree, so
a worktree without `pnpm-lock.yaml` gets no pnpm install.

## 3. Commands

The `pi-sec` executable is not on `PATH`. Run the command line with node.

```console
node ~/.pi/sec/snapshot/dist/cli.js repos <command>
```

| Command | What it does | Writes |
| --- | --- | --- |
| `repos register --name <owner>/<repo>` | Makes an empty bare repository under the root, sets its default branch to `main`, and installs the protection hook. | yes |
| `repos register --in-place <git directory> --name <name>` | Installs the protection hook in a git directory that stays where it is, and writes the record that names it. | yes |
| `repos worktree add <repo> <name>` | Makes one worktree with the branch `wt/<name>`, and fills its build directories. | yes |
| `repos worktree remove <repo> <name>` | Removes one worktree and its build directories. | yes |
| `repos worktree refill <repo> <name>` | Empties the build directories of one worktree and fills them again. | yes |
| `repos ff <repo> <branch>` | Moves `main` forward to a branch, and refuses every other move. | yes |
| `repos cache refresh [repo]` | Runs one cache refresh now, for one repository or for every repository. | yes |
| `repos cache prune [repo]` | Removes the caches past `cacheKeep`, for one repository or for every repository. | yes |
| `repos list [--json]` | Reads the repositories, their worktrees and their caches. | no |
| `repos show <repo> [--json]` | Reads one repository with its worktrees and its caches. | no |
| `repos doctor [--json]` | Tests the parts the registry depends on, and reports each test. | no |

`--json` stands after the arguments of the command, and it prints the value as
one JSON document, in the shape of section 5. `repos_list`, the agent tool,
returns the same value.

A command that refuses or fails writes one line to stderr and exits 1. A command
line that the usage does not describe prints the usage and exits 2. A
configuration file that does not load also exits 2. `repos doctor` exits 1 when
one of its checks fails, and `repos --help` exits 0.

### 3.1 Register a repository

`repos register --name <owner>/<repo>` refuses a name that is already registered,
under either form. It runs `git init --bare -b main`, and it installs the hook
and the config value that the hook reads (section 10).

`repos register --in-place <git directory> --name <name>` resolves
`git rev-parse --git-common-dir` to an absolute path and installs the hook in the
hooks folder of that git directory. It refuses a git directory that already
carries a `reference-transaction` hook of another tool, and it writes no record
then. The record holds one absolute path.

```json
{ "gitDir": "/path/to/the/git/directory" }
```

The command writes the record through a temporary file and a rename, so a reader
never sees half of it.

### 3.2 Add a worktree

1. Refuse a name that is not lowercase words joined by single hyphens, and refuse
   a name the repository already holds.
2. Refuse a worktree when the branch `wt/<name>` already exists. Two worktrees
   cannot share one branch.
3. Run `git worktree add`. A repository with no commit gets `--orphan`. A
   repository with commits starts the branch at its default branch, so a worktree
   begins where `main` is now.
4. Fill the build directories of the new worktree (section 6).
5. Report the path, the branch, the storage method, and where each build
   directory came from.

A failed install leaves the worktree in place and reports the failure. The folder
holds a branch and possibly a commit that exists nowhere else, so the caller
decides what to do with it.

### 3.3 Remove a worktree

The command refuses a worktree that holds modified or untracked files, and it
changes nothing then. It also refuses a folder outside `<root>/worktrees/`.

Otherwise it removes the build directories first, and then it runs
`git worktree remove` with no `--force`, so git has the last word. An ignored
file does not count as a change, and git removes the folder with it. The branch
`wt/<name>` stays: a branch is the commit the work left, and deleting it is a
decision for the operator.

### 3.4 Refill a worktree

`repos worktree refill` empties each build directory of a worktree and fills it
again from a cache or from an install. Use it after a build tool removed its own
build directory (section 11). It removes a plain folder that stands where a
subvolume belongs, and it removes nothing outside that worktree.

### 3.5 Move main forward

`repos ff <repo> <branch>` moves `refs/heads/main` to a branch, and it moves
forward only. `main` must be an ancestor of the branch. The command refuses a
branch that is behind `main`, and it refuses a branch that holds its own commits
from an older point.

The command refuses to move `main` while a worktree of that repository has it
checked out, and it names that worktree. The update names the value it replaces,
so a `main` that moved between the two reads is refused by git rather than
written over.

The command runs against the bare repository, outside every worktree, and the
protection hook leaves it alone there. That is the path a landing uses.

## 4. Storage methods

| Value | When | How a build directory is filled |
| --- | --- | --- |
| `subvolume` | btrfs, and this user can make and delete a subvolume under the registry root | one `btrfs subvolume snapshot` from the newest cache |
| `copy` | any other file system | `cp -a --reflink=auto` from the newest cache |
| `none` | the operator names it | an empty folder and then an install, and no cache is kept |
| `auto` | the default | `subvolume` when the test below passes, and `copy` otherwise |

`auto` tests the file system in two steps. Node's `statfsSync` reports the type of
the file system that holds the registry, and btrfs reports 2435016766. When the
type is btrfs, the registry makes one probe subvolume under `<root>/buildfs/` and
deletes it again. A failure at either step falls back to `copy`, because the type
alone does not say that this user can make a subvolume there. The registry
removes the probe subvolume on every path, including the path where the delete
failed.

`repos list` and `repos show` report the method in use, and `repos doctor`
reports it too.

## 5. The fields of a listing

`repos list --json` and `repos_list` return one object.

| Field | Meaning |
| --- | --- |
| `root` | The registry folder. |
| `mode` | The storage method. `auto` is reported as the method it resolves to, once the buildfs folder exists (section 4). |
| `repos` | One entry for each repository. |
| `worktrees` | One entry for each worktree of every listed repository. |
| `caches` | One entry for each cache of every listed repository. |

A registry folder that does not exist reads as an empty registry: `repos`,
`worktrees` and `caches` are empty lists.

One repository:

| Field | Meaning |
| --- | --- |
| `id` | `<owner>/<repo>`. |
| `gitDir` | The git directory that every worktree of this repository shares. |
| `inPlace` | True for a repository registered where it already lived. |
| `remotes` | A list of `{ name, url }`, one entry for each remote. |
| `defaultBranch` | The branch that `HEAD` points at, or null. |
| `sizeBytes` | The bytes of the git directory, or null. |
| `hookInstalled` | True when the protection hook is present, executable, of the registry's text, and pointed at this root. |

One worktree:

| Field | Meaning |
| --- | --- |
| `repo` | The repository id. |
| `path` | The folder. |
| `managed` | True when the folder sits under `<root>/worktrees/`. |
| `branch` | The branch, or null for a detached HEAD. |
| `head` | The commit, or null for a branch with no commit yet. |
| `dirty` | True when `git status --porcelain` prints anything. |
| `createdAt` | The moment git made the worktree, or the folder's own time when git keeps none. |
| `jobId` | The job id that the name carries, or null. |
| `jobTitle`, `jobStatus` | The title and the status of that job, or null. |
| `sizeBytes` | The bytes of the folder, or null for a worktree outside the registry. |
| `buildDirs` | One entry for each build directory that the lockfiles ask for and the folder holds. |

One build directory of a worktree:

| Field | Meaning |
| --- | --- |
| `dir` | The folder name inside the worktree, for example `node_modules`. |
| `mode` | `subvolume` when the folder is a btrfs subvolume (inode 256), and `copy` otherwise. |
| `filledFrom` | The cache the folder was filled from, or null after an install and after that cache is pruned. |
| `installedAt` | The moment the install finished, or null. |
| `lockfileHash` | The sha256 of the worktree's lockfile, or null when the rule names no lockfile. |
| `sizeBytes` | The bytes of the folder, or null. |

One cache:

| Field | Meaning |
| --- | --- |
| `repo` | The repository id. |
| `buildDir` | The build directory it holds, for example `node_modules`. |
| `path` | The cache folder. |
| `createdAt` | The moment it was made, from its meta file, or the folder's own time when it has none. |
| `sourceWorktree` | The worktree it was taken from. |
| `lockfileHash` | The sha256 of that worktree's lockfile at that moment. |
| `readOnly` | True when the subvolume is read-only. |
| `sizeBytes` | The bytes of the folder. |

The listing walks a folder and adds the allocated blocks of every file. It counts
a file once, also when a hard link reaches it by two names. It reads sizes only
for the git directory, for a worktree under `<root>/worktrees/` and for a cache,
because walking a folder outside the registry can read a whole home directory.

The job fields of a worktree come from the name and from the job store. `repos list`
and `repos show` read the job database under `state/`, the live store first and
the archive second, so a finished job that the sweep moved still answers.
`repos_list` reads the job store of the extension context. A job store that
cannot answer leaves `jobTitle` and `jobStatus` empty, and every other field
stays.

`repos show <repo>` and the `repos_list` tool refuse a name that the registry
does not hold.

## 6. How a build directory is filled

1. Read the lockfiles in the worktree, and take the build directories from the
   rules of section 2.
2. When the storage method is not `none`, read the newest cache of that build
   directory.
3. When that cache carries a meta file whose `lockfileHash` equals the sha256 of
   the worktree's lockfile, fill the folder from the cache: one
   `btrfs subvolume snapshot` in `subvolume` mode, and `cp -a --reflink=auto` in
   `copy` mode. Skip the install.
4. Otherwise make an empty folder and run the install command in the worktree. In
   `subvolume` mode the empty folder is a subvolume. A rule with no install
   command makes the empty folder and runs nothing: `target` is filled by the
   build that writes it, and its cache comes from a worktree that built it.
5. Run `restorecon` on each new subvolume and on each snapshot of one. A fresh
   subvolume starts with the SELinux label `unlabeled_t`, and `restorecon` sets
   the label of the folder beside it without root. A host without SELinux has no
   `restorecon`, and a failure there changes nothing about the tree.

A fill that fails removes the folder it made, and the command reports the
failure. A failed install leaves a worktree with no build directory rather than
one that cannot be trusted.

A cache carries a meta file, `pi-sec-cache.json`, with five fields: `repo`,
`buildDir`, `sourceWorktree`, `lockfileHash` and `createdAt`. The meta file stays
inside the folder that the cache filled, which is how the listing finds the cache
a worktree came from. A folder that an install filled has no meta file.

## 7. How the caches are kept current

The daemon refreshes the caches once a day. It makes its first test five minutes
after the process starts, so a restart starts no snapshot in the middle of boot,
and it makes one test each hour after that. A test reads
`state/last-refresh.json`, and it refreshes only when that file is missing or
older than `refreshHours`.

A refresh holds the lock folder `state/refresh.lock`, so a refresh in the daemon
and one from the command line take turns. The second caller returns with no work
rather than waiting. A lock older than two hours belongs to a run that died, and
the next run takes it over.

One refresh visits each repository and each build directory under it.

1. Take as candidates the worktrees of that repository that hold an installed
   build directory of that name. An npm worktree is a candidate only when
   `node_modules/.package-lock.json` describes its `package-lock.json`: every
   package of the marker is in the lockfile with the same version, and every
   package of the lockfile that is not the root entry and not optional is in the
   marker. A worktree whose install did not follow its lockfile is no source for
   a cache.
2. Read the install time of each candidate. For npm it is the mtime of the marker
   file, which npm writes at the end of an install. For another ecosystem it is
   the newest top-level entry of the folder, and the folder's own mtime when the
   folder is empty.
3. Pick the candidate whose install finished last. When the newest cache already
   carries that lockfile hash and was made at or after that install, skip this
   build directory: the cache is current.
4. Otherwise turn the build directory into a cache under
   `<root>/buildfs/<owner>/<repo>/<build directory>/<time>/`. A subvolume cache
   is a `btrfs subvolume snapshot`, and a `copy` cache is
   `cp -a --reflink=auto`. Write the meta file inside the new cache, fix its
   SELinux label with `restorecon`, and then set the subvolume read-only with
   `btrfs property set <path> ro true`. The label comes before the read-only
   flag, because a read-only subvolume accepts no write. A read-only subvolume
   still fills a worktree, because a snapshot of it is writable.
   A step that fails removes the new cache folder, so a half cache is never
   listed.
5. Remove the caches past `cacheKeep`, with the steps of section 8.

Each repository and each build directory has its own entry in the answer, so one
failed snapshot is reported there and the rest of the run continues. The daemon
does not log a failed snapshot, because the run itself finished. A run that
throws is one line in the daemon log, and it writes no new moment, so the next
hourly test tries again. A run that finishes writes the new moment to
`state/last-refresh.json`.

`repos cache refresh [repo]` and `repos cache prune [repo]` run the same code
from the command line. Pruning is the one irreversible step: a removed cache is
rebuilt only by an install, and that install needs the network.

## 8. Removing a build directory or a cache

The steps, in order.

1. Resolve the real path of the target, and refuse a path that is the allowed
   root or outside it. The allowed root is `<root>/worktrees/` for a build
   directory of a worktree, and `<root>/buildfs/` for a cache. One
   `btrfs subvolume delete` removes a whole tree in one call, so one wrong path
   takes every cache with it.
2. Read `/proc/self/mountinfo` and find the mount that owns the path. When that
   record holds `user_subvol_rm_allowed`, in the per-mount options or in the
   superblock options, an unprivileged delete is allowed.
3. With the option, read the read-only flag with
   `btrfs property get <path> ro`. Clear it with
   `btrfs property set <path> ro false` when it is set, and run
   `btrfs subvolume delete <path>`.
4. Without the option, or after a permission error, empty the tree and remove the
   folder: clear the read-only flag when it is set, remove every child with
   `rm -rf`, and run `rmdir`. A user can remove an empty subvolume this way
   without root.
5. A subvolume that holds another subvolume fails with a "not empty" error.
   Nothing is removed then, and the answer names that error. A nested subvolume
   is a cache or a worktree of its own, and removing the parent takes it too.
6. A plain folder is refused while the method says `subvolume`, so a mistyped
   path into a worktree is not deleted as if it were a cache. In `copy` mode a
   plain folder is removed with `rm -rf`.

The answer names the method that ran: `subvolume-delete`, `rm-rmdir`, `rm` or
`none`.

## 9. Installations without the mount option, and without btrfs

`user_subvol_rm_allowed` is a mount option, and an installation can lack it. The
registry still removes a subvolume there: step 4 of section 8 empties the tree and
removes the folder, and that needs no root. `repos doctor` reports the missing
option as a warning and not as a failure, because the registry works without it.

On a file system that is not btrfs the registry stores build directories as plain
folders, and the same flow runs with copies. `cp -a --reflink=auto` fills a folder
from a cache, and `rm -rf` removes it. The listing reports `copy` for both the
method and the folder.

One effect belongs to btrfs alone. A backup tool leaves a subvolume out of the
backup by its inode number, 256, and a subvolume installation stores every cache
and every build directory that way. A plain folder carries no such marker, so a
`copy` installation puts those trees into the backup.

## 10. The protection hook

Every worktree of one repository shares its refs, its tags and its hooks. One
file guards them all: `hooks/reference-transaction` in the git directory of the
repository, written by `repos register` and given the execute bit. For a
repository registered where it lives, the file goes into the hooks folder that
`git rev-parse --git-path hooks` names.

The hook reads one config value, `pi-sec.registryRoot`, and it acts only when
that value names a registry root. It also reads `$GIT_DIR/gitdir`, a file that
exists only inside a linked worktree, and it acts only when that path sits under
`<registry root>/worktrees/`. A ref change that starts outside a registry worktree
is not looked at, so the workspace tree, the execution tree and every other
folder of this install stay as they are. A repository that no registry owns is
untouched, also when the file is there by mistake.

The hook refuses these changes inside a registry worktree:

- a movement of `main` or of `snapshot`, by any command.
- a check out of `main` or of `snapshot`.
- a deletion of a branch.
- a deletion of a tag.
- a movement of a branch other than the worktree's own branch.
- a movement of a tag that already exists.

A rebase detaches HEAD before it moves the branch, so a plain reading of HEAD
names no branch while a rebase runs. The hook then reads the branch from
`rebase-merge/head-name` or `rebase-apply/head-name`, which git writes for the
length of the rebase. A rebase of the worktree's own branch is allowed with that
reading, also when it makes the commits again.

git reports an all-zero old value in two cases: when it creates a ref, and when a
command names no old value for an update. The hook asks git whether the ref is
there. A ref that is there is moved, so the line follows the rule for a branch or
a tag above. Only an absent ref counts as a new branch or a new tag.

The hook allows these changes inside a registry worktree:

- a commit, an amend, a reset, a stash, a merge and a rebase on the worktree's own
  branch. This covers a rebase that makes the commits again, `git rebase
  --continue`, `git rebase --abort` and an interactive rebase.
- a new branch and a new tag.
- a remote-tracking ref that `git fetch` creates or deletes.
- `git worktree add`.

Two git commands reach every worktree of one repository and have no hook that can
stop them: `git gc` and `git worktree prune`. A ref change outside a worktree is
not looked at either. So the rules that only an orchestrator and the update
script move `main`, and that an agent runs neither command, live in the role
files and not in the hook.

`repos register` refuses to replace a `reference-transaction` file that holds
other text, because another tool's hook is not the registry's to replace. It
reads and writes no other hook file.

`repos doctor` tests four things for each repository: the file is there, git can
execute it, the file holds the registry's text, and `pi-sec.registryRoot` names
this root. It also reports the storage method. While the method says `subvolume`,
it tests that each cache and each build directory of a worktree the registry made
is a subvolume. A worktree an operator made elsewhere holds the folder that their
own build tool installed, and the doctor leaves that folder alone. On btrfs it
reports a missing mount option as a warning.

## 11. Things to watch

- A build tool that deletes its own build directory, such as `cargo clean` or
  `rm -rf node_modules`, turns a subvolume into a plain folder when it makes the
  folder again. A backup then copies that folder. `repos list`
  shows the method of each build directory, and `repos doctor` reports a plain
  folder where the method says `subvolume`. `repos worktree refill` removes the
  folder and fills it from a cache.
- A hard link cannot cross a build directory boundary. The boundary is a
  subvolume, and the kernel treats a subvolume as another device. `ln` fails with
  an invalid cross-device link, and a rename across the boundary fails. A tool
  such as `mv` copies the file instead.
- `find -xdev` and `du -x` do not enter a subvolume, so they report less than the
  folder holds. The listing does not use them.
- A worktree that holds a modified or an untracked file stops
  `repos worktree remove`. Commit the change or discard it first.

## 12. Restoring from a backup

A backup that leaves subvolumes out by inode number holds the bare repositories,
the records, the worktrees and their tracked files, and the meta files. It does
not hold the caches, and it does not hold the build directories of the
worktrees.

After a restore, do two things.

1. Run `repos worktree refill <repo> <name>` for each worktree, which fills its
   build directory again.
2. Run `repos cache refresh`, which turns the newest install into a cache again.

Both steps need the packages of the lockfile: a refill with no cache runs the
install command, and that command reaches the network.

A narrower path does the same. Deleting the registry folder removes every
registration record and every cache. Each repository is then registered again
with `repos register` or `repos register --in-place`, and each worktree is cut
again with `repos worktree add`.
