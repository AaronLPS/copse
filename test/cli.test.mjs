import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'copse-cli-'));
  const remote = join(root, 'origin.git');
  const repo = join(root, 'project');
  git(['init', '--bare', '-b', 'main', remote], root);
  git(['init', '-b', 'main', repo], root);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), 'test\n');
  git(['add', '-A'], repo);
  git(['commit', '-m', 'initial'], repo);
  git(['remote', 'add', 'origin', remote], repo);
  git(['push', '-u', 'origin', 'main'], repo);
  return { root, repo };
}

function runCli(args, cwd) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
}

test('init reports a missing runner package with the normal concise CLI error', () => {
  const { root, repo } = makeRepo();
  try {
    const result = runCli(['init', '--runner-package'], repo);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^\n✗ --runner-package requires a value\n\n$/);
    assert.doesNotMatch(result.stderr, /Error:|at ModuleJob|src\/cli\.mjs:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('start passes a trailing runner-package flag to its custom command', () => {
  const { root, repo } = makeRepo();
  try {
    const result = runCli([
      'start', 'feat/passthrough', '--', 'node', '-e', 'process.exit(0)', '--', '--runner-package',
    ], repo);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /runner-package requires a value/);
    assert.ok(existsSync(join(root, 'project-feat-passthrough')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
