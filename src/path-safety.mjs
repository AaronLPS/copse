import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Inspect a repository-relative file target without following any existing
 * symlink in its path. Missing suffixes are safe to create because every
 * existing ancestor leading to them has already been checked.
 */
export function repositoryFileState(root, relativePath) {
  const resolvedRoot = realpathSync(root);
  const path = resolve(resolvedRoot, relativePath);
  const fromRoot = relative(resolvedRoot, path);
  if (fromRoot === '' || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return { safe: false, exists: false, path, problem: 'path is outside the repository' };
  }

  const segments = fromRoot.split(sep);
  let current = resolvedRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') return { safe: true, exists: false, path };
      return { safe: false, exists: false, path, problem: error.message };
    }
    if (stat.isSymbolicLink()) {
      return {
        safe: false,
        exists: true,
        path,
        problem: `path passes through symlink ${segments.slice(0, index + 1).join('/')}`,
      };
    }
    const leaf = index === segments.length - 1;
    if (!leaf && !stat.isDirectory()) {
      return {
        safe: false,
        exists: true,
        path,
        problem: `path passes through non-directory ${segments.slice(0, index + 1).join('/')}`,
      };
    }
    if (leaf) {
      return {
        safe: stat.isFile(),
        exists: true,
        path,
        ...(stat.isFile() ? {} : { problem: 'target is not a regular file' }),
      };
    }
  }
  return { safe: false, exists: false, path, problem: 'path has no file target' };
}
