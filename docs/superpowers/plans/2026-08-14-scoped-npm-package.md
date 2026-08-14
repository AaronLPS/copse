# Scoped npm Package Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish copse 0.4.0 as `@aaronlps/copse` while preserving the installed `copse` binary and ensuring every newly generated runner resolves the scoped package.

**Architecture:** Treat the npm package identity and the CLI binary name as separate contracts. Change the manifest and default/fallback package specs to the scoped identity, keep `bin.copse` unchanged, and make packed-artifact acceptance locate the installed manifest from npm's reported package name instead of assuming an unscoped directory.

**Tech Stack:** Node.js 20+, npm, Node test runner, Git/copse worktrees.

**Spec:** `docs/DESIGN.md` (Distribution: publish scoped as `@<scope>/copse` while the typed command remains `copse`).

## Global Constraints

- Package version remains exactly `0.4.0`; the rejected unscoped publish created no registry version.
- Public npm identity is exactly `@aaronlps/copse`.
- Installed binary name remains exactly `copse`.
- Generated runner argv defaults to `npx --yes @aaronlps/copse`; no shell parsing is introduced.
- Historical GitHub bootstrap support remains unchanged.

---

### Task 1: Scoped package identity and executable acceptance

**Files:**
- Modify: `package.json`
- Modify: `scripts/package-smoke.mjs`

**Interfaces:**
- Consumes: npm's `pack --json` result with `name`, `version`, `filename`, and `files`.
- Produces: package `@aaronlps/copse@0.4.0` with binary `copse -> src/cli.mjs`; package smoke that installs and executes the scoped artifact.

- [ ] **Step 1: Add the failing packed-package identity assertion**

Add a literal assertion immediately after `npm pack --json`:

```js
if (packed[0].name !== '@aaronlps/copse') {
  throw new Error(`package identity was ${packed[0].name}, expected @aaronlps/copse`);
}
```

Resolve the installed manifest path from the literal scoped directory segments:

```js
const installedManifest = join(consumer, 'node_modules', '@aaronlps', 'copse', 'package.json');
```

- [ ] **Step 2: Run the package smoke to verify RED**

Run: `npm run test:package`

Expected: FAIL with `package identity was copse, expected @aaronlps/copse` before the artifact is installed.

- [ ] **Step 3: Change only the npm package identity**

Change `package.json` name to `@aaronlps/copse`; retain version `0.4.0` and `bin: { "copse": "src/cli.mjs" }`.

- [ ] **Step 4: Run packed acceptance to verify GREEN**

Run: `npm run test:package`

Expected: PASS with `package acceptance ok: @aaronlps/copse 0.4.0, 29 files` and successful execution of `node_modules/.bin/copse`.

### Task 2: Scoped default runner behavior

**Files:**
- Modify: `test/config.test.mjs`
- Modify: `test/git-hooks.test.mjs`
- Modify: `test/wiring.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/git-hooks.mjs`
- Modify: `src/wiring.mjs`

**Interfaces:**
- Consumes: absent `runner` configuration.
- Produces: literal argv `['npx', '--yes', '@aaronlps/copse']` in parsed defaults and defensive render fallbacks.

- [ ] **Step 1: Write failing consumer-boundary tests**

Update the config default assertion to the scoped argv. Add direct missing-runner render cases that assert generated Git hook and CI commands contain the single shell-quoted package spec `'@aaronlps/copse'`.

- [ ] **Step 2: Run focused tests to verify RED**

Run: `node --test test/config.test.mjs test/git-hooks.test.mjs test/wiring.test.mjs`

Expected: FAIL because current defaults and render fallbacks still use unscoped `copse`.

- [ ] **Step 3: Implement the scoped default in all three production fallbacks**

Replace only the package-spec argv element in `src/config.mjs`, `src/git-hooks.mjs`, and `src/wiring.mjs` with `@aaronlps/copse`.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `node --test test/config.test.mjs test/git-hooks.test.mjs test/wiring.test.mjs`

Expected: PASS.

### Task 3: Current installation documentation and release verification

**Files:**
- Modify: `README.md`
- Modify: `docs/configuration.md`
- Modify: `docs/DESIGN.md`
- Modify: `docs/superpowers/specs/2026-08-13-productize-onboarding-design.md`

**Interfaces:**
- Consumes: the selected registry identity `@aaronlps/copse@0.4.0`.
- Produces: copyable npm bootstrap commands and default-runner documentation that resolve the published scoped package; historical implementation plans remain unchanged.

- [ ] **Step 1: Update current npm examples**

Use this exact release command wherever current documentation instructs npm onboarding:

```sh
npx @aaronlps/copse@0.4.0 init --apply \
  --runner-package @aaronlps/copse@0.4.0
```

Describe the default runner as `npx --yes @aaronlps/copse`. Preserve GitHub URLs and the CLI command name `copse`.

- [ ] **Step 2: Audit stale current-facing references**

Run: `rg -n "npx copse@0\\.4\\.0|runner.*npx.*copse|exec npx copse|name.*copse" README.md docs/configuration.md docs/DESIGN.md package.json src`

Expected: no current-facing unscoped npm package spec; package name is scoped and the binary/product name remains copse.

- [ ] **Step 3: Run full verification and publish dry-run**

Run: `node src/cli.mjs verify`

Run: `npm publish --dry-run --json`

Expected: 184 deterministic tests pass with two opt-in live tests skipped, syntax passes, packed acceptance reports the scoped package, and dry-run reports `@aaronlps/copse@0.4.0` with 29 files and executable `src/cli.mjs`.

- [ ] **Step 4: Commit the release fix**

```bash
git add package.json src scripts/package-smoke.mjs test README.md docs
git commit -m "fix: publish copse under npm scope"
```
