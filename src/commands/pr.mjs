import { resolve, sep } from 'node:path';

import { createPullRequest, pullRequestStatus } from '../github.mjs';
import { worktreeState, worktrees } from '../git.mjs';
import { parseBranchName } from '../naming.mjs';
import { CopseError } from './new.mjs';
import { commandVerify } from './verify.mjs';

function featureEntry(branch, cwd) {
  const entries = worktrees({ cwd });
  if (branch) return entries.find((entry) => entry.branch === branch);
  const resolved = resolve(cwd);
  return entries.find((entry) => {
    const base = resolve(entry.path);
    return resolved === base || resolved.startsWith(base + sep);
  });
}

export function commandPr(branch, {
  cwd = process.cwd(),
  config,
  draft = false,
  verify = true,
  run,
  verifyCommand = commandVerify,
} = {}) {
  const entry = featureEntry(branch, cwd);
  if (!entry || entry.isMain || !entry.branch) throw new CopseError('pr must run for a checked-out feature branch');
  branch = entry.branch;
  const parsed = parseBranchName(branch, config);
  if (!parsed.ok) throw new CopseError(parsed.reason);
  const state = worktreeState(entry.path);
  const blockers = [];
  if (state.dirty === 'unknown') blockers.push('dirty state is unknown');
  else if (state.dirty) blockers.push('working tree is dirty');
  if (state.unpushed > 0) blockers.push(`${state.unpushed} unpushed commit(s)`);
  if (blockers.length) throw new CopseError(`cannot create PR for ${branch}:\n${blockers.map((item) => `  · ${item}`).join('\n')}`);
  if (pullRequestStatus(branch, { cwd: entry.path, run })) throw new CopseError(`${branch} already has an open pull request`);
  if (verify && verifyCommand({ cwd: entry.path, config, run }) !== 0) throw new CopseError('verification failed; pull request was not created');
  const result = createPullRequest(branch, { base: config.baseBranch, draft, cwd: entry.path, run });
  if (result.status !== 0) throw new CopseError(`GitHub could not create a pull request for ${branch}`);
  console.log(`✓ pull request created for ${branch}`);
  return { branch, created: true, draft };
}
