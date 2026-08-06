/**
 * Everything that touches git, `gh` and the process table. No decisions live
 * here — this module answers questions, and src/decisions.mjs judges.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';

/**
 * `gh` missing or refusing is instant — ENOENT or a non-zero exit come back in
 * milliseconds. A `gh` that is merely slow does not: a captive portal accepts
 * the TCP connection and never answers it, so with no bound `grove list` — the
 * command people run to find out where they are — hangs forever instead of
 * degrading to "PR state unknown". This runs once per worktree, serially, so
 * the worst case is this bound times the worktree count.
 */
const GH_TIMEOUT_MS = 3000;

export function git(args, { cwd = process.cwd(), allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed:\n${error.stderr || error.message}`);
  }
}

/**
 * Every worktree of the repository containing `cwd`.
 *
 * `--porcelain` is parsed rather than the human format, which aligns columns
 * with spaces — a path containing a space would silently split.
 *
 * @param {{ cwd?: string }} [options]
 */
export function worktrees({ cwd = process.cwd() } = {}) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd });
  const entries = [];
  let current = null;

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, detached: false };
      entries.push(current);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      current.detached = true;
    }
  }

  // git lists the main worktree first — it is the one holding .git as a
  // directory rather than as a file pointing elsewhere.
  return entries.map((entry, index) => ({ ...entry, isMain: index === 0 }));
}

export function mainWorktree({ cwd = process.cwd() } = {}) {
  const found = worktrees({ cwd }).find((entry) => entry.isMain);
  if (!found) throw new Error('could not identify the main worktree');
  return found;
}

/**
 * Whether a worktree has uncommitted or unpushed work.
 *
 * The no-upstream branch is defended against rather than assumed away.
 * `git worktree add -b <branch> origin/<base>` does set an upstream, so the
 * ordinary path never reaches it — verified, not assumed. But a branch made by
 * hand, or one created with `branch.autoSetupMerge` turned off, has none, and
 * there `@{u}..HEAD` fails: read as "no output", that is zero unpushed for a
 * branch whose every commit is unpushed, and `drop` would destroy the lot.
 *
 * `dirty` is `true | false | 'unknown'`, not a plain boolean. `git status
 * --porcelain` is read with `allowFailure`, so a status git could not obtain
 * (a corrupt index, a permissions problem, an interrupted git process) comes
 * back as `null` — the same shape `allowFailure` gives a status that
 * succeeded and had nothing to report. Collapsing both into `dirty: false`
 * turns "could not ask" into "permission to remove", which is exactly the
 * failure mode this module's own doc comment warns against for `unpushed`.
 * `'unknown'` keeps that distinction visible to `removalBlockers`, which
 * must treat it as its own blocker rather than as clean.
 *
 * @param {string} path
 * @returns {{ dirty: true | false | 'unknown', unpushed: number }}
 */
export function worktreeState(path) {
  const dirty = git(['status', '--porcelain'], { cwd: path, allowFailure: true });
  const upstream = git(['rev-parse', '--abbrev-ref', '@{u}'], { cwd: path, allowFailure: true });

  let unpushed = 0;
  if (upstream === null) {
    // No upstream at all: every commit not on the remote-tracking base is
    // unpushed. Counting them as 0 would let `drop` destroy work.
    const out = git(['log', '--oneline', 'HEAD', '--not', '--remotes'], {
      cwd: path,
      allowFailure: true,
    });
    unpushed = out ? out.split('\n').length : 0;
  } else {
    const out = git(['log', '--oneline', '@{u}..HEAD'], { cwd: path, allowFailure: true });
    unpushed = out ? out.split('\n').length : 0;
  }

  const dirtyState = dirty === null ? 'unknown' : dirty !== '';
  return { dirty: dirtyState, unpushed };
}

/**
 * Whether a carried path is present, missing, or a symlink — checked without
 * following the link.
 *
 * `existsSync` follows symlinks, so a *dangling* symlink at a carried path
 * reads as "not present" — the exact gap that lets a write-through defeat
 * `config.mjs`'s `pathProblem` validation, which rejects `..`, absolute paths
 * and backslashes precisely to stop a carried path from writing outside the
 * tree it targets. A symlink walks around all three checks: it can be
 * committed and arrives with a clone, and `copyFileSync`/`cpSync` follow it,
 * reading from or writing through whatever it points at. `lstatSync` sees the
 * link itself, never its target, so a dangling link is reported as what it
 * is rather than as an absence.
 *
 * @param {string} path
 * @returns {'missing' | 'symlink' | 'present'}
 */
export function carryPathState(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
  return stat.isSymbolicLink() ? 'symlink' : 'present';
}

/**
 * The newest pull request for a branch, or `null` if there is none.
 *
 * Returns `undefined` when `gh` could not answer at all — absent, logged out,
 * offline, or timed out — because `grove list` must keep working without a
 * network and "there is no PR" would be a claim rather than an observation.
 *
 * @param {string} branch
 * @param {{ cwd: string }} options
 */
export function pullRequestFor(branch, { cwd }) {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state'],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GH_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    const [pr] = JSON.parse(out);
    return pr ?? null;
  } catch {
    return undefined;
  }
}
