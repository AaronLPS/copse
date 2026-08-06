# grove Core — Worktree Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `grove` CLI that creates, lists and removes git worktrees whose directory names are derived from their branches, carrying the gitignored files git cannot.

**Architecture:** Two halves with a hard line between them. Every decision — is this branch name legal, where does its directory go, may this worktree be removed, what does this pull request state mean — is a pure function taking explicit state, tested without a repository. Everything touching git, `gh` and the filesystem lives in adapter and command modules that read those decisions. This split is inherited from GoThinking, where it is what made the judgement calls testable at all.

**Tech Stack:** Node ≥20, ESM, **zero runtime dependencies**, `node:test` + `node:assert` for tests. No bundler, no transpile — the published package is the source.

## Global Constraints

- **Zero runtime dependencies.** grove is an `npx` target for projects that may not be Node projects; a cold `npx` that installs a dependency tree is a tax on every invocation, and a dependency in a tool that writes git hooks is supply-chain surface nobody asked for. Validation is hand-rolled.
- **Node ≥20**, declared in `package.json` `engines`. `node:test` is stable from 20.
- **ESM only.** `"type": "module"`, `.mjs` not required but all sources use `.mjs` for explicitness.
- **No config value is read from a module constant.** Every project-specific fact (base branch, prefixes, carried files) arrives as a parameter. A module-level constant is exactly what made GoThinking's version unshippable.
- **Pure modules import nothing from `node:child_process`, `node:fs`, or `node:path`'s filesystem-touching helpers.** `path` string manipulation is allowed; `existsSync` is not. This is checkable by reading imports and is the line the whole design rests on.
- **Every user-facing refusal names all its reasons at once**, not the first. A caller who fixes one blocker and is then told about the next learns to re-run rather than to read.
- **An absence that was never measured is not an absence.** Where a fact could not be obtained (`gh` missing, offline, timed out), it is reported as unknown, never as "none".

## File Structure

```
grove/
├── package.json                    name, bin, engines, test script
├── src/
│   ├── cli.mjs                     argv dispatch, top-level error rendering
│   ├── config.mjs                  parseConfig (pure) + loadConfig (reads disk)
│   ├── naming.mjs                  PURE: branch ⇄ slug ⇄ directory
│   ├── decisions.mjs               PURE: removal blockers, drift, PR notes, rescue set
│   ├── git.mjs                     ADAPTER: git, gh, worktree enumeration
│   └── commands/
│       ├── new.mjs
│       ├── list.mjs
│       ├── drop.mjs
│       └── doctor.mjs
└── test/
    ├── config.test.mjs
    ├── naming.test.mjs
    ├── decisions.test.mjs
    └── lifecycle.integration.test.mjs   real temp git repo
```

`naming.mjs` and `decisions.mjs` are separate because they answer different questions and have different consumers: naming is needed by `new`, `list` and `drop`; decisions are needed by `list` and `drop` only. Keeping them apart means a reader of `drop` does not have to hold the slug algebra in their head.

## Config schema (this plan's subset)

```json
{
  "baseBranch": "devel",
  "branchPrefixes": ["feat", "fix", "docs", "chore"],
  "carryFiles": [".env.test", "apps/mobile/.env"],
  "carryDirs": ["supabase/.temp"],
  "install": ["pnpm", "install"]
}
```

**Deviation from the design document, deliberately:** the design calls this field `envFiles`. It is named `carryFiles` here, with `carryDirs` beside it, because GoThinking proved the set is not only env files — `supabase/.temp` records which project a checkout is linked to, is gitignored, and its absence fails in a place that names neither Supabase nor linking. "Files git will not carry" is the actual category.

---

### Task 1: Package skeleton and config parsing

**Files:**
- Create: `package.json`
- Create: `src/config.mjs`
- Create: `.gitignore`
- Test: `test/config.test.mjs`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `DEFAULTS` — object with `baseBranch: 'main'`, `branchPrefixes: ['feat','fix','docs','chore']`, `carryFiles: []`, `carryDirs: []`, `install: null`
  - `parseConfig(raw: unknown): { ok: true, config: Config } | { ok: false, errors: string[] }` — pure
  - `loadConfig(dir: string): { ok: true, config: Config } | { ok: false, errors: string[] }` — reads `<dir>/grove.config.json`; a missing file yields `DEFAULTS`
  - `Config` = `{ baseBranch: string, branchPrefixes: string[], carryFiles: string[], carryDirs: string[], install: string[] | null }`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "grove",
  "version": "0.0.0",
  "description": "Many agent sessions, one repository, no collisions.",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "grove": "./src/cli.mjs" },
  "files": ["src"],
  "scripts": {
    "test": "node --test test/"
  },
  "license": "MIT"
}
```

The `name` field is a placeholder until the npm scope is decided; the `bin` key is what matters and does not change.

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 3: Write the failing test**

Create `test/config.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, parseConfig } from '../src/config.mjs';

