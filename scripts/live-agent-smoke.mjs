#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const commandWrapper = fileURLToPath(new URL('./live-agent-command.mjs', import.meta.url));
const supervisor = fileURLToPath(new URL('./fixtures/session-supervisor.mjs', import.meta.url));
const SETUP_TIMEOUT_MS = 30_000;
const LIFECYCLE_TIMEOUT_MS = 10_000;
const CHILD_EXIT_TIMEOUT_MS = 2_000;

function commandFromEnv(name) {
  let value;
  try {
    value = JSON.parse(process.env[name] ?? '');
  } catch {
    throw new Error(`${name} must be a JSON argv array`);
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== 'string' || part === '')
  ) {
    throw new Error(`${name} must be a non-empty JSON argv array`);
  }
  return value;
}

function run(command, args, { signal, ...options } = {}) {
  signal?.throwIfAborted();
  const output = execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: SETUP_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    ...options,
  }).trim();
  signal?.throwIfAborted();
  return output;
}

function waitFor(check, description, { signal, timeoutMs = LIFECYCLE_TIMEOUT_MS }) {
  const started = Date.now();
  return new Promise((resolveWait, reject) => {
    const inspect = () => {
      try {
        signal?.throwIfAborted();
        const value = check();
        if (value) return resolveWait(value);
        if (Date.now() - started >= timeoutMs) {
          return reject(new Error(`timed out waiting for ${description}`));
        }
        setTimeout(inspect, 25);
      } catch (error) {
        reject(error);
      }
    };
    inspect();
  });
}

function startSupervised(command, args, { cwd, env, temp, label }) {
  const statusPath = join(temp, `${label}-supervisor.json`);
  const child = spawn(process.execPath, [supervisor, statusPath, '--', command, ...args], {
    cwd,
    env,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: 'ignore',
  });
  const record = {
    child,
    label,
    statusPath,
    completed: null,
    stdout: '',
    stderr: '',
  };
  record.outcome = new Promise((resolveExit) => {
    child.once('error', (error) => resolveExit({ error }));
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  record.outcome.then((outcome) => { record.completed = outcome; });
  return record;
}

function refreshSupervisor(record) {
  if (!record || !existsSync(record.statusPath)) return null;
  const status = JSON.parse(readFileSync(record.statusPath, 'utf8'));
  record.stdout = status.stdout ?? record.stdout;
  record.stderr = status.stderr ?? record.stderr;
  return status;
}

function processOutput(record) {
  refreshSupervisor(record);
  return `${record.label} stdout:\n${record.stdout || '<empty>'}\n` +
    `${record.label} stderr:\n${record.stderr || '<empty>'}`;
}

function lifecycleDiagnostics(records, statePath) {
  let state = '<absent>';
  try {
    if (existsSync(statePath)) state = readFileSync(statePath, 'utf8');
  } catch (error) {
    state = `<unreadable: ${error.message}>`;
  }
  return [`Coordination state:\n${state}`, ...records.map(processOutput)].join('\n');
}

async function requireSuccess(record, signal) {
  const launcher = await waitFor(() => {
    const status = refreshSupervisor(record);
    if (status?.launcher?.completed) return status.launcher;
    if (record.completed) {
      throw new Error(`${record.label} supervisor exited before reporting launcher status`);
    }
    return null;
  }, `${record.label} launcher completion`, { signal });
  if (launcher.error || launcher.code !== 0) {
    throw new Error(
      `${record.label} launcher failed (${launcher.error ?? launcher.signal ?? launcher.code})\n` +
      processOutput(record),
    );
  }
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function processGroupIsAlive(pgid) {
  if (process.platform === 'win32' || !Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function outcomeWithin(record, timeoutMs) {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(null), timeoutMs);
    timer.unref?.();
    record.outcome.then((outcome) => {
      clearTimeout(timer);
      resolveWait(outcome);
    });
  });
}

async function stopSupervisors(records) {
  for (const record of records) {
    refreshSupervisor(record);
    if (record.completed?.error && !record.child.pid) continue;
    if (record.completed || !pidIsAlive(record.child.pid)) {
      throw new Error(
        `${record.label} supervisor exited before owned-tree teardown; refusing a stale PID/group target`,
      );
    }

    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(record.child.pid), '/T', '/F'], {
          stdio: 'ignore',
          timeout: CHILD_EXIT_TIMEOUT_MS,
        });
      } catch (error) {
        throw new Error(`taskkill could not terminate ${record.label} supervisor tree: ${error.message}`);
      }
      if (!await outcomeWithin(record, CHILD_EXIT_TIMEOUT_MS) || pidIsAlive(record.child.pid)) {
        throw new Error(`could not prove ${record.label} supervisor tree exited`);
      }
      continue;
    }

    process.kill(-record.child.pid, 'SIGTERM');
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    if (record.completed || !pidIsAlive(record.child.pid)) {
      throw new Error(`${record.label} supervisor did not retain its process group through graceful teardown`);
    }
    process.kill(-record.child.pid, 'SIGKILL');
    if (!await outcomeWithin(record, CHILD_EXIT_TIMEOUT_MS)) {
      throw new Error(`${record.label} supervisor did not exit after owned-group SIGKILL`);
    }
    await waitFor(
      () => !processGroupIsAlive(record.child.pid),
      `${record.label} process group teardown`,
      { timeoutMs: CHILD_EXIT_TIMEOUT_MS },
    );
  }
}

