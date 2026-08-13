import { test } from 'node:test';
import assert from 'node:assert/strict';

import { landBlockers } from '../src/decisions.mjs';
import { createPullRequest, mergePullRequest } from '../src/github.mjs';
import { landRecoveryMessages } from '../src/commands/land.mjs';

test('land blockers name unsafe state in priority order', () => {
  const blockers = landBlockers({ legal: true, protectedBranch: false, dirty: true, unpushed: 2, pr: null, checksGreen: false, dependencies: ['feat/api'] });
  assert.match(blockers[0], /dirty/);
  assert.match(blockers[1], /unpushed/);
  assert.match(blockers[2], /pull request/);
  assert.match(blockers.at(-1), /feat\/api/);
});

test('mergePullRequest invokes gh without a shell', () => {
  let seen;
  const result = mergePullRequest('feat/x', { cwd: '/repo', run(command, args, options) { seen = { command, args, options }; return { status: 0 }; } });
  assert.equal(result.status, 0);
  assert.deepEqual(seen.args, ['pr', 'merge', 'feat/x', '--merge']);
});

test('createPullRequest targets the configured base and preserves draft intent', () => {
  let seen;
  const result = createPullRequest('feat/x', {
    base: 'main', draft: true, cwd: '/repo',
    run(command, args, options) { seen = { command, args, options }; return { status: 0, ok: true }; },
  });
  assert.equal(result.status, 0);
  assert.deepEqual(seen.args, ['pr', 'create', '--head', 'feat/x', '--base', 'main', '--draft', '--fill']);
});

test('partial land failures include exact recovery commands', () => {
  const messages = landRecoveryMessages({
    branch: 'feat/x',
    baseBranch: 'main',
    mainPath: '/repo',
    cleanup: true,
    refreshed: false,
    refreshReason: 'main worktree could not fast-forward',
    cleaned: true,
    localBranchDeleted: false,
    remoteBranchDeleteAttempted: true,
    remoteBranchDeleted: false,
  });
  assert.match(messages.join('\n'), /git -C \/repo fetch --prune origin/);
  assert.match(messages.join('\n'), /git -C \/repo merge --ff-only origin\/main/);
  assert.match(messages.join('\n'), /git -C \/repo branch -d feat\/x/);
  assert.match(messages.join('\n'), /git -C \/repo push origin --delete feat\/x/);
});