test('an empty config is the defaults', () => {
  const result = parseConfig({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.config, DEFAULTS);
});

test('declared values override the defaults', () => {
  const result = parseConfig({ baseBranch: 'devel', carryFiles: ['.env.test'] });
  assert.equal(result.ok, true);
  assert.equal(result.config.baseBranch, 'devel');
  assert.deepEqual(result.config.carryFiles, ['.env.test']);
  // Untouched keys keep their defaults rather than becoming undefined.
  assert.deepEqual(result.config.branchPrefixes, DEFAULTS.branchPrefixes);
});

test('a prefix containing a hyphen is refused', () => {
  // branchForSlug splits a slug at its first hyphen. A prefix with a hyphen
  // in it makes that split ambiguous and breaks the bijection the whole
  // directory-naming scheme rests on. This must fail at config load, not at
  // the moment someone cannot find their worktree.
  const result = parseConfig({ branchPrefixes: ['feat', 'hot-fix'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /hot-fix/);
  assert.match(result.errors.join('\n'), /hyphen/);
});

test('an empty prefix list is refused', () => {
  const result = parseConfig({ branchPrefixes: [] });
  assert.equal(result.ok, false);
});

test('a carried path escaping the repository is refused', () => {
  // grove copies these paths into and out of worktree directories. A `..`
  // segment writes outside the tree it was aimed at.
  const result = parseConfig({ carryFiles: ['../../.ssh/id_rsa'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /outside the repository/);
});

test('an absolute carried path is refused', () => {
  const result = parseConfig({ carryFiles: ['/etc/passwd'] });
  assert.equal(result.ok, false);
});

test('every error is reported, not just the first', () => {
  const result = parseConfig({ branchPrefixes: [], carryFiles: ['/etc/passwd'] });
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 2);
});

test('a path listed as both a file and a directory is refused', () => {
  const result = parseConfig({ carryFiles: ['a/b'], carryDirs: ['a/b'] });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /both/);
});

test('install must be a non-empty command array when present', () => {
  assert.equal(parseConfig({ install: [] }).ok, false);
  assert.equal(parseConfig({ install: 'pnpm install' }).ok, false);
  assert.equal(parseConfig({ install: ['pnpm', 'install'] }).ok, true);
  assert.equal(parseConfig({ install: null }).ok, true);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test test/config.test.mjs`
Expected: FAIL — `Cannot find module '../src/config.mjs'`

- [ ] **Step 5: Write `src/config.mjs`**

```js
/**
 * The project's declaration of facts grove cannot infer.
 *
 * Parsing is separated from reading so every rule below is reachable from a
 * test without a file on disk. The rules are not cosmetic: two of them
 * (a hyphen in a prefix, a `..` in a carried path) protect invariants that
 * fail silently and far from their cause if they are ever violated.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILENAME = 'grove.config.json';

/**
 * Defaults chosen so a repository with no config file still works.
 * `baseBranch` is 'main' because that is what a fresh repository has;
 * projects using a devel/main split declare it.
 */
export const DEFAULTS = Object.freeze({
  baseBranch: 'main',
  branchPrefixes: Object.freeze(['feat', 'fix', 'docs', 'chore']),
  carryFiles: Object.freeze([]),
  carryDirs: Object.freeze([]),
  install: null,
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A repo-relative path that cannot escape the repository.
 *
 * Rejects absolute paths, `..` segments, and backslashes — the last because a
 * Windows-style separator would defeat the segment check while still being a
 * traversal on a platform that honours it.
 */
function pathProblem(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${field}: every entry must be a non-empty string`;
  }
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    return `${field}: "${value}" is absolute; entries are relative to the repository root`;
  }
  if (value.includes('\\')) {
    return `${field}: "${value}" contains a backslash; use forward slashes`;
  }
  if (value.split('/').includes('..')) {
    return `${field}: "${value}" points outside the repository`;
  }
  return null;
}

function checkStringArray(raw, field, errors, { check }) {
  if (!Array.isArray(raw)) {
    errors.push(`${field}: must be an array`);
    return null;
  }
  for (const entry of raw) {
    const problem = check(entry, field);
    if (problem) errors.push(problem);
  }
  return raw;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, config: object } | { ok: false, errors: string[] }}
 */
export function parseConfig(raw) {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`${CONFIG_FILENAME} must contain a JSON object`] };
  }

  const errors = [];
  const config = {
    baseBranch: DEFAULTS.baseBranch,
    branchPrefixes: [...DEFAULTS.branchPrefixes],
    carryFiles: [],
    carryDirs: [],
    install: null,
  };

  const known = new Set(['baseBranch', 'branchPrefixes', 'carryFiles', 'carryDirs', 'install']);
  for (const key of Object.keys(raw)) {
    // An unknown key is almost always a typo, and a typo that is silently
    // ignored looks exactly like a setting that does not work.
    if (!known.has(key)) errors.push(`unknown key "${key}"`);
  }

  if ('baseBranch' in raw) {
    if (typeof raw.baseBranch !== 'string' || raw.baseBranch.trim() === '') {
      errors.push('baseBranch: must be a non-empty string');
    } else {
      config.baseBranch = raw.baseBranch;
    }
  }

  if ('branchPrefixes' in raw) {
    const list = checkStringArray(raw.branchPrefixes, 'branchPrefixes', errors, {
      check(entry, field) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          return `${field}: every entry must be a non-empty string`;
        }
        if (entry.includes('-')) {
          // slugFor joins prefix and rest with a hyphen; branchForSlug splits
          // at the first one. A hyphen inside a prefix makes that inverse
          // wrong, and the symptom is a worktree nobody can find by name.
          return `${field}: "${entry}" contains a hyphen, which breaks the slug round trip`;
        }
        if (!/^[a-z][a-z0-9]*$/.test(entry)) {
          return `${field}: "${entry}" must be lower-case letters and digits, starting with a letter`;
        }
        return null;
      },
    });
    if (list !== null) {
      if (list.length === 0) errors.push('branchPrefixes: must list at least one prefix');
      else config.branchPrefixes = [...list];
    }
  }

  for (const field of ['carryFiles', 'carryDirs']) {
    if (!(field in raw)) continue;
    const list = checkStringArray(raw[field], field, errors, { check: pathProblem });
    if (list !== null) config[field] = [...list];
  }

  const overlap = config.carryFiles.filter((p) => config.carryDirs.includes(p));
  for (const path of overlap) {
    errors.push(`"${path}" is listed in both carryFiles and carryDirs`);
  }

  if ('install' in raw && raw.install !== null) {
    if (!Array.isArray(raw.install) || raw.install.length === 0) {
      errors.push('install: must be null, or a non-empty array like ["pnpm", "install"]');
    } else if (raw.install.some((part) => typeof part !== 'string' || part === '')) {
      errors.push('install: every element must be a non-empty string');
    } else {
      // An array rather than a string, so the command is never handed to a
      // shell and nothing in it can be interpreted as an operator.
      config.install = [...raw.install];
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config };
}

/**
 * Reads and parses the config in `dir`. A missing file is not an error —
 * it means the defaults.
 *
 * @param {string} dir
 */
export function loadConfig(dir) {
  let text;
  try {
    text = readFileSync(join(dir, CONFIG_FILENAME), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, config: parseConfig({}).config };
    return { ok: false, errors: [`could not read ${CONFIG_FILENAME}: ${error.message}`] };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`${CONFIG_FILENAME} is not valid JSON: ${error.message}`] };
  }

  return parseConfig(raw);
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `node --test test/config.test.mjs`
Expected: PASS, 9 tests

- [ ] **Step 7: Commit**

```bash
git add package.json .gitignore src/config.mjs test/config.test.mjs
git commit -m "Config parsing, with the two rules that protect invariants

A hyphen in a branch prefix breaks the slug round trip, and a `..` in a
carried path writes outside the tree it was aimed at. Both fail far from
their cause, so both are refused at load."
```

---

### Task 2: Branch naming — the bijection

**Files:**
- Create: `src/naming.mjs`
- Test: `test/naming.test.mjs`

**Interfaces:**
- Consumes: `Config` from Task 1 (`branchPrefixes`)
- Produces:
  - `branchShape(config): RegExp`
  - `parseBranchName(branch: string, config): { ok: true, prefix: string, rest: string } | { ok: false, reason: string }`
  - `slugFor(branch: string, config): string` — throws on an illegal branch
  - `branchForSlug(slug: string, config): string` — throws on an illegal slug
  - `directoryFor(branch: string, config, { repoDir: string }): string` — absolute path

- [ ] **Step 1: Write the failing test**

Create `test/naming.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig } from '../src/config.mjs';
import { branchForSlug, directoryFor, parseBranchName, slugFor } from '../src/naming.mjs';

const config = parseConfig({ branchPrefixes: ['feat', 'fix', 'docs', 'chore'] }).config;

test('a well-formed branch parses into prefix and rest', () => {
  const parsed = parseBranchName('feat/inbox-filter', config);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.prefix, 'feat');
  assert.equal(parsed.rest, 'inbox-filter');
});

test('the reason names the legal prefixes, so the message is actionable', () => {
  const parsed = parseBranchName('wip/thing', config);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /feat, fix, docs, chore/);
});

test('two slashes are refused', () => {
  // `feat/a/b` and `feat/a-b` would slug to the same directory.
  assert.equal(parseBranchName('feat/a/b', config).ok, false);
});

test('upper case and underscores are refused', () => {
  assert.equal(parseBranchName('feat/InboxFilter', config).ok, false);
  assert.equal(parseBranchName('feat/inbox_filter', config).ok, false);
});

test('a trailing or doubled hyphen is refused', () => {
  assert.equal(parseBranchName('feat/inbox-', config).ok, false);
  assert.equal(parseBranchName('feat/inbox--filter', config).ok, false);
});

test('the prefix set comes from config, not from a constant', () => {
  const custom = parseConfig({ branchPrefixes: ['spike'] }).config;
  assert.equal(parseBranchName('spike/audio', custom).ok, true);
  assert.equal(parseBranchName('feat/audio', custom).ok, false);
});

test('slugFor keeps the prefix', () => {
  // Stripping it reads better and loses the round trip: feat/foo and fix/foo
  // would want the same directory.
  assert.equal(slugFor('feat/inbox-filter', config), 'feat-inbox-filter');
});

test('slugFor and branchForSlug invert each other, for every legal shape', () => {
  const branches = [];
  for (const prefix of config.branchPrefixes) {
    for (const rest of ['a', 'ab', 'a-b', 'a-b-c', 'x1', 'x1-y2', 'inbox-filter-v2']) {
      branches.push(`${prefix}/${rest}`);
    }
  }
  assert.equal(branches.length, 28);
  for (const branch of branches) {
    assert.equal(branchForSlug(slugFor(branch, config), config), branch, branch);
  }
});

test('feat/foo and fix/foo do not collide', () => {
  assert.notEqual(slugFor('feat/foo', config), slugFor('fix/foo', config));
});

test('slugFor throws rather than producing a wrong directory', () => {
  assert.throws(() => slugFor('wip/thing', config), /not a branch name/);
});

test('branchForSlug rejects a slug with no separator', () => {
  assert.throws(() => branchForSlug('feat', config), /no prefix separator/);
});

test('branchForSlug rejects a slug whose head is not a known prefix', () => {
  assert.throws(() => branchForSlug('wip-thing', config), /not a branch name/);
});

test('the directory is a sibling of the repository, suffixed with the slug', () => {
  const dir = directoryFor('feat/inbox-filter', config, { repoDir: '/home/me/ws/proj' });
  assert.equal(dir, '/home/me/ws/proj-feat-inbox-filter');
});

test('a trailing slash on repoDir does not produce a double separator', () => {
  const dir = directoryFor('feat/x', config, { repoDir: '/home/me/ws/proj/' });
  assert.equal(dir, '/home/me/ws/proj-feat-x');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/naming.test.mjs`
Expected: FAIL — `Cannot find module '../src/naming.mjs'`

- [ ] **Step 3: Write `src/naming.mjs`**

```js
/**
 * The mapping between a branch, its worktree's directory name, and back.
 *
 * Pure, and taking the prefix set as a parameter rather than owning it: this
 * module is the reason grove is extractable at all, and a module-level
 * constant here is what made its predecessor project-specific.
 *
 * Why the directory name is derived and never chosen. GoThinking spent a week
 * as `gothinking` and `gothinking-extension`, which read as two repositories
 * and were one repository with two worktrees — and `-extension` held the
 * dashboard branch while the directory owning .git held a feature branch.
 * Nothing reports that.
 */

/**
 * `prefix/lower-kebab`, exactly one slash, anchored at both ends.
 *
 * The single slash is load-bearing. The slug replaces `/` with `-`, so
 * `feat/a/b` and `feat/a-b` would collide, and so would `feat-a/b`. Requiring
 * the first segment to be a known prefix and forbidding a second slash makes
 * the mapping a bijection, which is what lets branchForSlug exist at all.
 *
 * @param {{ branchPrefixes: string[] }} config
 */
export function branchShape(config) {
  return new RegExp(`^(${config.branchPrefixes.join('|')})/[a-z0-9]+(-[a-z0-9]+)*$`);
}

/**
 * @param {string} branch
 * @param {{ branchPrefixes: string[] }} config
 * @returns {{ ok: true, prefix: string, rest: string } | { ok: false, reason: string }}
 */
export function parseBranchName(branch, config) {
  const match = branchShape(config).exec(branch);
  if (match) return { ok: true, prefix: match[1], rest: branch.slice(match[1].length + 1) };

  return {
    ok: false,
    reason:
      `"${branch}" is not a branch name this repository uses. Expected ` +
      `<prefix>/<lower-kebab>, one slash, prefix one of: ${config.branchPrefixes.join(', ')}.`,
  };
}

/**
 * The directory suffix for a branch. `feat/inbox-filter` → `feat-inbox-filter`.
 *
 * The prefix is kept rather than stripped. Stripping reads better —
 * `proj-inbox-filter` — and loses the round trip: `feat/foo` and `fix/foo`
 * would want the same directory, and the second `worktree add` fails
 * complaining about a path when the problem is a branch.
 *
 * @param {string} branch
 * @param {{ branchPrefixes: string[] }} config
 */
export function slugFor(branch, config) {
  const parsed = parseBranchName(branch, config);
  if (!parsed.ok) throw new Error(parsed.reason);
  return branch.replace('/', '-');
}

/**
 * The inverse of slugFor. Splits at the first `-`, which is unambiguous
 * because config validation forbids a hyphen inside a prefix.
 *
 * @param {string} slug
 * @param {{ branchPrefixes: string[] }} config
 */
export function branchForSlug(slug, config) {
  const index = slug.indexOf('-');
  if (index === -1) throw new Error(`"${slug}" is not a worktree slug — no prefix separator.`);

  const branch = `${slug.slice(0, index)}/${slug.slice(index + 1)}`;
  const parsed = parseBranchName(branch, config);
  if (!parsed.ok) throw new Error(parsed.reason);
  return branch;
}

/**
 * Where a branch's worktree belongs: a sibling of the repository directory,
 * suffixed with the branch slug.
 *
 * Siblings rather than a nested container, and that is a constraint rather
 * than a taste: a worktree at a different depth resolves any relative path
 * reference differently, and only from some worktrees — a failure shape that
 * is hard to recognise because it is not uniform.
 *
 * @param {string} branch
 * @param {{ branchPrefixes: string[] }} config
 * @param {{ repoDir: string }} options the main worktree's absolute path
 */
export function directoryFor(branch, config, { repoDir }) {
  const trimmed = repoDir.replace(/\/+$/, '');
  return `${trimmed}-${slugFor(branch, config)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/naming.test.mjs`
Expected: PASS, 14 tests

- [ ] **Step 5: Commit**

```bash
git add src/naming.mjs test/naming.test.mjs
git commit -m "Branch ⇄ slug ⇄ directory, with the round trip as the tested invariant

The prefix is kept rather than stripped, which reads worse and is the
reason the mapping is a bijection: feat/foo and fix/foo would otherwise
want the same directory."
```

---

### Task 3: The judgement calls

**Files:**
- Create: `src/decisions.mjs`
- Test: `test/decisions.test.mjs`

**Interfaces:**
- Consumes: `Config` from Task 1; `parseBranchName`, `directoryFor` from Task 2
- Produces:
  - `removalBlockers({ dirty, unpushed, isMain, isCurrent }): string[]`
  - `rescuableFiles({ inWorktree: string[], inRepo: string[] }): string[]`
  - `pullRequestNote(pr, { isMain }): string` where `pr` is `{ number, state } | null | undefined`
  - `pullRequestLookupBranch({ detached, branch }): string | null`
  - `driftNote(entry, config, { repoDir }): string | null` where `entry` is `{ path, branch, detached, isMain }`

- [ ] **Step 1: Write the failing test**

Create `test/decisions.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig } from '../src/config.mjs';
import {
  driftNote,
  pullRequestLookupBranch,
  pullRequestNote,
  removalBlockers,
  rescuableFiles,
} from '../src/decisions.mjs';

const config = parseConfig({ baseBranch: 'devel' }).config;
const clean = { dirty: false, unpushed: 0, isMain: false, isCurrent: false };

test('a clean, non-main, non-current worktree has no blockers', () => {
  assert.deepEqual(removalBlockers(clean), []);
});

test('the main worktree can never be removed', () => {
  const blockers = removalBlockers({ ...clean, isMain: true });
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /owns \.git/);
});

test('being inside the worktree blocks removing it', () => {
  assert.match(removalBlockers({ ...clean, isCurrent: true })[0], /cd elsewhere/);
});

test('unpushed commits block, and the count is named', () => {
  assert.match(removalBlockers({ ...clean, unpushed: 3 })[0], /3 unpushed/);
});

test('every blocker is reported at once, not just the first', () => {
  // A caller told one reason at a time learns to re-run the command rather
  // than to read its output.
  const blockers = removalBlockers({ dirty: true, unpushed: 2, isMain: true, isCurrent: true });
  assert.equal(blockers.length, 4);
});

test('rescuable files are those the worktree holds and the repo does not', () => {
  const rescue = rescuableFiles({
    inWorktree: ['.env.test', 'apps/extension/.env'],
    inRepo: ['.env.test'],
  });
  assert.deepEqual(rescue, ['apps/extension/.env']);
});

test('nothing is rescuable when the repository has its own copy of everything', () => {
  assert.deepEqual(rescuableFiles({ inWorktree: ['.env.test'], inRepo: ['.env.test'] }), []);
});

test('a pull request that could not be asked about is unknown, not absent', () => {
  // `gh` missing, logged out, offline or timed out. Reporting that as
  // "no PR" is a claim where there was never an observation.
  assert.equal(pullRequestNote(undefined, { isMain: false }), 'PR state unknown');
});

test('asked, and there is none', () => {
  assert.equal(pullRequestNote(null, { isMain: false }), 'no PR');
});

test('a merged pull request on a feature worktree says it is droppable', () => {
  const note = pullRequestNote({ number: 12, state: 'MERGED' }, { isMain: false });
  assert.match(note, /#12 merged/);
  assert.match(note, /droppable/);
});

test('the main worktree is never labelled droppable', () => {
  // Its newest base → release pull request is essentially always merged, and
  // removalBlockers refuses it on isMain alone. Nothing was ever at risk, but
  // the column exists to be believed.
  const note = pullRequestNote({ number: 12, state: 'MERGED' }, { isMain: true });
  assert.match(note, /#12 merged/);
  assert.doesNotMatch(note, /droppable/);
});

test('open and closed read plainly', () => {
  assert.equal(pullRequestNote({ number: 7, state: 'OPEN' }, { isMain: false }), 'PR #7 open');
  assert.equal(pullRequestNote({ number: 7, state: 'CLOSED' }, { isMain: false }), 'PR #7 closed');
});

test('a detached worktree has no branch to look a pull request up by', () => {
  // The display string for a detached entry is truthy, so a caller gating on
  // "is there a branch" would run `gh pr list --head '(detached)'`, get no
  // matches, and print "no PR" for a row never meaningfully asked about.
  assert.equal(pullRequestLookupBranch({ detached: true, branch: null }), null);
  assert.equal(pullRequestLookupBranch({ detached: false, branch: 'feat/x' }), 'feat/x');
});

test('the main worktree on the base branch has no drift', () => {
  const entry = { path: '/ws/proj', branch: 'devel', detached: false, isMain: true };
  assert.equal(driftNote(entry, config, { repoDir: '/ws/proj' }), null);
});

test('the main worktree on a feature branch is drift', () => {
  const entry = { path: '/ws/proj', branch: 'feat/x', detached: false, isMain: true };
  assert.match(driftNote(entry, config, { repoDir: '/ws/proj' }), /should be on devel/);
});

test('a worktree in the wrong directory for its branch is drift, and the note names the right one', () => {
  const entry = { path: '/ws/proj-extension', branch: 'feat/dashboard', detached: false, isMain: false };
  const note = driftNote(entry, config, { repoDir: '/ws/proj' });
  assert.match(note, /proj-feat-dashboard/);
});

test('a worktree in the right directory has no drift', () => {
  const entry = { path: '/ws/proj-feat-x', branch: 'feat/x', detached: false, isMain: false };
  assert.equal(driftNote(entry, config, { repoDir: '/ws/proj' }), null);
});

test('an unrecognised branch prefix is drift', () => {
  const entry = { path: '/ws/proj-wip-x', branch: 'wip/x', detached: false, isMain: false };
  assert.match(driftNote(entry, config, { repoDir: '/ws/proj' }), /no recognised prefix/);
});

test('a detached worktree is not reported as drift', () => {
  // It has no branch, so there is no name for its directory to disagree with.
  const entry = { path: '/ws/proj-thing', branch: null, detached: true, isMain: false };
  assert.equal(driftNote(entry, config, { repoDir: '/ws/proj' }), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/decisions.test.mjs`
Expected: FAIL — `Cannot find module '../src/decisions.mjs'`

- [ ] **Step 3: Write `src/decisions.mjs`**

```js
/**
 * Every judgement `list` and `drop` make, as pure functions over explicit
 * state — so a dirty tree, an unpushed commit, a detached head, a `gh` that
 * could not answer and a directory whose name no longer fits its branch are
 * all reachable from a test without a repository.
 */
import { resolve } from 'node:path';

import { directoryFor, parseBranchName } from './naming.mjs';

/**
 * Every reason this worktree must not be removed, all of them at once.
 *
 * All of them, not the first: a caller who fixes one blocker and is then told
 * about the next learns to run the command repeatedly rather than to read it.
 *
 * @param {{ dirty: boolean, unpushed: number, isMain: boolean, isCurrent: boolean }} state
 * @returns {string[]}
 */
export function removalBlockers({ dirty, unpushed, isMain, isCurrent }) {
  const blockers = [];

  if (isMain) blockers.push('this is the main worktree — it owns .git and cannot be removed');
  if (isCurrent) blockers.push('you are currently in this worktree — cd elsewhere first');
  if (unpushed > 0) {
    blockers.push(
      `${unpushed} unpushed commit(s) — push them, or drop the branch deliberately with git branch -D`,
    );
  }
  if (dirty) blockers.push('uncommitted changes in the working tree');

  return blockers;
}

/**
 * Carried files this worktree holds the only copy of.
 *
 * These are gitignored, so removing the directory destroys them. In GoThinking
 * one env file was genuinely in this position — present in one worktree and
 * nowhere else, one `git worktree remove` from gone.
 *
 * @param {{ inWorktree: string[], inRepo: string[] }} present
 */
export function rescuableFiles({ inWorktree, inRepo }) {
  const held = new Set(inRepo);
  return inWorktree.filter((path) => !held.has(path));
}

/**
 * How a branch's pull request reads in `grove list`.
 *
 * `null` means asked and there is none; `undefined` means could not ask — `gh`
 * missing, unauthenticated, offline or timed out. They are different facts and
 * the second must not be printed as the first: an absence that was never
 * measured is not an absence.
 *
 * `isMain` exists because "droppable" is not only a fact about the pull
 * request — it is a claim about *this worktree*, and the main worktree's
 * newest base → release pull request is essentially always merged. Without
 * this, the one directory that can never be removed carried a permanent
 * "droppable" label.
 *
 * @param {{ number: number, state: 'OPEN' | 'MERGED' | 'CLOSED' } | null | undefined} pr
 * @param {{ isMain?: boolean }} [options]
 */
export function pullRequestNote(pr, { isMain = false } = {}) {
  if (pr === undefined) return 'PR state unknown';
  if (pr === null) return 'no PR';
  if (pr.state === 'MERGED') {
    return isMain ? `PR #${pr.number} merged` : `PR #${pr.number} merged — droppable`;
  }
  if (pr.state === 'CLOSED') return `PR #${pr.number} closed`;
  return `PR #${pr.number} open`;
}

/**
 * The branch to ask `gh` about, or `null` when there is none.
 *
 * A detached worktree has no branch, but a display string for it (`'(detached)'`)
 * is truthy — so a ternary gating the `gh` call on "is there a branch" runs it
 * anyway, finds no matches, and prints "no PR" for a row that was never
 * meaningfully asked about.
 *
 * @param {{ detached: boolean, branch: string | null }} entry
 * @returns {string | null}
 */
export function pullRequestLookupBranch(entry) {
  return entry.detached ? null : entry.branch;
}

/**
 * Why this worktree's directory name no longer says what is checked out in it,
 * or `null` when it does.
 *
 * @param {{ path: string, branch: string | null, detached: boolean, isMain: boolean }} entry
 * @param {{ branchPrefixes: string[], baseBranch: string }} config
 * @param {{ repoDir: string }} options
 * @returns {string | null}
 */
export function driftNote(entry, config, { repoDir }) {
  if (entry.detached) return null;

  if (entry.isMain) {
    // The main worktree owns .git, so a feature branch here is the one branch
    // that cannot be moved aside cheaply.
    return entry.branch === config.baseBranch
      ? null
      : `⚠ main worktree should be on ${config.baseBranch}`;
  }

  if (!parseBranchName(entry.branch, config).ok) return '⚠ branch name has no recognised prefix';

  const expected = directoryFor(entry.branch, config, { repoDir });
  if (resolve(expected) === resolve(entry.path)) return null;
  return `⚠ expected ${expected}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/decisions.test.mjs`
Expected: PASS, 19 tests

- [ ] **Step 5: Commit**

```bash
git add src/decisions.mjs test/decisions.test.mjs
git commit -m "The judgement calls, pure and complete

Notably: an unaskable pull request is unknown rather than absent, and a
detached worktree has no branch to ask about — two facts that read the
same on screen and are not the same claim."
```

---

### Task 4: The git and gh adapter

**Files:**
- Create: `src/git.mjs`
- Test: covered by Task 8's integration test (this module is defined by its interaction with real git; a mocked test of it would assert the mock)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `git(args: string[], { cwd, allowFailure }): string | null`
  - `worktrees({ cwd }): Array<{ path, branch: string|null, detached: boolean, isMain: boolean }>`
  - `mainWorktree({ cwd }): { path, branch, detached, isMain }` — throws if none
  - `pullRequestFor(branch, { cwd }): { number, state } | null | undefined`
  - `worktreeState(path): { dirty: boolean, unpushed: number }`

- [ ] **Step 1: Write `src/git.mjs`**

```js
/**
 * Everything that touches git, `gh` and the process table. No decisions live
 * here — this module answers questions, and src/decisions.mjs judges.
 */
import { execFileSync } from 'node:child_process';

/**
 * `gh` missing or refusing is instant — ENOENT or a non-zero exit come back in
 * milliseconds. A `gh` that is merely slow does not: a captive portal accepts
 * the TCP connection and never answers it, so with no bound `grove list` — the
 * command people run to find out where they are — hangs forever instead of
 * degrading to "PR state unknown". This runs once per worktree, serially, so
 * the worst case is this bound times the worktree count.
 */
const GH_TIMEOUT_MS = 3000;

export function git(args, { cwd = process.cwd(), allowFailure = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(' ')} failed:\n${error.stderr || error.message}`);
  }
}

/**
 * Every worktree of the repository containing `cwd`.
 *
 * `--porcelain` is parsed rather than the human format, which aligns columns
 * with spaces — a path containing a space would silently split.
 *
 * @param {{ cwd?: string }} [options]
 */
export function worktrees({ cwd = process.cwd() } = {}) {
  const out = git(['worktree', 'list', '--porcelain'], { cwd });
  const entries = [];
  let current = null;

  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length), branch: null, detached: false };
      entries.push(current);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      current.detached = true;
    }
  }

  // git lists the main worktree first — it is the one holding .git as a
  // directory rather than as a file pointing elsewhere.
  return entries.map((entry, index) => ({ ...entry, isMain: index === 0 }));
}

