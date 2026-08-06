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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../src/config.mjs';
import { commandDoctor } from '../src/commands/doctor.mjs';
import { commandDrop } from '../src/commands/drop.mjs';
import { commandList } from '../src/commands/list.mjs';
import { commandNew, GroveError } from '../src/commands/new.mjs';
import { driftNote } from '../src/decisions.mjs';
import { worktrees } from '../src/git.mjs';

/**
 * commandList/commandDoctor print to stdout as part of their contract; that
 * is fine in real use, but it is noise in test output that could obscure a
 * real failure. Silence it around the call rather than changing the
 * commands themselves.
 */
function withSilencedStdout(fn) {
  const original = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = original;
  }
}

// A machine with a global `commit.gpgsign=true` or `core.hooksPath` set
// would otherwise leak into every git command this suite runs — `git commit`
// stopping to ask for a signing key, or a hook firing that this repository
// never declared. Pointing GIT_CONFIG_GLOBAL/SYSTEM at /dev/null makes the
// suite see only what makeRepo() sets up, regardless of the host's config.
// Set on process.env (not just run()'s spawn options) because commandNew
// and commandDrop shell out to git internally via src/git.mjs, which
// inherits process.env rather than taking an env override.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_SYSTEM = '/dev/null';

const config = parseConfig({
  baseBranch: 'devel',
  carryFiles: ['.env.test'],
  install: null,
}).config;

