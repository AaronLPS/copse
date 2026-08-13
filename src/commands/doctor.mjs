/**
 * Whether copse is still wired into this repository, and whether what the
 * config declares still matches what is on disk.
 *
 * Collects worktree, carried-path, generated-forward, hook-path and CI findings
 * in one pass and exits non-zero if any are present.
 */
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { carryPathState, git, mainWorktree, worktreeRoot, worktrees } from '../git.mjs';
import { driftNote } from '../decisions.mjs';
import { CONFIG_FILENAME } from '../config.mjs';
import { desiredWiring, wiringMatches } from '../wiring.mjs';

export function commandDoctor({ cwd = process.cwd(), config }) {
  const findings = [];
  const repoDir = mainWorktree({ cwd }).path;
  const wiringRoot = worktreeRoot({ cwd });

  // A declared file that is not in the main worktree cannot be carried, and
  // that failure surfaces later, inside a worktree, as a missing variable.
  // carryPathState (lstat) is used rather than existsSync, so a symlink is
  // named as what it is rather than following it — existsSync would follow
  // a dangling symlink to nothing and report it as simply "not in
  // <repoDir>", hiding the reason `new`/`drop` refuse it.
  for (const [label, list] of [['carryFiles', config.carryFiles], ['carryDirs', config.carryDirs]]) {
    for (const path of list) {
      const state = carryPathState(join(repoDir, path));
      if (state === 'missing') {
        findings.push(`${label} lists "${path}", which is not in ${repoDir}`);
      } else if (state === 'symlink') {
        findings.push(
          `${label} lists "${path}", which is a symlink in ${repoDir} — copse refuses to follow it`,
        );
      }
    }
  }

  for (const entry of worktrees({ cwd })) {
    const note = driftNote(entry, config, { repoDir });
    if (note !== null) findings.push(`${entry.path}: ${note.replace(/^⚠ /, '')}`);
  }

  if (existsSync(join(wiringRoot, CONFIG_FILENAME))) {
    for (const [relative, expected] of desiredWiring(config)) {
      const path = join(wiringRoot, relative);
      if (!existsSync(path)) findings.push(`missing copse wiring: ${relative}`);
      else if (!wiringMatches(relative, readFileSync(path, 'utf8'), expected)) findings.push(`copse wiring differs: ${relative}`);
    }
    const hooksPath = git(['config', '--local', '--get', 'core.hooksPath'], { cwd: wiringRoot, allowFailure: true });
    if (hooksPath !== '.githooks') findings.push('git core.hooksPath is not .githooks');
    const runner = config.runner?.[0];
    if (runner?.includes('/') || isAbsolute(runner ?? '')) {
      const runnerPath = isAbsolute(runner) ? runner : resolve(wiringRoot, runner);
      try {
        accessSync(runnerPath, constants.X_OK);
      } catch {
        findings.push(`configured hook runner is not executable: ${runner}`);
      }
    }
  }

  console.log('');
  if (findings.length === 0) {
    console.log('✓ copse: nothing to report\n');
  } else {
    for (const finding of findings) console.log(`  · ${finding}`);
    console.log(`\n✗ ${findings.length} finding(s)\n`);
  }

  return { ok: findings.length === 0, findings };
}
