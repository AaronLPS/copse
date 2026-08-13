# Command reference

## `copse init [--apply]`

Reconciles an existing or new Git repository with copse. Report mode is the
default and returns non-zero while wiring is missing or conflicting. `--apply`
creates missing config, Git hooks, Codex/Claude settings, instruction files,
coordination seed, and an inferable Node CI workflow. Existing agent settings
are merged; other conflicting files are named and left unchanged. It sets the
clone-local `core.hooksPath` to `.githooks`.

## `copse new <branch>`

Creates `<repo>-<prefix>-<slug>` from `origin/<baseBranch>`, carries declared
ignored files/directories, and runs `install` without a shell. It refuses name
collisions, already checked-out branches, unsafe symlinks, and bare main repos.

## `copse start <branch> [--agent <name>] [-- <command...>]`

Finds or creates the branch worktree, then launches the configured agent or
custom argv with inherited stdio in that directory. The child exit status is
the copse exit status. A command after `--` takes precedence over `--agent`.

## `copse claim` and `copse release`

```sh
copse claim feat/ui --owner alice --depends-on feat/api --depends-on feat/schema
copse release feat/api
```

Claims refuse active ownership theft, self-dependencies, invalid names, and
dependency cycles. Release retains history and unblocks dependants. Live state
is shared through `.git/copse/features.json`.

## `copse list [--json]`

Shows every worktree, branch/name drift, dirty and unpushed state, pull request,
owner, feature status, and unreleased dependencies. `--json` emits a versioned
machine-readable snapshot.

## `copse verify`

Runs `doctor`, then each configured `verify` argv in order from the current
worktree root. It stops at the first failure and preserves its status. An empty
verification list is an error rather than a green no-op.

## `copse land [branch] [--yes] [--no-cleanup]`

Requires a legal non-protected branch, known-clean worktree, no unpushed
commits, an open PR, green checks, and released dependencies. Without `--yes`
it reports readiness only. With `--yes` it merges through `gh`, marks the
feature released, and removes the worktree when invoked safely from another
worktree. From inside the target worktree it leaves cleanup to a subsequent
`copse drop`, because deleting the caller's current directory is unsafe.

## `copse drop <branch-or-slug>`

Refuses the main/current worktree, dirty or unknown state, and unpushed work.
It rescues carried paths held only by the target before removal and retains the
local branch for an explicit later deletion.

## `copse doctor`

Checks carried paths, worktree naming, every generated forward, agent settings,
CI wiring, and clone-local `core.hooksPath`. It reports all findings and exits
one when any exist.

## `copse protect [--apply]`

Prints the GitHub ruleset JSON by default. `--apply` resolves the repository
through authenticated `gh`, creates the named ruleset or updates the existing
one, requires PRs and the `verify` check, and blocks deletion and force pushes
for base/release branches.

## `copse hook <event>`

Internal target for `pre-commit`, `pre-push`, `agent-session-start`, and
`agent-pre-tool-use`. Git events use exit status; agent events consume and emit
the documented JSON hook protocol on stdin/stdout.

Set `COPSE_DEBUG=1` to expose raw exceptions while developing copse itself.