function run(cmd, args, cwd) {
  execFileSync(cmd, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
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

test('new refuses a branch whose directory already exists', () => {
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    assert.throws(
      () => commandNew('feat/x', { cwd: repo, config }),
      /already exists/,
      'this hits the existsSync(target) check first, not the "already checked out" one',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new refuses a branch already checked out, even with its directory gone', () => {
  // The previous test's assertion only checked the error's *type*
  // (GroveError), which both refusals throw, so it passed while actually
  // exercising the existsSync(target) check — the worktrees().find(...)
  // refusal was never reached. Removing the directory but leaving the
  // branch's worktree registration in git (worktree list still reports it,
  // "prunable", until pruned) reaches the intended check.
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    rmSync(join(root, 'proj-feat-x'), { recursive: true, force: true });

    assert.throws(
      () => commandNew('feat/x', { cwd: repo, config }),
      /already checked out/,
    );
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

test('doctor finds a carryFiles entry that does not exist in the repo, and names it', () => {
  const missingConfig = parseConfig({
    baseBranch: 'devel',
    carryFiles: ['.env.test', '.env.absent'],
    install: null,
  }).config;

  const { root, repo } = makeRepo();
  try {
    const result = withSilencedStdout(() => commandDoctor({ cwd: repo, config: missingConfig }));
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.includes('.env.absent')),
      'the finding names the missing file',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor reports ok when every declared carry path exists and nothing has drifted', () => {
  const { root, repo } = makeRepo();
  try {
    const result = withSilencedStdout(() => commandDoctor({ cwd: repo, config }));
    assert.equal(result.ok, true);
    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('doctor names a carryFiles entry that is a symlink, distinct from one that is simply missing', () => {
  // existsSync follows symlinks, so a dangling one used to read as "not in
  // <repoDir>" — the same finding as a path that was never carried at all —
  // hiding the reason `new`/`drop` actually refuse it. carryPathState
  // (lstat) must report the symlink as what it is.
  const { root, repo } = makeRepo();
  try {
    const outside = join(root, 'outside-target');
    writeFileSync(outside, 'PAYLOAD\n');
    rmSync(join(repo, '.env.test'));
    symlinkSync(outside, join(repo, '.env.test'));

    const result = withSilencedStdout(() => commandDoctor({ cwd: repo, config }));
    assert.equal(result.ok, false);
    assert.ok(
      result.findings.some((f) => f.includes('.env.test') && /symlink/.test(f)),
      'the finding names the path as a symlink, not merely "not in <repoDir>"',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('list counts a misnamed worktree directory as one drift', () => {
  // pullRequestFor shells out to `gh` for each worktree; origin here is a
  // local bare repo path, not a GitHub remote, so `gh pr list` fails fast
  // (no network round trip) and pullRequestFor reports undefined either way
  // — this stays hermetic whether or not `gh` is installed on the host.
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    const target = join(root, 'proj-feat-x');
    const misnamed = join(root, 'proj-not-the-derived-name');

    // git worktree move keeps git's own bookkeeping consistent while
    // producing a directory name that no longer matches directoryFor's
    // expectation — the drift driftNote/commandList exist to catch.
    run('git', ['worktree', 'move', target, misnamed], repo);

    const drifted = withSilencedStdout(() => commandList({ cwd: repo, config }));
    assert.equal(drifted, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('list reports zero drift when every directory matches its branch', () => {
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    const drifted = withSilencedStdout(() => commandList({ cwd: repo, config }));
    assert.equal(drifted, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new refuses to copy through a symlinked carry path, and says why', () => {
  // existsSync follows symlinks, so a dangling one at the repo-side carried
  // path used to read as "not present" — rescued as if absent, and
  // copyFileSync/cpSync would then write or read through the link. The
  // worktree new already created must survive the refusal (see the "grove
  // drop" naming below), rather than being silently left half-provisioned.
  const { root, repo } = makeRepo();
  try {
    const outside = join(root, 'outside-target');
    writeFileSync(outside, 'PAYLOAD\n');
    rmSync(join(repo, '.env.test'));
    symlinkSync(outside, join(repo, '.env.test'));

    assert.throws(
      () => commandNew('feat/x', { cwd: repo, config }),
      (error) => /\.env\.test/.test(error.message) && /symlink/.test(error.message) && /grove drop feat\/x/.test(error.message),
    );

    const target = join(root, 'proj-feat-x');
    assert.ok(existsSync(target), 'worktree add already ran; the half-built worktree is left in place');
    assert.ok(!existsSync(join(target, '.env.test')), 'the symlink was never followed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drop refuses to rescue through a symlinked carry path in the repo, and leaves everything in place', () => {
  // The concrete exploit this guards: a dangling symlink at the repo-side
  // carried path reads as "the repo does not hold this file" under
  // existsSync, so the file looks rescuable, and copyFileSync writes
  // through the link to whatever it points at — even outside the repo.
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config });
    const target = join(root, 'proj-feat-x');

    const outside = join(root, 'outside-victim');
    writeFileSync(outside, 'original\n');
    rmSync(join(repo, '.env.test'));
    symlinkSync(outside, join(repo, '.env.test'));
    writeFileSync(join(target, '.env.test'), 'PAYLOAD\n');

    assert.throws(
      () => commandDrop('feat/x', { cwd: repo, config }),
      (error) => /\.env\.test/.test(error.message) && /symlink/.test(error.message),
    );

    assert.equal(readFileSync(outside, 'utf8'), 'original\n', 'nothing was written through the symlink');
    assert.ok(existsSync(target), 'the worktree survived the refusal — nothing was lost');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const nestedConfig = parseConfig({
  baseBranch: 'devel',
  carryFiles: ['cfg/.env.test'],
  install: null,
}).config;

const nestedDirConfig = parseConfig({
  baseBranch: 'devel',
  carryDirs: ['data/cache'],
  install: null,
}).config;

test('new refuses to copy through a symlinked intermediate directory (source side)', () => {
  // The gap carryPathState leaves on purpose: it lstats only the carried
  // path's final component. lstat on `cfg/.env.test` resolves `cfg` (the
  // intermediate) transparently, so a `cfg -> outside` symlink makes the
  // read land on whatever `outside/.env.test` is — reported as "present" or
  // "missing" as if `cfg` were an ordinary directory, never as a symlink.
  const { root, repo } = makeRepo();
  try {
    const outside = join(root, 'outside-source-dir');
    mkdirSync(outside);
    writeFileSync(join(outside, '.env.test'), 'PAYLOAD\n');
    symlinkSync(outside, join(repo, 'cfg'));

    assert.throws(
      () => commandNew('feat/x', { cwd: repo, config: nestedConfig }),
      (error) =>
        error instanceof GroveError &&
        /cfg\/\.env\.test/.test(error.message) &&
        /"cfg"/.test(error.message) &&
        /resolves outside/.test(error.message),
    );

    const target = join(root, 'proj-feat-x');
    assert.ok(existsSync(target), 'the half-built worktree from worktree add is left in place');
    assert.ok(
      !existsSync(join(target, 'cfg', '.env.test')),
      'nothing was written through the symlinked intermediate directory',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new refuses to write through a symlink already checked out at the destination carry path', () => {
  // The destination side of the carry that commandNew never checked at all:
  // a symlink can be committed on the branch itself at the carried path, so
  // it is already sitting at the destination the instant `git worktree add`
  // finishes — before grove's own copy step ever runs. Source and
  // destination are made to diverge on purpose: the commit (what the new
  // worktree checks out from origin/devel) holds the symlink, while the
  // repo's own working copy — grove's copy *source* — is a real file, so
  // this exercises the destination check specifically rather than the
  // source-side one already covered above.
  const { root, repo } = makeRepo();
  try {
    const outsideVictim = join(root, 'outside-victim');
    writeFileSync(outsideVictim, 'original\n');

    mkdirSync(join(repo, 'cfg'));
    symlinkSync(outsideVictim, join(repo, 'cfg', '.env.test'));
    // .gitignore has a bare `.env.test`, which git matches at any depth —
    // `git add -A` alone would skip this nested one as ignored. `-f` forces
    // it in, deliberately: the point of this test is a symlink git *did*
    // commit at the carried path, ignore rules notwithstanding.
    run('git', ['add', '-f', 'cfg/.env.test'], repo);
    run('git', ['commit', '-m', 'commit a symlink at the carried path'], repo);
    run('git', ['push', 'origin', 'devel'], repo);

    // The repo's local working copy now diverges from what devel actually
    // holds: a real file sits where the commit — and so the freshly
    // checked-out worktree — has a symlink.
    rmSync(join(repo, 'cfg', '.env.test'));
    writeFileSync(join(repo, 'cfg', '.env.test'), 'PAYLOAD\n');

    assert.throws(
      () => commandNew('feat/x', { cwd: repo, config: nestedConfig }),
      (error) =>
        error instanceof GroveError &&
        /cfg\/\.env\.test/.test(error.message) &&
        /symlink already checked out/.test(error.message),
    );

    assert.equal(
      readFileSync(outsideVictim, 'utf8'),
      'original\n',
      'nothing was written through the destination symlink',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new refuses to copy through a symlinked intermediate directory — carryDirs variant', () => {
  // carryDirs entry is 'data/cache'; the symlink sits at 'data' — one level
  // above the carried directory itself — so this exercises the intermediate
  // ancestor check, not the leaf check (a symlinked 'data/cache' itself
  // would just be an ordinary leaf-symlink refusal, already covered).
  const { root, repo } = makeRepo();
  try {
    const outside = join(root, 'outside-data-dir');
    mkdirSync(outside);
    mkdirSync(join(outside, 'cache'));
    writeFileSync(join(outside, 'cache', 'note.txt'), 'PAYLOAD\n');
    symlinkSync(outside, join(repo, 'data'));

    assert.throws(
      () => commandNew('feat/x', { cwd: repo, config: nestedDirConfig }),
      (error) =>
        error instanceof GroveError &&
        /data\/cache/.test(error.message) &&
        /"data"/.test(error.message) &&
        /resolves outside/.test(error.message),
    );

    const target = join(root, 'proj-feat-x');
    assert.ok(
      !existsSync(join(target, 'data', 'cache', 'note.txt')),
      'nothing was written through the symlinked carryDirs entry',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drop refuses to rescue through a symlinked intermediate directory in the repo', () => {
  // The exact transcript this closes: repo/cfg is a symlink to somewhere
  // outside the repo; the worktree holds a real cfg/.env.test. lstat on the
  // repo-side carried path resolves through the symlinked `cfg` and reports
  // "missing" (nothing at outside/.env.test), so the old code treated the
  // file as rescuable and copyFileSync wrote it straight through the link.
  const { root, repo } = makeRepo();
  try {
    commandNew('feat/x', { cwd: repo, config: nestedConfig });
    const target = join(root, 'proj-feat-x');

    const outside = join(root, 'outside-rescue-dir');
    mkdirSync(outside);
    rmSync(join(repo, 'cfg'), { recursive: true, force: true });
    symlinkSync(outside, join(repo, 'cfg'));
    mkdirSync(join(target, 'cfg'), { recursive: true });
    writeFileSync(join(target, 'cfg', '.env.test'), 'PAYLOAD\n');

    assert.throws(
      () => commandDrop('feat/x', { cwd: repo, config: nestedConfig }),
      (error) => /cfg\/\.env\.test/.test(error.message) && /resolves outside/.test(error.message),
    );

    assert.ok(!existsSync(join(outside, '.env.test')), 'nothing was written through the symlink');
    assert.ok(existsSync(target), 'the worktree survived the refusal — nothing was lost');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo-side symlinked intermediate directory that new refused to copy through does not deadlock drop', () => {
  // Mirrors the leaf-symlink deadlock regression test below, for the
  // intermediate-directory case: `new` refuses to copy through repo/cfg (a
  // symlink), so the worktree never gets a cfg/.env.test to rescue. `drop`
  // must still succeed — refusing because the same symlink is visible from
  // drop's side too would deadlock the two commands against each other.
  const { root, repo } = makeRepo();
  try {
    const outside = join(root, 'outside-deadlock-dir');
    mkdirSync(outside);
    writeFileSync(join(outside, '.env.test'), 'PAYLOAD\n');
    symlinkSync(outside, join(repo, 'cfg'));

    assert.throws(
      () => commandNew('feat/x', { cwd: repo, config: nestedConfig }),
      (error) => /cfg\/\.env\.test/.test(error.message) && /resolves outside/.test(error.message),
    );

    const target = join(root, 'proj-feat-x');
    assert.ok(existsSync(target), 'the half-built worktree from worktree add is left in place');
    assert.ok(!existsSync(join(target, 'cfg')), 'the copy never happened — nothing to rescue');

    // Before the containment fix mirrored the deadlock fix, this refused too.
    commandDrop('feat/x', { cwd: repo, config: nestedConfig });

    assert.ok(!existsSync(target), 'drop succeeded — the worktree was removed');
    assert.equal(
      readFileSync(join(outside, '.env.test'), 'utf8'),
      'PAYLOAD\n',
      'the symlink target was never touched',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo-side symlinked carry path that new refused to copy does not deadlock drop', () => {
  // The regression this guards: `new`'s refusal to copy through a repo-side
  // symlink left the worktree without a copy of the carried path at all —
  // so rescuableFiles' rescue set is empty for it — yet `drop`'s old,
  // unconditional refusal fired anyway (it saw the same repo-side symlink
  // and refused regardless of whether the worktree held anything to
  // rescue). That deadlocked `new` and `drop` against each other with no
  // way out except `git worktree remove` by hand. A repository that
  // legitimately symlinks a carried path (e.g. `.env` into a shared
  // secrets directory) must still be able to `grove drop` its worktrees.
  const { root, repo } = makeRepo();
  try {
    const outside = join(root, 'outside-target');
    writeFileSync(outside, 'PAYLOAD\n');
    rmSync(join(repo, '.env.test'));
    symlinkSync(outside, join(repo, '.env.test'));

    assert.throws(
      () => commandNew('feat/x', { cwd: repo, config }),
      (error) => /\.env\.test/.test(error.message) && /symlink/.test(error.message),
    );

    const target = join(root, 'proj-feat-x');
    assert.ok(existsSync(target), 'the half-built worktree from worktree add is left in place');
    assert.ok(!existsSync(join(target, '.env.test')), 'the copy never happened — nothing to rescue');

    // The deadlock: before the fix, this second call refused too, with no
    // way to remove the worktree short of `git worktree remove` by hand.
    commandDrop('feat/x', { cwd: repo, config });

    assert.ok(!existsSync(target), 'drop succeeded — the worktree was removed');
    assert.equal(readFileSync(outside, 'utf8'), 'PAYLOAD\n', 'the symlink target was never touched');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A bare main repository, with an ordinary worktree already attached — the
 * "clone --bare, then `git worktree add` onto it" layout the bug report
 * names as popular with this tool's audience. `git worktree list
 * --porcelain` reports the bare repository itself as the main worktree,
 * with a `bare` line instead of a `branch`/`detached` one.
 */
function makeBareRepo() {
  const root = mkdtempSync(join(tmpdir(), 'grove-bare-'));
  const seed = join(root, 'seed');

  run('git', ['init', '-b', 'devel', seed], root);
  run('git', ['config', 'user.email', 'test@example.com'], seed);
  run('git', ['config', 'user.name', 'Test'], seed);
  writeFileSync(join(seed, 'README.md'), '# proj\n');
  run('git', ['add', '-A'], seed);
  run('git', ['commit', '-m', 'first'], seed);

  const bareDir = join(root, 'proj.git');
  run('git', ['clone', '--bare', seed, bareDir], root);
  const workDir = join(root, 'proj-work');
  run('git', ['worktree', 'add', workDir, 'devel'], bareDir);
  rmSync(seed, { recursive: true, force: true });

  return { root, bareDir, workDir };
}

test('worktrees() reports a bare main repository as bare, not as branch: null', () => {
  const { root, bareDir } = makeBareRepo();
  try {
    const entries = worktrees({ cwd: bareDir });
    const main = entries.find((entry) => entry.isMain);
    assert.equal(main.bare, true);
    assert.equal(main.path, bareDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('driftNote does not report a real bare main repository as permanent drift', () => {
  // The attached worktree in this layout is on 'devel' — the base branch,
  // not a feat/fix/docs/chore-shaped name — so it drifts in its own right
  // (no recognised prefix) regardless of this fix; that is real and
  // unrelated to the bare-repository bug, so it is not asserted on here.
  // What this guards is specifically the main entry, which used to read
  // "should be on devel" forever because entry.branch was null and null is
  // never equal to config.baseBranch.
  const { root, bareDir } = makeBareRepo();
  try {
    const entries = worktrees({ cwd: bareDir });
    const main = entries.find((entry) => entry.isMain);
    assert.equal(driftNote(main, config, { repoDir: bareDir }), null);

    // commandList must still run cleanly end to end against this layout —
    // print 'null' as a branch name being one of the concrete symptoms
    // named in the bug report.
    withSilencedStdout(() => commandList({ cwd: bareDir, config }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('new refuses against a bare main repository rather than deriving a broken directory name', () => {
  const { root, bareDir } = makeBareRepo();
  try {
    assert.throws(
      () => commandNew('feat/x', { cwd: bareDir, config }),
      (error) => error instanceof GroveError && /bare/.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
