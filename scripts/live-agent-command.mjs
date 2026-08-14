#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const marker = process.argv[2];
const divider = process.argv.indexOf('--');
const argv = divider === -1 ? [] : process.argv.slice(divider + 1);
if (!marker || argv.length === 0) {
  throw new Error('usage: live-agent-command <marker> -- <command...>');
}

function currentBranch() {
  return execFileSync('git', ['branch', '--show-current'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runInteractive(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

writeFileSync(marker, JSON.stringify({ cwd: process.cwd(), branch: currentBranch() }) + '\n');
const status = await runInteractive(argv[0], argv.slice(1));
process.exit(status);
