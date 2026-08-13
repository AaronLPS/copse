import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { inspectListeningPort, runCommand, runInteractive } from '../src/process.mjs';

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

test('runInteractive exposes the child pid and resolves its exact exit status', async () => {
  const child = new EventEmitter();
  child.pid = 42;
  let invocation;
  const result = runInteractive('codex', ['--profile', 'fast'], {
    cwd: '/repo-feat-x',
    spawn(command, args, options) {
      invocation = { command, args, options };
      queueMicrotask(() => child.emit('exit', 9, null));
      return child;
    },
    onSpawn(pid) { assert.equal(pid, 42); },
  });
  assert.equal(await result, 9);
  assert.deepEqual(invocation.args, ['--profile', 'fast']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio, 'inherit');
});

test('inspectListeningPort reports the listener pid, command and cwd when lsof can measure them', () => {
  const calls = [];
  const owner = inspectListeningPort('port:3000', {
    run(command, args) {
      calls.push([command, args]);
      if (args.includes('-iTCP:3000')) return { ok: true, stdout: 'p42\ncnode\n', stderr: '', status: 0 };
      return { ok: true, stdout: 'p42\nfcwd\nn/worktrees/feat-api\n', stderr: '', status: 0 };
    },
  });

  assert.deepEqual(owner, { port: 3000, pid: 42, command: 'node', cwd: '/worktrees/feat-api' });
  assert.equal(calls.length, 2);
  assert.equal(inspectListeningPort('database:test'), null);
});