export function mainWorktree({ cwd = process.cwd() } = {}) {
  const found = worktrees({ cwd }).find((entry) => entry.isMain);
  if (!found) throw new Error('could not identify the main worktree');
  return found;
}

/**
 * Whether a worktree has uncommitted or unpushed work.
 *
 * The no-upstream branch is defended against rather than assumed away.
 * `git worktree add -b <branch> origin/<base>` does set an upstream, so the
 * ordinary path never reaches it — verified, not assumed. But a branch made by
 * hand, or one created with `branch.autoSetupMerge` turned off, has none, and
 * there `@{u}..HEAD` fails: read as "no output", that is zero unpushed for a
 * branch whose every commit is unpushed, and `drop` would destroy the lot.
 *
 * @param {string} path
 */
export function worktreeState(path) {
  const dirty = git(['status', '--porcelain'], { cwd: path, allowFailure: true });
  const upstream = git(['rev-parse', '--abbrev-ref', '@{u}'], { cwd: path, allowFailure: true });

  let unpushed = 0;
  if (upstream === null) {
    // No upstream at all: every commit not on the remote-tracking base is
    // unpushed. Counting them as 0 would let `drop` destroy work.
    const out = git(['log', '--oneline', 'HEAD', '--not', '--remotes'], {
      cwd: path,
      allowFailure: true,
    });
    unpushed = out ? out.split('\n').length : 0;
  } else {
    const out = git(['log', '--oneline', '@{u}..HEAD'], { cwd: path, allowFailure: true });
    unpushed = out ? out.split('\n').length : 0;
  }

  return { dirty: dirty !== null && dirty !== '', unpushed };
}

