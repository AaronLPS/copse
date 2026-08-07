# Command reference

```
copse new <prefix>/<lower-kebab>   create a worktree, branch, and carry the ignored files
copse list                         every worktree, and whether its directory name still fits
copse drop <branch>                remove a worktree, refusing while anything would be lost
copse doctor                       is the carried-file declaration and every worktree name still true
```

Run `copse` or `copse --help` for a similar summary, in its own words. There is
no `init`, `land`, `verify`, `protect`, or `hook` yet — those are designed in
[`DESIGN.md`](DESIGN.md) but not implemented, and running one just prints the
usage text.

Branch names and the directories derived from them are specified in
[`configuration.md`](configuration.md#branch-names-and-directory-names).

## `copse new`

```
copse new feat/inbox-filter
```

Validates the branch name against the shape in
[`configuration.md`](configuration.md#branch-names-and-directory-names), then:

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
way — `new` refuses to copy it rather than following it (see
[`SECURITY.md`](../SECURITY.md)), and lists every such refusal together rather
than stopping at the first. The worktree it already created is left in place,
half set up, with the fix pointed at: adjust the offending path, then either
re-run or remove it with `copse drop <branch>`.

## `copse list`

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

✓ every directory name matches its branch
```

(Actual output, from a repository with no `gh` reachable in the test
environment.)

## `copse drop`

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

## `copse doctor`

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

## Debugging copse itself

Every user-facing failure normally prints a one-line refusal and exits 1.
Set `COPSE_DEBUG=1` to get the raw exception and stack trace instead — for
debugging copse's own code, not for everyday use. (`COPSE_DEBUG=0`, an
unset `COPSE_DEBUG`, and an empty `COPSE_DEBUG=` all mean off; any other
value turns it on.)
