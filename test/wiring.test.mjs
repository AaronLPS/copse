import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { desiredWiring, detectCiMode, reconcileWiring, wiringMatches } from '../src/wiring.mjs';

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

test('CI matching uses the final runner step when custom setup also ends in verify', () => {
  const expected = `jobs:
  verify:
    steps:
      - run: "echo verify"
      - run: "'npx' '--yes' 'copse@0.5.0' verify"
`;
  const cases = [
    {
      name: 'current JSON-quoted scalar',
      stale: `jobs:
  verify:
    steps:
      - run: "echo verify"
      - run: "'npx' '--yes' 'copse@0.4.0' verify"
# consumer-owned customization
`,
      current: `${expected}# consumer-owned customization\n`,
    },
    {
      name: 'legacy raw scalar',
      stale: `jobs:
  verify:
    steps:
      - run: "echo verify"
      - run: 'npx' '--yes' 'copse@0.4.0' verify
# consumer-owned customization
`,
      current: `jobs:
  verify:
    steps:
      - run: "echo verify"
      - run: 'npx' '--yes' 'copse@0.5.0' verify
# consumer-owned customization
`,
    },
  ];

  for (const { name, stale, current } of cases) {
    assert.equal(wiringMatches('.github/workflows/copse.yml', stale, expected), false, `${name} accepted a stale runner`);
    assert.equal(wiringMatches('.github/workflows/copse.yml', current, expected), true, `${name} rejected the exact runner`);
  }
});

test('CI matching requires the exact final runner command in jobs.verify', () => {
  const expected = `jobs:
  verify:
    steps:
      - run: "'npx' '--yes' 'copse@0.5.0' verify"
`;
  const onlyAnotherJob = `jobs:
  smoke:
    steps:
      - run: "'npx' '--yes' 'copse@0.5.0' verify"
  verify:
    steps:
      - run: "echo no copse here"
`;
  const inVerifyJob = `jobs:
  smoke:
    steps:
      - run: "echo smoke"
  verify:
    steps:
      - run: "echo setup"
      - run: "'npx' '--yes' 'copse@0.5.0' verify"
      - run: "npm run test:coverage"
`;

  assert.equal(wiringMatches('.github/workflows/copse.yml', onlyAnotherJob, expected), false);
  assert.equal(wiringMatches('.github/workflows/copse.yml', inVerifyJob, expected), true);
});

test('CI matching ignores fake jobs and run steps inside YAML block scalars', () => {
  const expected = `jobs:
  verify:
    steps:
      - run: "copse verify"
`;
  const cases = [
    `name: |
  jobs:
    verify:
      steps:
        - run: "copse verify"
jobs:
  verify:
    steps:
      - run: "echo no verification"
`,
    `name: >-
  jobs:
    verify:
      steps:
        - run: "copse verify"
jobs:
  verify:
    steps:
      - run: "echo no verification"
`,
    `jobs:
  verify:
    name: |2-
      steps:
        - run: "copse verify"
    steps:
      - run: "echo no verification"
`,
    `jobs:
  verify:
    name: >2+
      - run: "copse verify"
    steps:
      - run: "echo no verification"
`,
  ];

  for (const actual of cases) {
    assert.equal(wiringMatches('.github/workflows/copse.yml', actual, expected), false);
  }
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

test('reconcile removes stale Copse groups when old and new groups are both active', () => {
  const root = mkdtempSync(join(tmpdir(), 'copse-wire-'));
  try {
    const oldConfig = { verify: [['npm', 'test']], runner: ['npx', '--yes', 'copse@0.4.0'] };
    const newConfig = { verify: [['npm', 'test']], runner: ['npx', '--yes', 'copse@0.5.0'] };
    const previousDesired = desiredWiring(oldConfig);
    const desired = desiredWiring(newConfig);
    const oldSettings = JSON.parse(previousDesired.get('.claude/settings.json'));
    const newSettings = JSON.parse(desired.get('.claude/settings.json'));
    const consumerStart = { matcher: 'startup', hooks: [{ type: 'command', command: 'consumer start' }] };
    const consumerTool = { matcher: 'Read', hooks: [{ type: 'command', command: 'consumer read' }] };
    const initial = {
      hooks: {
        SessionStart: [oldSettings.hooks.SessionStart[0], consumerStart, newSettings.hooks.SessionStart[0]],
        PreToolUse: [oldSettings.hooks.PreToolUse[0], consumerTool, newSettings.hooks.PreToolUse[0]],
      },
    };
    const path = join(root, '.claude', 'settings.json');
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(path, JSON.stringify(initial, null, 2) + '\n');

    const preview = reconcileWiring(root, new Map([['.claude/settings.json', desired.get('.claude/settings.json')]]), {
      previousDesired: new Map([['.claude/settings.json', previousDesired.get('.claude/settings.json')]]),
    });
    assert.ok(preview.conflicts.includes('.claude/settings.json'));
    assert.equal(readFileSync(path, 'utf8'), JSON.stringify(initial, null, 2) + '\n');

    const applied = reconcileWiring(root, new Map([['.claude/settings.json', desired.get('.claude/settings.json')]]), {
      apply: true,
      previousDesired: new Map([['.claude/settings.json', previousDesired.get('.claude/settings.json')]]),
    });
    const settings = JSON.parse(readFileSync(path, 'utf8'));
    assert.ok(applied.updated.includes('.claude/settings.json'));
    assert.deepEqual(settings.hooks.SessionStart, [consumerStart, newSettings.hooks.SessionStart[0]]);
    assert.deepEqual(settings.hooks.PreToolUse, [consumerTool, newSettings.hooks.PreToolUse[0]]);
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
