import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(new URL('..', import.meta.url).pathname);
// The package spec deliberately contains shell metacharacters. Every consumer
// must preserve it as one argv element, even where generated forwards use sh.
const temp = mkdtempSync(join(tmpdir(), 'copse-package-'));
const fixture = join(root, 'scripts', 'fixtures', 'recording-agent.mjs');
const codexMarker = join(temp, 'codex-marker.json');
const claudeMarker = join(temp, 'claude-marker.json');
const codexGate = join(temp, 'codex-gate');
const claudeGate = join(temp, 'claude-gate');
const runnerLog = join(temp, 'runner-invocations.jsonl');
const children = [];
const mutation = process.env.COPSE_PACKAGE_SMOKE_MUTATION ?? '';
const CHILD_EXIT_TIMEOUT_MS = 2_000;

class CleanupMutationComplete extends Error {}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function waitFor(check, timeoutMs = 5_000) {
  const started = Date.now();
  return new Promise((resolveWait, reject) => {
    const inspect = () => {
      try {
        const value = check();
        if (value) return resolveWait(value);
      } catch { /* state may be between atomic writes */ }
      if (Date.now() - started >= timeoutMs) return reject(new Error('timed out waiting for packaged lifecycle state'));
      setTimeout(inspect, 25);
    };
    inspect();
  });
}

function start(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { child, stdout: '', stderr: '', completed: null, agentPid: null };
  child.stdout.on('data', (chunk) => { record.stdout += chunk; });
  child.stderr.on('data', (chunk) => { record.stderr += chunk; });
  record.outcome = new Promise((resolveExit) => {
    child.once('error', (error) => resolveExit({ error }));
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  record.outcome.then((outcome) => { record.completed = outcome; });
  children.push(record);
  return record;
}

function processOutput(record, label) {
  return `${label} stdout:\n${record?.stdout ?? '<not started>'}\n` +
    `${label} stderr:\n${record?.stderr ?? '<not started>'}`;
}

async function requireSuccess(record, label, timeoutMs = CHILD_EXIT_TIMEOUT_MS) {
  const outcome = await outcomeWithin(record, timeoutMs);
  if (!outcome) {
    throw new Error(`${label} timed out after ${timeoutMs}ms\n${processOutput(record, label)}`);
  }
  if (outcome.error || outcome.code !== 0) {
    throw new Error(
      `${label} failed (${outcome.error?.message ?? outcome.signal ?? outcome.code})\n` +
      processOutput(record, label),
    );
  }
}

async function outcomeWithin(record, timeoutMs) {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(null), timeoutMs);
    timer.unref?.();
    record.outcome.then((outcome) => {
      clearTimeout(timer);
      resolveWait(outcome);
    });
  });
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

async function recordStoppedWithin(record, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (record.completed && !pidIsAlive(record.agentPid)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  return Boolean(record.completed) && !pidIsAlive(record.agentPid);
}

function taskkill(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* an already-exited process is the desired state */ }
}

function signalProcessTree(record, signal) {
  if (process.platform === 'win32') {
    if (!record.completed) taskkill(record.child.pid);
    if (pidIsAlive(record.agentPid)) taskkill(record.agentPid);
    return;
  }
  try { process.kill(-record.child.pid, signal); } catch { /* process group may already be gone */ }
  if (pidIsAlive(record.agentPid)) {
    try { process.kill(record.agentPid, signal); } catch { /* agent exited between checks */ }
  }
}

async function stopChildren() {
  for (const gate of [codexGate, claudeGate]) {
    try { writeFileSync(gate, 'release\n'); } catch { /* setup may have failed before the temp root was usable */ }
  }
  for (const record of children) {
    if (await recordStoppedWithin(record, CHILD_EXIT_TIMEOUT_MS)) continue;
    signalProcessTree(record, 'SIGTERM');
    if (await recordStoppedWithin(record, CHILD_EXIT_TIMEOUT_MS)) continue;
    signalProcessTree(record, 'SIGKILL');
    if (!await recordStoppedWithin(record, CHILD_EXIT_TIMEOUT_MS)) {
      throw new Error(
        `could not prove launcher ${record.child.pid} and configured agent ${record.agentPid ?? '<unknown>'} exited\n` +
        processOutput(record, 'cleanup'),
      );
    }
  }
}

function coordinationSnapshot(statePath) {
  try {
    return existsSync(statePath) ? readFileSync(statePath, 'utf8') : '<absent>';
  } catch (error) {
    return `<unreadable: ${error.message}>`;
  }
}

