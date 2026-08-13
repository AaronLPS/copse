# Security

## Supported versions

copse is pre-1.0 (currently `0.2.0`) and not yet published to npm. Only
the latest version is supported — there is no back-porting of fixes to
older tags.

## What copse does that carries risk

copse is a CLI that manages git worktrees on your own machine. Three
things it does are worth naming plainly rather than leaving implicit:

- **It spawns subprocesses.** `git`, `gh`, configured verification commands,
  and agent launchers are invoked directly with argv arrays and no shell.
- **It runs `install` from the repository's own config, with inherited
  stdio.** If `copse.config.json` sets `install`, `copse new` runs it —
  no confirmation prompt, output going straight to your terminal. This is
  the same trust boundary `npm install`'s lifecycle scripts already sit
  on: if you would run `git worktree add` and then whatever setup script a
  clone of this repository tells you to run, `copse new` running that
  command on your behalf adds no new exposure. It does mean that cloning
  and running `copse new` against a repository whose `copse.config.json`
  you have not read is exactly as trusting as cloning and running its
  setup script by hand.
- **It copies configured paths into and out of worktree directories.**
  `carryFiles`/`carryDirs` in `copse.config.json` name gitignored files
  (env files, local credentials) that `git worktree add` cannot carry;
  `copse new` copies them in, `copse drop` rescues them back out before
  removing a worktree that holds the only copy.
- **It installs repository-local Git and agent hooks.** `copse init --apply`
  writes small forwards whose executable comes from `runner`. Review that argv
  before applying wiring. Codex additionally requires explicit trust for new
  or changed non-managed project hooks.
- **It can call GitHub through authenticated `gh`.** `land --yes` merges a pull
  request; `protect --apply` creates or updates a repository ruleset. Both have
  read-only defaults and name their intended mutation before it is requested.

## What's already defended

- **`install` is always an array, never a string.** `copse.config.json`
  validation refuses a bare string. copse hands the array to
  `execFileSync` element by element (`src/commands/new.mjs`), so nothing
  in it is ever passed through a shell — there is no shell operator,
  `;`, or `$(...)` for a value in that array to be interpreted as.
- **A carried path is refused outright if it is absolute, contains a `..`
  segment, or contains a backslash** (`src/config.mjs`'s `pathProblem`,
  checked at config load). The backslash check exists because a
  forward-slash-only segment check can be walked around with a
  Windows-style separator on a platform that still honours it.
- **A carried path is refused if it is itself a symlink, on either side
  of the copy.** `carryPathState` (`src/git.mjs`) `lstat`s the path
  rather than `stat`ing it, so a symlink at the top level of a carried
  path — dangling or not — is refused rather than followed, whether it
  sits in the main worktree (the copy-in side, `copse new`) or was
  checked out on the branch itself and now sits in the new worktree.
  On the rescue side (`copse drop`), that same refusal only fires when
  the path actually participates in the rescue — a symlink neither side
  would touch during that particular removal does not block `drop`
  (`src/commands/drop.mjs`); otherwise `new` refusing to copy through a
  repo-side symlink and `drop` refusing to remove because of that same
  symlink would deadlock a repository that legitimately symlinks a
  carried path.
- **A carried path is refused if any *intermediate* directory in it
  resolves outside the tree through a symlink**, even a dangling one.
  `escapingAncestor` (`src/git.mjs`) walks every directory segment of a
  carried path but the last, resolves each with `realpathSync`, and
  refuses if the result lands outside the repository (copy-in) or the
  worktree (rescue). This is checked on both sides of both commands, so a
  carried path can never be made to write outside the directory it
  targets by aiming an ancestor segment at a symlink.
- Every carry-path refusal is collected and reported together — a bad
  carry path does not silently discard the rest.
- **Configured install, verify, runner, and agent commands are argv arrays.**
  They are spawned with shell parsing disabled. Generated shell forwards quote
  every runner element before appending the fixed hook subcommand.
- **Coordination writes are atomic and remain inside Git's common directory.**
  They are immediately shared by all worktrees, do not dirty a branch, and
  use an exclusive lock to prevent concurrent lost updates.
- **Carried directories are walked without following links before copying.**
  A symlink anywhere below a `carryDirs` entry is named and refused in both
  copy and rescue directions, so recursive copying cannot plant a live link
  that escapes the repository or worktree later.

## Reporting a vulnerability

For anything sensitive, please use [GitHub's private vulnerability
reporting](https://github.com/AaronLPS/copse/security/advisories/new)
(Security → Report a vulnerability on the repository) rather than a
public issue, so it can be assessed before details are public.

For anything that is not sensitive — a hardening suggestion, a question
about the trust model, a report that turns out not to be exploitable —
a regular [public issue](https://github.com/AaronLPS/copse/issues) is
fine.
