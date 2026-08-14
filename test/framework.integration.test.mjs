import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
import { desiredGitHooks, legacyGitHooks } from '../src/git-hooks.mjs';
import { desiredWiring } from '../src/wiring.mjs';

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
    assert.equal(run(['config', '--local', '--get', 'core.hooksPath'], repo), '.copse/hooks');
    assert.equal(run(['config', '--local', '--get', 'copse.previousHooksPath'], repo), '<default>');
    const second = commandInit({ cwd: repo, config, apply: true });
    assert.equal(second.created.length, 0);
    assert.equal(commandDoctor({ cwd: repo, config }).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init replaces legacy default wiring from a runner-omitting config without duplicating consumer hooks', () => {
  const { root, repo } = makeRepo();
  try {
    const raw = { verify: [['npm', 'test']] };
    const config = parseConfig(raw).config;
    const legacyConfig = { ...config, ciMode: 'npm', runner: ['npx', '--yes', 'copse'] };
    const legacyWiring = desiredWiring(legacyConfig);
    const legacyHooks = desiredGitHooks(legacyConfig);
    const consumerGroup = { matcher: 'complete', hooks: [{ type: 'command', command: 'consumer validate' }] };
    writeFileSync(join(repo, 'copse.config.json'), JSON.stringify(raw, null, 2) + '\n');
    for (const [relative, content] of [...legacyWiring, ...legacyHooks]) {
      const path = join(repo, relative);
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content, relative.startsWith('.copse/hooks/') ? { mode: 0o755 } : undefined);
    }
    const claudePath = join(repo, '.claude', 'settings.json');
    const oldClaude = JSON.parse(readFileSync(claudePath, 'utf8'));
    writeFileSync(claudePath, JSON.stringify({
      ...oldClaude, hooks: { ...oldClaude.hooks, Stop: [consumerGroup] },
    }, null, 2) + '\n');

    const result = commandInit({ cwd: repo, config, apply: true });
    const effectiveConfig = { ...config, ciMode: 'npm' };
    const newWiring = desiredWiring(effectiveConfig);
    const newClaude = JSON.parse(readFileSync(claudePath, 'utf8'));
    const expectedClaude = JSON.parse(newWiring.get('.claude/settings.json'));

    assert.deepEqual(result.conflicts, []);
    for (const [relative, expected] of [...newWiring, ...desiredGitHooks(effectiveConfig)]) {
      const actual = readFileSync(join(repo, relative), 'utf8');
      if (['.codex/hooks.json', '.claude/settings.json', '.github/workflows/copse.yml'].includes(relative)
          || relative.startsWith('.copse/hooks/')) {
        assert.match(actual, /@aaronlps\/copse/, relative);
      }
      if (!relative.endsWith('settings.json')) assert.equal(actual, expected, relative);
    }
    assert.deepEqual(newClaude.hooks.Stop, [consumerGroup]);
    assert.deepEqual(newClaude.hooks.SessionStart, expectedClaude.hooks.SessionStart);
    assert.deepEqual(newClaude.hooks.PreToolUse, expectedClaude.hooks.PreToolUse);
    assert.equal((JSON.stringify(newClaude).match(/@aaronlps\/copse/g) ?? []).length, 2);
    assert.doesNotMatch(JSON.stringify(newClaude), /'copse'/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init preserves and delegates an existing hooksPath', () => {
  const { root, repo } = makeRepo();
  try {
    const hookDir = join(repo, '.husky');
    mkdirSync(hookDir);
    const original = '#!/bin/sh\nprintf delegated > .delegated-hook\n';
    writeFileSync(join(hookDir, 'pre-commit'), original, { mode: 0o755 });
    run(['config', 'core.hooksPath', '.husky'], repo);
    const config = parseConfig({ verify: [['npm', 'test']], runner: [process.execPath, resolve('src/cli.mjs')] }).config;

    commandInit({ cwd: repo, config, apply: true });

    assert.equal(run(['config', '--get', 'core.hooksPath'], repo), '.copse/hooks');
    assert.equal(run(['config', '--get', 'copse.previousHooksPath'], repo), '.husky');
    assert.equal(readFileSync(join(hookDir, 'pre-commit'), 'utf8'), original);
    run(['switch', '-c', 'feat/delegated-hook'], repo);
    run(['commit', '--allow-empty', '-m', 'delegates'], repo);
    assert.equal(readFileSync(join(repo, '.delegated-hook'), 'utf8'), 'delegated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init delegates the default Git hook directory without changing its hook', () => {
  const { root, repo } = makeRepo();
  try {
    const hookPath = join(repo, '.git', 'hooks', 'pre-commit');
    const original = '#!/bin/sh\nprintf default > .default-hook\n';
    writeFileSync(hookPath, original, { mode: 0o755 });
    const config = parseConfig({ verify: [['npm', 'test']], runner: [process.execPath, resolve('src/cli.mjs')] }).config;

    commandInit({ cwd: repo, config, apply: true });

    assert.equal(run(['config', '--get', 'copse.previousHooksPath'], repo), '<default>');
    assert.equal(readFileSync(hookPath, 'utf8'), original);
    run(['switch', '-c', 'feat/default-hook'], repo);
    run(['commit', '--allow-empty', '-m', 'delegates default'], repo);
    assert.equal(readFileSync(join(repo, '.default-hook'), 'utf8'), 'default');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init migrates exact legacy v0.3 hooks without delegating back to .githooks', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']], runner: [process.execPath, resolve('src/cli.mjs')] }).config;
    const legacy = legacyGitHooks(config);
    for (const [relative, content] of legacy) {
      const path = join(repo, relative);
      mkdirSync(join(repo, '.githooks'), { recursive: true });
      writeFileSync(path, content, { mode: 0o755 });
    }
    run(['config', 'core.hooksPath', '.githooks'], repo);

    commandInit({ cwd: repo, config, apply: true });

    assert.equal(run(['config', '--get', 'core.hooksPath'], repo), '.copse/hooks');
    assert.equal(run(['config', '--get', 'copse.previousHooksPath'], repo), '<default>');
    for (const [relative, content] of legacy) {
      assert.equal(readFileSync(join(repo, relative), 'utf8'), content);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a second init preserves the originally delegated hooksPath', () => {
  const { root, repo } = makeRepo();
  try {
    mkdirSync(join(repo, '.husky'));
    run(['config', 'core.hooksPath', '.husky'], repo);
    const config = parseConfig({ verify: [['npm', 'test']] }).config;

    commandInit({ cwd: repo, config, apply: true });
    commandInit({ cwd: repo, config, apply: true });

    assert.equal(run(['config', '--get', 'core.hooksPath'], repo), '.copse/hooks');
    assert.equal(run(['config', '--get', 'copse.previousHooksPath'], repo), '.husky');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a wrapper conflict leaves the configured hooksPath unchanged', () => {
  const { root, repo } = makeRepo();
  try {
    mkdirSync(join(repo, '.husky'));
    mkdirSync(join(repo, '.copse', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.copse', 'hooks', 'pre-commit'), '#!/bin/sh\necho custom\n', { mode: 0o755 });
    run(['config', 'core.hooksPath', '.husky'], repo);
    const config = parseConfig({ verify: [['npm', 'test']] }).config;

    const result = commandInit({ cwd: repo, config, apply: true });

    assert.ok(result.conflicts.includes('.copse/hooks/pre-commit'));
    assert.equal(run(['config', '--get', 'core.hooksPath'], repo), '.husky');
    assert.throws(() => run(['config', '--get', 'copse.previousHooksPath'], repo));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init refuses a linked worktree core.hooksPath override and doctor diagnoses it', () => {
  const { root, repo } = makeRepo();
  try {
    run(['config', 'extensions.worktreeConfig', 'true'], repo);
    const linked = join(root, 'project-feat-worktree-hooks');
    run(['worktree', 'add', '-b', 'feat/worktree-hooks', linked], repo);
    mkdirSync(join(linked, '.husky'));
    run(['config', '--worktree', 'core.hooksPath', '.husky'], linked);
    const config = parseConfig({ verify: [['npm', 'test']] }).config;

    const result = commandInit({ cwd: linked, config, apply: true });
    const findings = commandDoctor({ cwd: linked, config }).findings.join('\n');

    assert.equal(result.ok, false);
    assert.ok(result.conflicts.includes('worktree core.hooksPath override'));
    assert.equal(run(['config', '--get', 'core.hooksPath'], linked), '.husky');
    assert.match(findings, /worktree core\.hooksPath overrides clone-local hook wiring/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init expands a tilde hooksPath before storing and delegating it', () => {
  const { root, repo } = makeRepo();
  const originalHome = process.env.HOME;
  try {
    const fakeHome = join(root, 'home');
    const hookDir = join(fakeHome, 'consumer-hooks');
    mkdirSync(hookDir, { recursive: true });
    const original = '#!/bin/sh\nprintf tilde > .tilde-hook\n';
    writeFileSync(join(hookDir, 'pre-commit'), original, { mode: 0o755 });
    process.env.HOME = fakeHome;
    run(['config', 'core.hooksPath', '~/consumer-hooks'], repo);
    const config = parseConfig({
      verify: [['npm', 'test']], runner: [process.execPath, resolve('src/cli.mjs')],
    }).config;

    commandInit({ cwd: repo, config, apply: true });

    assert.equal(run(['config', '--get', 'copse.previousHooksPath'], repo), hookDir);
    assert.equal(readFileSync(join(hookDir, 'pre-commit'), 'utf8'), original);
    run(['switch', '-c', 'feat/tilde-hook'], repo);
    run(['commit', '--allow-empty', '-m', 'delegates tilde'], repo);
    assert.equal(readFileSync(join(repo, '.tilde-hook'), 'utf8'), 'tilde');
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test('init runner package creates a config when one is absent', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({
      cwd: repo, config, apply: true, runnerPackage: 'github:AaronLPS/copse#b928453',
    });
    const saved = JSON.parse(readFileSync(join(repo, 'copse.config.json'), 'utf8'));
    assert.deepEqual(saved.runner, ['npx', '--yes', 'github:AaronLPS/copse#b928453']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init runner package persists the exact package source', () => {
  const { root, repo } = makeRepo();
  try {
    writeFileSync(join(repo, 'copse.config.json'), JSON.stringify({
      baseBranch: 'main', carryFiles: ['.env'], verify: [['npm', 'test']], runner: ['old-runner'],
    }, null, 2) + '\n');
    writeFileSync(join(repo, '.env'), 'secret\n');
    const loaded = parseConfig(JSON.parse(readFileSync(join(repo, 'copse.config.json'), 'utf8'))).config;
    const result = commandInit({
      cwd: repo, config: loaded, apply: true, runnerPackage: 'github:AaronLPS/copse#b928453',
    });
    const saved = JSON.parse(readFileSync(join(repo, 'copse.config.json'), 'utf8'));
    assert.deepEqual(saved.runner, ['npx', '--yes', 'github:AaronLPS/copse#b928453']);
    assert.deepEqual(saved.carryFiles, ['.env']);
    assert.equal(result.configChanged, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init keeps a selected CI mode when the config file already exists', () => {
  const { root, repo } = makeRepo();
  try {
    writeFileSync(join(repo, 'copse.config.json'), JSON.stringify({
      verify: [['npm', 'test']], ciMode: 'npm',
    }, null, 2) + '\n');
    const loaded = parseConfig(JSON.parse(readFileSync(join(repo, 'copse.config.json'), 'utf8'))).config;
    const result = commandInit({ cwd: repo, config: { ...loaded, ciMode: 'pnpm' }, apply: true });
    const workflow = readFileSync(join(repo, '.github/workflows/copse.yml'), 'utf8');
    assert.equal(result.effectiveConfig.ciMode, 'pnpm');
    assert.match(workflow, /pnpm install --frozen-lockfile/);
    assert.doesNotMatch(workflow, /- run: npm install/m);
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
    const headOid = run(['rev-parse', 'HEAD'], created.path);
    let mergeArgs;
    const fakeGh = (command, args) => {
      if (args[0] === 'pr' && args[1] === 'list') return { ok: true, status: 0, stdout: JSON.stringify([{ number: 7, state: 'OPEN', baseRefName: 'main', headRefOid: headOid, statusCheckRollup: [{ name: 'verify', conclusion: 'SUCCESS' }] }]), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'merge') { mergeArgs = args; return { ok: true, status: 0, stdout: '', stderr: '' }; }
      throw new Error(`unexpected ${command} ${args.join(' ')}`);
    };
    const result = commandLand('feat/done', { cwd: repo, config, yes: true, run: fakeGh });
    assert.equal(result.merged, true);
    assert.equal(result.cleaned, true);
    assert.deepEqual(mergeArgs, ['pr', 'merge', '7', '--merge', '--match-head-commit', headOid]);
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

test('start refuses a foreign owner before creating a worktree', async () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandClaim('feat/owned', { cwd: repo, config, owner: 'alice@host' });
    await assert.rejects(commandStart('feat/owned', {
      cwd: repo,
      config,
      owner: 'bob@host',
      command: ['agent'],
      run: async () => 0,
    }), /owned by alice@host/);
    assert.equal(existsSync(join(root, 'project-feat-owned')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('start rolls back its automatic claim when worktree provisioning fails', async () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    await assert.rejects(commandStart('feat/provision-fails', {
      cwd: repo,
      config,
      owner: 'alice@host',
      command: ['agent'],
      create() { throw new Error('provisioning exploded'); },
      run: async () => 0,
    }), /provisioning exploded/);
    const state = loadCoordination(coordinationStatePath({ cwd: repo, config }));
    assert.equal(state.features['feat/provision-fails'], undefined);
    assert.equal(state.leases['feat/provision-fails'], undefined);
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

test('doctor reports a wrong current Git hooks path', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    run(['config', 'core.hooksPath', '.husky'], repo);

    const findings = commandDoctor({ cwd: repo, config }).findings.join('\n');

    assert.match(findings, /git core\.hooksPath is not \.copse\/hooks/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports a Git hook delegation cycle', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    run(['config', 'copse.previousHooksPath', '.copse/hooks'], repo);

    const findings = commandDoctor({ cwd: repo, config }).findings.join('\n');

    assert.match(findings, /delegation cycle/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('init and doctor normalize equivalent Copse hook paths without persisting a cycle', () => {
  const { root, repo } = makeRepo();
  try {
    mkdirSync(join(repo, '.copse', 'hooks'), { recursive: true });
    run(['config', 'core.hooksPath', './.copse/../.copse/hooks'], repo);
    const config = parseConfig({ verify: [['npm', 'test']] }).config;

    commandInit({ cwd: repo, config, apply: true });

    assert.equal(run(['config', '--get', 'copse.previousHooksPath'], repo), '<default>');
    run(['config', 'core.hooksPath', join(repo, '.copse', 'hooks')], repo);
    assert.equal(commandDoctor({ cwd: repo, config }).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('rendered Git wrapper refuses a symlink delegation back to its physical directory', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({
      verify: [['npm', 'test']], runner: [process.execPath, resolve('src/cli.mjs')],
    }).config;
    commandInit({ cwd: repo, config, apply: true });
    symlinkSync(join(repo, '.copse', 'hooks'), join(repo, '.hook-alias'));
    run(['config', 'copse.previousHooksPath', '.hook-alias'], repo);
    run(['switch', '-c', 'feat/hook-cycle'], repo);

    assert.throws(
      () => run(['commit', '--allow-empty', '-m', 'must refuse cycle'], repo),
      (error) => /delegation cycle/.test(error.stderr),
    );
    assert.match(commandDoctor({ cwd: repo, config }).findings.join('\n'), /delegation cycle/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports a missing configured delegated hook directory', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    run(['config', 'copse.previousHooksPath', '.husky'], repo);

    const findings = commandDoctor({ cwd: repo, config }).findings.join('\n');

    assert.match(findings, /delegated hook directory does not exist: \.husky/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports a present delegated hook that is not executable', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    mkdirSync(join(repo, '.husky'));
    writeFileSync(join(repo, '.husky', 'pre-commit'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(repo, '.husky', 'pre-commit'), 0o644);
    run(['config', 'copse.previousHooksPath', '.husky'], repo);

    const findings = commandDoctor({ cwd: repo, config }).findings.join('\n');

    assert.match(findings, /delegated pre-commit is not executable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports a missing absolute delegated hook directory', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    const missing = join(root, 'removed-hooks');
    run(['config', 'copse.previousHooksPath', missing], repo);

    const findings = commandDoctor({ cwd: repo, config }).findings.join('\n');

    assert.match(findings, new RegExp(`delegated hook directory does not exist: ${missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor accepts an existing delegated directory with no hook files', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    mkdirSync(join(repo, '.husky'));
    run(['config', 'copse.previousHooksPath', '.husky'], repo);

    const result = commandDoctor({ cwd: repo, config });

    assert.equal(result.ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports a non-executable Copse wrapper and init repairs its mode', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    const wrapper = join(repo, '.copse', 'hooks', 'pre-commit');
    chmodSync(wrapper, 0o644);

    const broken = commandDoctor({ cwd: repo, config });
    assert.match(broken.findings.join('\n'), /copse hook is not executable: \.copse\/hooks\/pre-commit/);

    const repaired = commandInit({ cwd: repo, config, apply: true });
    assert.ok(repaired.updated.includes('.copse/hooks/pre-commit'));
    assert.equal(commandDoctor({ cwd: repo, config }).ok, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports each missing Copse Git wrapper', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    rmSync(join(repo, '.copse', 'hooks', 'pre-commit'));
    rmSync(join(repo, '.copse', 'hooks', 'pre-push'));

    const findings = commandDoctor({ cwd: repo, config }).findings.join('\n');

    assert.match(findings, /missing copse wiring: \.copse\/hooks\/pre-commit/);
    assert.match(findings, /missing copse wiring: \.copse\/hooks\/pre-push/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor reports byte drift in a Copse Git wrapper', () => {
  const { root, repo } = makeRepo();
  try {
    const config = parseConfig({ verify: [['npm', 'test']] }).config;
    commandInit({ cwd: repo, config, apply: true });
    const wrapper = join(repo, '.copse', 'hooks', 'pre-commit');
    writeFileSync(wrapper, `${readFileSync(wrapper, 'utf8')}# drift\n`, { mode: 0o755 });

    const findings = commandDoctor({ cwd: repo, config }).findings.join('\n');

    assert.match(findings, /copse wiring differs: \.copse\/hooks\/pre-commit/);
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
    const result = commandDoctor({
      cwd: repo,
      config,
      inspectPort(name) {
        return name === 'port:3000'
          ? { port: 3000, pid: 42, command: 'node', cwd: '/worktrees/feat-gone' }
          : null;
      },
    });
    assert.match(result.findings.join('\n'), /stale resource.*port:3000/);
    assert.match(result.observations.join('\n'), /pid 42.*node.*feat-gone/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
