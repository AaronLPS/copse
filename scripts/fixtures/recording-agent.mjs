#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const [label, marker, gate, ...forwarded] = process.argv.slice(2);
if (!label || !marker || !gate) throw new Error('usage: recording-agent <label> <marker> <gate> [...argv]');
writeFileSync(marker, JSON.stringify({
  label,
  cwd: process.cwd(),
  branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  forwarded,
}) + '\n');
if (process.env.COPSE_PACKAGE_SMOKE_MUTATION === 'launcher-closes-before-agent' && label === 'codex') {
  process.stdout.destroy();
  process.stderr.destroy();
}
while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 25));
if (['hang-after-codex-gate', 'launcher-closes-before-agent'].includes(process.env.COPSE_PACKAGE_SMOKE_MUTATION) && label === 'codex') {
  while (true) await new Promise((resolve) => setTimeout(resolve, 1_000));
}
