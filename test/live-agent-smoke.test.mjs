import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const commandWrapper = fileURLToPath(new URL('../scripts/live-agent-command.mjs', import.meta.url));

test('live agent smoke requires explicit opt-in and both argv arrays', () => {
  const absent = spawnSync(process.execPath, ['scripts/live-agent-smoke.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, COPSE_LIVE_AGENT_TEST: '' },
  });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /COPSE_LIVE_AGENT_TEST=1/);

  const missingClaude = spawnSync(process.execPath, ['scripts/live-agent-smoke.mjs'], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      COPSE_LIVE_AGENT_TEST: '1',
      COPSE_CODEX_COMMAND: JSON.stringify([process.execPath, '-e', 'process.exit(0)']),
      COPSE_CLAUDE_COMMAND: '',
    },
  });
  assert.notEqual(missingClaude.status, 0);
  assert.match(missingClaude.stderr, /COPSE_CLAUDE_COMMAND/);
});

test('live agent command records its repo context and preserves exact argv and status', () => {
  const temp = mkdtempSync(join(tmpdir(), 'copse-live-command-'));
  const marker = join(temp, 'marker.json');
  const argvLog = join(temp, 'argv.json');
  try {
    execFileSync('git', ['init', '-b', 'live-wrapper', temp], { stdio: 'ignore' });
    const fakeCommand = [
      process.execPath,
      '-e',
      'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2))); process.exit(7)',
      argvLog,
      'literal with spaces;$(not-a-shell)',
    ];

    const result = spawnSync(process.execPath, [commandWrapper, marker, '--', ...fakeCommand], {
      cwd: temp,
      encoding: 'utf8',
    });

    assert.equal(result.status, 7);
    assert.deepEqual(JSON.parse(readFileSync(argvLog, 'utf8')), ['literal with spaces;$(not-a-shell)']);
    assert.deepEqual(JSON.parse(readFileSync(marker, 'utf8')), {
      cwd: temp,
      branch: 'live-wrapper',
    });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('live agent smoke completes two overlapping packed fake sessions', {
  skip: process.env.COPSE_LIVE_FAKE_TEST !== '1',
}, () => {
  const fakeCommand = JSON.stringify([
    process.execPath,
    '-e',
    'setTimeout(() => {}, 500)',
  ]);
  const result = spawnSync(process.execPath, ['scripts/live-agent-smoke.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      COPSE_LIVE_AGENT_TEST: '1',
      COPSE_CODEX_COMMAND: fakeCommand,
      COPSE_CLAUDE_COMMAND: fakeCommand,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /live agent acceptance ok/);
});
