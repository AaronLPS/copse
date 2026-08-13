# Productize Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make copse bootstrap reproducible, preserve pre-existing Git hooks during onboarding, and prove two independent agent processes can run concurrently in isolated worktrees.

**Architecture:** Add a pure runner-package adapter and a focused Git-hook delegation module, then let `init` coordinate atomic config updates, generic wiring, wrapper installation, and clone-local Git settings. Extend packed-artifact acceptance with two real child processes and add a separately opted-in live vendor harness so deterministic CI never consumes Codex or Claude quota.

**Tech Stack:** Node.js >=20, ESM, Node standard library only, POSIX Git hooks, `node:test`, real temporary Git repositories, packed npm artifacts.

**Spec:** `docs/superpowers/specs/2026-08-13-productize-onboarding-design.md`

## Global Constraints

- Keep the main worktree on `main`; all edits remain in `feat/productize-onboarding`.
- Keep zero runtime dependencies and do not add a lockfile.
- Configured commands remain argv arrays and never pass through a shell.
- Never edit or remove an existing consumer Git hook file.
- Store the delegated hook path only in clone-local Git config under `copse.previousHooksPath`.
- Change `core.hooksPath` only after config and both copse wrappers reconcile without conflicts.
- Do not claim authenticated Codex or Claude behavior unless the opt-in live harness actually runs.
- Introduce every production behavior with a failing test and commit each task independently.

---

### Task 1: Reproducible runner-package bootstrap

**Files:**
- Create: `src/runner.mjs`
- Create: `test/runner.test.mjs`
- Modify: `src/cli.mjs:17-56`
- Modify: `src/commands/init.mjs:1-30`
- Modify: `src/wiring.mjs:77-126`
- Modify: `test/wiring.test.mjs:20-49`
- Modify: `test/framework.integration.test.mjs:41-53`

**Interfaces:**
- Produces: `runnerPackageFromArgv(argv): string | null`, `runnerForPackage(spec): string[]`, and `configWithRunner(raw, runner): object` from `src/runner.mjs`.
- Changes: `commandInit({ cwd, config, apply, runnerPackage })` returns existing wiring fields plus `configChanged: boolean` and `effectiveConfig: object`.
- Changes: `reconcileWiring(root, desired, { apply, previousDesired })` safely replaces exact old copse forwards while preserving consumer-owned hook groups.
- Consumes later: Task 3 uses `effectiveConfig` to render hooks and doctor-compatible wiring; Task 4 invokes the installed CLI with `--runner-package <artifact>`.

- [ ] **Step 1: Write pure failing runner tests**

Add `test/runner.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { configWithRunner, runnerForPackage, runnerPackageFromArgv } from '../src/runner.mjs';

test('a package spec becomes literal npx argv', () => {
  assert.deepEqual(runnerForPackage('github:AaronLPS/copse#b928453'), [
    'npx', '--yes', 'github:AaronLPS/copse#b928453',
  ]);
});

test('runner package parsing refuses missing, repeated and option-like values', () => {
  assert.throws(() => runnerPackageFromArgv(['init', '--runner-package']), /requires a value/);
  assert.throws(() => runnerPackageFromArgv([
    'init', '--runner-package', 'copse@1', '--runner-package', 'copse@2',
  ]), /only once/);
  assert.throws(() => runnerForPackage('--package=evil'), /package spec/);
});

test('a runner update preserves every other config value', () => {
  const raw = { baseBranch: 'devel', carryFiles: ['.env'], runner: ['old'] };
  assert.deepEqual(configWithRunner(raw, ['npx', '--yes', 'copse@0.4.0']), {
    baseBranch: 'devel', carryFiles: ['.env'], runner: ['npx', '--yes', 'copse@0.4.0'],
  });
  assert.deepEqual(raw.runner, ['old']);
});
```

- [ ] **Step 2: Run the runner test and verify RED**

Run: `node --test test/runner.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/runner.mjs`.

- [ ] **Step 3: Implement the pure runner adapter**

Create `src/runner.mjs` with these behaviors:

```js
export function runnerForPackage(spec) {
  if (typeof spec !== 'string' || spec.trim() === '' || spec.startsWith('-') || /[\0\r\n]/.test(spec)) {
    throw new Error('runner package spec must be one non-empty npm package spec and must not start with "-"');
  }
  return ['npx', '--yes', spec];
}

export function runnerPackageFromArgv(argv) {
  const indexes = argv.flatMap((value, index) => value === '--runner-package' ? [index] : []);
  if (indexes.length === 0) return null;
  if (indexes.length > 1) throw new Error('--runner-package may be provided only once');
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith('--')) throw new Error('--runner-package requires a value');
  return value;
}

export function configWithRunner(raw, runner) {
  return { ...structuredClone(raw), runner: [...runner] };
}
```

- [ ] **Step 4: Run the runner test and verify GREEN**

Run: `node --test test/runner.test.mjs`

Expected: 3 tests pass, 0 fail.

- [ ] **Step 5: Write failing init reconciliation tests**

Extend `test/framework.integration.test.mjs` with one absent-config and one existing-config case. The existing-config assertion must prove non-runner keys survive:

```js
test('init runner package persists the exact package source', () => {
  const { root, repo } = makeRepo();
  try {
    writeFileSync(join(repo, 'copse.config.json'), JSON.stringify({
      baseBranch: 'main', carryFiles: ['.env'], verify: [['npm', 'test']], runner: ['old-runner'],
    }, null, 2) + '\n');
    writeFileSync(join(repo, '.env'), 'secret\n');
    const loaded = parseConfig(JSON.parse(readFileSync(join(repo, 'copse.config.json'), 'utf8'))).config;
    const result = commandInit({
      cwd: repo, config: loaded, apply: true, runnerPackage: 'github:AaronLPS/copse#b928453',
    });
    const saved = JSON.parse(readFileSync(join(repo, 'copse.config.json'), 'utf8'));
    assert.deepEqual(saved.runner, ['npx', '--yes', 'github:AaronLPS/copse#b928453']);
    assert.deepEqual(saved.carryFiles, ['.env']);
    assert.equal(result.configChanged, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 6: Run the focused integration test and verify RED**

Run: `node --test test/framework.integration.test.mjs`

Expected: FAIL because `commandInit` ignores `runnerPackage` and leaves `runner` unchanged.

- [ ] **Step 7: Wire the CLI and atomic config update**

In `src/cli.mjs`, parse once before the switch and pass the result only to init:

```js
import { runnerPackageFromArgv } from './runner.mjs';

const runnerPackage = runnerPackageFromArgv(argv);
// ...
status = commandInit({ config: initConfig, apply: argv.includes('--apply'), runnerPackage }).ok ? 0 : 1;
```

In `src/commands/init.mjs`, read the raw config object when the file exists, apply only the runner key, validate through `parseConfig`, and write via same-directory temp plus rename when `apply` is true. For an absent config, write the full effective config as today. Return and use the effective parsed config for all forwards:

```js
const requestedRunner = runnerPackage ? runnerForPackage(runnerPackage) : null;
const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : null;
const requestedRaw = requestedRunner ? configWithRunner(raw ?? config, requestedRunner) : (raw ?? config);
const parsed = parseConfig(requestedRaw);
if (!parsed.ok) throw new Error(`cannot update ${CONFIG_FILENAME}:\n${parsed.errors.join('\n')}`);
effective = parsed.config;
const configChanged = requestedRunner !== null && JSON.stringify(config.runner) !== JSON.stringify(requestedRunner);
```

The write must use `${configPath}.copse-tmp-${process.pid}` and `renameSync`; report mode prints the pending runner change without writing.

- [ ] **Step 8: Replace only known old runner forwards**

Add wiring tests with Claude settings containing one consumer hook group plus
the exact old copse group, and an exact old generated CI workflow. Reconcile
from `previousDesired=desiredWiring(oldConfig)` to
`desired=desiredWiring(newConfig)` and assert the consumer group remains, the
old runner disappears, and the new runner appears once. Add a custom workflow
case whose old runner is not overwritten and is reported as a conflict.

Extend `reconcileWiring` with `previousDesired`. For ordinary files, an actual
file equal to `previousDesired.get(relative)` is safe to atomically update. For
Codex and Claude JSON, remove only groups exactly present in the previous
copse settings, then add the desired groups:

```js
function replacedAgentSettings(actual, previous, expected) {
  const have = parseJson(actual);
  const old = parseJson(previous);
  const want = parseJson(expected);
  if (!have || !old || !want) return null;
  const merged = { ...have, hooks: { ...(have.hooks ?? {}) } };
  for (const [event, groups] of Object.entries(old.hooks)) {
    const encoded = new Set(groups.map((group) => JSON.stringify(group)));
    merged.hooks[event] = (merged.hooks[event] ?? []).filter((group) => !encoded.has(JSON.stringify(group)));
  }
  for (const [event, groups] of Object.entries(want.hooks)) {
    merged.hooks[event] = [...(merged.hooks[event] ?? [])];
    for (const group of groups) if (!includesGroup(merged.hooks[event], group)) merged.hooks[event].push(group);
  }
  return JSON.stringify(merged, null, 2) + '\n';
}
```

Make workflow matching require the shell-quoted effective runner followed by
`verify`; a generic `copse` substring is no longer enough. Pass the pre-override
desired map from `commandInit` as `previousDesired`.

- [ ] **Step 9: Run focused and full tests**

Run: `node --test test/runner.test.mjs test/framework.integration.test.mjs test/wiring.test.mjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: all test files pass.