function lifecycleDiagnostics(records, statePath) {
  return [
    `Coordination state:\n${coordinationSnapshot(statePath)}`,
    ...records.map(({ record, label }) => processOutput(record, label)),
  ].join('\n');
}

async function waitForLifecycle(description, check, { records, statePath, timeoutMs = 5_000 }) {
  try {
    return await waitFor(check, timeoutMs);
  } catch (error) {
    throw new Error(`${description}: ${error.message}\n${lifecycleDiagnostics(records, statePath)}`);
  }
}

function requireExact(actual, expected, label) {
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`${label} was not exact\nexpected: ${JSON.stringify(expected)}\nactual: ${JSON.stringify(actual)}`);
  }
}

function removeArtifactQuotes(path, artifact) {
  const content = readFileSync(path, 'utf8');
  const mutated = content.replaceAll(`'${artifact}'`, artifact);
  if (mutated === content) throw new Error(`could not apply unquoted-artifact mutation to ${path}`);
  writeFileSync(path, mutated);
  return { path, content };
}

function requireDuplicateBlocked(runCopse, branch, agent, owner) {
  let blocked = false;
  try {
    runCopse(['start', branch, '--agent', agent, '--owner', owner]);
  } catch (error) {
    blocked = /active session/.test(`${error.stderr ?? ''}`);
  }
  if (!blocked) throw new Error(`packaged CLI allowed a duplicate ${agent} session for ${branch}`);
}

