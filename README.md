# copse

Many agent sessions, one repository, no collisions.

One person, several coding-agent sessions — Claude Code, Codex, or a mix —
each in its own terminal, each working on its own thing, against the same
checkout. Left alone, they collide: two sessions editing the same working
tree stomp each other's uncommitted changes, and a hand-made `git worktree
add` builds and then fails at runtime on a missing `.env`, because
`git worktree add` cannot carry a gitignored file and the failure looks like
a code problem instead of a missing setup step.

copse gives each session its own git worktree, named after its branch, with
the gitignored files a plain `git worktree add` would silently drop copied
over. It does not schedule agents, does not decide what they work on, and
does not merge anything on their behalf — it manages the directories.

This is the first slice of a larger design (see `docs/DESIGN.md`); what
follows describes only what is actually implemented and tested today.

## Install and run

copse is a zero-dependency `npx` target: `package.json` declares
`bin: { copse: "./src/cli.mjs" }` and no `dependencies`, so running it never
pulls in a tree of packages. It requires Node ≥20 (`node:test`, used by the
test suite, is stable from 20; the CLI itself uses nothing newer).

The package has not been published yet — see "Decisions left to the owner"
in the commit that added this file. Until it is, run it from a checkout:

```
node /path/to/copse/src/cli.mjs <command>
```

or put it on `PATH` for the length of a session with `npm link` from the
copse checkout. Once published under a real name, the same commands run as
`npx <package-name> <command>`.

## Command surface

```
copse new <prefix>/<lower-kebab>   create a worktree, branch, and carry the ignored files
copse list                         every worktree, and whether its directory name still fits
copse drop <branch>                remove a worktree, refusing while anything would be lost
copse doctor                       is the carried-file declaration and every worktree name still true
```

Run `copse` or `copse --help` for the same summary. There is no `init`,
`land`, `verify`, `protect`, or `hook` yet — see "Not built yet" below.

### `copse new`

```
copse new feat/inbox-filter
```

Validates the branch name against the shape below, then:

1. Refuses if the main worktree is a bare repository (deriving a sensible
   directory name for that case is unimplemented, so it refuses cleanly
   rather than producing a worktree named after the bare directory).
2. Refuses if the target directory already exists, or if the branch is
   already checked out somewhere else.
3. Fetches `origin`, then runs
   `git worktree add <target> -b <branch> origin/<baseBranch>`.
4. Copies every path in `carryFiles` and `carryDirs` from the main worktree
   into the new one, skipping (not failing on) any that are simply absent.
5. If `install` is configured, runs it in the new worktree with inherited
   stdio.

A real run looks like this (verified against a throwaway repository):

```
→ fetching, so origin/main is current
→ /home/me/ws/proj-feat-inbox-filter  (feat/inbox-filter from origin/main)
→ copying the files git will not carry
   ✓ .env.test

✓ /home/me/ws/proj-feat-inbox-filter
  cd /home/me/ws/proj-feat-inbox-filter
```

If a carried path turns out to be a symlink — or passes through one on the
way — `new` refuses to copy it rather than following it (see the security
note below), and lists every such refusal together rather than stopping at
the first. The worktree it already created is left in place, half set up,
with the fix pointed at: adjust the offending path, then either re-run or
remove it with `copse drop <branch>`.

### `copse list`

Prints every worktree of the repository, its branch, and:

- `⚠ ...` when the directory name no longer matches its branch (drift) — the
  main worktree checked out on the wrong branch, a feature worktree in the
  wrong directory, or a branch with a prefix `branchPrefixes` no longer
  declares;
- uncommitted-changes and unpushed-commit flags per worktree;
- the pull request state for that branch: `no PR`, `PR #7 open`, `PR #7
  closed`, `PR #12 merged — droppable`, or `PR state unknown` when `gh` is
  missing, unauthenticated, offline, or simply timed out (capped at 3
  seconds per worktree so one unreachable network does not hang the
  command that exists to tell you where you are). "Unknown" is never
  printed as "no PR" — those are different observations.

A bare main repository (no working tree to be dirty, no branch to ask `gh`
about) is labelled `(bare)` and is not asked those questions at all, rather
than reporting them as failed.

