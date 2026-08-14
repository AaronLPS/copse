#!/usr/bin/env node
import { writeSync } from 'node:fs';

import { loadConfig } from './config.mjs';
import { worktreeRoot } from './git.mjs';
import { CopseError, commandNew } from './commands/new.mjs';
import { commandList } from './commands/list.mjs';
import { commandDrop } from './commands/drop.mjs';
import { commandDoctor } from './commands/doctor.mjs';
import { commandInit } from './commands/init.mjs';
import { commandHook } from './commands/hook.mjs';
import { commandStart } from './commands/start.mjs';
import { commandClaim } from './commands/claim.mjs';
import { commandRelease } from './commands/release.mjs';
import { commandVerify } from './commands/verify.mjs';
import { commandLand } from './commands/land.mjs';
import { commandProtect } from './commands/protect.mjs';
import { commandPr } from './commands/pr.mjs';
import { runnerPackageFromArgv } from './runner.mjs';

const USAGE = `
  copse init [--apply]                reconcile project wiring
  copse new <branch>                  create an isolated worktree
  copse start <branch> [--agent name] create/find it and launch an agent
  copse claim <branch> [options]      record owner and dependencies
  copse release <branch>              mark a feature dependency released
  copse list [--json]                 worktrees, pull requests and coordination
  copse verify                        doctor, then configured checks
  copse pr [branch] [--draft]         verify and create a pull request
  copse land [branch] [--yes]         gate and merge a pull request
  copse drop <branch>                 safely remove a worktree
  copse doctor                        validate all project wiring and state
  copse protect [--apply]             preview/apply GitHub branch protection
  copse hook <event>                  internal hook forward target
`;

const DEBUG = !['', '0', undefined].includes(process.env.COPSE_DEBUG);
function die(message) { writeSync(2, `\n✗ ${message}\n\n`); process.exit(1); }
function valuesAfter(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i += 1) if (argv[i] === flag && argv[i + 1]) values.push(argv[++i]);
  return values;
}

const argv = process.argv.slice(2);
const [command, argument] = argv;
if (!command || command === '--help' || command === '-h') { console.log(USAGE); process.exit(0); }

let repoDir;
try { repoDir = worktreeRoot(); }
catch (error) { if (DEBUG) throw error; die(`not inside a git repository: ${error.message}`); }
const loaded = loadConfig(repoDir);
if (!loaded.ok) die(`copse.config.json:\n${loaded.errors.map((error) => `  · ${error}`).join('\n')}`);
const config = loaded.config;

try {
  let status = 0;
  switch (command) {
    case 'init': {
      const marker = argv.indexOf('--');
      const initArgv = marker === -1 ? argv : argv.slice(0, marker);
      const ciMode = valuesAfter(initArgv, '--ci')[0];
      const initConfig = ciMode ? { ...config, ciMode } : config;
      const runnerPackage = runnerPackageFromArgv(initArgv);
      status = commandInit({
        config: initConfig, apply: initArgv.includes('--apply'), runnerPackage,
      }).ok ? 0 : 1;
      break;
    }
    case 'new': commandNew(argument, { config }); break;
    case 'start': {
      const marker = argv.indexOf('--');
      const custom = marker === -1 ? null : argv.slice(marker + 1);
      const agent = valuesAfter(argv, '--agent')[0] ?? 'codex';
      const owner = valuesAfter(argv, '--owner')[0];
      const optionArgv = argv.slice(0, marker === -1 ? argv.length : marker);
      status = await commandStart(argument, { config, agent, command: custom, owner, resources: valuesAfter(optionArgv, '--resource') });
      break;
    }
    case 'claim': commandClaim(argument, { config, owner: valuesAfter(argv, '--owner')[0], dependsOn: valuesAfter(argv, '--depends-on'), resources: valuesAfter(argv, '--resource') }); break;
    case 'release': commandRelease(argument, { config }); break;
    case 'list': commandList({ config, json: argv.includes('--json') }); break;
    case 'drop': commandDrop(argument, { config }); break;
    case 'doctor': status = commandDoctor({ config }).ok ? 0 : 1; break;
    case 'verify': status = commandVerify({ config }); break;
    case 'pr': commandPr(argument?.startsWith('--') ? null : argument, { config, draft: argv.includes('--draft'), verify: !argv.includes('--no-verify') }); break;
    case 'land': commandLand(argument?.startsWith('--') ? null : argument, { config, yes: argv.includes('--yes'), cleanup: !argv.includes('--no-cleanup'), createPr: argv.includes('--create-pr') }); break;
    case 'protect': commandProtect({ config, apply: argv.includes('--apply') }); break;
    case 'hook': commandHook(argument, { config }); break;
    default: console.log(USAGE); status = 1;
  }
  process.exit(status ?? 0);
} catch (error) {
  if (DEBUG && !(error instanceof CopseError)) throw error;
  die(error.message);
}
