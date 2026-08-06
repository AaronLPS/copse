/**
 * Every worktree, whether its directory name still says what is checked out in
 * it, and what pull request it belongs to.
 *
 * The pull request column is what makes "one worktree per pull request, not
 * per task" visible. That rule cannot be enforced in code, so the alternative
 * to showing it is leaving it to be remembered.
 */
import { dirname, relative } from 'node:path';

import { pullRequestFor, worktreeState, worktrees } from '../git.mjs';
import { driftNote, pullRequestLookupBranch, pullRequestNote } from '../decisions.mjs';

export function commandList({ cwd = process.cwd(), config }) {
  const entries = worktrees({ cwd });
  const repoDir = entries.find((entry) => entry.isMain).path;
  const parent = dirname(repoDir);
  let drifted = 0;

  console.log('');
  for (const entry of entries) {
    // entry.branch is null for a bare main repository too (see git.mjs's
    // worktrees()), and null is not '(detached)' — print it as what it is
    // rather than falling through to the literal string "null".
    const branch = entry.bare ? '(bare)' : entry.detached ? '(detached)' : entry.branch;

    const note = driftNote(entry, config, { repoDir });
    if (note !== null) drifted += 1;

    const { dirty, unpushed } = worktreeState(entry.path);
    const lookupBranch = pullRequestLookupBranch(entry);
    const pr = lookupBranch ? pullRequestFor(lookupBranch, { cwd: entry.path }) : undefined;

    // dirty is true | false | 'unknown' (see worktreeState's comment); an
    // unknown status must read as unknown, not silently as clean.
    const dirtyFlag = dirty === 'unknown' ? 'dirty state unknown (git status failed)' : dirty ? 'uncommitted changes' : null;
    const flags = [
      dirtyFlag,
      unpushed ? `${unpushed} unpushed` : null,
      pullRequestNote(pr, { isMain: entry.isMain }),
    ].filter(Boolean);

    const shown =
      note ??
      (entry.isMain
        ? entry.bare
          ? 'bare repository — no working tree here'
          : `main worktree, pinned to ${config.baseBranch}`
        : '');
    console.log(`  ${relative(parent, entry.path).padEnd(38)} ${String(branch).padEnd(34)} ${shown}`);
    if (flags.length) console.log(`  ${''.padEnd(38)} ${flags.join(', ')}`);
  }

  console.log(
    drifted === 0 ? '\n✓ every directory name matches its branch\n' : `\n⚠ ${drifted} drifted\n`,
  );
  return drifted;
}
