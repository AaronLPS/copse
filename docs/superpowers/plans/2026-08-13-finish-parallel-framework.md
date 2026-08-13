# Finish Parallel-Work Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close copse's remaining collision, onboarding, distribution, pull-request, hook, and shared-resource gaps without turning it into a scheduler.

**Architecture:** Extend the versioned coordination state with leases and resource reservations, keeping all decisions pure and all Git/process/filesystem effects in adapters. Preserve the existing CLI-command split, add focused modules only where responsibility is new, and verify every slice through both pure tests and real temporary Git repositories.

**Tech Stack:** Node.js >=20, ESM, Node standard library only, `node:test`, real Git repositories, npm packed-artifact tests, injected `gh` adapters.

**Spec:** `docs/superpowers/specs/2026-08-13-finish-parallel-framework-design.md`

## Global Constraints

- Zero runtime dependencies and no lockfile.
- Feature work stays in the `feat/finish-parallel-framework` worktree.
- Configured and generated commands are argv arrays and never use shell interpolation except the quoted fixed hook forwards.
- Unknown process, Git, PR, hook, or coordination state blocks destructive mutation.
- Existing configuration remains backward-compatible.
- Consumer-owned files are never overwritten by `init`.
- Every behavior is introduced by a failing test and committed atomically.

---

### Task 1: Versioned leases and resource reservations

**Files:**
- Modify: `src/coordination.mjs`
- Modify: `src/config.mjs`
- Modify: `test/coordination.test.mjs`
- Modify: `test/config.test.mjs`

**Interfaces:**
- Consumes: existing `{ version: 1, features }` coordination state.
- Produces: `normalizeCoordination(state)`, `acquireLease(state, branch, options)`, `refreshLease(state, branch, leaseId, options)`, `releaseLease(state, branch, leaseId)`, `leaseStatus(lease, options)`, and config keys `leaseTimeoutSeconds`, `leaseHeartbeatSeconds`, `resources`, `coordinationBackend`.

- [ ] **Step 1: Write failing lease and config tests**

```js
test('a live lease blocks every duplicate start and a dead lease is reclaimed', () => {
  const first = acquireLease({ version: 1, features: {} }, 'feat/x', {
    id: 'one', owner: 'alice@host', host: 'host', pid: 10, now: 1_000,
    timeoutMs: 60_000, processAlive: () => true,
  });
  assert.throws(() => acquireLease(first, 'feat/x', {
    id: 'two', owner: 'alice@host', host: 'host', pid: 11, now: 2_000,
    timeoutMs: 60_000, processAlive: () => true,
  }), /active session/);
  const reclaimed = acquireLease(first, 'feat/x', {
    id: 'two', owner: 'alice@host', host: 'host', pid: 11, now: 2_000,
    timeoutMs: 60_000, processAlive: () => false,
  });
  assert.equal(reclaimed.leases['feat/x'].id, 'two');
});
```

- [ ] **Step 2: Run focused tests and confirm missing exports fail**

Run: `node --test test/coordination.test.mjs test/config.test.mjs`

- [ ] **Step 3: Implement state normalization and pure lease decisions**

```js
export function normalizeCoordination(state) {
  return { version: 1, features: {}, leases: {}, resources: {}, ...clone(state) };
}

export function leaseStatus(lease, { now, host, processAlive }) {
  if (!lease) return 'absent';
  if (now - lease.heartbeatAt > lease.timeoutMs) return 'stale';
  if (lease.host === host && !processAlive(lease.childPid ?? lease.pid)) return 'stale';
  return 'active';
}
```

- [ ] **Step 4: Add configuration validation**

Defaults: timeout `300`, heartbeat `30`, resources `{}`, backend `"local"`; require positive integers, heartbeat `<` timeout, safe resource names, and backend `local|committed`.

- [ ] **Step 5: Run focused and full tests, then commit**

Run: `npm test`

Commit: `feat: add coordination session leases`

