/**
 * Creates a worktree whose directory is derived from its branch, carrying the
 * gitignored files git cannot.
 *
 * Those files are the reason this command exists rather than a documented
 * `git worktree add` incantation: they are invisible in their absence, so a
 * hand-made worktree builds and then fails at runtime on a missing variable,
 * which reads as a code problem.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  carryPathState,
  describeEscapingAncestor,
  escapingAncestor,
  git,
  mainWorktree,
  worktrees,
} from '../git.mjs';
import { directoryFor, parseBranchName } from '../naming.mjs';

export class CopseError extends Error {}

export function commandNew(branch, { cwd = process.cwd(), config }) {
  if (!branch) throw new CopseError('usage: copse new <prefix>/<lower-kebab>');

  const parsed = parseBranchName(branch, config);
  if (!parsed.ok) throw new CopseError(parsed.reason);

  const main = mainWorktree({ cwd });
  if (main.bare) {
    // directoryFor derives the sibling directory from the main worktree's
    // own path — for a bare repository that path is the bare directory
    // itself (conventionally `<project>.git`), so the new worktree would be
    // named `<project>.git-feat-x` instead of anything resembling the
    // project. Making that naming (and the rest of a bare-aware `new`) work
    // is a real design question for a later plan, not a one-line fix — so
    // this refuses cleanly instead of producing a worktree nobody would
    // recognise.
    throw new CopseError(
      `${main.path} is a bare repository; copse new does not yet support creating worktrees ` +
        'against a bare main repository',
    );
  }
  const repoDir = main.path;
  const target = directoryFor(branch, config, { repoDir });

  if (existsSync(target)) throw new CopseError(`${target} already exists`);

  const existing = worktrees({ cwd }).find((entry) => entry.branch === branch);
  if (existing) throw new CopseError(`${branch} is already checked out at ${existing.path}`);

  const base = `origin/${config.baseBranch}`;
  console.log(`\n→ fetching, so ${base} is current`);
  git(['fetch', '--prune', 'origin'], { cwd: repoDir });

  console.log(`→ ${target}  (${branch} from ${base})`);
  git(['worktree', 'add', target, '-b', branch, base], { cwd: repoDir });

  console.log('→ copying the files git will not carry');
  let copied = 0;
  // Carried paths that turned out to be symlinks, or that pass through one,
  // on either side of the copy. A symlink is refused rather than followed:
  // copyFileSync/cpSync read or write through it, and a dangling one under
  // existsSync used to read as "not present", which let it slip past as
  // skipped instead of refused. carryPathState catches a symlinked *leaf*;
  // escapingAncestor catches a symlinked *intermediate directory* — lstat on
  // the leaf resolves every segment before it, so `cfg -> /elsewhere` with a
  // carried `cfg/.env.test` reads as whatever `/elsewhere/.env.test` is, not
  // as "cfg is a symlink". Both the source (repoDir) and the destination
  // (target — a symlink could be committed on the branch itself and arrive
  // via the checkout `worktree add` just did) are checked; every refusal is
  // collected and reported together rather than aborting the loop on the
  // first one, so one bad carry path does not hide the rest.
  const refused = [];
  function copyCarryPath(rel, copy) {
    const from = join(repoDir, rel);
    const sourceEscape = escapingAncestor(repoDir, rel);
    if (sourceEscape) {
      refused.push(describeEscapingAncestor(rel, sourceEscape, repoDir, 'the repository'));
      return;
    }
    const sourceState = carryPathState(from);
    if (sourceState === 'symlink') {
      refused.push(`${rel} (a symlink in ${repoDir}; refused rather than followed)`);
      return;
    }
    if (sourceState === 'missing') {
      console.log(`   – ${rel} (not present in ${repoDir}; skipped)`);
      return;
    }

    const to = join(target, rel);
    const destEscape = escapingAncestor(target, rel);
    if (destEscape) {
      refused.push(describeEscapingAncestor(rel, destEscape, target, 'the new worktree'));
      return;
    }
    const destState = carryPathState(to);
    if (destState === 'symlink') {
      refused.push(
        `${rel} (a symlink already checked out at ${to}; refused rather than followed)`,
      );
      return;
    }

    copy(from, to);
    console.log(`   ✓ ${rel}`);
    copied += 1;
  }

  for (const file of config.carryFiles) {
    copyCarryPath(file, (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(from, to);
    });
  }
  for (const dir of config.carryDirs) {
    copyCarryPath(dir, (from, to) => {
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
    });
  }
  if (copied === 0 && refused.length === 0 && (config.carryFiles.length > 0 || config.carryDirs.length > 0)) {
    console.log('   ! nothing was copied — the new worktree carries none of them');
  }

  // A failure from here on leaves a worktree that git worktree add already
  // created — half-provisioned, not half-created. Name where it is and how
  // to remove it, rather than leaving the caller to work that out from a
  // bare error.
  if (refused.length > 0) {
    throw new CopseError(
      `${target} exists but is only partly set up — refused to copy:\n` +
        refused.map((r) => `  · ${r}`).join('\n') +
        `\nFix the carried path(s) above, then remove this worktree with: copse drop ${branch}`,
    );
  }

  if (config.install) {
    console.log(`→ ${config.install.join(' ')}`);
    try {
      execFileSync(config.install[0], config.install.slice(1), { cwd: target, stdio: 'inherit' });
    } catch (error) {
      throw new CopseError(
        `${target} exists but ${config.install.join(' ')} failed:\n${error.message}\n` +
          `Fix the problem and re-run it there, or remove the worktree with: copse drop ${branch}`,
      );
    }
  }

  console.log(`\n✓ ${target}\n  cd ${target}\n`);
}
