#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const [label, marker, gate, ...forwarded] = process.argv.slice(2);
if (!label || !marker || !gate) throw new Error('usage: recording-agent <label> <marker> <gate> [...argv]');
writeFileSync(marker, JSON.stringify({
  label,
  cwd: process.cwd(),
  branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  forwarded,
}) + '\n');
if (process.env.COPSE_PACKAGE_SMOKE_MUTATION === 'grandchild-survives' && label === 'codex') {
  const grandchild = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {
    detached: false,
    stdio: 'ignore',
  });
  writeFileSync(process.env.COPSE_GRANDCHILD_PID_PATH, `${grandchild.pid}\n`);
  grandchild.unref();
}
while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 25));
if (process.env.COPSE_PACKAGE_SMOKE_MUTATION === 'hang-after-codex-gate' && label === 'codex') {
  while (true) await new Promise((resolve) => setTimeout(resolve, 1_000));
}
