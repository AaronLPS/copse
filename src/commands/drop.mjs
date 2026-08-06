/**
 * Removes a worktree, refusing while there is anything to lose — and rescuing
 * the carried files this worktree holds the only copy of before it does.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

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
  // A `startsWith` on raw paths treats `<repo>-feat-x2` as inside `<repo>-feat-x`
  // — a sibling worktree whose name happens to share a prefix. Require the
  // separator boundary (or exact equality) so only genuine descendants count.
  const resolvedCwd = resolve(cwd);
  const base = resolve(entry.path);
  const isCurrent = resolvedCwd === base || resolvedCwd.startsWith(base + sep);

  const blockers = removalBlockers({ dirty, unpushed, isMain: entry.isMain, isCurrent });
  if (blockers.length > 0) {
    throw new GroveError(
      `not removing ${entry.path}:\n${blockers.map((b) => `  · ${b}`).join('\n')}`,
    );
  }

  // The carried files and directories are gitignored, so removing the
  // worktree destroys them. Both carryFiles and carryDirs are consulted —
  // rescuableFiles is pure and path-shaped, so it applies to directories
  // unchanged, but a directory must be *copied* recursively rather than as a
  // single file, so the two lists stay separate below.
  const repoDir = mainWorktree({ cwd }).path;
  const carriedFiles = [...config.carryFiles];
  const carriedDirs = [...config.carryDirs];
  const rescueFiles = rescuableFiles({
    inWorktree: carriedFiles.filter((file) => existsSync(join(entry.path, file))),
    inRepo: carriedFiles.filter((file) => existsSync(join(repoDir, file))),
  });
  const rescueDirs = rescuableFiles({
    inWorktree: carriedDirs.filter((dir) => existsSync(join(entry.path, dir))),
    inRepo: carriedDirs.filter((dir) => existsSync(join(repoDir, dir))),
  });

  if (rescueFiles.length > 0 || rescueDirs.length > 0) {
    console.log(`\n→ rescuing files held only here, into ${repoDir}`);
    for (const file of rescueFiles) {
      mkdirSync(dirname(join(repoDir, file)), { recursive: true });
      copyFileSync(join(entry.path, file), join(repoDir, file));
      console.log(`   ✓ ${file}`);
    }
    for (const dir of rescueDirs) {
      mkdirSync(dirname(join(repoDir, dir)), { recursive: true });
      cpSync(join(entry.path, dir), join(repoDir, dir), { recursive: true });
      console.log(`   ✓ ${dir}`);
    }
  }

  console.log(`→ removing ${entry.path}`);
  git(['worktree', 'remove', entry.path], { cwd: repoDir });
  console.log(
    `\n✓ removed. The branch ${branch} still exists — delete it with:\n  git branch -d ${branch}\n`,
  );
}
