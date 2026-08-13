import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../src/config.mjs';
import { commandClaim } from '../src/commands/claim.mjs';
import { commandDoctor } from '../src/commands/doctor.mjs';
import { commandInit } from '../src/commands/init.mjs';
import { commandHook } from '../src/commands/hook.mjs';
import { commandLand } from '../src/commands/land.mjs';
import { commandNew } from '../src/commands/new.mjs';
import { commandRelease } from '../src/commands/release.mjs';
import { commandStart } from '../src/commands/start.mjs';
import { commandVerify } from '../src/commands/verify.mjs';
import { coordinationStatePath, loadCoordination, saveCoordination } from '../src/coordination.mjs';

process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

function run(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } }).trim();
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'copse-framework-'));
  const remote = join(root, 'origin.git');
  const repo = join(root, 'project');
  run(['init', '--bare', '-b', 'main', remote], root);
  run(['init', '-b', 'main', repo], root);
  run(['config', 'user.email', 'test@example.com'], repo);
  run(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  run(['add', '-A'], repo); run(['commit', '-m', 'initial'], repo);
  run(['remote', 'add', 'origin', remote], repo); run(['push', '-u', 'origin', 'main'], repo);
  return { root, repo };
}

test('init apply creates idempotent wiring that doctor accepts', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    const first = commandInit({ cwd: repo, config, apply: true });
    assert.equal(first.conflicts.length, 0);
    assert.ok(existsSync(join(repo, '.codex/hooks.json')));
    assert.equal(run(['config', '--local', '--get', 'core.hooksPath'], repo), '.githooks');
    const second = commandInit({ cwd: repo, config, apply: true });
    assert.equal(second.created.length, 0);
    assert.equal(commandDoctor({ cwd: repo, config }).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('coordination state is shared immediately across worktrees without dirtying main', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandNew('feat/api', { cwd: repo, config });
    commandNew('feat/ui', { cwd: repo, config });
    commandClaim('feat/api', { cwd: join(root, 'project-feat-api'), config, owner: 'api-agent' });
    commandClaim('feat/ui', { cwd: join(root, 'project-feat-ui'), config, owner: 'ui-agent', dependsOn: ['feat/api'] });
    const state = loadCoordination(coordinationStatePath({ cwd: repo }));
    assert.equal(state.features['feat/ui'].owner, 'ui-agent');
    commandRelease('feat/api', { cwd: join(root, 'project-feat-api'), config });
    assert.equal(loadCoordination(coordinationStatePath({ cwd: repo })).features['feat/api'].status, 'released');
    assert.equal(run(['status', '--porcelain'], repo), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installed hook policy blocks main edits and land closes a clean simulated PR', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    assert.throws(() => commandHook('pre-commit', { cwd: repo, config }), /protected/);
    const created = commandNew('feat/done', { cwd: repo, config });
    assert.doesNotThrow(() => commandHook('pre-commit', { cwd: created.path, config }));
    const fakeGh = (command, args) => {
      if (args[0] === 'pr' && args[1] === 'list') return { ok: true, status: 0, stdout: JSON.stringify([{ number: 7, state: 'OPEN', statusCheckRollup: [{ conclusion: 'SUCCESS' }] }]), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'merge') return { ok: true, status: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    };
    const result = commandLand('feat/done', { cwd: repo, config, yes: true, run: fakeGh });
    assert.equal(result.merged, true);
    assert.equal(result.cleaned, true);
    assert.equal(existsSync(created.path), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init and verify operate on the current linked worktree, not stale main files', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['check-feature']] }).config;
    const target = commandNew('feat/setup', { cwd: repo, config }).path;
    commandInit({ cwd: target, config, apply: true });
    assert.ok(existsSync(join(target, 'copse.config.json')));
    assert.equal(existsSync(join(repo, 'copse.config.json')), false);
    let checkedCwd;
    const status = commandVerify({ cwd: target, config, run(command, args, options) { checkedCwd = options.cwd; return { status: 0 }; } });
    assert.equal(status, 0);
    assert.equal(checkedCwd, target);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('start automatically claims a feature and refuses a duplicate live session', async () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandNew('feat/session', { cwd: repo, config });
    let finish;
    const running = new Promise((resolve) => { finish = resolve; });
    const first = commandStart('feat/session', {
      cwd: repo,
      config,
      owner: 'alice@host',
      command: ['agent'],
      processAlive: () => true,
      run(command, args, options) {
        options.onSpawn(4242);
        return running;
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(commandStart('feat/session', {
      cwd: repo,
      config,
      owner: 'alice@host',
      command: ['agent'],
      processAlive: () => true,
      run: async () => 0,
    }), /active session/);
    let state = loadCoordination(coordinationStatePath({ cwd: repo }));
    assert.equal(state.features['feat/session'].owner, 'alice@host');
    assert.equal(state.leases['feat/session'].childPid, 4242);
    finish(0);
    assert.equal(await first, 0);
    state = loadCoordination(coordinationStatePath({ cwd: repo }));
    assert.equal(state.leases['feat/session'], undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports a configured local hook runner that cannot execute', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']], runner: ['./missing-copse'] }).config;
    commandInit({ cwd: repo, config, apply: true });
    const result = commandDoctor({ cwd: repo, config });
    assert.equal(result.ok, false);
    assert.match(result.findings.join('\n'), /runner.*missing-copse/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('committed coordination backend writes the configured reviewed state file', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ coordinationBackend: 'committed', coordinationFile: '.copse/shared.json' }).config;
    commandClaim('feat/shared', { cwd: repo, config, owner: 'alice', resources: ['port:3000'] });
    const path = join(repo, '.copse', 'shared.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(state.features['feat/shared'].owner, 'alice');
    assert.equal(state.resources['port:3000'].branch, 'feat/shared');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports a resource whose owning lease no longer exists', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    const path = coordinationStatePath({ cwd: repo, config });
    saveCoordination(path, {
      version: 1,
      features: { 'feat/gone': { owner: 'alice', dependsOn: [], status: 'active' } },
      leases: {},
      resources: { 'port:3000': { branch: 'feat/gone', owner: 'alice', leaseId: 'missing' } },
    });
    const result = commandDoctor({ cwd: repo, config });
    assert.match(result.findings.join('\n'), /stale resource.*port:3000/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
