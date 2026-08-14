import { realpathSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve } from 'node:path';

export const COPSE_HOOKS_PATH = '.copse/hooks';
export const DEFAULT_HOOKS_SENTINEL = '<default>';

function shellQuote(part) {
  return `'${part.replaceAll("'", "'\\''")}'`;
}

function runnerCommand(config) {
  return (config.runner ?? ['npx', '--yes', '@aaronlps/copse']).map(shellQuote).join(' ');
}

function canonicalDirectory(path) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function hooksPathPointsToCopse({ hooksPath, root = null }) {
  if (!hooksPath) return false;
  if (!root) return !isAbsolute(hooksPath) && normalize(hooksPath) === COPSE_HOOKS_PATH;
  const candidate = isAbsolute(hooksPath) ? hooksPath : resolve(root, hooksPath);
  return canonicalDirectory(candidate) === canonicalDirectory(resolve(root, COPSE_HOOKS_PATH));
}

function delegatedHook(event) {
  return `previous=$(git config --local --get copse.previousHooksPath || true)
[ -n "$previous" ] || exit 0
commonDir=$(git rev-parse --git-common-dir) || exit 1
case "$commonDir" in
  /*) ;;
  *) commonDir="$root/$commonDir" ;;
esac
case "$previous" in
  '${DEFAULT_HOOKS_SENTINEL}') delegatedDir="$commonDir/hooks" ;;
  /*) delegatedDir="$previous" ;;
  *) delegatedDir="$root/$previous" ;;
esac
copsePhysical=$(CDPATH= cd -P "$root/${COPSE_HOOKS_PATH}" 2>/dev/null && pwd -P)
delegatedPhysical=$(CDPATH= cd -P "$delegatedDir" 2>/dev/null && pwd -P)
if [ -n "$copsePhysical" ] && [ "$delegatedPhysical" = "$copsePhysical" ]; then
  echo 'copse: Git hook delegation cycle points back to ${COPSE_HOOKS_PATH}' >&2
  exit 1
fi
delegated="$delegatedDir/${event}"
[ -x "$delegated" ] || exit 0
`;
}

function desiredPreCommit(config) {
  return `#!/bin/sh
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root" || exit 1
${runnerCommand(config)} hook pre-commit "$@" || exit $?
${delegatedHook('pre-commit')}"$delegated" "$@"
status=$?
exit "$status"
`;
}

function desiredPrePush(config) {
  return `#!/bin/sh
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root" || exit 1
input=$(mktemp "${'${TMPDIR:-/tmp}'}/copse-pre-push.XXXXXX") || exit 1
trap 'rm -f "$input"' EXIT HUP INT TERM
cat > "$input" || exit 1
${runnerCommand(config)} hook pre-push "$@" < "$input" || exit $?
${delegatedHook('pre-push')}"$delegated" "$@" < "$input"
status=$?
exit "$status"
`;
}

export function desiredGitHooks(config) {
  return new Map([
    [`${COPSE_HOOKS_PATH}/pre-commit`, desiredPreCommit(config)],
    [`${COPSE_HOOKS_PATH}/pre-push`, desiredPrePush(config)],
  ]);
}

export function legacyGitHooks(config) {
  const forward = runnerCommand(config);
  const enterRoot = 'cd "$(git rev-parse --show-toplevel)"';
  const hook = (event) => `#!/bin/sh\n${enterRoot} || exit 1\nexec ${forward} hook ${event} "$@"\n`;
  return new Map([
    ['.githooks/pre-commit', hook('pre-commit')],
    ['.githooks/pre-push', hook('pre-push')],
  ]);
}

export function hookMigration({ currentHooksPath, recordedPrevious, legacyCopse, root = null }) {
  const previous = recordedPrevious && !hooksPathPointsToCopse({ hooksPath: recordedPrevious, root })
    ? recordedPrevious
    : DEFAULT_HOOKS_SENTINEL;
  if (hooksPathPointsToCopse({ hooksPath: currentHooksPath, root })) {
    return { previous, changePath: false };
  }
  if (!currentHooksPath || legacyCopse) {
    return { previous, changePath: true };
  }
  return { previous: currentHooksPath, changePath: true };
}

export function resolveDelegatedHook({ previous, event, root, commonDir }) {
  if (!previous) return null;
  if (hooksPathPointsToCopse({ hooksPath: previous, root })) {
    throw new Error('Git hook delegation cycle points back to .copse/hooks');
  }
  if (previous === DEFAULT_HOOKS_SENTINEL) return join(commonDir, 'hooks', event);
  return join(isAbsolute(previous) ? previous : resolve(root, previous), event);
}