- [ ] **Step 10: Commit Task 1**

```sh
git add src/runner.mjs src/cli.mjs src/commands/init.mjs src/wiring.mjs test/runner.test.mjs test/wiring.test.mjs test/framework.integration.test.mjs
git commit -m "feat: persist explicit runner package"
```

---

### Task 2: Copse-owned hook wrappers and migration decisions

**Files:**
- Create: `src/git-hooks.mjs`
- Create: `test/git-hooks.test.mjs`
- Modify: `src/wiring.mjs:31-64`
- Modify: `test/wiring.test.mjs:1-65`

**Interfaces:**
- Produces: `COPSE_HOOKS_PATH`, `DEFAULT_HOOKS_SENTINEL`, `desiredGitHooks(config)`, `legacyGitHooks(config)`, `hookMigration(input)`, and `resolveDelegatedHook(input)`.
- `hookMigration({ currentHooksPath, recordedPrevious, legacyCopse })` returns `{ previous: string, changePath: boolean }` without touching Git.
- `desiredWiring(config)` stops returning Git hook files; `desiredGitHooks(config)` owns `.copse/hooks/*`.
- Task 3 consumes these functions from `init` and `doctor`.

- [ ] **Step 1: Write failing hook renderer and migration tests**

Create `test/git-hooks.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COPSE_HOOKS_PATH, DEFAULT_HOOKS_SENTINEL, desiredGitHooks, hookMigration,
  resolveDelegatedHook,
} from '../src/git-hooks.mjs';

const config = { runner: ['npx', '--yes', 'github:owner/repo#abc'] };

test('new installs delegate the default Git hooks directory', () => {
  assert.deepEqual(hookMigration({ currentHooksPath: null, recordedPrevious: null, legacyCopse: false }), {
    previous: DEFAULT_HOOKS_SENTINEL, changePath: true,
  });
});

test('existing and legacy hook paths never delegate to copse itself', () => {
  assert.equal(hookMigration({
    currentHooksPath: '.husky', recordedPrevious: null, legacyCopse: false,
  }).previous, '.husky');
  assert.equal(hookMigration({
    currentHooksPath: COPSE_HOOKS_PATH, recordedPrevious: '.husky', legacyCopse: false,
  }).previous, '.husky');
  assert.equal(hookMigration({
    currentHooksPath: '.githooks', recordedPrevious: null, legacyCopse: true,
  }).previous, DEFAULT_HOOKS_SENTINEL);
});

test('pre-push captures and replays stdin while quoting the runner', () => {
  const script = desiredGitHooks(config).get('.copse/hooks/pre-push');
  assert.match(script, /mktemp/);
  assert.match(script, /hook pre-push/);
  assert.match(script, /< "\$input"/);
  assert.match(script, /'github:owner\/repo#abc'/);
});

test('delegated paths resolve without cycles', () => {
  assert.equal(resolveDelegatedHook({
    previous: '.husky', event: 'pre-commit', root: '/repo', commonDir: '/repo/.git',
  }), '/repo/.husky/pre-commit');
  assert.equal(resolveDelegatedHook({
    previous: DEFAULT_HOOKS_SENTINEL, event: 'pre-push', root: '/repo', commonDir: '/repo/.git',
  }), '/repo/.git/hooks/pre-push');
  assert.throws(() => resolveDelegatedHook({
    previous: COPSE_HOOKS_PATH, event: 'pre-commit', root: '/repo', commonDir: '/repo/.git',
  }), /cycle/);
});
```

