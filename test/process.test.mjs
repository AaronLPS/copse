import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCommand } from '../src/process.mjs';

test('runCommand passes argv directly and disables shell parsing', () => {
  let invocation;
  const result = runCommand('agent', ['two words', ';'], {
    spawn(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: 'ok', stderr: '' };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(invocation.args, ['two words', ';']);
  assert.equal(invocation.options.shell, false);
});

test('runCommand exposes a non-zero status without throwing when allowed', () => {
  const result = runCommand('git', ['rev-parse', '--verify', 'definitely-missing-ref'], { allowFailure: true });
  assert.equal(result.ok, false);
  assert.notEqual(result.status, 0);
});