let cleanupMutationComplete = false;
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root }));
  const artifactDir = join(temp, 'artifacts with spaces $;[packed]');
  mkdirSync(artifactDir);
  const artifact = join(artifactDir, packed[0].filename);
  renameSync(join(temp, packed[0].filename), artifact);
  const names = new Set(packed[0].files.map((file) => file.path));
  for (const required of ['package.json', 'src/cli.mjs', 'src/commands/init.mjs', 'src/commands/land.mjs']) {
    if (!names.has(required)) throw new Error(`package is missing ${required}`);
  }

  const remote = join(temp, 'origin.git');
  const consumer = join(temp, 'consumer');
  run('git', ['init', '--bare', '-b', 'main', remote]);
  run('git', ['init', '-b', 'main', consumer]);
  run('git', ['config', 'user.email', 'smoke@example.com'], { cwd: consumer });
  run('git', ['config', 'user.name', 'Package Smoke'], { cwd: consumer });
  writeFileSync(join(consumer, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n');
  run('npm', ['install', '--ignore-scripts', artifact], { cwd: consumer });
  const copse = join(consumer, 'node_modules', '.bin', 'copse');
  const config = {
    baseBranch: 'main',
    verify: [[process.execPath, '-e', 'process.exit(0)']],
    agents: {
      codex: [process.execPath, fixture, 'codex', codexMarker, codexGate, '--profile', 'acceptance'],
      claude: [process.execPath, fixture, 'claude', claudeMarker, claudeGate, '--model', 'acceptance'],
    },
  };
  writeFileSync(join(consumer, 'copse.config.json'), JSON.stringify(config, null, 2) + '\n');
  run('git', ['add', '.gitignore', 'package.json', 'package-lock.json', 'copse.config.json'], { cwd: consumer });
  run('git', ['commit', '-m', 'initial'], { cwd: consumer });
  run('git', ['remote', 'add', 'origin', remote], { cwd: consumer });
  run('git', ['push', '-u', 'origin', 'main'], { cwd: consumer });

  const fakeBin = join(temp, 'bin');
  mkdirSync(fakeBin);
  const fakeGh = join(fakeBin, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'list') {
  process.stdout.write(JSON.stringify([{ number: 7, state: 'OPEN', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }]));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') process.exit(0);
process.stderr.write('unexpected fake gh call: ' + args.join(' '));
process.exit(2);
`);
  chmodSync(fakeGh, 0o755);
  const fakeNpx = join(fakeBin, 'npx');
  writeFileSync(fakeNpx, `#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args[0] !== '--yes' || args[1] !== ${JSON.stringify(artifact)}) {
  process.stderr.write('generated runner changed artifact argv: ' + JSON.stringify(args.slice(0, 2)) + '\\n');
  process.exit(2);
}
appendFileSync(${JSON.stringify(runnerLog)}, JSON.stringify(args) + '\\n');
const result = spawnSync(${JSON.stringify(copse)}, args.slice(2), { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
`);
  chmodSync(fakeNpx, 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
  const runCopse = (args, options = {}) => run(copse, args, { cwd: consumer, env, ...options });

  const help = runCopse(['--help']);
  if (!help.includes('copse init') || !help.includes('copse land')) throw new Error('installed CLI help is incomplete');
  runCopse(['init', '--apply', '--runner-package', artifact]);

  const savedConfig = JSON.parse(readFileSync(join(consumer, 'copse.config.json'), 'utf8'));
  if (JSON.stringify(savedConfig.runner) !== JSON.stringify(['npx', '--yes', artifact])) {
    throw new Error('saved config did not preserve the exact package artifact argv');
  }

  run('git', ['-c', 'core.hooksPath=/dev/null', 'add', '.codex', '.claude', '.copse', '.github', 'AGENTS.md', 'CLAUDE.md', 'copse.config.json'], { cwd: consumer });
  run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'install copse wiring'], { cwd: consumer });
  run('git', ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'main'], { cwd: consumer });
  runCopse(['doctor']);

  let blocked = false;
  let blockFailure = '';
  try {
    run('git', ['commit', '--allow-empty', '-m', 'must be blocked'], { cwd: consumer, env });
  } catch (error) {
    blockFailure = `${error.stderr ?? error.message}`;
    blocked = /protected/.test(blockFailure);
  }
  if (!blocked) throw new Error(`installed pre-commit hook did not protect main\n${blockFailure}`);

  const mutatedFiles = [];
  if (mutation === 'unquote-agent-hooks') {
    mutatedFiles.push(removeArtifactQuotes(join(consumer, '.codex', 'hooks.json'), artifact));
    mutatedFiles.push(removeArtifactQuotes(join(consumer, '.claude', 'settings.json'), artifact));
  }
  if (mutation === 'unquote-pre-push') {
    mutatedFiles.push(removeArtifactQuotes(join(consumer, '.copse', 'hooks', 'pre-push'), artifact));
  }
  if (mutation === 'unquote-ci') {
    mutatedFiles.push(removeArtifactQuotes(join(consumer, '.github', 'workflows', 'copse.yml'), artifact));
  }
  if (!artifact.includes(' ') || !artifact.includes('$') || !artifact.includes(';')) {
    throw new Error('package acceptance artifact path lost its whitespace/shell-sensitive test case');
  }
  const runnerCommand = `'npx' '--yes' '${artifact}'`;
  const agentCommand = (event) => `cd "$(git rev-parse --show-toplevel)" && exec ${runnerCommand} hook ${event} --protocol 1`;
  const expectedAgentSettings = (projectRoot) => ({
    hooks: {
      SessionStart: [{
        matcher: 'startup|resume|clear|compact',
        hooks: [{
          type: 'command',
          command: agentCommand('agent-session-start'),
          additionalContextLimit: 2000,
        }],
      }],
      PreToolUse: [{
        matcher: 'Bash|apply_patch|Edit|Write',
        hooks: [{ type: 'command', command: agentCommand('agent-pre-tool-use') }],
      }],
    },
    ...(projectRoot ? { $schema: 'https://json.schemastore.org/claude-code-settings.json' } : {}),
  });
  const codexSettings = JSON.parse(readFileSync(join(consumer, '.codex', 'hooks.json'), 'utf8'));
  const claudeSettings = JSON.parse(readFileSync(join(consumer, '.claude', 'settings.json'), 'utf8'));
  requireExact(codexSettings, expectedAgentSettings(false), 'Codex hook JSON');
  requireExact(claudeSettings, expectedAgentSettings(true), 'Claude hook JSON');

  const invokeAgentHook = (command, input) => run('sh', ['-c', command], {
    cwd: consumer,
    env,
    input: JSON.stringify(input),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sessionInput = { hook_event_name: 'SessionStart', cwd: consumer };
  const preToolInput = {
    hook_event_name: 'PreToolUse',
    cwd: consumer,
    tool_name: 'Bash',
    tool_input: { command: 'git status --short' },
  };
  invokeAgentHook(codexSettings.hooks.SessionStart[0].hooks[0].command, sessionInput);
  invokeAgentHook(codexSettings.hooks.PreToolUse[0].hooks[0].command, preToolInput);
  invokeAgentHook(claudeSettings.hooks.SessionStart[0].hooks[0].command, sessionInput);
  invokeAgentHook(claudeSettings.hooks.PreToolUse[0].hooks[0].command, preToolInput);

  const prePush = join(consumer, '.copse', 'hooks', 'pre-push');
  const nullOid = '0'.repeat(40);
  run(prePush, ['origin', 'https://example.invalid/origin.git'], {
    cwd: consumer,
    env,
    input: `refs/heads/feat/codex-agent ${nullOid} refs/heads/feat/codex-agent ${nullOid}\n`,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const workflow = readFileSync(join(consumer, '.github', 'workflows', 'copse.yml'), 'utf8');
  const expectedCiLine = `      - run: ${runnerCommand} verify`;
  requireExact(
    workflow.split('\n').filter((line) => line.includes(artifact)),
    [expectedCiLine],
    'CI runner representation',
  );
  run('sh', ['-c', `${runnerCommand} verify`], { cwd: consumer, env });

  const runnerInvocations = readFileSync(runnerLog, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  requireExact(runnerInvocations, [
    ['--yes', artifact, 'hook', 'pre-commit'],
    ['--yes', artifact, 'hook', 'agent-session-start', '--protocol', '1'],
    ['--yes', artifact, 'hook', 'agent-pre-tool-use', '--protocol', '1'],
    ['--yes', artifact, 'hook', 'agent-session-start', '--protocol', '1'],
    ['--yes', artifact, 'hook', 'agent-pre-tool-use', '--protocol', '1'],
    ['--yes', artifact, 'hook', 'pre-push', 'origin', 'https://example.invalid/origin.git'],
    ['--yes', artifact, 'verify'],
  ], 'generated runner argv log');

  for (const changed of mutatedFiles) writeFileSync(changed.path, changed.content);

  const codexSession = start(copse, [
    'start', 'feat/codex-agent', '--agent', 'codex', '--owner', 'codex@host',
  ], { cwd: consumer, env });
  const statePath = join(consumer, '.git', 'copse', 'features.json');
  let claudeSession = null;
  let state;
  try {
    const codexLease = await waitForLifecycle('timed out waiting for the Codex fixture and lease', () => {
      if (!existsSync(statePath)) return null;
      const lease = JSON.parse(readFileSync(statePath, 'utf8')).leases?.['feat/codex-agent'];
      codexSession.agentPid = lease?.childPid ?? codexSession.agentPid;
      return existsSync(codexMarker) && Number.isInteger(lease?.childPid) ? lease : null;
    }, {
      statePath,
      records: [{ record: codexSession, label: 'Codex' }],
    });
    codexSession.agentPid = codexLease.childPid;
    claudeSession = start(copse, [
      'start', 'feat/claude-agent', '--agent', 'claude', '--owner', 'claude@host',
    ], { cwd: consumer, env });
    state = await waitForLifecycle('timed out waiting for two packaged agent leases', () => {
      if (!existsSync(statePath)) return null;
      const value = JSON.parse(readFileSync(statePath, 'utf8'));
      codexSession.agentPid = value.leases?.['feat/codex-agent']?.childPid ?? codexSession.agentPid;
      claudeSession.agentPid = value.leases?.['feat/claude-agent']?.childPid ?? claudeSession.agentPid;
      if (!existsSync(codexMarker) || !existsSync(claudeMarker)) return null;
      return Number.isInteger(value.leases?.['feat/codex-agent']?.childPid) &&
        Number.isInteger(value.leases?.['feat/claude-agent']?.childPid) ? value : null;
    }, {
      statePath,
      records: [
        { record: codexSession, label: 'Codex' },
        { record: claudeSession, label: 'Claude' },
      ],
    });
  } catch (error) {
    if (error.message.includes('Coordination state:')) throw error;
    throw new Error(
      `${error.message}\n` +
      lifecycleDiagnostics([
        { record: codexSession, label: 'Codex' },
        { record: claudeSession, label: 'Claude' },
      ], statePath),
    );
  }
  if (Object.keys(state.leases).length !== 2) throw new Error('two agent leases were not simultaneously active');
  codexSession.agentPid = state.leases['feat/codex-agent'].childPid;
  claudeSession.agentPid = state.leases['feat/claude-agent'].childPid;

  const codex = JSON.parse(readFileSync(codexMarker, 'utf8'));
  const claude = JSON.parse(readFileSync(claudeMarker, 'utf8'));
  const codexWorktree = `${consumer}-feat-codex-agent`;
  const claudeWorktree = `${consumer}-feat-claude-agent`;
  if (codex.cwd !== codexWorktree || codex.branch !== 'feat/codex-agent') {
    throw new Error('Codex fixture did not run in its deterministic feature worktree');
  }
  if (claude.cwd !== claudeWorktree || claude.branch !== 'feat/claude-agent') {
    throw new Error('Claude fixture did not run in its deterministic feature worktree');
  }
  if (codex.cwd === claude.cwd) throw new Error('agent fixtures shared a worktree');
  if (codex.label !== 'codex' || JSON.stringify(codex.forwarded) !== JSON.stringify(['--profile', 'acceptance'])) {
    throw new Error('Codex fixture did not receive its exact configured argv');
  }
  if (claude.label !== 'claude' || JSON.stringify(claude.forwarded) !== JSON.stringify(['--model', 'acceptance'])) {
    throw new Error('Claude fixture did not receive its exact configured argv');
  }
  if (run('git', ['branch', '--show-current'], { cwd: consumer }) !== 'main') {
    throw new Error('main worktree left the main branch');
  }
  if (run('git', ['status', '--short'], { cwd: consumer }) !== '') {
    throw new Error('agent sessions dirtied the main worktree');
  }

  if (mutation === 'launcher-closes-before-agent') {
    codexSession.child.kill('SIGKILL');
    codexSession.child.stdout.destroy();
    codexSession.child.stderr.destroy();
    if (!await outcomeWithin(codexSession, 2_000)) throw new Error('cleanup mutation could not stop the Codex launcher');
    throw new CleanupMutationComplete('launcher closed while its configured agent remained alive');
  }

  const snapshot = JSON.parse(runCopse(['list', '--json']));
  const codexRow = snapshot.worktrees.find((row) => row.branch === 'feat/codex-agent');
  const claudeRow = snapshot.worktrees.find((row) => row.branch === 'feat/claude-agent');
  if (codexRow?.lease?.owner !== 'codex@host' || claudeRow?.lease?.owner !== 'claude@host') {
    throw new Error('list JSON omitted an active packaged agent lease');
  }

  requireDuplicateBlocked(runCopse, 'feat/codex-agent', 'codex', 'codex@host');
  requireDuplicateBlocked(runCopse, 'feat/claude-agent', 'claude', 'claude@host');

  writeFileSync(codexGate, 'release\n');
  await requireSuccess(codexSession, 'packaged Codex session');
  await waitForLifecycle('timed out waiting for independent Codex lease release', () => {
    const value = JSON.parse(readFileSync(statePath, 'utf8'));
    if (mutation === 'stall-codex-release-diagnostic') return null;
    return !value.leases?.['feat/codex-agent'] && value.leases?.['feat/claude-agent'] ? value : null;
  }, {
    statePath,
    records: [
      { record: codexSession, label: 'Codex' },
      { record: claudeSession, label: 'Claude' },
    ],
  });

  writeFileSync(claudeGate, 'release\n');
  await requireSuccess(claudeSession, 'packaged Claude session');
  await waitForLifecycle('timed out waiting for all packaged leases to clear', () => {
    const value = JSON.parse(readFileSync(statePath, 'utf8'));
    return Object.keys(value.leases ?? {}).length === 0 ? value : null;
  }, {
    statePath,
    records: [
      { record: codexSession, label: 'Codex' },
      { record: claudeSession, label: 'Claude' },
    ],
  });

  runCopse(['new', 'feat/land']);
  runCopse(['land', 'feat/land', '--yes']);
  runCopse(['verify']);

  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', 'copse', 'package.json'), 'utf8'));
  console.log(`package acceptance ok: copse ${installed.version}, ${packed[0].files.length} files`);
} catch (error) {
  if (!(error instanceof CleanupMutationComplete)) throw error;
  cleanupMutationComplete = true;
} finally {
  await stopChildren();
  const liveAgents = children.filter((record) => pidIsAlive(record.agentPid));
  if (liveAgents.length > 0) {
    throw new Error(`cleanup could not prove configured agent PID(s) exited: ${liveAgents.map((record) => record.agentPid).join(', ')}`);
  }
  const liveLaunchers = children.filter((record) => !record.completed);
  if (liveLaunchers.length > 0) throw new Error('cleanup could not prove every launcher exited');
  rmSync(temp, { recursive: true, force: true });
}
if (cleanupMutationComplete) console.log('package cleanup mutation ok: launcher and configured agent exited');