- [ ] **Step 2: Run the hook test and verify RED**

Run: `node --test test/git-hooks.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/git-hooks.mjs`.

- [ ] **Step 3: Implement pure hook decisions and renderers**

Create `src/git-hooks.mjs`. Use these constants and decision rules:

```js
import { isAbsolute, join, resolve } from 'node:path';

export const COPSE_HOOKS_PATH = '.copse/hooks';
export const DEFAULT_HOOKS_SENTINEL = '<default>';

export function hookMigration({ currentHooksPath, recordedPrevious, legacyCopse }) {
  if (currentHooksPath === COPSE_HOOKS_PATH) {
    return { previous: recordedPrevious ?? DEFAULT_HOOKS_SENTINEL, changePath: false };
  }
  if (!currentHooksPath || legacyCopse) {
    return { previous: recordedPrevious ?? DEFAULT_HOOKS_SENTINEL, changePath: true };
  }
  return { previous: currentHooksPath, changePath: true };
}

export function resolveDelegatedHook({ previous, event, root, commonDir }) {
  if (!previous) return null;
  if (previous === COPSE_HOOKS_PATH) throw new Error('Git hook delegation cycle points back to .copse/hooks');
  if (previous === DEFAULT_HOOKS_SENTINEL) return join(commonDir, 'hooks', event);
  return join(isAbsolute(previous) ? previous : resolve(root, previous), event);
}
```

Render both wrappers with a `cd` to the worktree root, fixed shell-quoted runner argv, copse-first exit behavior, and clone-local `copse.previousHooksPath` lookup. For `pre-push`, use:

```sh
input=$(mktemp "${TMPDIR:-/tmp}/copse-pre-push.XXXXXX") || exit 1
trap 'rm -f "$input"' EXIT HUP INT TERM
cat > "$input" || exit 1
<runner> hook pre-push "$@" < "$input" || exit $?
```

Then invoke the resolved previous hook with `< "$input"`, capture its status, and exit with that status so the trap runs.

`legacyGitHooks(config)` must reproduce the exact v0.3 `.githooks/pre-commit` and `.githooks/pre-push` contents using the pre-override runner.

- [ ] **Step 4: Separate generic wiring from Git wrapper wiring**

Remove `.githooks/pre-commit` and `.githooks/pre-push` from `desiredWiring`. Change generated CI from:

```yaml
- run: git config core.hooksPath .githooks
```

to:

```yaml
- run: git config core.hooksPath .copse/hooks
```

Update `test/wiring.test.mjs` so generic wiring expects Codex, Claude, instructions, coordination, and CI, while `test/git-hooks.test.mjs` owns wrapper assertions.

