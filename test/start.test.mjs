import { test } from 'node:test';
import assert from 'node:assert/strict';

import { launchInWorktree } from '../src/commands/start.mjs';

test('launchInWorktree runs the exact argv in the worktree and propagates status', () => {
  let seen;
  const status = launchInWorktree('/repo-feat-x', ['codex', '--profile', 'fast'], {
    run(command, args, options) { seen = { command, args, options }; return { status: 9 }; },
  });
  assert.equal(status, 9);
  assert.deepEqual(seen.args, ['--profile', 'fast']);
  assert.equal(seen.options.cwd, '/repo-feat-x');
});
