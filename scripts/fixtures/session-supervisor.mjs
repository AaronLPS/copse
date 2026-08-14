#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';

const statusPath = process.argv[2];
const divider = process.argv.indexOf('--');
const argv = divider === -1 ? [] : process.argv.slice(divider + 1);
if (!statusPath || argv.length === 0) {
  throw new Error('usage: session-supervisor <status-path> -- <command...>');
}

const status = {
  version: 1,
  supervisorPid: process.pid,
  launcherPid: null,
  launcher: { completed: false, code: null, signal: null, error: null },
  stdout: '',
  stderr: '',
  termSignals: 0,
};

function save() {
  const temporary = `${statusPath}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify(status) + '\n');
  renameSync(temporary, statusPath);
}

// Keep the group identity alive after a graceful tree signal. The harness
// follows with SIGKILL against this still-owned process group, which prevents
// a stale/reused PGID from ever becoming a teardown target.
if (process.platform !== 'win32') {
  process.on('SIGTERM', () => {
    status.termSignals += 1;
    save();
  });
}

save();
const launcher = spawn(argv[0], argv.slice(1), {
  cwd: process.cwd(),
  env: process.env,
  detached: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});
status.launcherPid = launcher.pid ?? null;
save();

launcher.stdout.on('data', (chunk) => {
  status.stdout += chunk;
  save();
});
launcher.stderr.on('data', (chunk) => {
  status.stderr += chunk;
  save();
});

let launcherCompleted = false;
function completeLauncher(values) {
  if (launcherCompleted) return;
  launcherCompleted = true;
  Object.assign(status.launcher, { completed: true, ...values });
  save();
}
launcher.once('error', (error) => completeLauncher({ error: error.message }));
launcher.once('close', (code, signal) => completeLauncher({ code, signal }));

// Deliberately persistent. Teardown owns this process and must explicitly
// terminate its live session/process group after all acceptance assertions.
setInterval(() => {}, 1_000);
