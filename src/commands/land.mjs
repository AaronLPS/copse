import { coordinationStatePath, featureBlockers, loadCoordination, releaseFeature, updateCoordination } from '../coordination.mjs';
import { resolve, sep } from 'node:path';
import { landBlockers } from '../decisions.mjs';
import { createPullRequest, mergePullRequest, pullRequestStatus } from '../github.mjs';
import { git, worktreeState, worktrees } from '../git.mjs';
import { parseBranchName } from '../naming.mjs';
import { protectedBranches } from '../hooks.mjs';
import { CopseError } from './new.mjs';
import { commandDrop } from './drop.mjs';

export function refreshBaseAfterMerge(config, { cwd = process.cwd() } = {}) {
  const main = worktrees({ cwd }).find((entry) => entry.isMain);
  if (!main || main.bare) return { refreshed: false, reason: 'main worktree is unavailable', mainPath: main?.path ?? null };
  if (main.branch !== config.baseBranch) return { refreshed: false, reason: `main worktree is not on ${config.baseBranch}`, mainPath: main.path };
  const state = worktreeState(main.path);
  if (state.dirty !== false) return { refreshed: false, reason: 'main worktree is not known-clean', mainPath: main.path };
  const remote = `refs/remotes/origin/${config.baseBranch}`;
  if (git(['rev-parse', '--verify', remote], { cwd: main.path, allowFailure: true }) === null) {
    return { refreshed: false, reason: `origin/${config.baseBranch} is unavailable`, mainPath: main.path };
  }
  if (git(['fetch', '--prune', 'origin'], { cwd: main.path, allowFailure: true }) === null) {
    return { refreshed: false, reason: 'fetching origin failed', mainPath: main.path };
  }
  if (git(['merge', '--ff-only', `origin/${config.baseBranch}`], { cwd: main.path, allowFailure: true }) === null) {
    return { refreshed: false, reason: 'main worktree could not fast-forward', mainPath: main.path };
  }
  return { refreshed: true, reason: null, mainPath: main.path };
}

function shownArg(value) {
  return /^[a-zA-Z0-9_./:@-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function shownCommand(args) {
  return args.map(shownArg).join(' ');
}

export function landRecoveryMessages({
  branch,
  baseBranch,
  mainPath,
  cleanup,
  cleanupReason = null,
  refreshed,
  refreshReason,
  cleaned,
  localBranchDeleted,
  remoteBranchDeleteAttempted,
  remoteBranchDeleted,
}) {
  const messages = [];
  if (!refreshed) {
    const fetch = mainPath ? shownCommand(['git', '-C', mainPath, 'fetch', '--prune', 'origin']) : null;
    const merge = mainPath ? shownCommand(['git', '-C', mainPath, 'merge', '--ff-only', `origin/${baseBranch}`]) : null;
    let commands;
    if (!mainPath) {
      commands = `locate a clean ${baseBranch} main worktree, then fetch and fast-forward it`;
    } else if (refreshReason === `main worktree is not on ${baseBranch}`) {
      commands = `run ${shownCommand(['git', '-C', mainPath, 'switch', baseBranch])}, then run ${fetch}, then run ${merge}`;
    } else if (refreshReason === 'main worktree is not known-clean') {
      commands = `commit or stash the changes in ${shownArg(mainPath)}, confirm it is on ${shownArg(baseBranch)}, then run ${fetch}, then run ${merge}`;
    } else {
      commands = `confirm ${shownArg(mainPath)} is clean and on ${shownArg(baseBranch)}, then run ${fetch}, then run ${merge}`;
    }
    messages.push(`main was not refreshed (${refreshReason}); recover with: ${commands}`);
  }
  if (cleanup && !cleaned) {
    messages.push(`worktree was not removed${cleanupReason ? ` (${cleanupReason})` : ''}; recover from outside it with: copse drop ${shownArg(branch)}`);
  }
  if (cleaned && !localBranchDeleted) {
    messages.push(`local branch was not deleted; recover with: ${shownCommand(['git', '-C', mainPath, 'branch', '-d', branch])}`);
  }
  if (remoteBranchDeleteAttempted && !remoteBranchDeleted) {
    messages.push(`remote branch was not deleted; recover with: ${shownCommand(['git', '-C', mainPath, 'push', 'origin', '--delete', branch])}`);
  }
  return messages;
}

export function commandLand(branch, { cwd = process.cwd(), config, yes = false, cleanup = true, createPr = false, run } = {}) {
  const entries = worktrees({ cwd });
  const resolvedCwd = resolve(cwd);
  const entry = branch ? entries.find((item) => item.branch === branch) : entries.find((item) => {
    const base = resolve(item.path);
    return resolvedCwd === base || resolvedCwd.startsWith(base + sep);
  });
  if (!entry || entry.isMain) throw new CopseError('land must run for a feature worktree or name a checked-out feature branch');
  branch = entry.branch;
  const state = worktreeState(entry.path);
  let pr = pullRequestStatus(branch, { cwd: entry.path, run });
  if (!pr && createPr) {
    const created = createPullRequest(branch, { base: config.baseBranch, cwd: entry.path, run });
    if (created.status !== 0) throw new CopseError(`GitHub could not create a pull request for ${branch}`);
    pr = pullRequestStatus(branch, { cwd: entry.path, run });
  }
  const coordinationPath = coordinationStatePath({ cwd, config });
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
  const refreshed = refreshBaseAfterMerge(config, { cwd });
  let localBranchDeleted = false;
  let remoteBranchDeleted = false;
  let remoteBranchDeleteAttempted = false;
  let cleanupReason = null;
  const entryPath = resolve(entry.path);
  if (cleanup && resolvedCwd !== entryPath && !resolvedCwd.startsWith(entryPath + sep)) {
    try {
      commandDrop(branch, { cwd, config });
      cleaned = true;
      localBranchDeleted = git(['branch', '-d', branch], { cwd, allowFailure: true }) !== null;
      if (git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], { cwd, allowFailure: true }) !== null) {
        remoteBranchDeleteAttempted = true;
        remoteBranchDeleted = git(['push', 'origin', '--delete', branch], { cwd, allowFailure: true }) !== null;
      }
    } catch (error) {
      cleanupReason = error.message;
    }
  }
  const recovery = landRecoveryMessages({
    branch,
    baseBranch: config.baseBranch,
    mainPath: refreshed.mainPath,
    cleanup,
    cleanupReason,
    refreshed: refreshed.refreshed,
    refreshReason: refreshed.reason,
    cleaned,
    localBranchDeleted,
    remoteBranchDeleteAttempted,
    remoteBranchDeleted,
  });
  console.log(`✓ merged ${branch}${cleaned ? ' and removed its worktree' : ''}`);
  for (const message of recovery) console.log(`  ⚠ ${message}`);
  return {
    ready: true,
    merged: true,
    refreshed: refreshed.refreshed,
    refreshReason: refreshed.reason,
    cleaned,
    localBranchDeleted,
    remoteBranchDeleteAttempted,
    remoteBranchDeleted,
    recovery,
  };
}
