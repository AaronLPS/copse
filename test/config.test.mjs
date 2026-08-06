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
