import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), 'copse-package-'));

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

try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root }));
  const artifact = join(temp, packed[0].filename);
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
    runner: [copse],
    agents: { codex: ['codex'], claude: ['claude'] },
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
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
  const runCopse = (args, options = {}) => run(copse, args, { cwd: consumer, env, ...options });

  const help = runCopse(['--help']);
  if (!help.includes('copse init') || !help.includes('copse land')) throw new Error('installed CLI help is incomplete');
  runCopse(['init', '--apply']);
  run('git', ['-c', 'core.hooksPath=/dev/null', 'add', '.githooks', '.codex', '.claude', '.copse', '.github', 'AGENTS.md', 'CLAUDE.md'], { cwd: consumer });
  run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'install copse wiring'], { cwd: consumer });
  run('git', ['-c', 'core.hooksPath=/dev/null', 'push', 'origin', 'main'], { cwd: consumer });
  runCopse(['doctor']);

  let blocked = false;
  try {
    run('git', ['commit', '--allow-empty', '-m', 'must be blocked'], { cwd: consumer, env });
  } catch (error) {
    blocked = /protected/.test(`${error.stderr ?? ''}`);
  }
  if (!blocked) throw new Error('installed pre-commit hook did not protect main');

  const session = spawn(copse, [
    'start', 'feat/session', '--owner', 'smoke@host', '--',
    process.execPath, '-e', 'setTimeout(() => {}, 1200)',
  ], { cwd: consumer, env, stdio: 'ignore' });
  const statePath = join(consumer, '.git', 'copse', 'features.json');
  await waitFor(() => {
    if (!existsSync(statePath)) return null;
    return JSON.parse(readFileSync(statePath, 'utf8')).leases?.['feat/session'];
  });
  const snapshot = JSON.parse(runCopse(['list', '--json']));
  const sessionRow = snapshot.worktrees.find((row) => row.branch === 'feat/session');
  if (sessionRow?.lease?.owner !== 'smoke@host') throw new Error('list JSON omitted the active packaged session lease');

  let duplicateBlocked = false;
  try {
    runCopse(['start', 'feat/session', '--owner', 'smoke@host', '--', process.execPath, '-e', 'process.exit(0)']);
  } catch (error) {
    duplicateBlocked = /active session/.test(`${error.stderr ?? ''}`);
  }
  if (!duplicateBlocked) throw new Error('packaged CLI allowed a duplicate live session');
  const sessionStatus = await new Promise((resolveExit, reject) => {
    session.once('error', reject);
    session.once('exit', (code) => resolveExit(code));
  });
  if (sessionStatus !== 0) throw new Error(`packaged session exited ${sessionStatus}`);
  runCopse(['drop', 'feat/session']);

  runCopse(['new', 'feat/land']);
  runCopse(['land', 'feat/land', '--yes']);
  runCopse(['verify']);

  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', 'copse', 'package.json'), 'utf8'));
  console.log(`package acceptance ok: copse ${installed.version}, ${packed[0].files.length} files`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
