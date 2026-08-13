import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { desiredWiring, reconcileWiring } from '../src/wiring.mjs';

test('desired wiring covers Git, Codex, Claude, instructions, coordination and CI', () => {
  const files = desiredWiring({ verify: [['npm', 'test']] });
  for (const path of ['.githooks/pre-commit', '.githooks/pre-push', '.codex/hooks.json', '.claude/settings.json', 'AGENTS.md', 'CLAUDE.md', '.copse/features.json', '.github/workflows/copse.yml']) {
    assert.ok(files.has(path), `missing ${path}`);
  }
  assert.match(files.get('.githooks/pre-commit'), /git rev-parse --show-toplevel/);
  assert.match(files.get('.codex/hooks.json'), /git rev-parse --show-toplevel/);
  assert.match(files.get('.github/workflows/copse.yml'), /git config core\.hooksPath \.githooks/);
});

test('reconcile reports conflicts and apply never overwrites them', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-wire-'));
  try {
    writeFileSync(join(root, 'AGENTS.md'), 'consumer owned\n');
    const report = reconcileWiring(root, desiredWiring({ verify: [['npm', 'test']] }), { apply: true });
    assert.ok(report.conflicts.includes('AGENTS.md'));
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'consumer owned\n');
    assert.ok(report.created.includes('.githooks/pre-commit'));
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