### Task 2: Async launcher, automatic claim, and duplicate-start refusal

**Files:**
- Modify: `src/process.mjs`
- Modify: `src/commands/start.mjs`
- Modify: `src/commands/claim.mjs`
- Modify: `src/cli.mjs`
- Modify: `src/commands/list.mjs`
- Modify: `test/process.test.mjs`
- Modify: `test/start.test.mjs`
- Modify: `test/framework.integration.test.mjs`

**Interfaces:**
- Consumes: Task 1 lease functions and coordination lock.
- Produces: async `runInteractive(command, args, options)`, async `commandStart`, `--owner`, `--resource`, lease display in list/JSON.

- [ ] **Step 1: Write failing launcher and integration tests**

```js
test('start claims, leases, refuses a duplicate, and releases after exit', async () => {
  const running = deferredChild();
  const first = commandStart('feat/x', { config, owner: 'alice@host', spawn: running.spawn });
  await running.started;
  await assert.rejects(commandStart('feat/x', {
    config, owner: 'alice@host', spawn: fakeSpawn,
  }), /active session/);
  running.exit(0);
  assert.equal(await first, 0);
  assert.equal(loadCoordination(path).leases['feat/x'], undefined);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test test/start.test.mjs test/process.test.mjs test/framework.integration.test.mjs`

- [ ] **Step 3: Implement asynchronous process adapter**

```js
export function runInteractive(command, args, { cwd, spawn = nodeSpawn, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: false });
    onSpawn?.(child.pid);
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
```

- [ ] **Step 4: Make start validate, claim, reserve, heartbeat, and release**

Acquire the coordination lock before launch, claim only when unclaimed/released/same owner, reserve requested resources, create the lease, update it with child PID, refresh on an unref'd timer, and release by lease id in `finally`.

- [ ] **Step 5: Make CLI await async commands and expose owner/resources**

Use top-level `await main()` and preserve exact child exit codes. Default owner is `${USER ?? 'unknown'}@${hostname()}`.

- [ ] **Step 6: Run tests and commit**

Run: `npm test`

Commit: `feat: prevent duplicate agent sessions`

### Task 3: Packed-artifact consumer lifecycle

**Files:**
- Modify: `scripts/package-smoke.mjs`
- Modify: `package.json`
- Create: `test/fixtures/fake-gh.mjs`

**Interfaces:**
- Consumes: installed `node_modules/.bin/copse` only.
- Produces: an acceptance script that invokes real CLI commands against a temporary consumer and never imports source modules.

- [ ] **Step 1: Extend the smoke test so the current package fails acceptance**

```js
runCopse(['init', '--apply']);
runCopse(['doctor']);
runCopse(['claim', 'feat/api', '--owner', 'api@host']);
runCopse(['new', 'feat/api']);
assert.throws(() => runGit(['commit', '--allow-empty', '-m', 'bad'], consumer));
runCopse(['verify']);
```

The fixture GitHub executable returns deterministic PR/check/merge JSON from argv and records calls for assertions.

- [ ] **Step 2: Run package smoke and confirm the first missing lifecycle behavior**

Run: `npm run test:package`

- [ ] **Step 3: Build the complete consumer harness**

Create a bare origin, seed main, configure runner to the installed bin, initialize wiring, create two worktrees, assert duplicate-start refusal with a short-lived custom Node command, invoke hook JSON, verify, simulate PR/land, and clean up.

- [ ] **Step 4: Run package smoke and commit**

Run: `npm run test:package`

Commit: `test: exercise packed consumer lifecycle`