Update `reconcileWiring` executable handling from the legacy-only
`.githooks/` prefix to `.copse/hooks/` so both new wrapper files receive mode
`0o755` immediately after atomic creation.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test test/git-hooks.test.mjs test/wiring.test.mjs`

Expected: all tests pass.

- [ ] **Step 6: Commit Task 2**

```sh
git add src/git-hooks.mjs src/wiring.mjs test/git-hooks.test.mjs test/wiring.test.mjs
git commit -m "feat: render delegated git hook wrappers"
```

---

### Task 3: Non-destructive hook onboarding and doctor diagnostics

**Files:**
- Modify: `src/commands/init.mjs`
- Modify: `src/commands/doctor.mjs`
- Modify: `test/framework.integration.test.mjs`
- Modify: `test/lifecycle.integration.test.mjs`

**Interfaces:**
- `commandInit` reconciles `desiredGitHooks(effectiveConfig)` separately and writes local Git keys only after zero wrapper conflicts.
- Local keys: `core.hooksPath=.copse/hooks` and `copse.previousHooksPath=<previous>`.
- `commandDoctor` returns findings for wrong current path, recursion, missing delegated directories, and present-but-non-executable delegated hook files.

- [ ] **Step 1: Write failing real-Git coexistence tests**

Add integration tests covering configured and default hooks. The configured case must execute the original hook after onboarding without changing its bytes:

```js
test('init preserves and delegates an existing hooksPath', () => {
  const { root, repo } = makeRepo();
  try {
    const hookDir = join(repo, '.husky');
    mkdirSync(hookDir);
    const original = '#!/bin/sh\nprintf delegated > .delegated-hook\n';
    writeFileSync(join(hookDir, 'pre-commit'), original, { mode: 0o755 });
    run(['config', 'core.hooksPath', '.husky'], repo);
    const config = parseConfig({ verify: [['npm', 'test']], runner: [process.execPath, resolve('src/cli.mjs')] }).config;

    commandInit({ cwd: repo, config, apply: true });

    assert.equal(run(['config', '--get', 'core.hooksPath'], repo), '.copse/hooks');
    assert.equal(run(['config', '--get', 'copse.previousHooksPath'], repo), '.husky');
    assert.equal(readFileSync(join(hookDir, 'pre-commit'), 'utf8'), original);
    run(['switch', '-c', 'feat/delegated-hook'], repo);
    run(['commit', '--allow-empty', '-m', 'delegates'], repo);
    assert.equal(readFileSync(join(repo, '.delegated-hook'), 'utf8'), 'delegated');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

Add cases for:

- unset `core.hooksPath` plus executable `.git/hooks/pre-commit` using `<default>`;
- exact legacy v0.3 `.githooks` migration without `.githooks` delegation;
- a second `init --apply` preserving the same previous path;
- delegated hook non-zero status blocking commit;
- `pre-push` receiving the same four-field ref line as copse;
- wrapper conflict leaving `core.hooksPath` unchanged.

- [ ] **Step 2: Run focused integration tests and verify RED**

Run: `node --test test/framework.integration.test.mjs test/lifecycle.integration.test.mjs`

Expected: FAIL because init still replaces `core.hooksPath` directly and `.copse/hooks` is absent.

- [ ] **Step 3: Implement ordered hook migration in init**

Before applying the runner override, preserve the pre-override config for exact legacy rendering. Compute:

```js
const currentHooksPath = git(['config', '--local', '--get', 'core.hooksPath'], { cwd: repoDir, allowFailure: true });
const recordedPrevious = git(['config', '--local', '--get', 'copse.previousHooksPath'], { cwd: repoDir, allowFailure: true });
const legacy = legacyGitHooks(config);
const legacyCopse = currentHooksPath === '.githooks' && [...legacy].every(([relative, expected]) => {
  const path = join(repoDir, relative);
  return existsSync(path) && readFileSync(path, 'utf8') === expected;
});
const migration = hookMigration({ currentHooksPath, recordedPrevious, legacyCopse });
```

Reconcile generic files and `.copse/hooks` files. Only after both reports contain no conflicts and `apply` is true:

```js
git(['config', '--local', 'copse.previousHooksPath', migration.previous], { cwd: repoDir });
git(['config', '--local', 'core.hooksPath', COPSE_HOOKS_PATH], { cwd: repoDir });
```

Merge wrapper created/missing/matching/conflict lists into the command result and console report. Never delete `.githooks`.

- [ ] **Step 4: Write failing doctor delegation tests**

Add tests asserting these exact findings:

```js
assert.match(findings, /git core\.hooksPath is not \.copse\/hooks/);
assert.match(findings, /delegation cycle/);
assert.match(findings, /delegated hook directory does not exist: \.husky/);
assert.match(findings, /delegated pre-commit is not executable/);
```

- [ ] **Step 5: Run doctor tests and verify RED**

Run: `node --test test/framework.integration.test.mjs`

Expected: FAIL because doctor still expects `.githooks` and does not inspect `copse.previousHooksPath`.

- [ ] **Step 6: Implement doctor delegation checks**

Replace the `.githooks` expectation with `COPSE_HOOKS_PATH`. Resolve `gitCommonDir({ cwd })` to an absolute path, read the previous key, and call `resolveDelegatedHook` for both events. Report:

- a cycle when previous equals `.copse/hooks`;
- a missing configured previous directory;
- a hook file that exists but lacks `X_OK`;
- an absolute previous directory that no longer exists.

Do not report a missing individual hook file inside an existing previous directory; Git treats it as no hook.

- [ ] **Step 7: Run focused and full tests**

Run: `node --test test/git-hooks.test.mjs test/wiring.test.mjs test/framework.integration.test.mjs test/lifecycle.integration.test.mjs`

Expected: all focused tests pass.

Run: `npm test`

Expected: all test files pass.

- [ ] **Step 8: Commit Task 3**

```sh
git add src/commands/init.mjs src/commands/doctor.mjs test/framework.integration.test.mjs test/lifecycle.integration.test.mjs
git commit -m "feat: preserve existing git hooks on init"
```

---

### Task 4: Packed two-agent concurrency acceptance

**Files:**
- Create: `scripts/fixtures/recording-agent.mjs`
- Modify: `scripts/package-smoke.mjs`
- Modify: `package.json`

**Interfaces:**
- `recording-agent.mjs` consumes `<label> <marker-path> <gate-path> [...forwarded]`, writes JSON `{ label, cwd, branch, forwarded }`, and exits only after the gate file exists.
- Package smoke configures installed copse agent argv to the fixture, launches `feat/codex-agent` and `feat/claude-agent`, and observes the installed CLI only.

- [ ] **Step 1: Create a failing package acceptance assertion**

First extend `scripts/package-smoke.mjs` to require two simultaneous leases and two marker files, but do not create the fixture yet:

```js
const state = await waitFor(() => {
  if (!existsSync(statePath)) return null;
  const value = JSON.parse(readFileSync(statePath, 'utf8'));
  return value.leases?.['feat/codex-agent'] && value.leases?.['feat/claude-agent'] ? value : null;
});
if (Object.keys(state.leases).length !== 2) throw new Error('two agent leases were not simultaneously active');
```

Change bootstrap to omit `runner` from the initial config and invoke:

```js
runCopse(['init', '--apply', '--runner-package', artifact]);
```

Assert the saved config, both agent hook JSON files, Git wrappers, and CI workflow contain the exact artifact path.

- [ ] **Step 2: Run package smoke and verify RED**

Run: `npm run test:package`

Expected: FAIL because `scripts/fixtures/recording-agent.mjs` is absent or no second lease appears.

- [ ] **Step 3: Implement the recording agent fixture**

Create `scripts/fixtures/recording-agent.mjs`:

```js
#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const [label, marker, gate, ...forwarded] = process.argv.slice(2);
if (!label || !marker || !gate) throw new Error('usage: recording-agent <label> <marker> <gate> [...argv]');
writeFileSync(marker, JSON.stringify({
  label,
  cwd: process.cwd(),
  branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
  forwarded,
}) + '\n');
while (!existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 25));
```

- [ ] **Step 4: Launch and inspect both installed-agent sessions**

Configure:

```js
agents: {
  codex: [process.execPath, fixture, 'codex', codexMarker, codexGate, '--profile', 'acceptance'],
  claude: [process.execPath, fixture, 'claude', claudeMarker, claudeGate, '--model', 'acceptance'],
},
```

Spawn two installed CLI processes with `--agent codex` and `--agent claude`. Wait for both markers and leases. Assert deterministic worktree paths, branches, forwarded argv, main branch `main`, and clean main status. Attempt one duplicate start for each feature and require `active session`. Create only the Codex gate and prove the Claude lease remains; then create the Claude gate and require all leases to clear.

Update staging paths from `.githooks` to `.copse/hooks`. Ensure child processes are awaited in `finally` before removing the temporary root.

- [ ] **Step 5: Run package and full tests**

Run: `npm run test:package`

Expected: `package acceptance ok` and exit 0.

Run: `npm test`

Expected: all test files pass.

- [ ] **Step 6: Commit Task 4**

```sh
git add scripts/fixtures/recording-agent.mjs scripts/package-smoke.mjs package.json
git commit -m "test: prove two packaged agent sessions"
```

---

### Task 5: Explicit live Codex and Claude acceptance harness

**Files:**
- Create: `scripts/live-agent-command.mjs`
- Create: `scripts/live-agent-smoke.mjs`
- Create: `test/live-agent-smoke.test.mjs`
- Modify: `package.json`

**Interfaces:**
- `live-agent-smoke.mjs` requires `COPSE_LIVE_AGENT_TEST=1`, `COPSE_CODEX_COMMAND`, and `COPSE_CLAUDE_COMMAND`.
- Each command variable is a JSON non-empty string array.
- `live-agent-command.mjs` consumes `<marker> -- <command...>`, writes its cwd/branch marker, then spawns the exact command with inherited stdio and returns its status.

- [ ] **Step 1: Write failing refusal tests**

Create `test/live-agent-smoke.test.mjs` using `spawnSync(process.execPath, ['scripts/live-agent-smoke.mjs'])`:

```js
test('live agent smoke requires explicit opt-in and both argv arrays', () => {
  const absent = spawnSync(process.execPath, ['scripts/live-agent-smoke.mjs'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, COPSE_LIVE_AGENT_TEST: '' },
  });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stderr, /COPSE_LIVE_AGENT_TEST=1/);

  const missingClaude = spawnSync(process.execPath, ['scripts/live-agent-smoke.mjs'], {
    cwd: root, encoding: 'utf8', env: {
      ...process.env,
      COPSE_LIVE_AGENT_TEST: '1',
      COPSE_CODEX_COMMAND: '["codex","exec","reply COPSE_OK"]',
      COPSE_CLAUDE_COMMAND: '',
    },
  });
  assert.notEqual(missingClaude.status, 0);
  assert.match(missingClaude.stderr, /COPSE_CLAUDE_COMMAND/);
});
```

- [ ] **Step 2: Run the refusal test and verify RED**

Run: `node --test test/live-agent-smoke.test.mjs`

Expected: FAIL because the live harness does not exist.

- [ ] **Step 3: Implement strict environment parsing**

At the top of `scripts/live-agent-smoke.mjs`, refuse before packing or creating a temp directory:

```js
if (process.env.COPSE_LIVE_AGENT_TEST !== '1') {
  throw new Error('live agent acceptance is disabled; set COPSE_LIVE_AGENT_TEST=1 explicitly');
}
function commandFromEnv(name) {
  let value;
  try { value = JSON.parse(process.env[name] ?? ''); } catch { throw new Error(`${name} must be a JSON argv array`); }
  if (!Array.isArray(value) || value.length === 0 || value.some((part) => typeof part !== 'string' || part === '')) {
    throw new Error(`${name} must be a non-empty JSON argv array`);
  }
  return value;
}
```

Catch top-level errors, print only `error.message` to stderr, and set exit code 1 so refusal output is actionable.

- [ ] **Step 4: Implement the exact-command wrapper**

Create `scripts/live-agent-command.mjs` with `spawn` and `shell: false`:

```js
const marker = process.argv[2];
const divider = process.argv.indexOf('--');
const argv = divider === -1 ? [] : process.argv.slice(divider + 1);
if (!marker || argv.length === 0) throw new Error('usage: live-agent-command <marker> -- <command...>');
writeFileSync(marker, JSON.stringify({ cwd: process.cwd(), branch: currentBranch() }) + '\n');
const status = await runInteractive(argv[0], argv.slice(1));
process.exit(status);
```

Implement a local child promise rather than importing production source, because the live smoke must exercise only the packed CLI artifact.

- [ ] **Step 5: Build the disposable packed live harness**

Follow the package smoke setup: pack copse, install it in a temporary consumer, create a bare origin and clean main, write config with two agents whose argv starts with `live-agent-command.mjs`, then spawn:

```js
copse start feat/live-codex --agent codex --owner live-codex@host
copse start feat/live-claude --agent claude --owner live-claude@host
```

Wait for both cwd markers and both leases simultaneously, validate separate worktrees/branches, await both vendor commands, require zero statuses and released leases, and remove the temporary root in `finally`.

- [ ] **Step 6: Run refusal and safe fake-command acceptance**

Run: `node --test test/live-agent-smoke.test.mjs`

Expected: refusal tests pass.

Run a quota-free harness check:

```sh
env COPSE_LIVE_AGENT_TEST=1 \
  COPSE_CODEX_COMMAND='["node","-e","setTimeout(() => {}, 500)"]' \
  COPSE_CLAUDE_COMMAND='["node","-e","setTimeout(() => {}, 500)"]' \
  node scripts/live-agent-smoke.mjs
```

Expected: both live wrapper sessions overlap and the script exits 0. This proves the harness, not vendor authentication.

- [ ] **Step 7: Add the opt-in package script and commit**

Add:

```json
"test:agents:live": "node scripts/live-agent-smoke.mjs"
```

Then commit:

```sh
git add scripts/live-agent-command.mjs scripts/live-agent-smoke.mjs test/live-agent-smoke.test.mjs package.json
git commit -m "test: add opt-in live agent acceptance"
```

---

### Task 6: Documentation, self-migration, and release verification

**Files:**
- Modify: `README.md`
- Modify: `docs/commands.md`
- Modify: `docs/configuration.md`
- Modify: `docs/STATUS-2026-08-13.md`
- Modify: `.github/workflows/copse.yml`
- Modify: `package.json`
- Create: `.copse/hooks/pre-commit` through `copse init --apply`
- Create: `.copse/hooks/pre-push` through `copse init --apply`
- Retain unchanged: `.githooks/pre-commit`, `.githooks/pre-push`

**Interfaces:**
- Documents `--runner-package`, `.copse/hooks`, `copse.previousHooksPath`, deterministic packaged acceptance, and opt-in live acceptance.
- Updates package version from `0.3.0` to `0.4.0`; publishing remains outside scope.

- [ ] **Step 1: Update user-facing documentation**

Replace the pre-publication quickstart with the one-invocation GitHub bootstrap:

```sh
npx github:AaronLPS/copse init
npx github:AaronLPS/copse init --apply \
  --runner-package github:AaronLPS/copse
```

Show the release form separately:

```sh
npx copse@0.4.0 init --apply --runner-package copse@0.4.0
```

Explain that an existing Husky/custom path is stored in local Git config and invoked after copse policy. Document the live harness with explicit example argv but state that it may consume vendor quota and is never part of ordinary `verify`.

- [ ] **Step 2: Update self-hosted CI and version**

Change `.github/workflows/copse.yml` to:

```yaml
- run: git config core.hooksPath .copse/hooks
```

Set `package.json` version to `0.4.0`. Do not create `package-lock.json`.

- [ ] **Step 3: Apply self-migration through the feature CLI**

Run from the feature worktree:

```sh
node src/cli.mjs init --apply
```

Expected:

- `.copse/hooks/pre-commit` and `.copse/hooks/pre-push` are created and executable;
- local `core.hooksPath` is `.copse/hooks`;
- local `copse.previousHooksPath` is `<default>` for the recognized legacy copse installation;
- existing `.githooks/*` bytes remain unchanged;
- a second init reports no created or conflicting files.

- [ ] **Step 4: Run documentation and repository diagnostics**

Run: `node src/cli.mjs doctor`

Expected: `copse: nothing to report`.

Run: `git diff --check`

Expected: exit 0 with no output.

Run: `rg -n 'core\.hooksPath \.githooks|\.githooks/pre-' README.md docs src test scripts .github package.json`

Expected: matches only intentional legacy migration tests/design history; current instructions and generated wiring use `.copse/hooks`.

- [ ] **Step 5: Run full fresh verification**

Run: `node src/cli.mjs verify`

Expected: doctor passes, every test file passes, syntax is `ok`, and packed acceptance prints `package acceptance ok: copse 0.4.0`.

Run: `npm run test:coverage`

Expected: exit 0 and aggregate line coverage remains above 90%.

- [ ] **Step 6: Commit Task 6**

```sh
git add README.md docs/commands.md docs/configuration.md docs/STATUS-2026-08-13.md .github/workflows/copse.yml package.json .copse/hooks
git commit -m "docs: publish safe onboarding workflow"
```

- [ ] **Step 7: Review branch and close through copse**

Run:

```sh
git status --short --branch
git log --oneline main..HEAD
node src/cli.mjs verify
```

Expected: clean feature branch with six implementation/documentation commits after the design/plan commits, followed by a fresh successful verification.

Then follow the repository contract:

```sh
node src/cli.mjs pr feat/productize-onboarding
node src/cli.mjs land feat/productize-onboarding
node src/cli.mjs land feat/productize-onboarding --yes
```

Expected: PR creation succeeds, dry-run land reports ready only after green checks, and confirmed land merges, refreshes `main`, releases coordination state, and safely removes the worktree. If GitHub authentication or required checks are unavailable, stop after the verified clean branch and report the exact recovery command rather than bypassing the gate.
