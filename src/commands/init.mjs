import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CONFIG_FILENAME, parseConfig } from '../config.mjs';
import { git, worktreeRoot } from '../git.mjs';
import {
  COPSE_HOOKS_PATH, desiredGitHooks, hookMigration, legacyGitHooks,
} from '../git-hooks.mjs';
import { configWithRunner, runnerForPackage } from '../runner.mjs';
import { desiredWiring, detectCiMode, reconcileWiring } from '../wiring.mjs';

function writeConfig(path, content) {
  const temp = `${path}.copse-tmp-${process.pid}`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

export function commandInit({ cwd = process.cwd(), config, apply = false, runnerPackage = null }) {
  const repoDir = worktreeRoot({ cwd });
  const currentHooksPath = git(['config', '--local', '--get', 'core.hooksPath'], {
    cwd: repoDir, allowFailure: true,
  });
  const recordedPrevious = git(['config', '--local', '--get', 'copse.previousHooksPath'], {
    cwd: repoDir, allowFailure: true,
  });
  const legacy = legacyGitHooks(config);
  const legacyCopse = currentHooksPath === '.githooks' && [...legacy].every(([relative, expected]) => {
    const path = join(repoDir, relative);
    return existsSync(path) && readFileSync(path, 'utf8') === expected;
  });
  const migration = hookMigration({ currentHooksPath, recordedPrevious, legacyCopse });
  let effective = config;
  if (config.ciMode === 'auto') effective = { ...effective, ciMode: detectCiMode(repoDir) };
  if (config.verify.length === 0 && existsSync(join(repoDir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
      if (pkg.scripts?.test) effective = { ...effective, verify: [['npm', 'test']] };
    } catch { /* malformed package.json is not init's file to diagnose */ }
  }
  const configPath = join(repoDir, CONFIG_FILENAME);
  const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
  const previousDesired = desiredWiring(effective);
  const previousGitHooks = desiredGitHooks(effective);
  const requestedRunner = runnerPackage ? runnerForPackage(runnerPackage) : null;
  const rawWithInvocationOverrides = raw ? { ...raw, ciMode: config.ciMode } : effective;
  const requestedRaw = requestedRunner
    ? configWithRunner(rawWithInvocationOverrides, requestedRunner)
    : rawWithInvocationOverrides;
  const parsed = parseConfig(requestedRaw);
  if (!parsed.ok) throw new Error(`cannot update ${CONFIG_FILENAME}:\n${parsed.errors.join('\n')}`);
  effective = parsed.config;
  if (effective.ciMode === 'auto') effective = { ...effective, ciMode: detectCiMode(repoDir) };
  if (effective.verify.length === 0 && existsSync(join(repoDir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(repoDir, 'package.json'), 'utf8'));
      if (pkg.scripts?.test) effective = { ...effective, verify: [['npm', 'test']] };
    } catch { /* malformed package.json is not init's file to diagnose */ }
  }
  const configChanged = requestedRunner !== null && JSON.stringify(config.runner) !== JSON.stringify(requestedRunner);
  if (configChanged && !apply) console.log(`  · pending runner update in ${CONFIG_FILENAME}`);
  if (apply && (!raw || configChanged)) {
    const saved = raw && configChanged ? requestedRaw : effective;
    writeConfig(configPath, JSON.stringify(saved, null, 2) + '\n');
  }
  const genericReport = reconcileWiring(repoDir, desiredWiring(effective), { apply, previousDesired });
  const hookReport = reconcileWiring(repoDir, desiredGitHooks(effective), {
    apply, previousDesired: previousGitHooks,
  });
  const report = Object.fromEntries(
    ['missing', 'matching', 'conflicts', 'created', 'updated'].map((key) => [
      key, [...genericReport[key], ...hookReport[key]],
    ]),
  );
  if (apply && genericReport.conflicts.length === 0 && hookReport.conflicts.length === 0) {
    git(['config', '--local', 'copse.previousHooksPath', migration.previous], { cwd: repoDir });
    git(['config', '--local', 'core.hooksPath', COPSE_HOOKS_PATH], { cwd: repoDir });
  }
  for (const path of report.created) console.log(`  ✓ created ${path}`);
  for (const path of report.updated) console.log(`  ✓ updated ${path}`);
  for (const path of report.missing.filter((p) => !report.created.includes(p))) console.log(`  · missing ${path}`);
  for (const path of report.conflicts) console.log(`  ! conflict ${path} (left unchanged)`);
  if (!apply && report.missing.length) console.log('\nRun copse init --apply to create missing wiring.');
  return {
    ok: report.conflicts.length === 0 && (apply || report.missing.length === 0),
    configChanged,
    effectiveConfig: effective,
    ...report,
  };
}
