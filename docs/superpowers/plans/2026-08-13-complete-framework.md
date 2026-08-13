# Complete Parallel-Work Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete copse's onboarding, agent integration, coordination, verification, merge, protection, CI, documentation, and dogfooding layers.

**Architecture:** Preserve the pure-decision/adapters/commands split. Add focused modules for wiring reconciliation, hook policy, coordination state, command execution, and GitHub interactions; command modules compose those units and receive adapters for deterministic tests.

**Tech Stack:** Node >=20, ESM, Node standard library only, `node:test`, real temporary Git repositories, Git and GitHub CLI adapters.

**Spec:** `docs/superpowers/specs/2026-08-13-complete-framework-design.md`

## Global Constraints

- Zero runtime dependencies and no lockfile.
- Never pass configured commands through a shell.
- No consumer-owned file is silently overwritten.
- Read-only/report mode is the default for init and protect.
- Unknown state blocks destructive operations.
- Every new behavior follows red-green-refactor and has real integration coverage where Git/filesystem behavior matters.

---

### Task 1: Extended configuration and command runner

**Files:** `src/config.mjs`, `src/process.mjs`, `test/config.test.mjs`, `test/process.test.mjs`

- [x] Add failing tests for new config defaults, validation, and safe argv execution.
- [x] Run the focused tests and confirm feature-missing failures.
- [x] Implement `releaseBranch`, `verify`, `agents`, and `coordinationFile` parsing plus the process adapter.
- [x] Run focused and full suites.

### Task 2: Wiring model and `init`

**Files:** `src/wiring.mjs`, `src/commands/init.mjs`, `test/wiring.test.mjs`, `test/init.integration.test.mjs`, `src/cli.mjs`

- [x] Add failing pure reconciliation tests and real-repository init tests.
- [x] Implement absent/matching/conflicting classifications and atomic safe writes.
- [x] Generate Git, Codex, Claude, instruction, config, coordination, and CI forwards.
- [x] Wire `copse init` and verify report/apply idempotence.

### Task 3: Hook policy and expanded `doctor`

**Files:** `src/hooks.mjs`, `src/commands/hook.mjs`, `src/commands/doctor.mjs`, `test/hooks.test.mjs`, `test/lifecycle.integration.test.mjs`

- [x] Add failing tests for Git branch guards and Codex/Claude JSON hook behavior.
- [x] Implement Git pre-commit/pre-push and agent SessionStart/PreToolUse policies.
- [x] Expand doctor to verify every installed forward, hooksPath, config, state, and workflow.
- [x] Exercise installed Git hooks against real commits and pushes.

### Task 4: Agent launcher

**Files:** `src/commands/start.mjs`, `src/commands/new.mjs`, `test/start.integration.test.mjs`, `src/cli.mjs`

- [x] Add failing tests for existing, missing, custom, and failed launcher paths.
- [x] Refactor `new` to return structured provisioning data.
- [x] Implement shell-free agent/custom command launch in target `cwd`.
- [x] Verify exit-code propagation and no duplicate worktree creation.

### Task 5: Coordination registry

**Files:** `src/coordination.mjs`, `src/commands/claim.mjs`, `src/commands/release.mjs`, `src/commands/list.mjs`, `test/coordination.test.mjs`, `test/coordination.integration.test.mjs`

- [x] Add failing ownership, dependency, cycle, release, and blocked-state tests.
- [x] Implement versioned atomic state and pure dependency analysis.
- [x] Add claim/release commands and JSON/text list views.
- [x] Verify concurrent-safe lock/refusal behavior.

### Task 6: Shared verification

**Files:** `src/commands/verify.mjs`, `test/verify.integration.test.mjs`, `src/cli.mjs`

- [x] Add failing doctor-first, empty-list, ordering, and exit-propagation tests.
- [x] Implement sequential argv execution with grouped output.
- [x] Verify the same command is usable from generated CI.

### Task 7: Land preconditions and merge closure

**Files:** `src/github.mjs`, `src/commands/land.mjs`, `src/decisions.mjs`, `test/land.test.mjs`, `test/land.integration.test.mjs`, `src/cli.mjs`

- [x] Add failing pure precondition and exact GitHub argv tests.
- [x] Implement PR/check lookup and dependency gates.
- [x] Implement dry-run default, `--yes` merge, and safe optional cleanup.
- [x] Verify every blocker and successful simulated closure.

### Task 8: GitHub protection

**Files:** `src/protection.mjs`, `src/commands/protect.mjs`, `test/protection.test.mjs`, `src/cli.mjs`

- [x] Add failing ruleset payload and repository-resolution tests.
- [x] Implement dry-run JSON and injected `gh api` application.
- [x] Verify idempotent update/create selection without live mutation.

### Task 9: CI, packaging, dogfooding, and documentation

**Files:** `.github/workflows/test.yml`, `copse.config.json`, `.githooks/*`, `.codex/hooks.json`, `.claude/settings.json`, `AGENTS.md`, `CLAUDE.md`, `.copse/features.json`, `README.md`, `docs/commands.md`, `docs/configuration.md`, `SECURITY.md`, `package.json`, tests

- [x] Add failing packaging and end-to-end consumer acceptance checks.
- [x] Harden CI with syntax, package smoke, concurrency, and explicit permissions.
- [x] Apply copse wiring to its own repository without recursive verify configuration.
- [x] Update all user documentation from design language to shipped behavior.
- [x] Run full tests, syntax checks, package inspection, and consumer acceptance.
- [x] Review the final diff against every acceptance criterion in the spec.