```
  proj                                   main                               main worktree, pinned to main
                                         PR state unknown
  proj-feat-inbox-filter                 feat/inbox-filter
                                         PR state unknown
```

(Actual output, from a repository with no `gh` reachable in the test
environment.)

### `copse drop`

```
copse drop feat/inbox-filter
copse drop feat-inbox-filter   # the directory slug works too
```

**The refusals are the point of this command.** `drop` will not remove a
worktree while there is anything to lose:

- it is the main worktree (it owns `.git` and cannot be removed);
- you are currently inside it;
- it has unpushed commits — including when it has no upstream at all, in
  which case every commit on it counts as unpushed rather than zero;
- its working tree is dirty, or its status could not even be determined
  (`git status` itself failing is treated as "unknown," which blocks
  removal — it is never silently read as clean).

Every applicable reason is reported at once:

```
✗ not removing /home/me/ws/proj-feat-inbox-filter:
  · 1 unpushed commit(s) — push them, or drop the branch deliberately with git branch -D
```

Once none of that applies, `drop` rescues carried files or directories that
this worktree holds the only copy of — the entire reason the command
exists. `git worktree add` cannot carry gitignored files, so `copse new`
copies them in; if a worktree is the only place a carried file still has
real content (this happened for real, once, with an env file that existed
in one worktree and nowhere else), a bare `git worktree remove` would
delete the only copy with no warning. `drop` compares what the worktree
holds against what the main worktree holds, copies over whatever the
worktree alone has, and only then removes the directory:

```
→ removing /home/me/ws/proj-feat-inbox-filter

✓ removed. The branch feat/inbox-filter still exists — delete it with:
  git branch -d feat/inbox-filter
```

The branch itself is left behind deliberately — removing the worktree is
not the same decision as discarding the branch, and the message says how to
do the second thing explicitly.

If a carried path is (or passes through) a symlink on either side, `drop`
refuses to inspect it rather than silently reading through it or writing
through it — but only when that path actually participates in the rescue.
A symlink that neither side would ever touch during this particular removal
does not block `drop`; otherwise `new` refusing to copy through a
repo-side symlink and `drop` refusing to remove because of that same
symlink would deadlock a repository that legitimately symlinks a carried
path (an `.env` into a shared secrets directory, for instance).

### `copse doctor`

Checks that:

- every path in `carryFiles`/`carryDirs` still exists in the main worktree
  (a stale declaration is reported now, not discovered inside a new
  worktree at the moment it matters), and is not itself a symlink;
- no worktree has drifted, using the same check `list` uses.

```
✓ copse: nothing to report
```

Exits 0 when there is nothing to report, 1 otherwise — this is the one
command whose exit code is meant to be scripted against.

## `copse.config.json`

One optional file at the repository root. Every key has a default, so a
repository with no config file works with `baseBranch: "main"` and no
carried paths.

| key | default | validation |
| --- | --- | --- |
| `baseBranch` | `"main"` | non-empty string |
| `branchPrefixes` | `["feat", "fix", "docs", "chore"]` | non-empty array; each entry lower-case letters/digits starting with a letter; **no hyphens** |
| `carryFiles` | `[]` | array of repo-relative paths |
| `carryDirs` | `[]` | array of repo-relative paths; may not overlap `carryFiles` |
| `install` | `null` | `null`, or a non-empty array of non-empty strings |

An unknown top-level key is refused too — almost always a typo, and a typo
that is silently ignored looks exactly like a setting that doesn't work.
Every violation is collected and reported together, not just the first.

```json
{
  "baseBranch": "devel",
  "branchPrefixes": ["feat", "fix", "docs", "chore"],
  "carryFiles": [".env.test", "apps/mobile/.env"],
  "carryDirs": ["supabase/.temp"],
  "install": ["pnpm", "install"]
}
```

Two of these rules protect invariants that fail far from their cause if
ever violated, so both are checked at config load rather than left to be
discovered later:

- **A hyphen in a branch prefix is refused.** The slug that names a
  worktree's directory is built by replacing the branch's `/` with `-`
  (`feat/inbox-filter` → `feat-inbox-filter`); recovering the branch from
  that slug means splitting at the first `-`. A prefix containing a hyphen
  makes that split ambiguous, and the symptom is a worktree nobody can find
  by name.