/**
 * The newest pull request for a branch, or `null` if there is none.
 *
 * Returns `undefined` when `gh` could not answer at all — absent, logged out,
 * offline, or timed out — because `grove list` must keep working without a
 * network and "there is no PR" would be a claim rather than an observation.
 *
 * @param {string} branch
 * @param {{ cwd: string }} options
 */
export function pullRequestFor(branch, { cwd }) {
  try {
    const out = execFileSync(
      'gh',
      ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '1', '--json', 'number,state'],
      {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GH_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      },
    );
    const [pr] = JSON.parse(out);
    return pr ?? null;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2: Verify it loads and enumerates this repository**

Run: `node -e "import('./src/git.mjs').then(m => console.log(m.worktrees()))"`
Expected: an array with one entry, `isMain: true`, whose `path` is the grove repository.

- [ ] **Step 3: Commit**

```bash
git add src/git.mjs
git commit -m "The git and gh adapter, with no decisions in it

Two bounds that are not obvious: gh gets a 3s timeout because a captive
portal never answers, and a branch with no upstream counts commits
against every remote rather than reporting zero unpushed."
```

---

### Task 5: `grove new`

**Files:**
- Create: `src/commands/new.mjs`
- Create: `src/cli.mjs`

**Interfaces:**
- Consumes: `loadConfig`, `parseBranchName`, `directoryFor`, `git`, `worktrees`, `mainWorktree`
- Produces: `commandNew(branch: string, { cwd }): void` — throws `GroveError` on refusal

- [ ] **Step 1: Write `src/commands/new.mjs`**

```js
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

import { git, mainWorktree, worktrees } from '../git.mjs';
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
  for (const file of config.carryFiles) {
    const from = join(repoDir, file);
    if (!existsSync(from)) {
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
    if (!existsSync(from)) {
      console.log(`   – ${dir} (not present in ${repoDir}; skipped)`);
      continue;
    }
    cpSync(from, join(target, dir), { recursive: true });
    console.log(`   ✓ ${dir}`);
    copied += 1;
  }
  if (copied === 0 && (config.carryFiles.length > 0 || config.carryDirs.length > 0)) {
    console.log('   ! nothing was copied — the new worktree carries none of them');
  }

  if (config.install) {
    console.log(`→ ${config.install.join(' ')}`);
    execFileSync(config.install[0], config.install.slice(1), { cwd: target, stdio: 'inherit' });
  }

  console.log(`\n✓ ${target}\n  cd ${target}\n`);
}
```

- [ ] **Step 2: Write `src/cli.mjs`**

```js
#!/usr/bin/env node
/**
 * Argument dispatch and the one place a refusal becomes an exit code.
 */
import { loadConfig } from './config.mjs';
import { mainWorktree } from './git.mjs';
import { GroveError, commandNew } from './commands/new.mjs';

const USAGE = `
  grove new <prefix>/<lower-kebab>   worktree off the base branch, files carried
  grove list                         every worktree, and whether its name still fits
  grove drop <branch>                refuses while there is anything to lose
  grove doctor                       is grove still wired into this repository

  The directory is derived from the branch. Configure in grove.config.json.
`;

function die(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

const [command, argument] = process.argv.slice(2);

if (command === undefined || command === '--help' || command === '-h') {
  console.log(USAGE);
  process.exit(0);
}

let repoDir;
try {
  repoDir = mainWorktree().path;
} catch {
  die('not inside a git repository');
}

const loaded = loadConfig(repoDir);
if (!loaded.ok) {
  console.error('\n✗ grove.config.json:');
  for (const error of loaded.errors) console.error(`  · ${error}`);
  console.error('');
  process.exit(1);
}
const config = loaded.config;

try {
  switch (command) {
    case 'new':
      commandNew(argument, { config });
      break;
    default:
      console.log(USAGE);
      process.exit(1);
  }
} catch (error) {
  if (error instanceof GroveError) die(error.message);
  throw error;
}
```

- [ ] **Step 3: Verify the help text and the refusal path by hand**

Run: `node src/cli.mjs --help`
Expected: the usage block, exit 0.

Run: `node src/cli.mjs new wip/thing`
Expected: `✗ "wip/thing" is not a branch name this repository uses.` and exit 1.

- [ ] **Step 4: Commit**

```bash
git add src/commands/new.mjs src/cli.mjs
git commit -m "grove new: a worktree named after its branch, carrying what git will not"
```

---

### Task 6: `grove list`

**Files:**
- Create: `src/commands/list.mjs`
- Modify: `src/cli.mjs` — add the `list` case

**Interfaces:**
- Consumes: `worktrees`, `worktreeState`, `pullRequestFor`, `driftNote`, `pullRequestNote`, `pullRequestLookupBranch`
- Produces: `commandList({ cwd, config }): number` — returns the drift count

- [ ] **Step 1: Write `src/commands/list.mjs`**

```js
/**
 * Every worktree, whether its directory name still says what is checked out in
 * it, and what pull request it belongs to.
 *
 * The pull request column is what makes "one worktree per pull request, not
 * per task" visible. That rule cannot be enforced in code, so the alternative
 * to showing it is leaving it to be remembered.
 */
import { dirname, relative } from 'node:path';

import { pullRequestFor, worktreeState, worktrees } from '../git.mjs';
import { driftNote, pullRequestLookupBranch, pullRequestNote } from '../decisions.mjs';

export function commandList({ cwd = process.cwd(), config }) {
  const entries = worktrees({ cwd });
  const repoDir = entries.find((entry) => entry.isMain).path;
  const parent = dirname(repoDir);
  let drifted = 0;

  console.log('');
  for (const entry of entries) {
    const branch = entry.detached ? '(detached)' : entry.branch;

    const note = driftNote(entry, config, { repoDir });
    if (note !== null) drifted += 1;

    const { dirty, unpushed } = worktreeState(entry.path);
    const lookupBranch = pullRequestLookupBranch(entry);
    const pr = lookupBranch ? pullRequestFor(lookupBranch, { cwd: entry.path }) : undefined;

    const flags = [
      dirty ? 'uncommitted changes' : null,
      unpushed ? `${unpushed} unpushed` : null,
      pullRequestNote(pr, { isMain: entry.isMain }),
    ].filter(Boolean);

    const shown = note ?? (entry.isMain ? `main worktree, pinned to ${config.baseBranch}` : '');
    console.log(`  ${relative(parent, entry.path).padEnd(38)} ${String(branch).padEnd(34)} ${shown}`);
    if (flags.length) console.log(`  ${''.padEnd(38)} ${flags.join(', ')}`);
  }

  console.log(
    drifted === 0 ? '\n✓ every directory name matches its branch\n' : `\n⚠ ${drifted} drifted\n`,
  );
  return drifted;
}
```

- [ ] **Step 2: Wire it into `src/cli.mjs`**

Add the import beside the existing one:

```js
import { commandList } from './commands/list.mjs';
```

Add the case above `default:`:

```js
    case 'list':
      commandList({ config });
      break;
```

- [ ] **Step 3: Verify against this repository**

Run: `node src/cli.mjs list`
Expected: one row for the grove repository itself. Because grove's own config does not exist yet, `baseBranch` defaults to `main` and the row reads `main worktree, pinned to main` with no drift.

- [ ] **Step 4: Commit**

```bash
git add src/commands/list.mjs src/cli.mjs
git commit -m "grove list: what is checked out where, and which pull request it is

The pull request column is how 'one worktree per pull request' becomes
visible rather than remembered."
```

---

### Task 7: `grove drop`

**Files:**
- Create: `src/commands/drop.mjs`
- Modify: `src/cli.mjs` — add the `drop` case

**Interfaces:**
- Consumes: `worktrees`, `worktreeState`, `mainWorktree`, `git`, `removalBlockers`, `rescuableFiles`, `parseBranchName`, `branchForSlug`
- Produces: `commandDrop(argument: string, { cwd, config }): void`

- [ ] **Step 1: Write `src/commands/drop.mjs`**

```js
/**
 * Removes a worktree, refusing while there is anything to lose — and rescuing
 * the carried files this worktree holds the only copy of before it does.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { git, mainWorktree, worktreeState, worktrees } from '../git.mjs';
import { removalBlockers, rescuableFiles } from '../decisions.mjs';
import { branchForSlug, parseBranchName } from '../naming.mjs';
import { GroveError } from './new.mjs';

export function commandDrop(argument, { cwd = process.cwd(), config }) {
  if (!argument) throw new GroveError('usage: grove drop <branch>');

  // Accept either form: the branch, or the directory slug it produced.
  let branch = argument;
  if (!parseBranchName(argument, config).ok) {
    try {
      branch = branchForSlug(argument, config);
    } catch {
      throw new GroveError(parseBranchName(argument, config).reason);
    }
  }

  const entry = worktrees({ cwd }).find((w) => w.branch === branch);
  if (!entry) throw new GroveError(`no worktree has ${branch} checked out`);

  const { dirty, unpushed } = worktreeState(entry.path);
  const isCurrent = resolve(cwd).startsWith(resolve(entry.path));

  const blockers = removalBlockers({ dirty, unpushed, isMain: entry.isMain, isCurrent });
  if (blockers.length > 0) {
    throw new GroveError(
      `not removing ${entry.path}:\n${blockers.map((b) => `  · ${b}`).join('\n')}`,
    );
  }

  // The carried files are gitignored, so removing the directory destroys them.
  const repoDir = mainWorktree({ cwd }).path;
  const carried = [...config.carryFiles];
  const rescue = rescuableFiles({
    inWorktree: carried.filter((file) => existsSync(join(entry.path, file))),
    inRepo: carried.filter((file) => existsSync(join(repoDir, file))),
  });

  if (rescue.length > 0) {
    console.log(`\n→ rescuing files held only here, into ${repoDir}`);
    for (const file of rescue) {
      mkdirSync(dirname(join(repoDir, file)), { recursive: true });
      copyFileSync(join(entry.path, file), join(repoDir, file));
      console.log(`   ✓ ${file}`);
    }
  }

  console.log(`→ removing ${entry.path}`);
  git(['worktree', 'remove', entry.path], { cwd: repoDir });
  console.log(
    `\n✓ removed. The branch ${branch} still exists — delete it with:\n  git branch -d ${branch}\n`,
  );
}
```

- [ ] **Step 2: Wire it into `src/cli.mjs`**

Add the import:

```js
import { commandDrop } from './commands/drop.mjs';
```

Add the case above `default:`:

```js
    case 'drop':
      commandDrop(argument, { config });
      break;
```

- [ ] **Step 3: Commit**

```bash
git add src/commands/drop.mjs src/cli.mjs
git commit -m "grove drop: refuses while anything would be lost, rescues what only it holds"
```

---

### Task 8: `grove doctor` and the lifecycle integration test

**Files:**
- Create: `src/commands/doctor.mjs`
- Modify: `src/cli.mjs` — add the `doctor` case
- Test: `test/lifecycle.integration.test.mjs`

**Interfaces:**
- Consumes: everything above
- Produces: `commandDoctor({ cwd, config }): { ok: boolean, findings: string[] }`

This task carries the integration test because that test is what proves the previous three commands work at all — every one of their bugs lives in the interaction with real git, where a unit test cannot see it.

- [ ] **Step 1: Write `src/commands/doctor.mjs`**

```js
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
```

- [ ] **Step 2: Wire it into `src/cli.mjs`**

Add the import:

```js
import { commandDoctor } from './commands/doctor.mjs';
```

Add the case above `default:`:

```js
    case 'doctor': {
      const { ok } = commandDoctor({ config });
      process.exit(ok ? 0 : 1);
    }
```

- [ ] **Step 3: Write the failing integration test**

Create `test/lifecycle.integration.test.mjs`:

```js
/**
 * The whole lifecycle against a real git repository, because every bug in a
 * tool of this kind lives in the interaction with real git, where a mocked
 * test would assert the mock.
 *
 * A bare repository stands in for the remote, so `origin/<base>` resolves and
 * pushing works without a network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../src/config.mjs';
import { commandDrop } from '../src/commands/drop.mjs';
import { commandNew } from '../src/commands/new.mjs';
import { GroveError } from '../src/commands/new.mjs';

const config = parseConfig({
  baseBranch: 'devel',
  carryFiles: ['.env.test'],
  install: null,
}).config;

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository with an `origin` that is a real bare repo on disk. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'grove-'));
  const remote = join(root, 'origin.git');
  const repo = join(root, 'proj');

  run('git', ['init', '--bare', '-b', 'devel', remote], root);
  run('git', ['init', '-b', 'devel', repo], root);
  run('git', ['config', 'user.email', 'test@example.com'], repo);
  run('git', ['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), '# proj\n');
  writeFileSync(join(repo, '.gitignore'), '.env.test\n');
  writeFileSync(join(repo, '.env.test'), 'SECRET=1\n');
  run('git', ['add', '-A'], repo);
  run('git', ['commit', '-m', 'first'], repo);
  run('git', ['remote', 'add', 'origin', remote], repo);
  run('git', ['push', '-u', 'origin', 'devel'], repo);

  return { root, repo };
}

test('new creates the derived directory and carries the ignored file', () => {
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/inbox-filter', { cwd: repo, config });

    const target = join(root, 'proj-feat-inbox-filter');
    assert.ok(existsSync(target), 'the derived directory exists');
    assert.ok(existsSync(join(target, '.env.test')), 'the gitignored file was carried');
    assert.equal(readFileSync(join(target, '.env.test'), 'utf8'), 'SECRET=1\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new refuses a branch already checked out', () => {
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    assert.throws(() => commandNew('feat/x', { cwd: repo, config }), GroveError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drop refuses while a commit is unpushed', () => {
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    const target = join(root, 'proj-feat-x');
    writeFileSync(join(target, 'note.md'), 'work\n');
    run('git', ['add', '-A'], target);
    run('git', ['commit', '-m', 'work'], target);

    assert.throws(
      () => commandDrop('feat/x', { cwd: repo, config }),
      /unpushed/,
      'a branch with no upstream must not read as fully pushed',
    );
    assert.ok(existsSync(target), 'the worktree survived the refusal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drop refuses while the working tree is dirty', () => {
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    const target = join(root, 'proj-feat-x');
    writeFileSync(join(target, 'README.md'), 'edited\n');

    assert.throws(() => commandDrop('feat/x', { cwd: repo, config }), /uncommitted/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drop rescues a carried file this worktree holds the only copy of', () => {
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    const target = join(root, 'proj-feat-x');

    // The near miss this rescue exists for: the only copy lives in the
    // worktree about to be removed.
    rmSync(join(repo, '.env.test'));
    writeFileSync(join(target, '.env.test'), 'SECRET=rescued\n');

    commandDrop('feat/x', { cwd: repo, config });

    assert.ok(!existsSync(target), 'the worktree was removed');
    assert.equal(
      readFileSync(join(repo, '.env.test'), 'utf8'),
      'SECRET=rescued\n',
      'the only copy was carried back before removal',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drop accepts the directory slug as well as the branch', () => {
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    commandDrop('feat-x', { cwd: repo, config });
    assert.ok(!existsSync(join(root, 'proj-feat-x')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drop refuses the main worktree', () => {
  const { root, repo } = makeRepo();
  try {
    // devel is not a legal branch name, so this exercises the branch that
    // reaches removalBlockers rather than the name check.
    assert.throws(() => commandDrop('feat/nothing', { cwd: repo, config }), /no worktree has/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run the test to verify it fails, then passes**

Run: `node --test test/lifecycle.integration.test.mjs`

Expected: PASS. These tests guard behaviour rather than drive it — the commands they exercise were written in Tasks 5–7, so this is the run that proves those tasks were right, not a red-then-green cycle.

**Then prove the no-upstream branch is really defended**, because nothing above reaches it: `worktree add` sets an upstream, so the ordinary path never exercises that code. Strip it deliberately and confirm `drop` still refuses.

```bash
node --test test/lifecycle.integration.test.mjs
```

Add this test to the file and watch it pass only with the `--not --remotes` branch in `worktreeState`; comment that branch out and watch it fail:

```js
test('drop refuses a branch with no upstream at all', () => {
  // Nothing in the ordinary flow produces this — `worktree add -b x origin/base`
  // sets an upstream. A hand-made branch, or one made with
  // branch.autoSetupMerge off, has none, and `@{u}..HEAD` then fails. Read as
  // "no output" that is zero unpushed for a branch whose every commit is
  // unpushed, and drop would destroy all of it.
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    const target = join(root, 'proj-feat-x');
    run('git', ['branch', '--unset-upstream'], target);
    writeFileSync(join(target, 'note.md'), 'work\n');
    run('git', ['add', '-A'], target);
    run('git', ['commit', '-m', 'work'], target);

    assert.throws(() => commandDrop('feat/x', { cwd: repo, config }), /unpushed/);
    assert.ok(existsSync(target), 'the worktree survived the refusal');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Then run the whole suite: `node --test test/`
Expected: PASS, all files.

- [ ] **Step 5: Verify `doctor` reports a real finding**

In this repository, create `grove.config.json` declaring a file that does not exist, run doctor, then delete it:

```bash
echo '{"carryFiles":[".env.absent"]}' > grove.config.json
node src/cli.mjs doctor; echo "exit=$?"
rm grove.config.json
```

Expected: one finding naming `.env.absent`, `exit=1`. A doctor that has never been seen to fail is not evidence of anything.

- [ ] **Step 6: Commit**

```bash
git add src/commands/doctor.mjs src/cli.mjs test/lifecycle.integration.test.mjs
git commit -m "grove doctor, and the lifecycle proven against a real repository

The integration test uses a real bare repo as origin, so 'unpushed'
means what it means in practice. Doctor was verified by making it
refuse, not by watching it pass."
```

---

## Self-review

**Spec coverage.** This plan covers the design's worktree layer: derived directory names, flat siblings, the main worktree's role, carrying ignored files, `drop`'s rescue, one-worktree-per-pull-request made visible, and ports diagnosed — *except* the port diagnosis, which is deliberately deferred: it needs process-table reading that is platform-specific and belongs with `list`'s second iteration rather than blocking the lifecycle. **That is a knowing gap and is recorded here rather than dropped.** `init`, `land`, `verify`, `protect`, git hooks, the CI workflow and the agent instruction file are Plans 2 and 3.

**Placeholder scan.** No TBDs. `package.json`'s `name` is a stated placeholder pending the npm scope, and does not block anything.

**Type consistency.** `Config` shape is fixed in Task 1 and consumed unchanged. `GroveError` is defined in `commands/new.mjs` and imported by `commands/drop.mjs` — slightly awkward placement that Plan 2 should move to its own module when a third command needs it; noted rather than pre-factored.

## Deviations recorded

- `envFiles` in the design became `carryFiles` + `carryDirs`, because the set is provably not only env files.
- `worktreeState` counts commits against every remote when a branch has no upstream, where GoThinking's version used `@{u}..HEAD` with `allowFailure` and so read a failed command as zero unpushed.

  **This is hardening, not a bug fix, and the difference was measured rather than reasoned about.** The first draft of this plan claimed it was the state every fresh `grove new` branch is in. It is not: `git worktree add -b feat/x origin/devel` sets the upstream to `origin/devel` automatically, so `@{u}..HEAD` counts correctly on the ordinary path — confirmed in a scratch repository before this line was written. The gap is real but narrow: a branch made by hand, or one made with `branch.autoSetupMerge` disabled. It is defended because the failure is silent and its cost is destroyed work, not because anything has hit it.

  The general point is worth more than the instance: **a command that can fail, read through `allowFailure`, returns the same value as a command that succeeded with nothing to say.** Anywhere that value is then treated as a count, "could not ask" becomes "zero".
