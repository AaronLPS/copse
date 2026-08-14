import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname } from 'node:path';
import { gitCommonDir, worktreeRoot } from './git.mjs';
import { repositoryFileState } from './path-safety.mjs';

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
  return releaseResources(next, branch, {});
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
  resources = [],
}) {
  let next = normalizeCoordination(state);
  const existing = next.leases[branch];
  if (leaseStatus(existing, { now, host, processAlive }) === 'active') {
    throw new Error(`${branch} already has an active session owned by ${existing.owner}`);
  }
  if (existing) next = releaseResources(next, branch, { leaseId: existing.id });
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
  return reserveResources(next, branch, resources, { owner, leaseId: id });
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
  return releaseResources(next, branch, { leaseId });
}

export function reserveResources(state, branch, names, { owner, leaseId = null } = {}) {
  const next = normalizeCoordination(state);
  for (const name of [...new Set(names)]) {
    const existing = next.resources[name];
    if (existing && existing.branch !== branch) {
      throw new Error(`${name} is reserved by ${existing.branch} (${existing.owner})`);
    }
    if (!existing) next.resources[name] = { branch, owner, leaseId };
  }
  return next;
}

export function releaseResources(state, branch, { leaseId } = {}) {
  const next = normalizeCoordination(state);
  for (const [name, reservation] of Object.entries(next.resources)) {
    if (reservation.branch !== branch) continue;
    if (leaseId !== undefined && reservation.leaseId !== leaseId) continue;
    delete next.resources[name];
  }
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

function localProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function staleLock(path, {
  now,
  host,
  processAlive,
  lockTimeoutMs,
}) {
  let record = null;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { /* legacy or interrupted lock write */ }
  const createdAt = Number.isFinite(record?.createdAt)
    ? record.createdAt
    : statSync(path).mtimeMs;
  if (now - createdAt > lockTimeoutMs) return true;
  return record?.host === host && !processAlive(record.pid);
}

function ensureLockDirectory(lockPath, statePath, options) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }

    let stat;
    try { stat = lstatSync(lockPath); }
    catch (error) { if (error.code === 'ENOENT') continue; else throw error; }
    if (stat.isDirectory()) return;
    if (!staleLock(lockPath, options)) {
      throw new Error(`coordination state is being updated: ${statePath}`);
    }
    try { unlinkSync(lockPath); }
    catch (error) {
      if (['ENOENT', 'EISDIR', 'EPERM'].includes(error.code)) continue;
      throw error;
    }
  }
  throw new Error(`coordination state is being updated: ${statePath}`);
}

export function updateCoordination(path, updater, {
  now = Date.now(),
  host = hostname(),
  processAlive = localProcessAlive,
  lockTimeoutMs = 30_000,
} = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  ensureLockDirectory(lockPath, path, { now, host, processAlive, lockTimeoutMs });
  const contenderName = `${randomUUID()}.json`;
  const contenderPath = `${lockPath}/${contenderName}`;
  writeFileSync(contenderPath, JSON.stringify({ pid: process.pid, host, createdAt: now }) + '\n', { flag: 'wx' });

  const contenders = [];
  try {
    for (const name of readdirSync(lockPath)) {
      const contender = `${lockPath}/${name}`;
      if (name !== contenderName) {
        let stale;
        try {
          stale = staleLock(contender, { now, host, processAlive, lockTimeoutMs });
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        if (stale) {
          try { unlinkSync(contender); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          continue;
        }
      }
      let stat;
      try { stat = statSync(contender, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') continue; else throw error; }
      let record = null;
      try { record = JSON.parse(readFileSync(contender, 'utf8')); } catch { /* legacy lock contender */ }
      const createdAt = Number.isFinite(record?.createdAt) ? record.createdAt : Number(stat.birthtimeMs);
      contenders.push({ name, createdAt, createdNs: stat.birthtimeNs });
    }
    contenders.sort((left, right) => {
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
      if (left.createdNs !== right.createdNs) return left.createdNs < right.createdNs ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    if (contenders[0]?.name !== contenderName) {
      throw new Error(`coordination state is being updated: ${path}`);
    }

    const next = updater(loadCoordination(path));
    saveCoordination(path, next);
    return next;
  } finally {
    try { unlinkSync(contenderPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { rmdirSync(lockPath); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
  }
}

export function coordinationStatePath({ cwd = process.cwd(), config } = {}) {
  const relative = config?.coordinationFile ?? '.copse/features.json';
  let root = null;
  try { root = worktreeRoot({ cwd }); } catch { /* bare repositories have no committed seed */ }
  const repositoryState = root ? repositoryFileState(root, relative) : null;
  if (repositoryState && !repositoryState.safe) {
    throw new Error(`unsafe coordinationFile ${relative}: ${repositoryState.problem}`);
  }
  if (config?.coordinationBackend === 'committed') {
    if (!root) throw new Error('committed coordination requires a working tree');
    return repositoryState.path;
  }
  const path = `${gitCommonDir({ cwd })}/copse/features.json`;
  const seed = repositoryState?.path ?? null;
  if (!existsSync(path) && seed && existsSync(seed)) saveCoordination(path, loadCoordination(seed));
  return path;
}