- **A carried path is refused if it is absolute, contains a `..` segment,
  contains a backslash, or (checked at copy time, not config-parse time)
  resolves outside the repository through a symlink.** copse copies these
  paths into and out of worktree directories on your behalf; any of those
  four is a way to make that copy land somewhere other than where it looks
  like it lands. The backslash check exists because a `/`-only segment
  check can be walked around with a Windows-style separator on a platform
  that still honours it.

`install` is always an array, never a string — see the security note below
for why that particular detail matters.

## Branch names and directory names

A branch must be `<prefix>/<lower-kebab>`, with exactly one slash, where
`<prefix>` is one of `branchPrefixes`: for example `feat/inbox-filter`,
`fix/null-check`. Two slashes, upper case, underscores, and a doubled or
trailing hyphen are all refused.

The directory a worktree gets is derived from the branch, never chosen: the
`/` becomes a `-`, and the whole slug is appended as a suffix to the main
worktree's own directory, as a flat sibling of it — not nested inside it.

```
repository:  /home/me/ws/proj
branch:      feat/inbox-filter
worktree:    /home/me/ws/proj-feat-inbox-filter
```

The prefix is kept in the slug rather than stripped. Stripping it would read
better (`proj-inbox-filter`) but would break the round trip: `feat/foo` and
`fix/foo` would then want the same directory. Flat siblings, rather than a
nested container, exist because a worktree at a different depth resolves
any relative path reference differently than the main worktree does — a
failure that shows up in only *some* worktrees, which is a hard shape to
recognise.

## Security note

`install`, if configured, runs a binary — named by the first element of the
array — found via `copse.config.json`, a file inside the repository, with
inherited stdio and no confirmation prompt. That is the same trust boundary
`npm install`'s lifecycle scripts already sit on: if you would run `git
worktree add` and then whatever setup script a clone of this repository
tells you to run, `copse new` running the same command on your behalf adds
no new exposure. It is worth naming plainly rather than leaving implicit.

Two things narrow that boundary rather than widen it:

- `install` is always an array (`["pnpm", "install"]`), never a string.
  copse hands it to `execFileSync` element by element — nothing is ever
  passed through a shell, so nothing in it can be interpreted as a shell
  operator.
- copse refuses to follow a symlink on any carried path, on either the
  repository side or the worktree side, and refuses when an *intermediate*
  directory in that path resolves outside the tree it was aimed at through
  a symlink (even a dangling one). A carried path can therefore never write
  outside the worktree or repository directory it targets.

## Debugging copse itself

Every user-facing failure normally prints a one-line refusal and exits 1.
Set `COPSE_DEBUG=1` to get the raw exception and stack trace instead — for
debugging copse's own code, not for everyday use. (`COPSE_DEBUG=0`, an
unset `COPSE_DEBUG`, and an empty `COPSE_DEBUG=` all mean off; any other
value turns it on.)

## Not built yet

`docs/DESIGN.md` describes a larger toolkit than what exists today. These
pieces are designed but not implemented, and running the corresponding
command will just print the usage text, not do the thing:

- `copse init` — reconciling an existing repository against copse's wiring.
- `copse land` — the unpushed → CI green → merge → offer-cleanup sequence.
- `copse verify` — running a project's declared checks, the same way
  locally and in CI.
- `copse protect` — creating a GitHub branch ruleset via the API.
- `copse hook` — the internal target every generated git/CI/Claude-Code
  forward would call.
- Git hooks, a generated CI workflow, and a Claude Code settings block —
  none of these are written by copse yet.
- Port diagnosis in `copse list` ("which worktree owns the process on this
  port").

If you're looking for one of these and it isn't here, it's on the roadmap,
not a bug.

## Testing

```
npm test
```

runs `node --test test/*.mjs`: pure unit tests for config parsing, the
branch/slug/directory mapping, and the removal/drift/pull-request judgement
calls, plus an integration suite that runs the full lifecycle against a
real temporary git repository (copse's own bugs live in the interaction
with real git, not in isolated logic). 80 tests, all passing, as of this
writing.
