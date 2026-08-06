/**
 * Everything that touches git, `gh` and the process table. No decisions live
 * here — this module answers questions, and src/decisions.mjs judges.
 */
import { execFileSync } from 'node:child_process';

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
 * @param {string} path
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

  return { dirty: dirty !== null && dirty !== '', unpushed };
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
