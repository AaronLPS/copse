import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acquireLease,
  claimFeature,
  featureBlockers,
  leaseStatus,
  normalizeCoordination,
  refreshLease,
  releaseFeature,
  releaseLease,
  updateCoordination,
} from '../src/coordination.mjs';

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

test('legacy coordination state gains empty lease and resource maps', () => {
  assert.deepEqual(normalizeCoordination(empty()), {
    version: 1,
    features: {},
    leases: {},
    resources: {},
  });
});

test('a live lease blocks every duplicate start and a dead lease is reclaimed', () => {
  const first = acquireLease(empty(), 'feat/x', {
    id: 'one', owner: 'alice@host', host: 'host', pid: 10,
    now: 1_000, timeoutMs: 60_000, processAlive: () => true,
  });
  assert.throws(() => acquireLease(first, 'feat/x', {
    id: 'two', owner: 'alice@host', host: 'host', pid: 11,
    now: 2_000, timeoutMs: 60_000, processAlive: () => true,
  }), /active session.*alice@host/);

  const reclaimed = acquireLease(first, 'feat/x', {
    id: 'two', owner: 'alice@host', host: 'host', pid: 11,
    now: 2_000, timeoutMs: 60_000, processAlive: () => false,
  });
  assert.equal(reclaimed.leases['feat/x'].id, 'two');
});

test('lease expiry, refresh and id-scoped release are deterministic', () => {
  let state = acquireLease(empty(), 'feat/x', {
    id: 'one', owner: 'alice@host', host: 'host', pid: 10,
    now: 1_000, timeoutMs: 5_000, processAlive: () => true,
  });
  assert.equal(leaseStatus(state.leases['feat/x'], {
    now: 7_000, host: 'host', processAlive: () => true,
  }), 'stale');
  state = refreshLease(state, 'feat/x', 'one', { now: 7_000, childPid: 20 });
  assert.equal(state.leases['feat/x'].heartbeatAt, 7_000);
  assert.equal(state.leases['feat/x'].childPid, 20);
  assert.throws(() => releaseLease(state, 'feat/x', 'other'), /lease changed/);
  assert.equal(releaseLease(state, 'feat/x', 'one').leases['feat/x'], undefined);
});
