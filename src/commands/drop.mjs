/**
 * Removes a worktree, refusing while there is anything to lose — and rescuing
 * the carried files this worktree holds the only copy of before it does.
 */
import { copyFileSync, cpSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import {
  carryPathState,
  describeEscapingAncestor,
  escapingAncestor,
  git,
  mainWorktree,
  nestedSymlinks,
  worktreeState,
  worktrees,
} from '../git.mjs';
import { removalBlockers, rescuableFiles } from '../decisions.mjs';
import { branchForSlug, parseBranchName } from '../naming.mjs';
import { CopseError } from './new.mjs';

export function commandDrop(argument, { cwd = process.cwd(), config }) {
  if (!argument) throw new CopseError('usage: copse drop <branch>');

  // Accept either form: the branch, or the directory slug it produced.
  let branch = argument;
  if (!parseBranchName(argument, config).ok) {
    try {
      branch = branchForSlug(argument, config);
    } catch {
      throw new CopseError(parseBranchName(argument, config).reason);
    }
  }

  const entry = worktrees({ cwd }).find((w) => w.branch === branch);
  if (!entry) throw new CopseError(`no worktree has ${branch} checked out`);

  const { dirty, unpushed } = worktreeState(entry.path);
  // A `startsWith` on raw paths treats `<repo>-feat-x2` as inside `<repo>-feat-x`
  // — a sibling worktree whose name happens to share a prefix. Require the
  // separator boundary (or exact equality) so only genuine descendants count.
  const resolvedCwd = resolve(cwd);
  const base = resolve(entry.path);
  const isCurrent = resolvedCwd === base || resolvedCwd.startsWith(base + sep);

  const blockers = removalBlockers({ dirty, unpushed, isMain: entry.isMain, isCurrent });
  if (blockers.length > 0) {
    throw new CopseError(
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
  // symlinked *leaf* is refused rather than followed. escapingAncestor
  // catches the other half: a symlinked *intermediate* directory, which
  // lstat on the leaf resolves straight through — `cfg -> /elsewhere` with a
  // carried `cfg/.env.test` makes lstat report on whatever
  // `/elsewhere/.env.test` is, "missing" if it is not there, which is
  // exactly what let a rescue write through it undetected.
  //
  // Both kinds of refusal are gated the same way: only when the path would
  // actually be read from or written through during the rescue below, i.e.
  // only when it actually participates in rescuableFiles' rescue set:
  //   - a worktree-side symlink (leaf or ancestor) is refused only when the
  //     repo side does not already hold a real copy — that is exactly the
  //     condition under which rescuableFiles would treat the path as
  //     rescuable and copyFileSync/cpSync would read through the
  //     worktree-side link;
  //   - a repo-side symlink (leaf or ancestor) is refused only when the
  //     worktree side holds a real copy that would be copied onto it — the
  //     write-through case, where copyFileSync/cpSync would follow the
  //     repo-side link and write to whatever it points at, including
  //     outside the repository.
  // A path that would never be touched by the rescue at all — e.g. the
  // worktree never carried it in the first place, because `copse new`
  // itself refused to copy through a repo-side symlink — must not block
  // `drop`: that would deadlock `new` and `drop` against each other, and
  // make `copse drop` unusable on any repository that legitimately
  // symlinks a carried path (e.g. an `.env` into a shared secrets
  // directory). Every refusal that does apply is still collected and
  // reported together, and drop stops before touching anything.
  const repoDir = mainWorktree({ cwd }).path;
  const carriedFiles = [...config.carryFiles];
  const carriedDirs = [...config.carryDirs];

  function classify(paths, { directories = false } = {}) {
    const worktreePresent = [];
    const repoPresent = [];
    const refused = [];
    for (const path of paths) {
      const worktreeState = carryPathState(join(entry.path, path));
      const repoState = carryPathState(join(repoDir, path));
      const worktreeEscape = escapingAncestor(entry.path, path);
      const repoEscape = escapingAncestor(repoDir, path);

      if (worktreeState === 'present') worktreePresent.push(path);
      if (repoState === 'present') repoPresent.push(path);

      if (worktreeState === 'symlink' && repoState !== 'present') {
        refused.push(`${path} (a symlink in ${entry.path}; refused rather than followed)`);
      }
      if (repoState === 'symlink' && worktreeState === 'present') {
        refused.push(`${path} (a symlink in ${repoDir}; refused rather than followed)`);
      }
      if (worktreeEscape && repoState !== 'present') {
        refused.push(describeEscapingAncestor(path, worktreeEscape, entry.path, 'the worktree'));
      }
      if (repoEscape && worktreeState === 'present') {
        refused.push(describeEscapingAncestor(path, repoEscape, repoDir, 'the repository'));
      }
      if (directories && worktreeState === 'present' && repoState !== 'present' && !worktreeEscape) {
        for (const nested of nestedSymlinks(join(entry.path, path))) {
          refused.push(`${path}/${nested} (a nested symlink in ${entry.path}; refused rather than rescued)`);
        }
      }
    }
    return { worktreePresent, repoPresent, refused };
  }

  const files = classify(carriedFiles);
  const dirs = classify(carriedDirs, { directories: true });

  const refusedCarry = [...files.refused, ...dirs.refused];
  if (refusedCarry.length > 0) {
    throw new CopseError(
      `not removing ${entry.path} — refused to inspect carried path(s):\n` +
        refusedCarry.map((r) => `  · ${r}`).join('\n') +
        '\nResolve the symlink(s) above (replace with a real file or directory), then retry.',
    );
  }

  const rescueFiles = rescuableFiles({ inWorktree: files.worktreePresent, inRepo: files.repoPresent });
  const rescueDirs = rescuableFiles({ inWorktree: dirs.worktreePresent, inRepo: dirs.repoPresent });

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
