import { test } from 'node:test';
import assert from 'node:assert/strict';

import { landBlockers } from '../src/decisions.mjs';
import { createPullRequest, mergePullRequest, pullRequestStatus } from '../src/github.mjs';
import { landRecoveryMessages } from '../src/commands/land.mjs';

test('land blockers name unsafe state in priority order', () => {
  const blockers = landBlockers({ legal: true, protectedBranch: false, dirty: true, unpushed: 2, pr: null, checksGreen: false, dependencies: ['feat/api'] });
  assert.match(blockers[0], /dirty/);
  assert.match(blockers[1], /unpushed/);
  assert.match(blockers[2], /pull request/);
  assert.match(blockers.at(-1), /feat\/api/);
});

test('land blockers reject a PR with the wrong base or head commit', () => {
  const common = {
    legal: true, protectedBranch: false, dirty: false, unpushed: 0,
    pr: { number: 17 }, checksGreen: true, dependencies: [],
  };

  assert.match(landBlockers({ ...common, prBaseMatches: false, prHeadMatches: true }).join('\n'), /configured base/);
  assert.match(landBlockers({ ...common, prBaseMatches: true, prHeadMatches: false }).join('\n'), /head commit/);
});

test('pullRequestStatus requires a successful verify check and preserves PR identity', () => {
  const responses = [
    [{ number: 17, state: 'OPEN', baseRefName: 'main', headRefOid: 'abc123', statusCheckRollup: [{ name: 'lint', conclusion: 'SUCCESS' }] }],
    [{ number: 17, state: 'OPEN', baseRefName: 'main', headRefOid: 'abc123', statusCheckRollup: [{ name: 'verify', conclusion: 'SKIPPED' }] }],
    [{ number: 17, state: 'OPEN', baseRefName: 'main', headRefOid: 'abc123', statusCheckRollup: [{ name: 'verify', conclusion: 'SUCCESS' }, { context: 'verify', state: 'SKIPPED' }] }],
    [{ number: 17, state: 'OPEN', baseRefName: 'main', headRefOid: 'abc123', statusCheckRollup: [{ name: 'verify', conclusion: 'SUCCESS' }] }],
  ];
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    return { ok: true, status: 0, stdout: JSON.stringify(responses.shift()), stderr: '' };
  };

  assert.equal(pullRequestStatus('feat/x', { cwd: '/repo', run }).checksGreen, false);
  assert.equal(pullRequestStatus('feat/x', { cwd: '/repo', run }).checksGreen, false);
  assert.equal(pullRequestStatus('feat/x', { cwd: '/repo', run }).checksGreen, false);
  assert.deepEqual(pullRequestStatus('feat/x', { cwd: '/repo', run }), {
    number: 17,
    state: 'OPEN',
    baseRefName: 'main',
    headRefOid: 'abc123',
    checksGreen: true,
  });
  for (const call of calls) {
    assert.ok(call.args.at(-1).includes('baseRefName'));
    assert.ok(call.args.at(-1).includes('headRefOid'));
  }
});

test('mergePullRequest binds the verified PR number and head commit without a shell', () => {
  let seen;
  const result = mergePullRequest(17, { headOid: 'abc123', cwd: '/repo', run(command, args, options) { seen = { command, args, options }; return { status: 0 }; } });
  assert.equal(result.status, 0);
  assert.deepEqual(seen.args, ['pr', 'merge', '17', '--merge', '--match-head-commit', 'abc123']);
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

test('base refresh recovery switches branches before suggesting a fast-forward', () => {
  const messages = landRecoveryMessages({
    branch: 'feat/x', baseBranch: 'main', mainPath: '/repo', cleanup: false,
    refreshed: false, refreshReason: 'main worktree is not on main', cleaned: false,
    localBranchDeleted: false, remoteBranchDeleteAttempted: false, remoteBranchDeleted: false,
  });
  assert.match(messages[0], /commit or stash.*confirm it is clean/);
  assert.match(messages[0], /git -C \/repo switch main/);
  assert.ok(messages[0].indexOf('switch main') < messages[0].indexOf('merge --ff-only'));
});
