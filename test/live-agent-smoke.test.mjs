import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

test('live agent smoke tears down later supervisors after an earlier teardown failure', {
  skip: process.env.COPSE_LIVE_FAKE_TEST !== '1' || process.platform === 'win32',
}, () => {
  const temp = mkdtempSync(join(tmpdir(), 'copse-live-cleanup-'));
  const startedPath = join(temp, 'second-started');
  const cleanedPath = join(temp, 'second-cleaned');
  const supervisorPidPath = join(temp, 'second-supervisor.pid');
  const parentPidExpression = `Number(require('node:child_process').execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())`;
  const firstCommand = JSON.stringify([
    process.execPath,
    '-e',
    `const fs=require('node:fs'); let pid=process.pid; for(let i=0;i<3;i++) pid=${parentPidExpression}; const started=process.argv[1]; const wait=()=>{ if(fs.existsSync(started)){ process.kill(pid, 'SIGKILL'); process.exit(0); } setTimeout(wait, 10); }; wait();`,
    startedPath,
  ]);
  const secondCommand = JSON.stringify([
    process.execPath,
    '-e',
    `const fs=require('node:fs'); let pid=process.pid; for(let i=0;i<3;i++) pid=${parentPidExpression}; fs.writeFileSync(process.argv[3], String(pid)); process.on('SIGTERM', ()=>fs.writeFileSync(process.argv[2], 'cleaned')); fs.writeFileSync(process.argv[1], 'started'); setInterval(()=>{}, 1000);`,
    startedPath,
    cleanedPath,
    supervisorPidPath,
  ]);

  try {
    const result = spawnSync(process.execPath, ['scripts/live-agent-smoke.mjs'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        COPSE_LIVE_AGENT_TEST: '1',
        COPSE_CODEX_COMMAND: firstCommand,
        COPSE_CLAUDE_COMMAND: secondCommand,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Codex supervisor exited before owned-tree teardown/);
    assert.equal(existsSync(cleanedPath), true, result.stderr || result.error?.message);
  } finally {
    if (existsSync(supervisorPidPath)) {
      const supervisorPid = Number(readFileSync(supervisorPidPath, 'utf8'));
      try { process.kill(-supervisorPid, 'SIGKILL'); } catch {}
    }
    rmSync(temp, { recursive: true, force: true });
  }
});
