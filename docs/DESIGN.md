# copse — design

*2026-08-06*

## What this is

A toolkit for running several coding-agent sessions against one repository at
the same time without them colliding. Each session gets its own git worktree,
its own branch, and its own pull request; the toolkit supplies the lifecycle
commands, the guards that keep the discipline true, and the CI/ruleset wiring
that catches whatever the local guards cannot.

It is extracted from GoThinking, where every piece below was learned by losing
time to its absence. GoThinking becomes copse's first consumer, not its host.

## The picture it serves

One person, several agent sessions — Claude Code, Codex, or a mix — each in its
own terminal, each in its own worktree, each on its own branch. The person is
not dispatching or scheduling; they open sessions and read pull requests. Most
of the work is the agents'. The person intervenes for judgement calls and for
end-to-end verification.

This is deliberately **not** an agent fleet with a scheduler. No orchestration
layer is designed for, because none is used.

## What is in scope, and what is not

copse ships three layers:

- **Executable** — the CLI: worktree lifecycle, merge entry, state, verify,
  doctor, ruleset setup.
- **Configuration** — what it writes into a consuming repo: git hooks, a CI
  workflow, an agent instruction file, an optional Claude Code hook block.
- **Nothing else.** The *discipline* layer — the prose that explains why a
  report of a manual check is not evidence, why a gate must be shown to
  refuse, why a generated file can decide what a check sees — does not travel.
  Each project writes its own. Where a rule is mechanically enforceable it
  arrives as a guard rather than as a paragraph, and that part does travel.

Explicitly out of scope:

| | why |
| --- | --- |
| Launching app surfaces for manual review | Deeply stack-specific. Every project defines its own. |
| Seeding, migrations, emulators | Belong to whatever the project is built on. |
| A scheduler or agent fleet | Not the picture being served. No abstraction is paid for a hypothetical second shape. |

## Distribution

An npm package with one bin, published scoped (`@<scope>/copse`) so the typed
command is `copse` regardless of what the unscoped registry name holds.

Chosen over copy-in templating and over a machine-level binary for one reason:
**the update path**. An improvement found in the third project has to reach the
first two, or the toolkit's value decays with each project instead of
compounding. A template fork breaks that link at install; a machine-level
binary has nowhere to put two projects that need different versions.

Node is required on the machine. For a non-Node project that is the only cost —
`npx copse` needs no dependency entry.

### The governing constraint: delegate, never generate

Everything copse writes into a consuming repo is a one-line forward:

```
.githooks/pre-commit          exec npx copse hook pre-commit "$@"
.githooks/pre-push            exec npx copse hook pre-push "$@"
.github/workflows/ci.yml      <toolchain preamble> + npx copse verify
.claude/settings.json         npx copse hook claude-<event>
```

This is the answer to the problem every tool of this kind eventually has: the
files it writes are files the consumer also edits, so an upgrade becomes a
three-way merge. Tools that generate real content end up either clobbering or
maintaining managed-block markers, and markers rot the first time someone edits
inside them. If the generated content is a forward, upstream changes live in
the package and the written files stay untouched for years — the upgrade
degrades to a version bump.

Accepting copse means accepting this constraint on its own design.

## The three enforcement layers

Agents may be Claude Code or Codex or both, so `.claude/settings.json` hooks
cannot be the enforcement layer — they reach only Claude Code sessions. The
layers that reach everything are git hooks (any agent that commits or pushes
goes through git) and CI plus the GitHub ruleset (which reaches hand edits
too). The Claude Code hook falls back to the role it is actually good at: the
fast half, asking before the action rather than after.

| what it catches | git hook | agent hook | CI / ruleset |
| --- | --- | --- | --- |
| committing straight to the base branch | primary | earlier | backstop |
| a branch name that does not fit | primary | earlier | — |
| merging with commits still unpushed | out of reach | Claude only | invisible to it |
| a check quietly deleted | — | — | visible as a config diff |
| force-push, bypassing a PR | — | — | ruleset |

### The one gap, named rather than papered over

**`gh pr merge` does not go through git.** It is an API call; no local hook
fires. The guard that has caught a real incident — a pull request merged while
its branch still had an unpushed commit, leaving the base branch looking
finished with half the work missing — therefore has no mechanism that reaches a
Codex session. CI cannot see it either: CI checks what the pull request
contains, not what is still sitting unpushed on a laptop.

