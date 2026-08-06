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
