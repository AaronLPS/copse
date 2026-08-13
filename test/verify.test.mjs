import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runVerification } from '../src/commands/verify.mjs';

test('verification refuses an empty check list', () => {
  assert.throws(() => runVerification([], { cwd: '/tmp', run: () => ({ status: 0 }) }), /no checks/);
});

test('verification runs argv in order and stops at first failure', () => {
  const calls = [];
  const status = runVerification([['one', 'a'], ['two'], ['three']], {
    cwd: '/repo',
    run(command, args) { calls.push([command, ...args]); return { status: command === 'two' ? 5 : 0 }; },
  });
  assert.equal(status, 5);
  assert.deepEqual(calls, [['one', 'a'], ['two']]);
});
