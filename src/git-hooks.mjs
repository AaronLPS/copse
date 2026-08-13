import { isAbsolute, join, resolve } from 'node:path';

export const COPSE_HOOKS_PATH = '.copse/hooks';
export const DEFAULT_HOOKS_SENTINEL = '<default>';

function shellQuote(part) {
  return `'${part.replaceAll("'", "'\\''")}'`;
}

function runnerCommand(config) {
  return (config.runner ?? ['npx', '--yes', 'copse']).map(shellQuote).join(' ');
}

function delegatedHook(event) {
  return `previous=$(git config --local --get copse.previousHooksPath || true)
[ -n "$previous" ] || exit 0
if [ "$previous" = '${COPSE_HOOKS_PATH}' ]; then
  echo 'copse: Git hook delegation cycle points back to ${COPSE_HOOKS_PATH}' >&2
  exit 1
fi
commonDir=$(git rev-parse --git-common-dir) || exit 1
case "$commonDir" in
  /*) ;;
  *) commonDir="$root/$commonDir" ;;
esac
case "$previous" in
  '${DEFAULT_HOOKS_SENTINEL}') delegated="$commonDir/hooks/${event}" ;;
  /*) delegated="$previous/${event}" ;;
  *) delegated="$root/$previous/${event}" ;;
esac
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

export function hookMigration({ currentHooksPath, recordedPrevious, legacyCopse }) {
  if (currentHooksPath === COPSE_HOOKS_PATH) {
    return { previous: recordedPrevious ?? DEFAULT_HOOKS_SENTINEL, changePath: false };
  }
  if (!currentHooksPath || legacyCopse) {
    return { previous: recordedPrevious ?? DEFAULT_HOOKS_SENTINEL, changePath: true };
  }
  return { previous: currentHooksPath, changePath: true };
}

export function resolveDelegatedHook({ previous, event, root, commonDir }) {
  if (!previous) return null;
  if (previous === COPSE_HOOKS_PATH) throw new Error('Git hook delegation cycle points back to .copse/hooks');
  if (previous === DEFAULT_HOOKS_SENTINEL) return join(commonDir, 'hooks', event);
  return join(isAbsolute(previous) ? previous : resolve(root, previous), event);
}
