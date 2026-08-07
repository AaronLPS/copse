/**
 * The mapping between a branch, its worktree's directory name, and back.
 *
 * Pure, and taking the prefix set as a parameter rather than owning it: this
 * module is the reason copse is extractable at all, and a module-level
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
