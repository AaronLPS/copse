/**
 * Whether grove is still wired into this repository, and whether what the
 * config declares still matches what is on disk.
 *
 * This plan's scope is the worktree layer only. Later plans add the hook,
 * workflow and ruleset checks; the shape — collect findings, return them all,
 * exit non-zero if any — is set here.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { mainWorktree, worktrees } from '../git.mjs';
import { driftNote } from '../decisions.mjs';

export function commandDoctor({ cwd = process.cwd(), config }) {
  const findings = [];
  const repoDir = mainWorktree({ cwd }).path;

  // A declared file that is not in the main worktree cannot be carried, and
  // that failure surfaces later, inside a worktree, as a missing variable.
  for (const file of config.carryFiles) {
    if (!existsSync(join(repoDir, file))) {
      findings.push(`carryFiles lists "${file}", which is not in ${repoDir}`);
    }
  }
  for (const dir of config.carryDirs) {
    if (!existsSync(join(repoDir, dir))) {
      findings.push(`carryDirs lists "${dir}", which is not in ${repoDir}`);
    }
  }

  for (const entry of worktrees({ cwd })) {
    const note = driftNote(entry, config, { repoDir });
    if (note !== null) findings.push(`${entry.path}: ${note.replace(/^⚠ /, '')}`);
  }

  console.log('');
  if (findings.length === 0) {
    console.log('✓ grove: nothing to report\n');
  } else {
    for (const finding of findings) console.log(`  · ${finding}`);
    console.log(`\n✗ ${findings.length} finding(s)\n`);
  }

  return { ok: findings.length === 0, findings };
}