copse's answer is `copse land`: not an interception, but a better entry point
that projects name in their instruction file. It is a convention, not a
guarantee, and that is stated rather than hidden. A PATH shim over `gh` was
considered and declined — it is a machine-level side effect, and it is still
escapable by an absolute path, so it pays a full price for a partial gate.

The convention buys something beyond the check: the whole closing sequence
(merge → offer to remove the worktree → return to the base branch) becomes one
command that behaves identically for every agent, instead of a Claude-only
`PostToolUse` hook.

## Command surface

```
copse init      reconcile an existing repo against copse's wiring
copse doctor    is this still wired up
copse new       create a worktree, branch, and carry the ignored files
copse list      every worktree, whether its name still fits, its PR, its ports
copse drop      remove a worktree, refusing while anything would be lost
copse land      unpushed → CI green → merge → offer cleanup
copse verify    run the project's declared checks; same path locally and in CI
copse protect   create the branch ruleset via the GitHub API
copse hook      internal: the target of every generated forward
```

## Core mechanisms

### The directory name is derived, never chosen

`feat/x` lives in `<repo>-feat-x`. The slug and branch functions invert each
other, and the round trip is the tested invariant. The prefix is kept rather
than stripped — it reads worse, and it is the reason the mapping is a
bijection: `feat/foo` and `fix/foo` would otherwise want the same directory.

Branch names are `<prefix>/<lower-kebab>` with exactly one slash. The prefix
set is project-declared, defaulting to `feat fix docs chore`.

### Flat siblings

`<repo>` and `<repo>-feat-x` sit at the same depth. This is a constraint rather
than a taste: inconsistent depth makes any relative path reference resolve
differently from different worktrees — a failure that shows up in *some*
worktrees and not others, which is a hard shape to recognise.

### The main worktree does no feature work

It owns `.git`, which makes it the one directory that cannot be moved aside
cheaply, so it is the worst place to put a branch. It is the integration view:
fetch there, cut branches there, read the base branch's state there.

### Carrying the ignored files is why `drop` exists

Gitignored files — env files, local credentials — are exactly what
`git worktree add` cannot carry, so a hand-made worktree builds and then fails
on a missing variable, which reads as a code problem. `new` copies them from
the main worktree. `drop` rescues any file this worktree holds the only copy of
before removing anything; in GoThinking one env file was genuinely in that
position, present in one worktree and nowhere else, one `git worktree remove`
from gone.

The list is `config.carryFiles`, with `config.carryDirs` beside it for the
directory case (`supabase/.temp` and its like), kept separate because copying a
tree and copying a file fail differently and a single list would have to guess
which was meant. `doctor` checks that every declared path exists in the main
worktree, so a stale declaration is reported rather than discovered at the
moment it matters. A declared path that is a symlink is refused rather than
followed: copse would otherwise copy through it into somewhere the config never
named.

### `copse land` checks, ordered by how hard the mistake is to notice

1. **Unpushed commits** — refuse. This is the one that caused a real incident.
2. **CI not green** — refuse. The ruleset also blocks this, but a local refusal
   is faster and explains itself.
3. **Working tree dirty** — refuse.
4. After merging, **offer** to remove the worktree. Never do it silently: that
   directory may hold another session.

### One worktree per pull request, not per task

A follow-up to an open pull request is a commit on that branch, pushed. The
test is not "is this new work" but "is this a separate thing to review".

This cannot be enforced in code, so `copse list` shows each worktree's pull
request and makes the drift visible instead. A cross-cutting rule needs a
component and a guard, not a paragraph.

### Ports are diagnosed, never allocated

`copse list` answers "which worktree owns the process on this port", by reading
the listening socket's pid and its working directory. It starts nothing and
binds nothing. Whether a project pins a dev-server port is the project's
business; copse only makes "is that server mine?" a question with an answer.

## Configuration

One file, `copse.config.json`, declaring facts rather than behaviour. What the
CLI accepts today:

```json
{
  "baseBranch": "devel",
  "branchPrefixes": ["feat", "fix", "docs", "chore"],
  "carryFiles": [".env.test", "apps/mobile/.env"],
  "carryDirs": ["supabase/.temp"],
  "install": ["pnpm", "install"]
}
```

