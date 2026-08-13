import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gitCommonDir } from './git.mjs';

function clone(state) { return JSON.parse(JSON.stringify(state)); }

export function normalizeCoordination(state) {
  if (state?.version !== 1 || typeof state.features !== 'object' || state.features === null) {
    throw new Error('invalid coordination state');
  }
  return {
    version: 1,
    features: clone(state.features),
    leases: clone(state.leases ?? {}),
    resources: clone(state.resources ?? {}),
  };
}

function reaches(state, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (state.features[from]?.dependsOn ?? []).some((next) => reaches(state, next, target, seen));
}

export function claimFeature(state, branch, { owner, dependsOn = [] }) {
  const next = normalizeCoordination(state);
  const current = next.features[branch];
  if (current?.status === 'active' && current.owner !== owner) throw new Error(`${branch} is already owned by ${current.owner}`);
  if (dependsOn.includes(branch)) throw new Error(`${branch} cannot depend on itself`);
  next.features[branch] = { owner, dependsOn: [...new Set(dependsOn)], status: 'active' };
  for (const dependency of dependsOn) {
    if (reaches(next, dependency, branch)) throw new Error(`dependency cycle involving ${branch}`);
  }
  return next;
}

export function releaseFeature(state, branch) {
  const next = normalizeCoordination(state);
  if (!next.features[branch]) throw new Error(`${branch} is not claimed`);
  next.features[branch].status = 'released';
  return next;
}

export function featureBlockers(state, branch) {
  return (state.features[branch]?.dependsOn ?? []).filter((dep) => state.features[dep]?.status !== 'released');
}

export function leaseStatus(lease, {
  now = Date.now(),
  host,
  processAlive = () => true,
} = {}) {
  if (!lease) return 'absent';
  if (now - lease.heartbeatAt > lease.timeoutMs) return 'stale';
  if (host && lease.host === host) {
    try {
      if (!processAlive(lease.childPid ?? lease.pid)) return 'stale';
    } catch {
      // Unknown liveness must block rather than granting a second writer.
    }
  }
  return 'active';
}

export function acquireLease(state, branch, {
  id,
  owner,
  host,
  pid,
  childPid = null,
  label = null,
  now = Date.now(),
  timeoutMs,
  processAlive = () => true,
}) {
  const next = normalizeCoordination(state);
  const existing = next.leases[branch];
  if (leaseStatus(existing, { now, host, processAlive }) === 'active') {
    throw new Error(`${branch} already has an active session owned by ${existing.owner}`);
  }
  next.leases[branch] = {
    id,
    owner,
    host,
    pid,
    childPid,
    label,
    createdAt: now,
    heartbeatAt: now,
    timeoutMs,
  };
  return next;
}

export function refreshLease(state, branch, leaseId, { now = Date.now(), childPid } = {}) {
  const next = normalizeCoordination(state);
  const lease = next.leases[branch];
  if (!lease || lease.id !== leaseId) throw new Error(`${branch} lease changed before refresh`);
  lease.heartbeatAt = now;
  if (childPid !== undefined) lease.childPid = childPid;
  return next;
}

export function releaseLease(state, branch, leaseId) {
  const next = normalizeCoordination(state);
  const lease = next.leases[branch];
  if (!lease) return next;
  if (lease.id !== leaseId) throw new Error(`${branch} lease changed before release`);
  delete next.leases[branch];
  return next;
}

export function loadCoordination(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return normalizeCoordination(state);
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeCoordination({ version: 1, features: {} });
    throw error;
  }
}

export function saveCoordination(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx' });
  renameSync(temp, path);
}

export function updateCoordination(path, updater) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let lock;
  try {
    lock = openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`coordination state is being updated: ${path}`);
    throw error;
  }
  try {
    const next = updater(loadCoordination(path));
    saveCoordination(path, next);
    return next;
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function coordinationStatePath({ cwd = process.cwd() } = {}) {
  return `${gitCommonDir({ cwd })}/copse/features.json`;
}
