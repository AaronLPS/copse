import { test } from 'node:test';
import assert from 'node:assert/strict';

import { configWithRunner, runnerForPackage, runnerPackageFromArgv } from '../src/runner.mjs';

test('a package spec becomes literal npx argv', () => {
  assert.deepEqual(runnerForPackage('github:AaronLPS/copse#b928453'), [
    'npx', '--yes', 'github:AaronLPS/copse#b928453',
  ]);
});

test('runner package parsing refuses missing, repeated and option-like values', () => {
  assert.throws(() => runnerPackageFromArgv(['init', '--runner-package']), /requires a value/);
  assert.throws(() => runnerPackageFromArgv([
    'init', '--runner-package', 'copse@1', '--runner-package', 'copse@2',
  ]), /only once/);
  assert.throws(() => runnerForPackage('--package=evil'), /package spec/);
});

test('a runner update preserves every other config value', () => {
  const raw = { baseBranch: 'devel', carryFiles: ['.env'], runner: ['old'] };
  assert.deepEqual(configWithRunner(raw, ['npx', '--yes', 'copse@0.4.0']), {
    baseBranch: 'devel', carryFiles: ['.env'], runner: ['npx', '--yes', 'copse@0.4.0'],
  });
  assert.deepEqual(raw.runner, ['old']);
});
