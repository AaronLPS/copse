/**
 * Removes a worktree, refusing while there is anything to lose — and rescuing
 * the carried files this worktree holds the only copy of before it does.
 */
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { carryPathState, git, mainWorktree, worktreeState, worktrees } from '../git.mjs';
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
  //
  // Presence is decided with carryPathState (lstat), not existsSync, and a
  // symlink on either side is refused rather than followed. existsSync
  // follows symlinks: a *dangling* one at the repo-side path used to read as
  // "the repo does not hold this file", which made the file look rescuable
  // and sent copyFileSync writing through the link to whatever it points
  // at — including outside the repository entirely. Every refusal is
  // collected and reported together, and drop stops before touching
  // anything, rather than rescuing what it safely can and silently losing
  // the rest.
  const repoDir = mainWorktree({ cwd }).path;
  const carriedFiles = [...config.carryFiles];
  const carriedDirs = [...config.carryDirs];

  function classify(paths, baseDir, side) {
    const present = [];
    const refused = [];
    for (const path of paths) {
      const state = carryPathState(join(baseDir, path));
      if (state === 'symlink') refused.push(`${path} (a symlink in ${side}; refused rather than followed)`);
      else if (state === 'present') present.push(path);
    }
    return { present, refused };
  }

  const worktreeFiles = classify(carriedFiles, entry.path, entry.path);
  const repoFilesSeen = classify(carriedFiles, repoDir, repoDir);
  const worktreeDirs = classify(carriedDirs, entry.path, entry.path);
  const repoDirsSeen = classify(carriedDirs, repoDir, repoDir);

  const refusedCarry = [
    ...worktreeFiles.refused,
    ...repoFilesSeen.refused,
    ...worktreeDirs.refused,
    ...repoDirsSeen.refused,
  ];
  if (refusedCarry.length > 0) {
    throw new GroveError(
      `not removing ${entry.path} — refused to inspect carried path(s):\n` +
        refusedCarry.map((r) => `  · ${r}`).join('\n') +
        '\nResolve the symlink(s) above (replace with a real file or directory), then retry.',
    );
  }

  const rescueFiles = rescuableFiles({ inWorktree: worktreeFiles.present, inRepo: repoFilesSeen.present });
  const rescueDirs = rescuableFiles({ inWorktree: worktreeDirs.present, inRepo: repoDirsSeen.present });

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
