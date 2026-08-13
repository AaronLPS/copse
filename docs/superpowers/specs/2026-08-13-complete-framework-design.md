# copse complete parallel-work framework design

Date: 2026-08-13

## Purpose

Turn copse from a safe worktree directory manager into an installable framework
that lets a developer start several Claude Code, Codex, or shell-driven feature
sessions in parallel, keeps each session on a legal isolated branch, exposes
ownership and dependencies, runs the same checks locally and in CI, and closes
the branch-to-merge-to-cleanup lifecycle safely.

The framework coordinates deterministic mechanics. It does not schedule LLMs,
decide product priorities, or automatically resolve semantic merge conflicts.

## Product contract

The complete command surface is:

```text
copse init [--apply] [--ci npm|pnpm|yarn|custom]
copse new <branch>
copse start <branch> [--agent codex|claude] [-- <command...>]
copse list [--json]
copse claim <branch> [--owner <name>] [--depends-on <branch>...]
copse release <branch>
copse drop <branch>
copse land [branch] [--yes] [--no-cleanup]
copse verify
copse doctor
copse protect [--apply]
copse hook <event>
```

Read-only commands report every finding in one run. Mutating commands refuse
when they cannot prove the operation is safe. No command silently overwrites a
consumer-owned file.

## Configuration

`copse.config.json` remains the single project declaration. Existing keys keep
their meaning. The schema adds:

```json
{
  "releaseBranch": null,
  "verify": [["npm", "test"]],
  "agents": {
    "codex": ["codex"],
    "claude": ["claude"]
  },
  "coordinationFile": ".copse/features.json"
}
```

- `releaseBranch` is optional. When null, pull requests target `baseBranch`.
- `verify` is an array of argv arrays and is never passed through a shell.
- `agents` maps supported launcher names to argv arrays. The defaults require
  only the corresponding executable on `PATH`.
- `coordinationFile` must be a repository-relative JSON path that cannot escape
  the repository.

Unknown keys, empty commands, overlapping carried paths, unsafe relative paths,
and illegal agent names are rejected together.

## Repository onboarding

`copse init` is a reconciler:

- Without `--apply`, it reports missing, matching, and conflicting wiring.
- With `--apply`, it creates only absent files, updates files that are exact
  older copse forwards, sets local `core.hooksPath`, and refuses consumer-owned
  conflicts.
- It creates a minimal default config only when no config exists.
- It installs `.githooks/pre-commit` and `.githooks/pre-push` as one-line
  forwards to `copse hook`.
- It creates `.codex/hooks.json` with a `SessionStart` and `PreToolUse` forward.
- It creates or merges `.claude/settings.json` with matching `SessionStart` and
  `PreToolUse` command hooks. Unrelated settings and hooks are preserved.
- It creates `AGENTS.md` and `CLAUDE.md` only when absent. If either exists and
  lacks the copse contract, init reports a manual-integration finding instead
  of inserting a managed block.
- It creates a simple GitHub Actions workflow only when one can be inferred
  safely. Existing workflows are never rewritten.

Codex reads repository `AGENTS.md` from the Git root toward the current working
directory and supports repository-local `.codex/hooks.json`. Claude Code reads
repository `CLAUDE.md` and `.claude/settings.json`. Both products therefore get
the same deterministic guard while retaining their native instruction model.

## Hooks and enforcement

The CLI owns all hook logic; generated files only forward JSON/stdin and exit
status to the installed package.

- Git `pre-commit` refuses commits on `baseBranch` or `releaseBranch` and
  refuses illegal feature branch names.
- Git `pre-push` parses every ref update from stdin, refuses protected-branch
  pushes, and refuses illegal local branch names.
- Agent `SessionStart` reports concise additional context describing the
  current worktree, branch, ownership, dependencies, and any violation.
- Agent `PreToolUse` blocks mutating shell/Git operations when the session is in
  the main worktree on a protected branch and points the agent to `copse start`.
- Git hooks and CI remain the enforcement boundary. Agent hooks are earlier,
  more helpful feedback, not the only protection.

Hook adapters accept the common JSON input used by current Codex and Claude
Code command hooks. They produce the event-specific JSON output understood by
both tools, with exit status as a conservative fallback.

