# Productize onboarding and agent acceptance

Date: 2026-08-13

Status: approved for planning.

## Goal

Make copse safe and convenient to install into both new and existing
repositories, including repositories that already use Git hooks, and prove the
parallel launcher with two independently running agent processes. This phase
productizes the framework that already exists; it does not add task scheduling
or semantic merge-conflict resolution.

## Scope

This phase delivers three connected outcomes:

1. A bootstrap contract that records the exact package source used by generated
   Git, Codex, Claude, and CI forwards.
2. Git-hook coexistence that preserves an existing `core.hooksPath` or default
   `.git/hooks` installation instead of replacing it.
3. Deterministic two-agent acceptance in CI plus an explicit opt-in harness for
   authenticated Codex and Claude Code sessions.

Publishing the npm package, changing npm ownership, and introducing a central
agent scheduler are outside this phase. The code must be ready for publication,
but publishing remains an explicit release action.

## Chosen approach

### Explicit, reproducible runner bootstrap

`copse init` gains `--runner-package <package-spec>`. The flag expands to the
argv array `['npx', '--yes', packageSpec]` and is applied before configuration
and wiring are reconciled. For the current GitHub distribution the complete
bootstrap is:

```sh
npx github:AaronLPS/copse init --apply \
  --runner-package github:AaronLPS/copse
```

After npm publication the same interface supports a pinned release:

```sh
npx copse@0.4.0 init --apply --runner-package copse@0.4.0
```

An explicit value is preferred to unreliable inference from npm's temporary
`_npx` path. When an existing parseable `copse.config.json` already declares
`runner`, the CLI flag authorizes one targeted update of that key while every
other JSON value is preserved. Report mode describes the pending
runner change; `--apply` writes it atomically before generating forwards.
Malformed or schema-invalid configuration is reported and left unchanged.
Without the flag, existing configuration and backwards-compatible defaults
continue to work.

Package specs are single non-empty arguments. They may be npm names, pinned npm
versions, GitHub shorthand, Git URLs, or local package paths accepted by npm;
they are never evaluated by a shell. Documentation recommends pinned npm
versions for releases and an explicit Git commit/tag for GitHub production use.

The bootstrap acceptance test installs the packed artifact in a temporary
consumer and asserts that every generated forward contains the chosen package
spec rather than the source checkout or bare `npx copse` default.

When the runner changes, init replaces only forwards that exactly match the
previous effective copse configuration. In Codex and Claude settings it removes
the exact old copse hook groups and adds the new groups while preserving every
consumer group. An exact previously generated CI workflow is updated in place;
a custom workflow is accepted only when its verify job contains the new exact
runner argv. Unknown or consumer-owned old-runner wiring is reported as a
conflict rather than leaving two copse hook groups active.

### Non-destructive Git-hook delegation

Copse-owned Git wrappers move to `.copse/hooks/pre-commit` and
`.copse/hooks/pre-push`. `init --apply` records the previously active hook path
in clone-local Git configuration under `copse.previousHooksPath`, then sets
`core.hooksPath` to `.copse/hooks`.

The previous path is determined as follows:

- An existing non-copse `core.hooksPath` is recorded verbatim.
- With no configured path, the sentinel `<default>` represents the repository's
  common `.git/hooks` directory.
- An existing `.copse/hooks` installation reuses the already recorded previous
  path and does not create a delegation cycle.
- A legacy `.githooks` installation whose files exactly match the v0.3 forwards
  generated from the pre-override configuration is migrated without delegating
  back to itself.
- A consumer-owned `.githooks` directory is treated like any other previous
  hook path and remains untouched.

Each wrapper runs the copse policy first. On success it resolves and invokes an
executable previous hook with the original arguments and propagates its exit
status. `pre-push` first captures stdin in a securely created temporary file so
both copse and the delegated hook receive the exact ref-update stream. Cleanup
uses a shell trap. Missing or non-executable previous hook files are a no-op;
an invalid path or delegation cycle is a `doctor` finding.

No existing hook file is edited or removed. The local previous-path setting is
not committed because different clones may use different hook managers. This
also means moving a checkout does not break a relative configured path or the
`<default>` sentinel. Absolute existing hook paths remain supported but are
reported by `doctor` when they no longer exist.

`doctor` verifies the copse wrapper files, executable bits, current
`core.hooksPath`, previous-path non-recursion, and the existence/executability
of delegated hooks when a corresponding previous hook file exists. CI sets
`core.hooksPath=.copse/hooks`; it has no previous local hook installation.

