import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  acquireLease,
  claimFeature,
  featureBlockers,
  leaseStatus,
  normalizeCoordination,
  refreshLease,
  releaseResources,
  reserveResources,
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
  mkdirSync(`${path}.lock`);
  const lock = openSync(join(`${path}.lock`, 'live.json'), 'wx');
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'test-host', createdAt: 1_000 }));
    assert.throws(() => updateCoordination(path, (state) => state, {
      host: 'test-host', now: 2_000, processAlive: () => true,
    }), /being updated/);
  } finally {
    closeSync(lock);
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomic coordination update reclaims a lock owned by a dead local process', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-coordinate-'));
  const path = join(root, 'state', 'features.json');
  mkdirSync(join(root, 'state'));
  mkdirSync(`${path}.lock`);
  writeFileSync(join(`${path}.lock`, 'dead.json'), JSON.stringify({ pid: 404, host: 'test-host', createdAt: 1_000 }));
  try {
    const state = updateCoordination(path, (current) => current, {
      host: 'test-host',
      now: 2_000,
      processAlive: () => false,
    });
    assert.deepEqual(state.features, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a stale legacy lock file migrates to the contender-directory protocol', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-coordinate-'));
  const path = join(root, 'state', 'features.json');
  mkdirSync(join(root, 'state'));
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: 404, host: 'test-host', createdAt: 1_000 }));
  try {
    const state = updateCoordination(path, (current) => current, {
      host: 'test-host', now: 2_000, processAlive: () => false,
    });
    assert.deepEqual(state.features, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('stale-lock reclamation serializes competing reclaimers', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-coordinate-'));
  const path = join(root, 'state', 'features.json');
  mkdirSync(join(root, 'state'));
  mkdirSync(`${path}.lock`);
  writeFileSync(join(`${path}.lock`, 'dead.json'), JSON.stringify({ pid: 404, host: 'test-host', createdAt: 1_000 }));
  let competingError;
  try {
    updateCoordination(path, (current) => current, {
      host: 'test-host',
      now: 2_000,
      processAlive(pid) {
        if (pid !== 404) return true;
        try {
          updateCoordination(path, (current) => current, {
            host: 'test-host', now: 2_001, processAlive: (candidate) => candidate !== 404,
          });
        } catch (error) {
          competingError = error;
        }
        return false;
      },
    });
    assert.match(competingError?.message ?? '', /being updated/);
  } finally {
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
  let first = acquireLease(empty(), 'feat/x', {
    id: 'one', owner: 'alice@host', host: 'host', pid: 10,
    now: 1_000, timeoutMs: 60_000, processAlive: () => true, resources: ['port:3000'],
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
  assert.equal(reclaimed.resources['port:3000'], undefined);
  assert.equal(releaseLease(reclaimed, 'feat/x', 'two').resources['port:3000'], undefined);
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

test('two features cannot reserve the same shared resource', () => {
  const first = reserveResources(empty(), 'feat/api', ['port:3000'], { owner: 'api', leaseId: 'one' });
  assert.throws(() => reserveResources(first, 'feat/ui', ['port:3000'], { owner: 'ui', leaseId: 'two' }), /feat\/api.*api/);
  const released = releaseResources(first, 'feat/api', { leaseId: 'one' });
  assert.equal(released.resources['port:3000'], undefined);
});

test('releasing one lease does not remove a persistent feature reservation', () => {
  let state = reserveResources(empty(), 'feat/api', ['db:test'], { owner: 'api' });
  state = reserveResources(state, 'feat/api', ['db:test'], { owner: 'api', leaseId: 'lease' });
  state = releaseResources(state, 'feat/api', { leaseId: 'lease' });
  assert.equal(state.resources['db:test'].branch, 'feat/api');
  assert.equal(state.resources['db:test'].leaseId, null);
});
