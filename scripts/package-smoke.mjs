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

const root = resolve(new URL('..', import.meta.url).pathname);
// The package spec deliberately contains shell metacharacters. Every consumer
// must preserve it as one argv element, even where generated forwards use sh.
const temp = mkdtempSync(join(tmpdir(), 'copse-package-'));
const fixture = join(root, 'scripts', 'fixtures', 'recording-agent.mjs');
const codexMarker = join(temp, 'codex-marker.json');
const claudeMarker = join(temp, 'claude-marker.json');
const codexGate = join(temp, 'codex-gate');
const claudeGate = join(temp, 'claude-gate');
const children = [];

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
  const record = { child, stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { record.stdout += chunk; });
  child.stderr.on('data', (chunk) => { record.stderr += chunk; });
  record.outcome = new Promise((resolveExit) => {
    child.once('error', (error) => resolveExit({ error }));
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  children.push(record);
  return record;
}

async function requireSuccess(record, label) {
  const outcome = await record.outcome;
  if (outcome.error || outcome.code !== 0) {
    throw new Error(`${label} failed (${outcome.error?.message ?? outcome.signal ?? outcome.code})\n${record.stderr}`);
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

async function stopChildren() {
  for (const gate of [codexGate, claudeGate]) {
    try { writeFileSync(gate, 'release\n'); } catch { /* setup may have failed before the temp root was usable */ }
  }
  for (const record of children) {
    if (await outcomeWithin(record, 2_000)) continue;
    try {
      if (process.platform === 'win32') record.child.kill('SIGTERM');
      else process.kill(-record.child.pid, 'SIGTERM');
    } catch { /* the process may have exited between the timeout and signal */ }
    if (await outcomeWithin(record, 2_000)) continue;
    try {
      if (process.platform === 'win32') record.child.kill('SIGKILL');
      else process.kill(-record.child.pid, 'SIGKILL');
    } catch { /* already gone */ }
    await record.outcome;
  }
}

function requireArtifact(relative, artifact) {
  const content = readFileSync(relative, 'utf8');
  if (!content.includes(artifact)) throw new Error(`${relative} omitted the exact package artifact path`);
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

try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root }));
  const artifactDir = join(temp, 'artifacts[packed]');
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
const args = process.argv.slice(2);
if (args[0] !== '--yes' || args[1] !== ${JSON.stringify(artifact)}) {
  process.stderr.write('generated runner changed artifact argv: ' + JSON.stringify(args.slice(0, 2)) + '\\n');
  process.exit(2);
}
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
  for (const relative of [
    '.codex/hooks.json',
    '.claude/settings.json',
    '.copse/hooks/pre-commit',
    '.copse/hooks/pre-push',
    '.github/workflows/copse.yml',
  ]) requireArtifact(join(consumer, relative), artifact);

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

  const codexSession = start(copse, [
    'start', 'feat/codex-agent', '--agent', 'codex', '--owner', 'codex@host',
  ], { cwd: consumer, env });
  const statePath = join(consumer, '.git', 'copse', 'features.json');
  let claudeSession = null;
  let state;
  try {
    await waitFor(() => {
      if (!existsSync(statePath) || !existsSync(codexMarker)) return null;
      return JSON.parse(readFileSync(statePath, 'utf8')).leases?.['feat/codex-agent'];
    });
    claudeSession = start(copse, [
      'start', 'feat/claude-agent', '--agent', 'claude', '--owner', 'claude@host',
    ], { cwd: consumer, env });
    state = await waitFor(() => {
      if (!existsSync(statePath) || !existsSync(codexMarker) || !existsSync(claudeMarker)) return null;
      const value = JSON.parse(readFileSync(statePath, 'utf8'));
      return value.leases?.['feat/codex-agent'] && value.leases?.['feat/claude-agent'] ? value : null;
    });
  } catch (error) {
    const lifecycleState = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '<absent>';
    throw new Error(
      `${error.message}\n` +
      `Codex stdout:\n${codexSession.stdout}\nCodex stderr:\n${codexSession.stderr}\n` +
      `Claude stdout:\n${claudeSession?.stdout ?? '<not started>'}\n` +
      `Claude stderr:\n${claudeSession?.stderr ?? '<not started>'}\n` +
      `Coordination state:\n${lifecycleState}`,
    );
  }
  if (Object.keys(state.leases).length !== 2) throw new Error('two agent leases were not simultaneously active');

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
  await waitFor(() => {
    const value = JSON.parse(readFileSync(statePath, 'utf8'));
    return !value.leases?.['feat/codex-agent'] && value.leases?.['feat/claude-agent'] ? value : null;
  });

  writeFileSync(claudeGate, 'release\n');
  await requireSuccess(claudeSession, 'packaged Claude session');
  await waitFor(() => {
    const value = JSON.parse(readFileSync(statePath, 'utf8'));
    return Object.keys(value.leases ?? {}).length === 0 ? value : null;
  });

  runCopse(['new', 'feat/land']);
  runCopse(['land', 'feat/land', '--yes']);
  runCopse(['verify']);

  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', 'copse', 'package.json'), 'utf8'));
  console.log(`package acceptance ok: copse ${installed.version}, ${packed[0].files.length} files`);
} finally {
  await stopChildren();
  rmSync(temp, { recursive: true, force: true });
}
