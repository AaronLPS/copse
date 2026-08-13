import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { runInteractive } from '../process.mjs';
import { worktrees } from '../git.mjs';
import {
  acquireLease,
  claimFeature,
  coordinationStatePath,
  refreshLease,
  releaseLease,
  updateCoordination,
} from '../coordination.mjs';
import { parseBranchName } from '../naming.mjs';
import { commandNew, CopseError } from './new.mjs';

export function launchInWorktree(path, argv, { run = runInteractive, onSpawn } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new CopseError('no agent command configured');
  return run(argv[0], argv.slice(1), { cwd: path, onSpawn });
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function defaultOwner(env = process.env, host = hostname()) {
  return `${env.USER || env.USERNAME || 'unknown'}@${host}`;
}

export async function commandStart(branch, {
  cwd = process.cwd(),
  config,
  agent = 'codex',
  command = null,
  owner = defaultOwner(),
  run = runInteractive,
  processAlive = processIsAlive,
  now = Date.now,
  leaseId = randomUUID(),
  resources = [],
} = {}) {
  if (!branch) throw new CopseError('usage: copse start <branch> [--agent codex|claude] [-- <command...>]');
  const parsed = parseBranchName(branch, config);
  if (!parsed.ok) throw new CopseError(parsed.reason);
  const argv = command ?? config.agents[agent];
  if (!argv) throw new CopseError(`unknown agent "${agent}"; configured agents: ${Object.keys(config.agents).join(', ')}`);

  let entry = worktrees({ cwd }).find((worktree) => worktree.branch === branch);
  if (!entry) {
    const created = commandNew(branch, { cwd, config });
    entry = { path: created.path, branch };
  }

  const statePath = coordinationStatePath({ cwd, config });
  const timeoutMs = config.leaseTimeoutSeconds * 1_000;
  const host = hostname();
  updateCoordination(statePath, (state) => {
    const feature = state.features[branch];
    let next = state;
    if (!feature || feature.status === 'released') {
      next = claimFeature(state, branch, { owner, dependsOn: feature?.dependsOn ?? [] });
    } else if (feature.owner !== owner) {
      throw new CopseError(`${branch} is already owned by ${feature.owner}`);
    }
    return acquireLease(next, branch, {
      id: leaseId,
      owner,
      host,
      pid: process.pid,
      label: command ? command.join(' ') : agent,
      now: now(),
      timeoutMs,
      processAlive,
      resources: [...(config.resources[branch] ?? []), ...resources],
    });
  });

  console.log(`→ launching ${argv.join(' ')} in ${entry.path}`);
  let heartbeat;
  try {
    const launched = launchInWorktree(entry.path, argv, {
      run,
      onSpawn(childPid) {
        updateCoordination(statePath, (state) => refreshLease(state, branch, leaseId, {
          now: now(),
          childPid,
        }));
        heartbeat = setInterval(() => {
          try {
            updateCoordination(statePath, (state) => refreshLease(state, branch, leaseId, {
              now: now(),
            }));
          } catch {
            clearInterval(heartbeat);
          }
        }, config.leaseHeartbeatSeconds * 1_000);
        heartbeat.unref?.();
      },
    });
    return await launched;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    try {
      updateCoordination(statePath, (state) => releaseLease(state, branch, leaseId));
    } catch {
      // A reclaimed lease belongs to another launcher and must not be removed.
    }
  }
}
