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

import { carryPathState, git, mainWorktree, worktrees } from '../git.mjs';
import { directoryFor, parseBranchName } from '../naming.mjs';

export class GroveError extends Error {}

export function commandNew(branch, { cwd = process.cwd(), config }) {
  if (!branch) throw new GroveError('usage: grove new <prefix>/<lower-kebab>');

  const parsed = parseBranchName(branch, config);
  if (!parsed.ok) throw new GroveError(parsed.reason);

  const repoDir = mainWorktree({ cwd }).path;
  const target = directoryFor(branch, config, { repoDir });

  if (existsSync(target)) throw new GroveError(`${target} already exists`);

  const existing = worktrees({ cwd }).find((entry) => entry.branch === branch);
  if (existing) throw new GroveError(`${branch} is already checked out at ${existing.path}`);

  const base = `origin/${config.baseBranch}`;
  console.log(`\n→ fetching, so ${base} is current`);
  git(['fetch', '--prune', 'origin'], { cwd: repoDir });

  console.log(`→ ${target}  (${branch} from ${base})`);
  git(['worktree', 'add', target, '-b', branch, base], { cwd: repoDir });

  console.log('→ copying the files git will not carry');
  let copied = 0;
  // Carried paths that turned out to be symlinks in the main worktree. A
  // symlink is refused rather than followed: copyFileSync/cpSync read
  // through it, and a dangling one under existsSync used to read as "not
  // present", which let it slip past as skipped instead of refused. Every
  // refusal is collected and reported together rather than aborting the
  // loop on the first one, so one bad carry path does not hide the rest.
  const refused = [];
  for (const file of config.carryFiles) {
    const from = join(repoDir, file);
    const state = carryPathState(from);
    if (state === 'symlink') {
      refused.push(`${file} (a symlink in ${repoDir}; refused rather than followed)`);
      continue;
    }
    if (state === 'missing') {
      console.log(`   – ${file} (not present in ${repoDir}; skipped)`);
      continue;
    }
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(from, join(target, file));
    console.log(`   ✓ ${file}`);
    copied += 1;
  }
  for (const dir of config.carryDirs) {
    const from = join(repoDir, dir);
    const state = carryPathState(from);
    if (state === 'symlink') {
      refused.push(`${dir} (a symlink in ${repoDir}; refused rather than followed)`);
      continue;
    }
    if (state === 'missing') {
      console.log(`   – ${dir} (not present in ${repoDir}; skipped)`);
      continue;
    }
    cpSync(from, join(target, dir), { recursive: true });
    console.log(`   ✓ ${dir}`);
    copied += 1;
  }
  if (copied === 0 && refused.length === 0 && (config.carryFiles.length > 0 || config.carryDirs.length > 0)) {
    console.log('   ! nothing was copied — the new worktree carries none of them');
  }

  // A failure from here on leaves a worktree that git worktree add already
  // created — half-provisioned, not half-created. Name where it is and how
  // to remove it, rather than leaving the caller to work that out from a
  // bare error.
  if (refused.length > 0) {
    throw new GroveError(
      `${target} exists but is only partly set up — refused to copy:\n` +
        refused.map((r) => `  · ${r}`).join('\n') +
        `\nFix the carried path(s) above, then remove this worktree with: grove drop ${branch}`,
    );
  }

  if (config.install) {
    console.log(`→ ${config.install.join(' ')}`);
    try {
      execFileSync(config.install[0], config.install.slice(1), { cwd: target, stdio: 'inherit' });
    } catch (error) {
      throw new GroveError(
        `${target} exists but ${config.install.join(' ')} failed:\n${error.message}\n` +
          `Fix the problem and re-run it there, or remove the worktree with: grove drop ${branch}`,
      );
    }
  }

  console.log(`\n✓ ${target}\n  cd ${target}\n`);
}
