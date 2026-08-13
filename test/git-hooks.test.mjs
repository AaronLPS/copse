import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COPSE_HOOKS_PATH, DEFAULT_HOOKS_SENTINEL, desiredGitHooks, hookMigration, legacyGitHooks,
  resolveDelegatedHook,
} from '../src/git-hooks.mjs';
import { reconcileWiring } from '../src/wiring.mjs';

const config = { runner: ['npx', '--yes', 'github:owner/repo#abc'] };

test('new installs delegate the default Git hooks directory', () => {
  assert.deepEqual(hookMigration({ currentHooksPath: null, recordedPrevious: null, legacyCopse: false }), {
    previous: DEFAULT_HOOKS_SENTINEL, changePath: true,
  });
});

test('existing and legacy hook paths never delegate to copse itself', () => {
  assert.equal(hookMigration({
    currentHooksPath: '.husky', recordedPrevious: null, legacyCopse: false,
  }).previous, '.husky');
  assert.equal(hookMigration({
    currentHooksPath: COPSE_HOOKS_PATH, recordedPrevious: '.husky', legacyCopse: false,
  }).previous, '.husky');
  assert.equal(hookMigration({
    currentHooksPath: '.githooks', recordedPrevious: null, legacyCopse: true,
  }).previous, DEFAULT_HOOKS_SENTINEL);
});

test('pre-push captures and replays stdin while quoting the runner', () => {
  const script = desiredGitHooks(config).get('.copse/hooks/pre-push');
  assert.match(script, /mktemp/);
  assert.match(script, /hook pre-push/);
  assert.match(script, /< "\$input"/);
  assert.match(script, /'github:owner\/repo#abc'/);
});

test('delegated paths resolve without cycles', () => {
  assert.equal(resolveDelegatedHook({
    previous: '.husky', event: 'pre-commit', root: '/repo', commonDir: '/repo/.git',
  }), '/repo/.husky/pre-commit');
  assert.equal(resolveDelegatedHook({
    previous: DEFAULT_HOOKS_SENTINEL, event: 'pre-push', root: '/repo', commonDir: '/repo/.git',
  }), '/repo/.git/hooks/pre-push');
  assert.throws(() => resolveDelegatedHook({
    previous: COPSE_HOOKS_PATH, event: 'pre-commit', root: '/repo', commonDir: '/repo/.git',
  }), /cycle/);
});

test('legacy renderer preserves the v0.3 forwards for migration matching', () => {
  assert.deepEqual([...legacyGitHooks(config)], [
    ['.githooks/pre-commit', "#!/bin/sh\ncd \"$(git rev-parse --show-toplevel)\" || exit 1\nexec 'npx' '--yes' 'github:owner/repo#abc' hook pre-commit \"$@\"\n"],
    ['.githooks/pre-push', "#!/bin/sh\ncd \"$(git rev-parse --show-toplevel)\" || exit 1\nexec 'npx' '--yes' 'github:owner/repo#abc' hook pre-push \"$@\"\n"],
  ]);
});

test('reconciliation marks newly rendered Git wrappers executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-hooks-'));
  try {
    reconcileWiring(root, desiredGitHooks(config), { apply: true });
    assert.equal(statSync(join(root, '.copse/hooks/pre-commit')).mode & 0o777, 0o755);
    assert.equal(statSync(join(root, '.copse/hooks/pre-push')).mode & 0o777, 0o755);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reconciliation repairs exact Copse wrappers that lost execute mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-hooks-'));
  try {
    const desired = desiredGitHooks(config);
    reconcileWiring(root, desired, { apply: true });
    for (const relative of desired.keys()) chmodSync(join(root, relative), 0o644);

    const report = reconcileWiring(root, desired, { apply: true });

    assert.deepEqual(report.updated, [...desired.keys()]);
    for (const relative of desired.keys()) {
      assert.equal(statSync(join(root, relative)).mode & 0o111, 0o111);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
