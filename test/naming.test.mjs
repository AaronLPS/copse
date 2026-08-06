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
