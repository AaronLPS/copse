import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gitCommonDir } from './git.mjs';

function clone(state) { return JSON.parse(JSON.stringify(state)); }

function reaches(state, from, target, seen = new Set()) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (state.features[from]?.dependsOn ?? []).some((next) => reaches(state, next, target, seen));
}

export function claimFeature(state, branch, { owner, dependsOn = [] }) {
  const next = clone(state);
  if (next.version !== 1) throw new Error(`unsupported coordination version ${next.version}`);
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
  const next = clone(state);
  if (!next.features[branch]) throw new Error(`${branch} is not claimed`);
  next.features[branch].status = 'released';
  return next;
}

export function featureBlockers(state, branch) {
  return (state.features[branch]?.dependsOn ?? []).filter((dep) => state.features[dep]?.status !== 'released');
}

export function loadCoordination(path) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (state.version !== 1 || typeof state.features !== 'object' || state.features === null) throw new Error('invalid coordination state');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, features: {} };
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
