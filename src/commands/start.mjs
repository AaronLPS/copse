import { runCommand } from '../process.mjs';
import { worktrees } from '../git.mjs';
import { commandNew, CopseError } from './new.mjs';

export function launchInWorktree(path, argv, { run = runCommand } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) throw new CopseError('no agent command configured');
  const result = run(argv[0], argv.slice(1), { cwd: path, inherit: true, allowFailure: true });
  return result.status ?? 1;
}

export function commandStart(branch, { cwd = process.cwd(), config, agent = 'codex', command = null, run = runCommand }) {
  if (!branch) throw new CopseError('usage: copse start <branch> [--agent codex|claude] [-- <command...>]');
  let entry = worktrees({ cwd }).find((worktree) => worktree.branch === branch);
  if (!entry) {
    const created = commandNew(branch, { cwd, config });
    entry = { path: created.path, branch };
  }
  const argv = command ?? config.agents[agent];
  if (!argv) throw new CopseError(`unknown agent "${agent}"; configured agents: ${Object.keys(config.agents).join(', ')}`);
  console.log(`→ launching ${argv.join(' ')} in ${entry.path}`);
  return launchInWorktree(entry.path, argv, { run });
}