Every key has a default, so a repository with no config file still works. An
unknown key is an error rather than a shrug — a silently ignored typo looks
exactly like a setting that does not work. `install` is an array rather than a
string so the command is never handed to a shell, where an element could be
read as an operator.

Two further keys are designed but not yet parsed, and are named here so the
sections that depend on them read straight:

- `releaseBranch` — the other half of a `devel`/`main` split. Only `land` and
  `protect` need it, and neither exists yet.
- `verify` — the project's declared check list, as argued below.

They are absent from the parser deliberately, not by oversight: accepting a key
the CLI does nothing with is worse than rejecting it, because the config would
then claim a guarantee nothing enforces.

### Why `verify` lives here and not in the workflow

GoThinking needed a test guarding its CI workflow because the first version of
its guards passed while the workflow's typecheck and test steps had been
deleted. The root cause was that the check list lived in YAML and nothing
watched the YAML.

Moving the list into config removes the failure rather than guarding it:
deleting a check is now a conspicuous line in a pull request diff. `copse
verify` runs the same list locally and in CI, which also closes the gap where
CI is green over something never run locally. Each command is wrapped in a
`::group::` so the GitHub UI still shows which one failed.

The generated workflow is **not** a single step. It carries a toolchain
preamble — checkout, language and package-manager setup — that is genuinely
stack-specific and cannot be forwarded away. That is acceptable because the two
kinds of drift are not alike: **a broken preamble fails loudly** (nothing runs
at all), while **a deleted check fails silently** (everything green, nothing
examined). The silent half goes into config; the loud half stays in YAML.

A project needing a build matrix should write its own workflow and skip this
part. copse does not pretend to cover every CI shape.

## `doctor`, and why no downstream test is needed

`copse verify` runs `doctor` first. That single ordering makes every way the
wiring can go missing fail loudly:

- the package uninstalled → `npx copse verify` fails in CI
- `.githooks/` deleted, or `core.hooksPath` unset → doctor refuses at step zero
- the verify step removed from the workflow → the ruleset's required `ci` check
  goes missing and the pull request sits blocked-pending

That last one matters more than it looks. A workflow file that fails to parse
produces **no check at all**, and the pull request appears green; the required-
check rule is what converts that into a block. The ruleset is half the design,
not a hardening pass on top of it.

Git will not let a fresh clone execute code, so `core.hooksPath` must be set
once per clone. That step cannot be removed. Putting the hooks in a committed
`.githooks/` rather than `.git/hooks` at least makes them versioned,
reviewable, and shared across worktrees.

## `init` is reconciliation, not generation

The hard case is an existing repository, not a greenfield one — copse's first
user already has an equivalent of everything it ships. So `init` defaults to
reporting: this file is absent, this file exists with different content, this
config value cannot be inferred and needs you. `--apply` writes, item by item,
with confirmation. It never clobbers.

## Testing

Two layers, because the bugs live in different places.

**Upstream unit tests** cover the pure logic: the slug/branch round trip, and
the shell parsing behind the merge guard — which must include the three
bypasses that are the entire reason that guard exists (`sudo`, a leading
environment assignment, an absolute path to the binary). `land`'s precondition
logic is tested; the API call it eventually makes is not.

**Integration tests against a real temporary git repository** run
`init → new → commit → drop` and assert that ignored files were actually
carried and that `drop` actually refuses when it holds the only copy of one.
Nearly every bug in a tool of this kind lives in the interaction with real git,
where unit tests cannot see it.

**Acceptance is not a green suite.** It is GoThinking running on copse with
behaviour unchanged: 537 lines of worktree code deleted in favour of the
dependency, `pnpm wt` reduced to a thin alias, and one real branch → pull
request → land cycle completed.

## Deferred

- **A known-issues guard** — "a new defect is a GitHub issue, not an entry in
  the instruction file". Mechanically enforceable and project-independent, and
  it defends against a disease every agent-driven project gets: an instruction
  file that grows without bound while every session reads it in full. It is
  held back only because it sits on the discipline side of a boundary already
  drawn, and v1 should not relitigate that boundary.
- **Non-Node projects.** The design avoids assuming a package manager, but only
  one stack has been exercised. The second real project decides whether the
  abstraction holds.

## Bootstrapping note

copse cannot dogfood its own conventions before it exists. This document is the
first commit on `main`. The `devel`/`main` split, the hooks, and the ruleset
are applied to copse itself once the CLI can apply them.
