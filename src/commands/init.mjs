import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILENAME } from '../config.mjs';
import { git, worktreeRoot } from '../git.mjs';
import { desiredWiring, detectCiMode, reconcileWiring } from '../wiring.mjs';

export function commandInit({ cwd = process.cwd(), config, apply = false }) {
  const repoDir = worktreeRoot({ cwd });
  let effective = config;
  if (config.ciMode === 'auto') effective = { ...effective, ciMode: detectCiMode(repoDir) };
  if (config.verify.length === 0 && existsSync(join(repoDir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
      if (pkg.scripts?.test) effective = { ...effective, verify: [['npm', 'test']] };
    } catch { /* malformed package.json is not init's file to diagnose */ }
  }
  const configPath = join(repoDir, CONFIG_FILENAME);
  if (apply && !existsSync(configPath)) {
    writeFileSync(configPath, JSON.stringify(effective, null, 2) + '\n');
  }
  const report = reconcileWiring(repoDir, desiredWiring(effective), { apply });
  if (apply) git(['config', 'core.hooksPath', '.githooks'], { cwd: repoDir });
  for (const path of report.created) console.log(`  ✓ created ${path}`);
  for (const path of report.updated) console.log(`  ✓ updated ${path}`);
  for (const path of report.missing.filter((p) => !report.created.includes(p))) console.log(`  · missing ${path}`);
  for (const path of report.conflicts) console.log(`  ! conflict ${path} (left unchanged)`);
  if (!apply && report.missing.length) console.log('\nRun copse init --apply to create missing wiring.');
  return { ok: report.conflicts.length === 0 && (apply || report.missing.length === 0), ...report };
}
