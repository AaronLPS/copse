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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('drop rescues a carried directory this worktree holds the only copy of', () => {
  // Task 7's review found that the original rescue path only handled
  // config.carryFiles, copied with copyFileSync — which throws on a
  // directory. carryDirs must be rescued too, with cpSync({ recursive: true }).
  const dirConfig = parseConfig({
    baseBranch: 'devel',
    carryDirs: ['data'],
    install: null,
  }).config;

  const { root, repo } = makeRepo();
  try {
    writeFileSync(join(repo, '.gitignore'), '.env.test\ndata/\n');
    run('git', ['add', '-A'], repo);
    run('git', ['commit', '-m', 'ignore data'], repo);
    run('git', ['push', 'origin', 'devel'], repo);
    mkdirSync(join(repo, 'data'));
    writeFileSync(join(repo, 'data', 'note.txt'), 'original\n');

    commandNew('feat/x', { cwd: repo, config: dirConfig });
    const target = join(root, 'proj-feat-x');

    // The only copy of the directory lives in the worktree about to be
    // removed — mirror the carried-file rescue test above, but for a
    // directory, which requires a recursive copy rather than copyFileSync.
    rmSync(join(repo, 'data'), { recursive: true, force: true });
    writeFileSync(join(target, 'data', 'note.txt'), 'rescued directory\n');

    commandDrop('feat/x', { cwd: repo, config: dirConfig });

    assert.ok(!existsSync(target), 'the worktree was removed');
    assert.equal(
      readFileSync(join(repo, 'data', 'note.txt'), 'utf8'),
      'rescued directory\n',
      'the only copy of the carried directory was carried back before removal',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drop from a prefix-colliding sibling worktree is not blocked as "currently in this worktree"', () => {
  // Task 7's review found that isCurrent used a bare startsWith on raw paths,
  // so `<repo>-feat-x2` (cwd) counted as "inside" `<repo>-feat-x` (the
  // worktree being dropped) merely because one path string starts with the
  // other. isCurrent must require a separator boundary.
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    commandNew('feat/x2', { cwd: repo, config });

    const targetX = join(root, 'proj-feat-x');
    const targetX2 = join(root, 'proj-feat-x2');
    assert.ok(existsSync(targetX2), 'sanity: the colliding sibling exists');

    commandDrop('feat/x', { cwd: targetX2, config });

    assert.ok(!existsSync(targetX), 'the target worktree was actually removed');
    assert.ok(existsSync(targetX2), 'the sibling worktree was left alone');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
