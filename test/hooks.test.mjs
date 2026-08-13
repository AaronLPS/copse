import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gitHookDecision, agentHookOutput, normalizeAgentEvent } from '../src/hooks.mjs';

const config = { baseBranch: 'main', releaseBranch: null, branchPrefixes: ['feat', 'fix'] };

test('pre-commit refuses protected and illegal branches', () => {
  assert.match(gitHookDecision('pre-commit', { branch: 'main', config }).reason, /protected/);
  assert.match(gitHookDecision('pre-commit', { branch: 'wip/x', config }).reason, /branch name/);
  assert.equal(gitHookDecision('pre-commit', { branch: 'feat/x', config }).ok, true);
});

test('agent PreToolUse denies edits in the main worktree on the base branch', () => {
  const output = agentHookOutput({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: '/repo' }, {
    config, mainPath: '/repo', branch: 'main', worktreePath: '/repo',
  });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /copse start/);
});

test('agent SessionStart adds worktree and branch context', () => {
  const output = agentHookOutput({ hook_event_name: 'SessionStart', cwd: '/repo-feat-x' }, {
    config, mainPath: '/repo', branch: 'feat/x', worktreePath: '/repo-feat-x',
    feature: { owner: 'alice', status: 'active', dependsOn: ['feat/api'] }, blockedBy: ['feat/api'],
  });
  assert.match(output.hookSpecificOutput.additionalContext, /feat\/x/);
  assert.match(output.hookSpecificOutput.additionalContext, /owner alice/);
  assert.match(output.hookSpecificOutput.additionalContext, /blocked by feat\/api/);
});

test('pre-push refuses updating or deleting a protected remote ref', () => {
  const update = 'refs/heads/feat/x aaa refs/heads/main bbb';
  const deletion = '(delete) 000 refs/heads/main bbb';
  assert.match(gitHookDecision('pre-push', { branch: 'feat/x', config, updates: [update] }).reason, /protected/);
  assert.match(gitHookDecision('pre-push', { branch: 'feat/x', config, updates: [deletion] }).reason, /protected/);
});

test('Codex and Claude event field variants normalize to the shared policy', () => {
  const codex = normalizeAgentEvent({
    hookEventName: 'PreToolUse',
    toolName: 'exec_command',
    toolInput: { cmd: 'git commit -m x' },
    cwd: '/repo',
  });
  const claude = normalizeAgentEvent({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git commit -m x' },
    cwd: '/repo',
  });
  for (const input of [codex, claude]) {
    const output = agentHookOutput(input, { config, mainPath: '/repo', branch: 'main', worktreePath: '/repo' });
    assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  }
});

test('unified exec argv mutations are recognized without shell parsing', () => {
  const output = agentHookOutput({
    event: 'PreToolUse', tool: 'unified_exec', input: { argv: ['git', 'push', 'origin', 'main'] }, cwd: '/repo',
  }, { config, mainPath: '/repo', branch: 'main', worktreePath: '/repo' });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
});
