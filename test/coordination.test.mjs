import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { claimFeature, releaseFeature, featureBlockers, updateCoordination } from '../src/coordination.mjs';

const empty = () => ({ version: 1, features: {} });

test('claim records owner and dependencies', () => {
  const state = claimFeature(empty(), 'feat/ui', { owner: 'alice', dependsOn: ['feat/api'] });
  assert.deepEqual(state.features['feat/ui'], { owner: 'alice', dependsOn: ['feat/api'], status: 'active' });
});

test('atomic coordination update refuses a concurrent writer', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-coordinate-'));
  const path = join(root, 'state', 'features.json');
  mkdirSync(join(root, 'state'));
  const lock = openSync(`${path}.lock`, 'wx');
  try {
    assert.throws(() => updateCoordination(path, (state) => state), /being updated/);
  } finally {
    closeSync(lock);
    rmSync(root, { recursive: true, force: true });
  }
});

test('claim refuses ownership theft and dependency cycles', () => {
  let state = claimFeature(empty(), 'feat/a', { owner: 'alice', dependsOn: ['feat/b'] });
  state = claimFeature(state, 'feat/b', { owner: 'bob', dependsOn: [] });
  assert.throws(() => claimFeature(state, 'feat/a', { owner: 'bob', dependsOn: [] }), /owned by alice/);
  assert.throws(() => claimFeature(state, 'feat/b', { owner: 'bob', dependsOn: ['feat/a'] }), /cycle/);
});

test('release unblocks dependants', () => {
  let state = claimFeature(empty(), 'feat/api', { owner: 'a', dependsOn: [] });
  state = claimFeature(state, 'feat/ui', { owner: 'b', dependsOn: ['feat/api'] });
  assert.deepEqual(featureBlockers(state, 'feat/ui'), ['feat/api']);
  state = releaseFeature(state, 'feat/api');
  assert.deepEqual(featureBlockers(state, 'feat/ui'), []);
});
