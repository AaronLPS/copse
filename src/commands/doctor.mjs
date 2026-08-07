/**
 * Whether copse is still wired into this repository, and whether what the
 * config declares still matches what is on disk.
 *
 * This plan's scope is the worktree layer only. Later plans add the hook,
 * workflow and ruleset checks; the shape — collect findings, return them all,
 * exit non-zero if any — is set here.
 */
import { join } from 'node:path';

import { carryPathState, mainWorktree, worktrees } from '../git.mjs';
import { driftNote } from '../decisions.mjs';

export function commandDoctor({ cwd = process.cwd(), config }) {
  const findings = [];
  const repoDir = mainWorktree({ cwd }).path;

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

  console.log('');
  if (findings.length === 0) {
    console.log('✓ copse: nothing to report\n');
  } else {
    for (const finding of findings) console.log(`  · ${finding}`);
    console.log(`\n✗ ${findings.length} finding(s)\n`);
  }

  return { ok: findings.length === 0, findings };
}
