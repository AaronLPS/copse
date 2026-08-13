import { coordinationStatePath, featureBlockers, loadCoordination, releaseFeature, updateCoordination } from '../coordination.mjs';
import { resolve, sep } from 'node:path';
import { landBlockers } from '../decisions.mjs';
import { mergePullRequest, pullRequestStatus } from '../github.mjs';
import { worktreeState, worktrees } from '../git.mjs';
import { parseBranchName } from '../naming.mjs';
import { protectedBranches } from '../hooks.mjs';
import { CopseError } from './new.mjs';
import { commandDrop } from './drop.mjs';

export function commandLand(branch, { cwd = process.cwd(), config, yes = false, cleanup = true, run } = {}) {
  const entries = worktrees({ cwd });
  const resolvedCwd = resolve(cwd);
  const entry = branch ? entries.find((item) => item.branch === branch) : entries.find((item) => {
    const base = resolve(item.path);
    return resolvedCwd === base || resolvedCwd.startsWith(base + sep);
  });
  if (!entry || entry.isMain) throw new CopseError('land must run for a feature worktree or name a checked-out feature branch');
  branch = entry.branch;
  const state = worktreeState(entry.path);
  const pr = pullRequestStatus(branch, { cwd: entry.path, run });
  const coordinationPath = coordinationStatePath({ cwd });
  const coordination = loadCoordination(coordinationPath);
  const blockers = landBlockers({
    legal: parseBranchName(branch, config).ok,
    protectedBranch: protectedBranches(config).has(branch),
    dirty: state.dirty,
    unpushed: state.unpushed,
    pr,
    checksGreen: pr?.checksGreen ?? false,
    dependencies: featureBlockers(coordination, branch),
  });
  if (blockers.length) throw new CopseError(`cannot land ${branch}:\n${blockers.map((item) => `  · ${item}`).join('\n')}`);
  if (!yes) {
    console.log(`Ready to merge PR #${pr.number} for ${branch}. Re-run with --yes to merge${cleanup ? ' and clean up' : ''}.`);
    return { ready: true, merged: false };
  }
  const merged = mergePullRequest(branch, { cwd: entry.path, run });
  if (merged.status !== 0) throw new CopseError(`GitHub could not merge ${branch}`);
  if (coordination.features[branch]) {
    updateCoordination(coordinationPath, (current) => current.features[branch] ? releaseFeature(current, branch) : current);
  }
  let cleaned = false;
  const entryPath = resolve(entry.path);
  if (cleanup && resolvedCwd !== entryPath && !resolvedCwd.startsWith(entryPath + sep)) {
    commandDrop(branch, { cwd, config });
    cleaned = true;
  }
  console.log(`✓ merged ${branch}${cleaned ? ' and removed its worktree' : cleanup ? '; run copse drop from another worktree to clean up' : ''}`);
  return { ready: true, merged: true, cleaned };
}
