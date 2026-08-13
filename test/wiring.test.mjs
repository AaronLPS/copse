import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { desiredWiring, detectCiMode, reconcileWiring } from '../src/wiring.mjs';

test('desired wiring covers Codex, Claude, instructions, coordination and CI', () => {
  const files = desiredWiring({ verify: [['npm', 'test']] });
  for (const path of ['.codex/hooks.json', '.claude/settings.json', 'AGENTS.md', 'CLAUDE.md', '.copse/features.json', '.github/workflows/copse.yml']) {
    assert.ok(files.has(path), `missing ${path}`);
  }
  assert.equal(files.has('.githooks/pre-commit'), false);
  assert.equal(files.has('.githooks/pre-push'), false);
  assert.match(files.get('.codex/hooks.json'), /git rev-parse --show-toplevel/);
  assert.match(files.get('.codex/hooks.json'), /--protocol 1/);
  assert.match(files.get('.github/workflows/copse.yml'), /git config core\.hooksPath \.copse\/hooks/);
});

test('CI runner is a JSON-quoted YAML scalar that extracts to the exact shell command', () => {
  const artifact = '/tmp/artifacts with spaces $;[packed]/copse.tgz';
  const workflow = desiredWiring({
    verify: [['npm', 'test']],
    runner: ['npx', '--yes', artifact],
  }).get('.github/workflows/copse.yml');
  const line = workflow.split('\n').find((candidate) => candidate.includes(artifact));
  const scalar = line?.match(/^\s*- run: (.+)$/)?.[1];

  assert.match(scalar ?? '', /^"/);
  assert.equal(JSON.parse(scalar), `'npx' '--yes' '${artifact}' verify`);
});

test('reconcile reports conflicts and apply never overwrites them', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-wire-'));
  try {
    writeFileSync(join(root, 'AGENTS.md'), 'consumer owned\n');
    const report = reconcileWiring(root, desiredWiring({ verify: [['npm', 'test']] }), { apply: true });
    assert.ok(report.conflicts.includes('AGENTS.md'));
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'consumer owned\n');
    assert.ok(report.created.includes('.codex/hooks.json'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reconcile merges copse hooks into existing agent settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-wire-'));
  try {
    const path = join(root, '.claude/settings.json');
    mkdirSync(join(root, '.claude'));
    writeFileSync(path, JSON.stringify({ permissions: { allow: ['Read'] }, hooks: { Stop: [] } }));
    const report = reconcileWiring(root, desiredWiring({ verify: [['npm', 'test']] }), { apply: true });
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(settings.permissions, { allow: ['Read'] });
    assert.ok(settings.hooks.SessionStart);
    assert.ok(report.updated.includes('.claude/settings.json'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reconcile replaces exact previous copse wiring while preserving consumer hook groups', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-wire-'));
  try {
    const oldConfig = { verify: [['npm', 'test']], runner: ['npx', '--yes', 'copse@0.4.0'] };
    const newConfig = { verify: [['npm', 'test']], runner: ['npx', '--yes', 'copse@0.5.0'] };
    const previousDesired = desiredWiring(oldConfig);
    const desired = desiredWiring(newConfig);
    const oldSettings = JSON.parse(previousDesired.get('.claude/settings.json'));
    const consumerGroup = { matcher: 'complete', hooks: [{ type: 'command', command: 'consumer validate' }] };
    mkdirSync(join(root, '.claude'), { recursive: true });
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({
      hooks: { ...oldSettings.hooks, Stop: [consumerGroup] },
    }, null, 2) + '\n');
    writeFileSync(join(root, '.github/workflows/copse.yml'), previousDesired.get('.github/workflows/copse.yml'));

    const report = reconcileWiring(root, desired, { apply: true, previousDesired });
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    const wanted = JSON.parse(desired.get('.claude/settings.json'));
    assert.deepEqual(settings.hooks.Stop, [consumerGroup]);
    assert.deepEqual(settings.hooks.SessionStart, wanted.hooks.SessionStart);
    assert.deepEqual(settings.hooks.PreToolUse, wanted.hooks.PreToolUse);
    assert.doesNotMatch(JSON.stringify(settings), /copse@0\.4\.0/);
    assert.match(JSON.stringify(settings), /copse@0\.5\.0/);
    assert.equal(readFileSync(join(root, '.github/workflows/copse.yml'), 'utf8'), desired.get('.github/workflows/copse.yml'));
    assert.ok(report.updated.includes('.claude/settings.json'));
    assert.ok(report.updated.includes('.github/workflows/copse.yml'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reconcile leaves a custom old-runner workflow unchanged as a conflict', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-wire-'));
  try {
    const oldConfig = { verify: [['npm', 'test']], runner: ['npx', '--yes', 'copse@0.4.0'] };
    const newConfig = { verify: [['npm', 'test']], runner: ['npx', '--yes', 'copse@0.5.0'] };
    const previousDesired = desiredWiring(oldConfig);
    const desired = desiredWiring(newConfig);
    const path = join(root, '.github/workflows/copse.yml');
    const custom = `${previousDesired.get('.github/workflows/copse.yml')}# consumer-owned customization\n`;
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
    writeFileSync(path, custom);

    const report = reconcileWiring(root, desired, { apply: true, previousDesired });
    assert.ok(report.conflicts.includes('.github/workflows/copse.yml'));
    assert.equal(readFileSync(path, 'utf8'), custom);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CI mode detection follows lockfiles and custom workflows avoid npm install', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-wire-'));
  try {
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    assert.equal(detectCiMode(root), 'pnpm');
    const config = {
      baseBranch: 'main',
      verify: [['python', '-m', 'pytest']],
      runner: ['copse'],
      coordinationFile: '.copse/features.json',
      ciMode: 'custom',
      ciSetup: [['python', '-m', 'pip', 'install', '-r', 'requirements.txt']],
    };
    const workflow = desiredWiring(config).get('.github/workflows/copse.yml');
    assert.match(workflow, /python -m pip install -r requirements\.txt/);
    assert.doesNotMatch(workflow, /npm install/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
