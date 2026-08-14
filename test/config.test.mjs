import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_FILENAME, DEFAULTS, loadConfig, parseConfig } from '../src/config.mjs';

test('an empty config is the defaults', () => {
  const result = parseConfig({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, DEFAULTS);
});

test('declared values override the defaults', () => {
  const result = parseConfig({ baseBranch: 'devel', carryFiles: ['.env.test'] });
  assert.equal(result.ok, true);
  assert.equal(result.config.baseBranch, 'devel');
  assert.deepEqual(result.config.carryFiles, ['.env.test']);
  // Untouched keys keep their defaults rather than becoming undefined.
  assert.deepEqual(result.config.branchPrefixes, DEFAULTS.branchPrefixes);
});

test('a prefix containing a hyphen is refused', () => {
  // branchForSlug splits a slug at its first hyphen. A prefix with a hyphen
  // in it makes that split ambiguous and breaks the bijection the whole
  // directory-naming scheme rests on. This must fail at config load, not at
  // the moment someone cannot find their worktree.
  const result = parseConfig({ branchPrefixes: ['feat', 'hot-fix'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /hot-fix/);
  assert.match(result.errors.join('\n'), /hyphen/);
});

test('an empty prefix list is refused', () => {
  const result = parseConfig({ branchPrefixes: [] });
  assert.equal(result.ok, false);
});

test('a carried path escaping the repository is refused', () => {
  // copse copies these paths into and out of worktree directories. A `..`
  // segment writes outside the tree it was aimed at.
  const result = parseConfig({ carryFiles: ['../../.ssh/id_rsa'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /outside the repository/);
});

test('an absolute carried path is refused', () => {
  const result = parseConfig({ carryFiles: ['/etc/passwd'] });
  assert.equal(result.ok, false);
});

test('every error is reported, not just the first', () => {
  const result = parseConfig({ branchPrefixes: [], carryFiles: ['/etc/passwd'] });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
});

test('a path listed as both a file and a directory is refused', () => {
  const result = parseConfig({ carryFiles: ['a/b'], carryDirs: ['a/b'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /both/);
});

test('install must be a non-empty command array when present', () => {
  assert.equal(parseConfig({ install: [] }).ok, false);
  assert.equal(parseConfig({ install: 'pnpm install' }).ok, false);
  assert.equal(parseConfig({ install: ['pnpm', 'install'] }).ok, true);
  assert.equal(parseConfig({ install: null }).ok, true);
});

test('loadConfig: a missing config file yields the defaults', () => {
  // loadConfig is the only config path the CLI actually uses, and a missing
  // file is the common case — a repository that has not opted into any
  // copse settings still has to work.
  const dir = mkdtempSync(join(tmpdir(), 'copse-config-'));
  try {
    const result = loadConfig(dir);
    assert.equal(result.ok, true);
    assert.deepEqual(result.config, DEFAULTS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: malformed JSON fails and names the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copse-config-'));
  try {
    writeFileSync(join(dir, CONFIG_FILENAME), '{ not valid json');
    const result = loadConfig(dir);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), new RegExp(CONFIG_FILENAME.replace('.', '\\.')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig: a well-formed config file is parsed the same as parseConfig would', () => {
  const dir = mkdtempSync(join(tmpdir(), 'copse-config-'));
  try {
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ baseBranch: 'devel' }));
    const result = loadConfig(dir);
    assert.equal(result.ok, true);
    assert.equal(result.config.baseBranch, 'devel');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('framework configuration has safe defaults', () => {
  const { config } = parseConfig({});
  assert.equal(config.releaseBranch, null);
  assert.deepEqual(config.verify, []);
  assert.deepEqual(config.agents, { codex: ['codex'], claude: ['claude'] });
  assert.equal(config.coordinationFile, '.copse/features.json');
  assert.deepEqual(config.runner, ['npx', '--yes', '@aaronlps/copse']);
  assert.equal(config.leaseTimeoutSeconds, 300);
  assert.equal(config.leaseHeartbeatSeconds, 30);
  assert.deepEqual(config.resources, {});
  assert.equal(config.coordinationBackend, 'local');
  assert.equal(config.ciMode, 'auto');
  assert.deepEqual(config.ciSetup, []);
});

test('CI mode and custom setup use explicit safe argv arrays', () => {
  assert.equal(parseConfig({ ciMode: 'deno' }).ok, false);
  assert.equal(parseConfig({ ciSetup: ['echo setup'] }).ok, false);
  assert.equal(parseConfig({ ciSetup: [[]] }).ok, false);
  const result = parseConfig({ ciMode: 'custom', ciSetup: [['python', '-m', 'pip', 'install', '-r', 'requirements.txt']] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.config.ciSetup[0], ['python', '-m', 'pip', 'install', '-r', 'requirements.txt']);
});

test('verify and agent commands must be non-empty argv arrays', () => {
  assert.equal(parseConfig({ verify: ['npm test'] }).ok, false);
  assert.equal(parseConfig({ verify: [[]] }).ok, false);
  assert.equal(parseConfig({ agents: { codex: 'codex' } }).ok, false);
  assert.equal(parseConfig({ runner: 'npx copse' }).ok, false);
  assert.equal(parseConfig({ verify: [['npm', 'test']] }).ok, true);
});

test('releaseBranch and coordinationFile are validated', () => {
  assert.equal(parseConfig({ releaseBranch: '' }).ok, false);
  assert.equal(parseConfig({ coordinationFile: '../features.json' }).ok, false);
  const result = parseConfig({ releaseBranch: 'main', coordinationFile: '.state/features.json' });
  assert.equal(result.ok, true);
  assert.equal(result.config.releaseBranch, 'main');
});

test('lease timing, resources and coordination backend are validated together', () => {
  const invalid = parseConfig({
    leaseTimeoutSeconds: 0,
    leaseHeartbeatSeconds: 60,
    resources: { 'feat/x': ['bad resource'] },
    coordinationBackend: 'cloud',
  });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /leaseTimeoutSeconds/);
  assert.match(invalid.errors.join('\n'), /leaseHeartbeatSeconds/);
  assert.match(invalid.errors.join('\n'), /bad resource/);
  assert.match(invalid.errors.join('\n'), /coordinationBackend/);

  const valid = parseConfig({
    leaseTimeoutSeconds: 120,
    leaseHeartbeatSeconds: 10,
    resources: { 'feat/x': ['port:3000', 'db:test'] },
    coordinationBackend: 'committed',
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.config.resources['feat/x'], ['port:3000', 'db:test']);
});
