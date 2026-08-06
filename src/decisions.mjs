/**
 * Every judgement `list` and `drop` make, as pure functions over explicit
 * state — so a dirty tree, an unpushed commit, a detached head, a `gh` that
 * could not answer and a directory whose name no longer fits its branch are
 * all reachable from a test without a repository.
 */
import { resolve } from 'node:path';

import { directoryFor, parseBranchName } from './naming.mjs';

/**
 * Every reason this worktree must not be removed, all of them at once.
 *
 * All of them, not the first: a caller who fixes one blocker and is then told
 * about the next learns to run the command repeatedly rather than to read it.
 *
 * @param {{ dirty: boolean, unpushed: number, isMain: boolean, isCurrent: boolean }} state
 * @returns {string[]}
 */
export function removalBlockers({ dirty, unpushed, isMain, isCurrent }) {
  const blockers = [];

  if (isMain) blockers.push('this is the main worktree — it owns .git and cannot be removed');
  if (isCurrent) blockers.push('you are currently in this worktree — cd elsewhere first');
  if (unpushed > 0) {
    blockers.push(
      `${unpushed} unpushed commit(s) — push them, or drop the branch deliberately with git branch -D`,
    );
  }
  if (dirty) blockers.push('uncommitted changes in the working tree');

  return blockers;
}

/**
 * Carried files this worktree holds the only copy of.
 *
 * These are gitignored, so removing the directory destroys them. In GoThinking
 * one env file was genuinely in this position — present in one worktree and
 * nowhere else, one `git worktree remove` from gone.
 *
 * @param {{ inWorktree: string[], inRepo: string[] }} present
 */
export function rescuableFiles({ inWorktree, inRepo }) {
  const held = new Set(inRepo);
  return inWorktree.filter((path) => !held.has(path));
}

/**
 * How a branch's pull request reads in `grove list`.
 *
 * `null` means asked and there is none; `undefined` means could not ask — `gh`
 * missing, unauthenticated, offline or timed out. They are different facts and
 * the second must not be printed as the first: an absence that was never
 * measured is not an absence.
 *
 * `isMain` exists because "droppable" is not only a fact about the pull
 * request — it is a claim about *this worktree*, and the main worktree's
 * newest base → release pull request is essentially always merged. Without
 * this, the one directory that can never be removed carried a permanent
 * "droppable" label.
 *
 * @param {{ number: number, state: 'OPEN' | 'MERGED' | 'CLOSED' } | null | undefined} pr
 * @param {{ isMain?: boolean }} [options]
 */
export function pullRequestNote(pr, { isMain = false } = {}) {
  if (pr === undefined) return 'PR state unknown';
  if (pr === null) return 'no PR';
  if (pr.state === 'MERGED') {
    return isMain ? `PR #${pr.number} merged` : `PR #${pr.number} merged — droppable`;
  }
  if (pr.state === 'CLOSED') return `PR #${pr.number} closed`;
  return `PR #${pr.number} open`;
}

/**
 * The branch to ask `gh` about, or `null` when there is none.
 *
 * A detached worktree has no branch, but a display string for it (`'(detached)'`)
 * is truthy — so a ternary gating the `gh` call on "is there a branch" runs it
 * anyway, finds no matches, and prints "no PR" for a row that was never
 * meaningfully asked about.
 *
 * @param {{ detached: boolean, branch: string | null }} entry
 * @returns {string | null}
 */
export function pullRequestLookupBranch(entry) {
  return entry.detached ? null : entry.branch;
}

/**
 * Why this worktree's directory name no longer says what is checked out in it,
 * or `null` when it does.
 *
 * @param {{ path: string, branch: string | null, detached: boolean, isMain: boolean }} entry
 * @param {{ branchPrefixes: string[], baseBranch: string }} config
 * @param {{ repoDir: string }} options
 * @returns {string | null}
 */
export function driftNote(entry, config, { repoDir }) {
  if (entry.detached) return null;

  if (entry.isMain) {
    // The main worktree owns .git, so a feature branch here is the one branch
    // that cannot be moved aside cheaply.
    return entry.branch === config.baseBranch
      ? null
      : `⚠ main worktree should be on ${config.baseBranch}`;
  }

  if (!parseBranchName(entry.branch, config).ok) return '⚠ branch name has no recognised prefix';

  const expected = directoryFor(entry.branch, config, { repoDir });
  if (resolve(expected) === resolve(entry.path)) return null;
  return `⚠ expected ${expected}`;
}