### Two-agent acceptance

Deterministic acceptance uses the packed artifact in a real temporary consumer.
Two executable fixture agents are launched concurrently through separate
commands named `codex` and `claude`. Each records its cwd, branch, arguments,
and lifetime while remaining alive long enough for the harness to inspect
coordination state. Acceptance proves:

- the agents run in two different deterministic sibling worktrees;
- both feature leases are simultaneously active;
- starting a second process for either feature is refused;
- both processes receive their configured argv without shell parsing;
- exiting releases only the matching lease;
- the main worktree remains clean and on the configured base branch.

The fixture executables validate copse's process and coordination behavior; they
do not claim to validate vendor authentication or model behavior.

An additional `npm run test:agents:live` harness is disabled unless
`COPSE_LIVE_AGENT_TEST=1`. It requires JSON argv arrays in
`COPSE_CODEX_COMMAND` and `COPSE_CLAUDE_COMMAND`, creates disposable feature
worktrees, starts both commands concurrently through the packed copse binary,
checks active leases and cwd markers, and removes the temporary repository.
This makes authenticated Codex/Claude acceptance possible without hard-coding
version-specific flags or silently spending user quota. The command refuses to
run when opt-in or either argv value is absent.

## Component boundaries

- `src/runner.mjs` validates package specs and derives runner argv. It has no
  filesystem or process side effects.
- `src/git-hooks.mjs` decides previous-path migration and renders wrappers. It
  keeps hook coexistence separate from generic repository wiring.
- `src/commands/init.mjs` orchestrates config reconciliation, generic wiring,
  local Git hook settings, and hook-wrapper installation.
- `src/commands/doctor.mjs` reports hook delegation and runner wiring drift.
- `src/wiring.mjs` continues to own Codex, Claude, instruction, coordination,
  and CI forwards, parameterized by the effective runner and hook directory.
- Package and live-agent smoke scripts exercise only installed CLI artifacts;
  they do not import production source modules.

## Configuration and compatibility

The committed configuration schema does not gain a clone-specific hook path.
`runner` remains the single persisted argv source of truth. Existing config
files and generated agent settings remain valid.

The migration recognizes exact legacy copse hook forwards before changing
`core.hooksPath`. Unknown `.githooks` content is never classified as copse-owned.
Repeated `init --apply` is idempotent and cannot replace a newer previous hook
path with `.copse/hooks`.

The project remains Node.js 20+, ESM, standard-library-only, and shell-free for
configured commands. Generated POSIX hook wrappers quote every fixed runner
argument and never interpolate package specs as shell source.

## Failure handling

- An empty or repeated incompatible `--runner-package` value fails before any
  file or Git configuration is changed.
- A conflicting wrapper file is reported and left intact. The explicit runner
  flag may update only the `runner` key in a valid committed config;
  `core.hooksPath` changes only after config and all required wrappers succeed.
- If recording the previous hook path or setting the new hook path fails, init
  returns non-zero with an exact recovery instruction.
- Wrapper failure blocks the Git operation. Copse policy failure takes priority;
  otherwise the delegated hook's status is preserved.
- Live acceptance always removes its temporary repository in `finally`, but it
  never kills or modifies Agent processes outside that disposable repository.

## Testing and acceptance

All behavioral changes follow red-green TDD. Required coverage includes:

1. Pure runner-package validation and CLI parsing.
2. New install, configured hooksPath, default `.git/hooks`, legacy copse
   `.githooks`, idempotent re-init, invalid/cyclic delegation, and pre-push stdin
   replay.
3. Existing Husky-style hooks still execute and preserve their exit status.
4. Packed consumer forwards use the selected GitHub/npm spec.
5. Two fixture agents run concurrently while duplicate entry is refused.
6. The live harness refuses absent opt-in/commands without starting an agent.
7. `copse verify`, coverage, syntax, and packed-package acceptance pass.

Manual release acceptance additionally runs the opt-in live harness with an
authenticated Codex command and an authenticated Claude Code command, then
reviews both vendors' project-hook trust prompts. This manual step is required
for a release claim that names live vendor integration, but not for ordinary CI.

## Success criteria

- A new consumer can install from GitHub or a pinned npm version in one init
  invocation and every generated forward keeps using that source.
- An existing repository's active Git hooks still run after copse onboarding,
  without modifying the original hook files.
- Two different agent processes demonstrably run in parallel worktrees while a
  duplicate session is blocked.
- No test or documentation claims authenticated vendor behavior unless the
  opt-in live acceptance has actually been run.