### Task 4: Local-only and multi-toolchain onboarding

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/git.mjs`
- Modify: `src/wiring.mjs`
- Modify: `src/commands/init.mjs`
- Modify: `src/commands/new.mjs`
- Modify: `src/cli.mjs`
- Modify: `test/config.test.mjs`
- Modify: `test/wiring.test.mjs`
- Modify: `test/lifecycle.integration.test.mjs`
- Modify: `test/framework.integration.test.mjs`

**Interfaces:**
- Produces: `detectCiMode(root)`, `workflowFor(config, { ciMode })`, `baseSource(config, { cwd })`, config `ciMode`, `ciSetup`.

- [ ] **Step 1: Write failing detection and local-only repository tests**

```js
test('new uses local main when origin is absent', () => {
  const repo = makeLocalRepoWithoutOrigin();
  const created = commandNew('feat/local', { cwd: repo, config });
  assert.equal(git(['merge-base', '--is-ancestor', 'main', 'feat/local'], { cwd: repo }), '');
  assert.ok(existsSync(created.path));
});
```

- [ ] **Step 2: Run focused tests and confirm fetch-origin failure**

Run: `node --test test/wiring.test.mjs test/framework.integration.test.mjs test/lifecycle.integration.test.mjs`

- [ ] **Step 3: Implement base-source selection**

Use `refs/remotes/origin/<base>` when it resolves, fetching first; otherwise require a clean local `refs/heads/<base>` and branch from it without network access.

- [ ] **Step 4: Implement CI mode detection and generation**

Detection priority: explicit config/CLI, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `package.json`, else `none`. Generate setup-node and the matching install only for Node modes; append exact `ciSetup` argv commands for custom mode.

- [ ] **Step 5: Test every mode and commit**

Run: `npm test`

Commit: `feat: support local and multi-toolchain onboarding`

### Task 5: Pull-request creation and robust landing

**Files:**
- Create: `src/commands/pr.mjs`
- Modify: `src/github.mjs`
- Modify: `src/commands/land.mjs`
- Modify: `src/cli.mjs`
- Modify: `src/git.mjs`
- Modify: `test/land.test.mjs`
- Modify: `test/framework.integration.test.mjs`

**Interfaces:**
- Produces: `createPullRequest(branch, options)`, `commandPr`, `refreshBaseAfterMerge`, `--draft`, `--create-pr`.

- [ ] **Step 1: Write exact argv and partial-success tests**

```js
test('create PR targets configured base without a shell', () => {
  createPullRequest('feat/x', { base: 'main', draft: true, cwd: '/repo', run });
  assert.deepEqual(seen.args, ['pr', 'create', '--head', 'feat/x', '--base', 'main', '--draft', '--fill']);
});
```

- [ ] **Step 2: Run focused tests and confirm missing command**

Run: `node --test test/land.test.mjs test/framework.integration.test.mjs`

- [ ] **Step 3: Implement `copse pr` preconditions and creation**

Require feature worktree, legal branch, known-clean state, zero unpushed commits, successful verification unless `--no-verify`, then invoke `gh pr create`.

- [ ] **Step 4: Separate merge, remote deletion, local refresh, and cleanup**

Merge without `--delete-branch`; after confirmed success fetch origin, fast-forward a clean main worktree on base, release state, drop the feature worktree, delete local branch, and delete the remote branch as separate guarded operations. Return structured `{ merged, refreshed, cleaned, localBranchDeleted, remoteBranchDeleted, recovery }`.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Commit: `feat: close pull request lifecycle`

### Task 6: Hook protocol hardening and doctor diagnostics

**Files:**
- Modify: `src/hooks.mjs`
- Modify: `src/wiring.mjs`
- Modify: `src/commands/hook.mjs`
- Modify: `src/commands/doctor.mjs`
- Modify: `test/hooks.test.mjs`
- Modify: `test/wiring.test.mjs`
- Modify: `test/framework.integration.test.mjs`
- Modify: `docs/commands.md`

**Interfaces:**
- Produces: `normalizeAgentEvent(input)`, protocol-versioned forwards, runner diagnostics.

- [ ] **Step 1: Add Codex and Claude event fixtures plus bypass-boundary tests**

```js
for (const input of [codexExecEvent, claudeBashEvent]) {
  const output = agentHookOutput(input, mainContext);
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
}
assert.deepEqual(agentHookOutput(interpreterWriteEvent, mainContext), {});
```

- [ ] **Step 2: Run focused tests and confirm current tool-name mismatch**

Run: `node --test test/hooks.test.mjs test/wiring.test.mjs test/framework.integration.test.mjs`

- [ ] **Step 3: Normalize event fields and tool names**

Recognize `Bash`, `shell`, `exec_command`, `unified_exec`, `apply_patch`, `Edit`, and `Write`; accept command text from `command`, `cmd`, or argv fields. Keep arbitrary interpreter writes explicitly out of the security guarantee.

- [ ] **Step 4: Add doctor checks and CLI hook smoke tests**

Doctor validates parseable JSON, expected protocol marker, runner executable resolution for local runners, and exact Git forward executability. Integration tests pipe JSON into the actual CLI and parse stdout.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Commit: `feat: harden agent hook integration`

### Task 7: Resources and portable coordination backend

**Files:**
- Modify: `src/coordination.mjs`
- Modify: `src/commands/claim.mjs`
- Modify: `src/commands/release.mjs`
- Modify: `src/commands/list.mjs`
- Modify: `src/commands/doctor.mjs`
- Modify: `src/commands/start.mjs`
- Modify: `src/cli.mjs`
- Modify: `test/coordination.test.mjs`
- Modify: `test/framework.integration.test.mjs`

**Interfaces:**
- Produces: `reserveResources`, `releaseResources`, `coordinationStatePath({ config, cwd })`, `--resource` and config-declared feature resources.

- [ ] **Step 1: Write resource collision and seed/backend tests**

```js
test('two active features cannot reserve the same resource', () => {
  const first = reserveResources(emptyState(), 'feat/api', ['port:3000'], lease);
  assert.throws(() => reserveResources(first, 'feat/ui', ['port:3000'], otherLease), /feat\/api/);
});
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node --test test/coordination.test.mjs test/framework.integration.test.mjs`

- [ ] **Step 3: Implement reservations and backend selection**

Local mode stores live state in Git common dir and initializes it from the committed seed once. Committed mode writes the configured file atomically and rejects a dirty/unmerged concurrent update. Lease release removes only reservations owned by the matching lease id.

- [ ] **Step 4: Surface resource state in claim/start/list/doctor**

Claim accepts repeated `--resource`; start combines claim resources with CLI resources. List reports owner/branch, and doctor reports stale reservations plus listening-port PID/cwd when measurable.

- [ ] **Step 5: Run tests and commit**

Run: `npm test`

Commit: `feat: coordinate shared development resources`

### Task 8: Documentation, full verification, and integration

**Files:**
- Modify: `README.md`
- Modify: `docs/commands.md`
- Modify: `docs/configuration.md`
- Modify: `docs/STATUS-2026-08-13.md`
- Modify: `SECURITY.md`
- Modify: `copse.config.json`

**Interfaces:**
- Consumes every prior task.
- Produces accurate shipped documentation and final acceptance evidence.

- [ ] **Step 1: Update user-facing lifecycle and configuration docs**

Document automatic claims, leases, resource reservations, local-only repos, CI modes, `pr`, partial land recovery, hook trust/advisory limits, and both coordination backends. Remove claims no test proves.

- [ ] **Step 2: Run formatting/syntax and full verification**

Run: `node src/cli.mjs verify`

Expected: doctor clean, 0 test failures, syntax ok, packed consumer lifecycle ok.

- [ ] **Step 3: Run coverage and inspect changed-file diff**

Run: `npm run test:coverage`

Expected: line coverage >=90%.

Run: `git diff --check origin/main...HEAD`

- [ ] **Step 4: Commit documentation**

Commit: `docs: describe completed parallel framework`

- [ ] **Step 5: Land through the project lifecycle**

Push the branch, create a PR with `copse pr`, run `copse land --yes` after checks are green, and confirm the main worktree fast-forwards cleanly.

