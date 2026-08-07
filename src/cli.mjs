#!/usr/bin/env node
/**
 * Argument dispatch and the one place a refusal becomes an exit code.
 */
import { loadConfig } from './config.mjs';
import { mainWorktree } from './git.mjs';
import { CopseError, commandNew } from './commands/new.mjs';
import { commandList } from './commands/list.mjs';
import { commandDrop } from './commands/drop.mjs';
import { commandDoctor } from './commands/doctor.mjs';

const USAGE = `
  copse new <prefix>/<lower-kebab>   worktree off the base branch, files carried
  copse list                         every worktree, and whether its name still fits
  copse drop <branch>                refuses while there is anything to lose
  copse doctor                       is copse still wired into this repository

  The directory is derived from the branch. Configure in copse.config.json.
`;

// Boolean(process.env.COPSE_DEBUG) treats the string "0" as truthy — it is
// a non-empty string like any other — so COPSE_DEBUG=0, meant to mean "off",
// turned debug mode on. Only unset, empty, and the literal "0" mean off.
const DEBUG = !['', '0', undefined].includes(process.env.COPSE_DEBUG);

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const [command, argument] = process.argv.slice(2);

if (command === undefined || command === '--help' || command === '-h') {
  console.log(USAGE);
  process.exit(0);
}

let repoDir;
try {
  repoDir = mainWorktree().path;
} catch (error) {
  if (DEBUG) throw error;
  die(`not inside a git repository: ${error.message}`);
}

const loaded = loadConfig(repoDir);
if (!loaded.ok) {
  console.error('\n✗ copse.config.json:');
  for (const error of loaded.errors) console.error(`  · ${error}`);
  console.error('');
  process.exit(1);
}
const config = loaded.config;

try {
  switch (command) {
    case 'new':
      commandNew(argument, { config });
      break;
    case 'list':
      commandList({ config });
      break;
    case 'drop':
      commandDrop(argument, { config });
      break;
    case 'doctor': {
      const { ok } = commandDoctor({ config });
      process.exit(ok ? 0 : 1);
      break;
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }
} catch (error) {
  // Every user-facing failure is rendered through the same die() path, not
  // just CopseError refusals — otherwise the most likely first-run failures
  // (no origin remote, offline, install exiting non-zero, git worktree add
  // refusing) end in a raw V8 stack trace instead of a message. The stack
  // stays reachable behind COPSE_DEBUG for anyone debugging copse itself.
  if (DEBUG) throw error;
  die(error.message);
}
