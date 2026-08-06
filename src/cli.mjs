#!/usr/bin/env node
/**
 * Argument dispatch and the one place a refusal becomes an exit code.
 */
import { loadConfig } from './config.mjs';
import { mainWorktree } from './git.mjs';
import { GroveError, commandNew } from './commands/new.mjs';
import { commandList } from './commands/list.mjs';

const USAGE = `
  grove new <prefix>/<lower-kebab>   worktree off the base branch, files carried
  grove list                         every worktree, and whether its name still fits
  grove drop <branch>                refuses while there is anything to lose
  grove doctor                       is grove still wired into this repository

  The directory is derived from the branch. Configure in grove.config.json.
`;

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
} catch {
  die('not inside a git repository');
}

const loaded = loadConfig(repoDir);
if (!loaded.ok) {
  console.error('\n✗ grove.config.json:');
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
    default:
      console.log(USAGE);
      process.exit(1);
  }
} catch (error) {
  if (error instanceof GroveError) die(error.message);
  throw error;
}
