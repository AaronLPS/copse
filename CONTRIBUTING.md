# Contributing to copse

## Running the suite

```
npm test
```

runs `node --test test/*.mjs`. Run that exact command, not `node --test
test/` — a bare directory argument has, in practice, not been reliable
across Node versions (a Node 22 regression once stopped expanding it to the
files inside), and the glob is what CI runs, so it is the only form that
matches what actually gets checked.

There is no build step and no lockfile: zero runtime dependencies means
`npm test` works straight after a clone.

## The architecture rule

`src/naming.mjs` and `src/decisions.mjs` are pure — they import nothing
from `node:fs` or `node:child_process`, and never will. Every judgement
call (is this branch name valid, does this worktree drift, is it safe to
remove) lives in one of those two files, as a function over plain
JavaScript values. Everything that actually touches git, the filesystem,
or `gh` lives in `src/git.mjs`, which only answers questions; it does not
decide anything.

This split is why the judgement calls are testable without a repository —
`test/naming.test.mjs` and `test/decisions.test.mjs` run in milliseconds,
against no filesystem. A change that moves a decision into `git.mjs`, or
that makes a "pure" module import `node:fs`, breaks the reason those tests
are fast and breaks the reason they can exist without a throwaway git repo.
Keep decisions in `naming.mjs`/`decisions.mjs` and adapters in `git.mjs`.

## Zero dependencies

`package.json` has no `dependencies`. This is a hard constraint, not a
preference: copse is meant to be run with `npx` by a project that has not
installed it, and every dependency added is a dependency that project now
resolves on every `copse new`. If a task seems to need a package, look
first for whether Node's standard library already does it — the codebase
leans on `node:fs`, `node:child_process`, and `node:path` throughout,
deliberately.

## Refusals name every reason at once

`copse drop`, `copse new`, and config validation all collect every
applicable reason before reporting, rather than stopping at the first
(see `removalBlockers` in `src/decisions.mjs`, or the carry-path refusal
list in `src/commands/new.mjs`). A caller who fixes one blocker and is
then told about the next learns to run the command repeatedly instead of
reading it. If you add a new refusal path, add it to the list that gets
collected — do not `throw` early out of a loop that is supposed to finish
collecting first.

## Unknown is not the same as none

An absence that was never actually measured is reported as unknown, not
as "none" or "clean". `git status` failing is `dirty: 'unknown'`, not
`dirty: false` — folding it into `false` would turn "could not ask" into
permission to delete a worktree. `gh` being unreachable is `pullRequestNote
=> 'PR state unknown'`, not `'no PR'`. If you add a new check that can
fail to answer, give it a third state rather than defaulting to the
"nothing found" case.

## Tests

The integration suite (`test/lifecycle.integration.test.mjs`) runs
against a real temporary git repository, built fresh per test run, with a
real bare repository standing in for `origin` so `origin/<base>` resolves
and pushes work without a network. Nearly every bug in a tool like this
lives in the interaction with real git, not in isolated logic — a mocked
git would only ever assert the mock.

A bug fix is expected to come with a test that fails without it. If you
are not sure whether your test actually covers the bug, disable your fix
and confirm the new test — and only the new test — fails; that is how the
existing coverage for this project's trickier refusal branches was
verified (see the commit history, e.g. `d1c765b`).

## Commit messages

Look at `git log` before writing one. This project's commit messages
explain what was wrong and why, not just what changed — a message like
"fix bug" is not the standard to match; a message that names the failure
mode a caller would have hit is.

## Pull requests

Keep `src/naming.mjs` and `src/decisions.mjs` pure, keep the suite green,
and describe what was broken before your change, the same way the commit
message does.
