import { test } from 'node:test';
import assert from 'node:assert/strict';

import { launchInWorktree } from '../src/commands/start.mjs';

test('launchInWorktree runs the exact argv in the worktree and propagates status', async () => {
  let seen;
  const status = await launchInWorktree('/repo-feat-x', ['codex', '--profile', 'fast'], {
    run(command, args, options) { seen = { command, args, options }; return Promise.resolve(9); },
  });
  assert.equal(status, 9);
  assert.deepEqual(seen.args, ['--profile', 'fast']);
  assert.equal(seen.options.cwd, '/repo-feat-x');
});