function sameMarker(actual, expected) {
  return actual.cwd === expected.cwd && actual.branch === expected.branch;
}

function withCleanupFailure(primary, cleanup) {
  if (!primary) return cleanup;
  if (!cleanup) return primary;
  return new Error(`${primary.message}\ncleanup failed: ${cleanup.message}`);
}

async function runLiveAcceptance(codexCommand, claudeCommand) {
  const controller = new AbortController();
  const abort = (signal) => controller.abort(new Error(`live agent acceptance interrupted by ${signal}`));
  const onSigint = () => abort('SIGINT');
  const onSigterm = () => abort('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  let temp;
  const records = [];
  let failure = null;
  let acceptanceMessage = null;
  try {
    temp = mkdtempSync(join(tmpdir(), 'copse-live-agent-'));
    const disposableEnv = {
      ...process.env,
      npm_config_cache: join(temp, 'npm-cache'),
    };
    const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], {
      cwd: projectRoot,
      env: disposableEnv,
      signal: controller.signal,
    }));
    const artifact = join(temp, packed[0].filename);
    const remote = join(temp, 'origin.git');
    const consumer = join(temp, 'consumer');
    const codexMarker = join(temp, 'live-codex.json');
    const claudeMarker = join(temp, 'live-claude.json');

    const gitEnv = {
      ...disposableEnv,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    run('git', ['init', '--bare', '-b', 'main', remote], { cwd: temp, env: gitEnv, signal: controller.signal });
    run('git', ['init', '-b', 'main', consumer], { cwd: temp, env: gitEnv, signal: controller.signal });
    run('git', ['config', 'user.email', 'live-smoke@example.invalid'], {
      cwd: consumer, env: gitEnv, signal: controller.signal,
    });
    run('git', ['config', 'user.name', 'Copse Live Smoke'], {
      cwd: consumer, env: gitEnv, signal: controller.signal,
    });
    writeFileSync(join(consumer, '.gitignore'), 'node_modules/\n');
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n');
    run('npm', ['install', '--ignore-scripts', artifact], {
      cwd: consumer, env: gitEnv, signal: controller.signal,
    });
    const copse = join(consumer, 'node_modules', '.bin', 'copse');
    const config = {
      baseBranch: 'main',
      agents: {
        codex: [process.execPath, commandWrapper, codexMarker, '--', ...codexCommand],
        claude: [process.execPath, commandWrapper, claudeMarker, '--', ...claudeCommand],
      },
    };
    writeFileSync(join(consumer, 'copse.config.json'), JSON.stringify(config, null, 2) + '\n');
    run('git', ['add', '.gitignore', 'package.json', 'package-lock.json', 'copse.config.json'], {
      cwd: consumer, env: gitEnv, signal: controller.signal,
    });
    run('git', ['commit', '-m', 'initial'], { cwd: consumer, env: gitEnv, signal: controller.signal });
    run('git', ['remote', 'add', 'origin', remote], { cwd: consumer, env: gitEnv, signal: controller.signal });
    run('git', ['push', '-u', 'origin', 'main'], {
      cwd: consumer, env: gitEnv, signal: controller.signal,
    });

    run(copse, ['new', 'feat/live-codex'], {
      cwd: consumer, env: gitEnv, signal: controller.signal,
    });
    run(copse, ['new', 'feat/live-claude'], {
      cwd: consumer, env: gitEnv, signal: controller.signal,
    });

    if (run('git', ['status', '--short'], { cwd: consumer, env: gitEnv, signal: controller.signal }) !== '') {
      throw new Error('disposable main worktree was not clean before live sessions');
    }

    const startEnv = { ...gitEnv };
    const codexSession = startSupervised(copse, [
      'start', 'feat/live-codex', '--agent', 'codex', '--owner', 'live-codex@host',
    ], { cwd: consumer, env: startEnv, temp, label: 'Codex' });
    records.push(codexSession);
    const statePath = join(consumer, '.git', 'copse', 'features.json');
    await waitFor(() => {
      const status = refreshSupervisor(codexSession);
      if (status?.launcher?.completed || codexSession.completed) {
        throw new Error(
          `Codex launcher completed before the Claude session could start\n` +
          lifecycleDiagnostics(records, statePath),
        );
      }
      if (!existsSync(statePath) || !existsSync(codexMarker)) return null;
      const lease = JSON.parse(readFileSync(statePath, 'utf8')).leases?.['feat/live-codex'];
      return Number.isInteger(lease?.childPid) ? lease : null;
    }, 'initial live Codex marker and lease', { signal: controller.signal });

    const claudeSession = startSupervised(copse, [
      'start', 'feat/live-claude', '--agent', 'claude', '--owner', 'live-claude@host',
    ], { cwd: consumer, env: startEnv, temp, label: 'Claude' });
    records.push(claudeSession);

    const overlap = await waitFor(() => {
      for (const record of records) {
        const status = refreshSupervisor(record);
        if (status?.launcher?.completed) {
          throw new Error(
            `${record.label} launcher completed before both live leases overlapped\n` +
            lifecycleDiagnostics(records, statePath),
          );
        }
        if (record.completed) {
          throw new Error(
            `${record.label} supervisor exited during live startup\n` + lifecycleDiagnostics(records, statePath),
          );
        }
      }
      if (!existsSync(statePath) || !existsSync(codexMarker) || !existsSync(claudeMarker)) return null;
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      const codexLease = state.leases?.['feat/live-codex'];
      const claudeLease = state.leases?.['feat/live-claude'];
      return Number.isInteger(codexLease?.childPid) && Number.isInteger(claudeLease?.childPid)
        ? state
        : null;
    }, 'two live cwd markers and leases to overlap', { signal: controller.signal });

    if (Object.keys(overlap.leases).length !== 2) {
      throw new Error('live acceptance did not observe exactly two simultaneous leases');
    }
    if (
      overlap.leases['feat/live-codex'].owner !== 'live-codex@host' ||
      overlap.leases['feat/live-claude'].owner !== 'live-claude@host'
    ) {
      throw new Error('live acceptance observed unexpected lease owners');
    }

    const codexContext = JSON.parse(readFileSync(codexMarker, 'utf8'));
    const claudeContext = JSON.parse(readFileSync(claudeMarker, 'utf8'));
    const expectedCodex = { cwd: `${consumer}-feat-live-codex`, branch: 'feat/live-codex' };
    const expectedClaude = { cwd: `${consumer}-feat-live-claude`, branch: 'feat/live-claude' };
    if (!sameMarker(codexContext, expectedCodex)) {
      throw new Error(`Codex command ran outside its disposable worktree: ${JSON.stringify(codexContext)}`);
    }
    if (!sameMarker(claudeContext, expectedClaude)) {
      throw new Error(`Claude command ran outside its disposable worktree: ${JSON.stringify(claudeContext)}`);
    }
    if (codexContext.cwd === claudeContext.cwd) throw new Error('live commands shared a worktree');

    await Promise.all([
      requireSuccess(codexSession, controller.signal),
      requireSuccess(claudeSession, controller.signal),
    ]);
    await waitFor(() => {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      return Object.keys(state.leases ?? {}).length === 0 ? state : null;
    }, 'both live leases to release', { signal: controller.signal });

    if (run('git', ['branch', '--show-current'], {
      cwd: consumer, env: gitEnv, signal: controller.signal,
    }) !== 'main') {
      throw new Error('live acceptance moved the disposable main worktree off main');
    }
    if (run('git', ['status', '--short'], {
      cwd: consumer, env: gitEnv, signal: controller.signal,
    }) !== '') {
      throw new Error('live acceptance dirtied the disposable main worktree');
    }
    acceptanceMessage = `live agent acceptance ok: ${packed[0].filename}, two overlapping sessions`;
  } catch (error) {
    failure = error;
  }

  let cleanupFailure = null;
  try {
    await stopSupervisors(records);
  } catch (error) {
    cleanupFailure = error;
  }
  try {
    if (temp) rmSync(temp, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = withCleanupFailure(cleanupFailure, error);
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
  }

  const finalFailure = withCleanupFailure(failure, cleanupFailure);
  if (finalFailure) throw finalFailure;
  writeSync(1, `${acceptanceMessage}\n`);
}

async function main() {
  if (process.env.COPSE_LIVE_AGENT_TEST !== '1') {
    throw new Error('live agent acceptance is disabled; set COPSE_LIVE_AGENT_TEST=1 explicitly');
  }
  const codexCommand = commandFromEnv('COPSE_CODEX_COMMAND');
  const claudeCommand = commandFromEnv('COPSE_CLAUDE_COMMAND');
  await runLiveAcceptance(codexCommand, claudeCommand);
}

try {
  await main();
} catch (error) {
  writeSync(2, `${error.message}\n`);
  process.exitCode = 1;
}
