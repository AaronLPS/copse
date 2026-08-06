/**
 * Everything that touches git, `gh` and the process table. No decisions live
 * here — this module answers questions, and src/decisions.mjs judges.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

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
      current = { path: line.slice('worktree '.length), branch: null, detached: false, bare: false };
      entries.push(current);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      current.detached = true;
    } else if (line === 'bare') {
      // A bare main repository (`git init --bare`, worktrees added onto it)
      // emits `worktree <path>` then `bare` — no `branch`, no `detached`.
      // Left unparsed, that reads as `{ branch: null, detached: false }`,
      // which is indistinguishable from "on no branch and not detached" —
      // a state that does not exist for a real working tree. driftNote then
      // saw branch !== baseBranch forever and reported permanent drift.
      current.bare = true;
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
 * Whether some directory *above* a carry path's final component resolves
 * outside `root` — the gap carryPathState leaves on purpose. carryPathState
 * lstats only the final segment, because that is the only segment it is
 * `new`/`drop`'s job to refuse to *follow* (it is the thing being read or
 * written). But `lstat` does not stop at the final segment when resolving
 * the segments before it — the kernel dereferences every intermediate
 * symlink to get there. So a symlinked *intermediate* directory
 * (`cfg -> /elsewhere`, carrying `cfg/.env.test`) makes `lstat('cfg/.env.test')`
 * resolve straight through `cfg` and report on whatever `/elsewhere/.env.test`
 * turns out to be — 'missing' if it does not exist there, which is exactly
 * how `drop` mistook a rescue-worthy write for a no-op and copied through
 * the link into `/elsewhere`.
 *
 * The check: walk the relative path's directory segments (not the final
 * one — that is carryPathState's job), and for each that exists, resolve it
 * fully with `realpathSync` and confirm the result still sits inside
 * `root`'s own realpath. `..` and absolute segments are already rejected by
 * `config.mjs`'s `pathProblem`, so the only way a literal descendant of
 * `root` can resolve elsewhere is through a symlink somewhere in the chain —
 * realpath collapses the whole chain in one call, so this does not need to
 * know which segment it was. A segment that does not exist yet is not a
 * containment question — it cannot point anywhere until something creates
 * it — and is left to whatever mkdir/copy step runs next.
 *
 * A *dangling* escaping symlink — `cfg -> /nonexistent` — is its own case,
 * not folded into "does not exist yet". `lstat` proves the segment itself
 * exists; it is `realpathSync` resolving *through* it that fails with
 * ENOENT, because what it points at is gone. Treating that the same as a
 * segment that was never created lets it slip past this check entirely —
 * `drop` would then proceed into a rescue, `mkdirSync` the same dangling
 * path, and die with a raw `ENOENT`, not a named refusal, possibly after
 * other carry paths were already rescued. A carried path passing through a
 * dangling symlink is refused just like one passing through a live escape,
 * with a reason that says which of the two it is.
 *
 * @param {string} root the tree this path must stay inside — the main
 *   worktree for the repo side of a carry, the worktree directory for the
 *   worktree side
 * @param {string} relPath the carry path, relative to root
 * @returns {{ via: string, dangling: boolean } | null} the relative
 *   ancestor segment that escapes (or dangles) and which of the two it is,
 *   or null if every existing ancestor stays inside `root`
 */
export function escapingAncestor(root, relPath) {
  const realRoot = realpathSync(root);
  const segments = relPath.split('/');
  let literal = root;

  // The final segment is the carried file or directory itself; whether *it*
  // is a symlink is carryPathState's question, not this one.
  for (let i = 0; i < segments.length - 1; i += 1) {
    literal = join(literal, segments[i]);

    // lstat first: distinguishes "this segment does not exist yet" (ENOENT
    // here — not a containment question, nothing can point anywhere until
    // something creates it) from "this segment exists but is a dangling
    // symlink" (ENOENT only on the realpath call below, because lstat just
    // proved the link itself is there).
    try {
      lstatSync(literal);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    let real;
    try {
      real = realpathSync(literal);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { via: segments.slice(0, i + 1).join('/'), dangling: true };
      }
      throw error;
    }
    if (real !== realRoot && !real.startsWith(realRoot + sep)) {
      return { via: segments.slice(0, i + 1).join('/'), dangling: false };
    }
  }
  return null;
}

/**
 * The one-line refusal reason for an `escapingAncestor` result, shared by
 * `new` and `drop` so a live escape and a dangling one read consistently on
 * both the repo side and the worktree side rather than each caller wording
 * it slightly differently.
 *
 * @param {string} relPath the carry path
 * @param {{ via: string, dangling: boolean }} escape escapingAncestor's result
 * @param {string} root the directory the escape was checked against
 * @param {string} insideLabel what to call `root` in the message, e.g.
 *   "the repository" or "the new worktree"
 */
export function describeEscapingAncestor(relPath, escape, root, insideLabel) {
  return escape.dangling
    ? `${relPath} (passes through "${escape.via}" in ${root}, a symlink that does not resolve ` +
        'to anything; refused rather than followed)'
    : `${relPath} (passes through "${escape.via}" in ${root}, which resolves outside ${insideLabel}; ` +
        'refused rather than followed)';
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
