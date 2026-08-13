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
while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 25));