## Agent-aware worktree start

`copse start` resolves the deterministic target. If absent, it invokes the same
provisioning path as `new`. It then spawns the selected agent command with
inherited stdio and the target worktree as `cwd`. `-- <command...>` launches an
arbitrary command and takes precedence over `--agent`.

The launcher never uses a shell. It returns the child exit code and prints the
resolved path before launch. A missing executable or failed provisioning leaves
an actionable error.

## Lightweight coordination

Live coordination state is stored under Git's common directory
(`.git/copse/features.json`), which is shared immediately by every worktree and
does not dirty the main worktree. A committed `.copse/features.json` documents
and seeds the stable format:

```json
{
  "version": 1,
  "features": {
    "feat/inbox": {
      "owner": "alice",
      "dependsOn": ["feat/api"],
      "status": "active"
    }
  }
}
```

`claim` creates or updates one feature after validating its branch and
dependencies, refusing self-dependencies and dependency cycles. A branch
already actively owned by another owner is not stolen without `release`.
`release` marks the feature released rather than deleting history. `list`
shows ownership, dependencies, blocked state, worktree, and PR information;
`--json` exposes a stable machine-readable snapshot.

This provides live coordination and merge-order visibility without becoming a
scheduler or writing volatile session IDs into Git.

## Verification and CI

`copse verify` runs `doctor` first, then every configured argv command in order
with inherited stdio. It stops on the first failed check and returns that
failure. An empty check list is a configuration finding, not a silently green
verification.

The repository's own CI is expanded to:

- run the test suite on the supported Node matrix;
- run syntax checks over every source and test module;
- run package packing/install smoke tests;
- execute an end-to-end consumer lifecycle in a temporary real Git repository;
- set explicit least-privilege permissions and concurrency cancellation;
- keep network-dependent GitHub protection tests behind injected adapters.

Generated consumer CI invokes the configured `runner` argv followed by
`verify`; the default is `npx --yes copse verify`.

## Land and repository protection

`copse land` operates on a non-main worktree and refuses, in this order:

1. illegal or protected branch;
2. dirty or unknown working-tree state;
3. commits not pushed to the upstream;
4. missing pull request;
5. non-green required checks;
6. unresolved coordination dependencies.

It invokes `gh pr merge --delete-branch` only after all preconditions pass.
After a successful merge it optionally removes the worktree through the same
safe removal path. `--yes` is required for non-interactive merge and cleanup;
without it, the command prints the exact actions and refuses to mutate.

`copse protect` computes a GitHub ruleset for `baseBranch` and optional
`releaseBranch`: require pull requests, require the configured CI check, block
force pushes and deletion, and restrict direct updates. Without `--apply` it
prints the intended JSON. With `--apply` it uses `gh api`, refusing when the
repository or authentication cannot be determined. API access is injected in
tests.

## Error handling and safety

- Shell interpolation is never used for configured or agent commands.
- Writes are atomic through a same-directory temporary file plus rename.
- JSON state includes a version and rejects unknown future versions.
- Init and protect have dry-run/reporting defaults.
- Filesystem paths are containment-checked before reads, writes, or copies.
- External command failure retains the command, exit status, and stderr.
- Worktree creation is rolled back when carry or install provisioning fails and
  the worktree is still clean; otherwise the partial worktree is retained with
  explicit recovery instructions.

## Testing and acceptance

Every new decision begins as a pure function test. Every command receives
filesystem, Git, process, or GitHub adapters where nondeterminism matters. Real
Git integration tests cover init, hooks, start, claim/release, verify, land
preconditions, drop, and generated wiring. Tests for external merge/protection
assert the exact argv and API payload rather than contacting GitHub.

Acceptance requires:

1. `npm test` and syntax checks pass.
2. `npm pack` contains only the intended runtime and documentation files.
3. A temporary consumer repository completes `init --apply`, `doctor`, two
   parallel claims/worktrees, hook refusals, verify, simulated land, and drop.
4. copse's own repository contains valid copse configuration and wiring.
5. README and command/configuration references describe only shipped behavior.
