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
import { coordinationStatePath, featureBlockers, loadCoordination } from '../coordination.mjs';

export function commandList({ cwd = process.cwd(), config, json = false }) {
  const entries = worktrees({ cwd });
  const repoDir = entries.find((entry) => entry.isMain).path;
  const coordination = loadCoordination(coordinationStatePath({ cwd }));
  const parent = dirname(repoDir);
  let drifted = 0;

  if (json) {
    const snapshot = entries.map((entry) => ({
      path: entry.path, branch: entry.branch, main: entry.isMain, detached: entry.detached,
      coordination: entry.branch ? coordination.features[entry.branch] ?? null : null,
      blockedBy: entry.branch ? featureBlockers(coordination, entry.branch) : [],
      lease: entry.branch ? coordination.leases[entry.branch] ?? null : null,
    }));
    console.log(JSON.stringify({ version: 1, worktrees: snapshot, features: coordination.features }, null, 2));
    return snapshot;
  }

  console.log('');
  for (const entry of entries) {
    // entry.branch is null for a bare main repository too (see git.mjs's
    // worktrees()), and null is not '(detached)' — print it as what it is
    // rather than falling through to the literal string "null".
    const branch = entry.bare ? '(bare)' : entry.detached ? '(detached)' : entry.branch;

    const note = driftNote(entry, config, { repoDir });
    if (note !== null) drifted += 1;

    // A bare main repository has no working tree at all: no files to be
    // dirty, no commits checked out to be ahead of a remote-tracking
    // branch, no branch to ask gh about. Those are not measurements that
    // failed — worktreeState's 'unknown' and pullRequestNote's "PR state
    // unknown" both mean "asked and could not find out" — they are
    // questions that do not apply here at all. Asking them anyway would
    // print "dirty state unknown"/"PR state unknown" for a row that was
    // never askable, which is the "an absence that was never measured is
    // not an absence" confusion in reverse: a question never asked reading
    // as one that was asked and failed. The bare label on the row itself
    // (see `shown` below) already says why there is nothing here.
    let flags = [];
    if (!entry.bare) {
      const { dirty, unpushed } = worktreeState(entry.path);
      const lookupBranch = pullRequestLookupBranch(entry);
      const pr = lookupBranch ? pullRequestFor(lookupBranch, { cwd: entry.path }) : undefined;
      // dirty is true | false | 'unknown' (see worktreeState's comment); an
      // unknown status must read as unknown, not silently as clean.
      const dirtyFlag =
        dirty === 'unknown' ? 'dirty state unknown (git status failed)' : dirty ? 'uncommitted changes' : null;
      flags = [
        dirtyFlag,
        unpushed ? `${unpushed} unpushed` : null,
        pullRequestNote(pr, { isMain: entry.isMain }),
      ].filter(Boolean);
    }

    const shown =
      note ??
      (entry.isMain
        ? entry.bare
          ? 'bare repository — no working tree here'
          : `main worktree, pinned to ${config.baseBranch}`
        : '');
    console.log(`  ${relative(parent, entry.path).padEnd(38)} ${String(branch).padEnd(34)} ${shown}`);
    if (flags.length) console.log(`  ${''.padEnd(38)} ${flags.join(', ')}`);
    const feature = entry.branch ? coordination.features[entry.branch] : null;
    if (feature) {
      const blocked = featureBlockers(coordination, entry.branch);
      console.log(`  ${''.padEnd(38)} owner ${feature.owner}, ${feature.status}${blocked.length ? `, blocked by ${blocked.join(', ')}` : ''}`);
    }
    const lease = entry.branch ? coordination.leases[entry.branch] : null;
    if (lease) {
      console.log(`  ${''.padEnd(38)} active session ${lease.owner}${lease.label ? ` (${lease.label})` : ''}`);
    }
  }

  console.log(
    drifted === 0 ? '\n✓ every directory name matches its branch\n' : `\n⚠ ${drifted} drifted\n`,
  );
  return drifted;
}
