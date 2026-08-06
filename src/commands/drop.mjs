/**
 * Removes a worktree, refusing while there is anything to lose — and rescuing
 * the carried files this worktree holds the only copy of before it does.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { git, mainWorktree, worktreeState, worktrees } from '../git.mjs';
import { removalBlockers, rescuableFiles } from '../decisions.mjs';
import { branchForSlug, parseBranchName } from '../naming.mjs';
import { GroveError } from './new.mjs';

export function commandDrop(argument, { cwd = process.cwd(), config }) {
  if (!argument) throw new GroveError('usage: grove drop <branch>');

  // Accept either form: the branch, or the directory slug it produced.
  let branch = argument;
  if (!parseBranchName(argument, config).ok) {
    try {
      branch = branchForSlug(argument, config);
    } catch {
      throw new GroveError(parseBranchName(argument, config).reason);
    }
  }

  const entry = worktrees({ cwd }).find((w) => w.branch === branch);
  if (!entry) throw new GroveError(`no worktree has ${branch} checked out`);

  const { dirty, unpushed } = worktreeState(entry.path);
  const isCurrent = resolve(cwd).startsWith(resolve(entry.path));

  const blockers = removalBlockers({ dirty, unpushed, isMain: entry.isMain, isCurrent });
  if (blockers.length > 0) {
    throw new GroveError(
      `not removing ${entry.path}:\n${blockers.map((b) => `  · ${b}`).join('\n')}`,
    );
  }

  // The carried files are gitignored, so removing the directory destroys them.
  const repoDir = mainWorktree({ cwd }).path;
  const carried = [...config.carryFiles];
  const rescue = rescuableFiles({
    inWorktree: carried.filter((file) => existsSync(join(entry.path, file))),
    inRepo: carried.filter((file) => existsSync(join(repoDir, file))),
  });

  if (rescue.length > 0) {
    console.log(`\n→ rescuing files held only here, into ${repoDir}`);
    for (const file of rescue) {
      mkdirSync(dirname(join(repoDir, file)), { recursive: true });
      copyFileSync(join(entry.path, file), join(repoDir, file));
      console.log(`   ✓ ${file}`);
    }
  }

  console.log(`→ removing ${entry.path}`);
  git(['worktree', 'remove', entry.path], { cwd: repoDir });
  console.log(
    `\n✓ removed. The branch ${branch} still exists — delete it with:\n  git branch -d ${branch}\n`,
  );
}
