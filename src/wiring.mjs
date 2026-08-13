import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function desiredWiring(config) {
  const quote = (part) => `'${part.replaceAll("'", `'\\''`)}'`;
  const forward = (config.runner ?? ['npx', '--yes', 'copse']).map(quote).join(' ');
  const agentContract = `# copse parallel-work contract

- Keep the main worktree on the configured base branch; do feature work in a copse worktree.
- Start feature sessions with \`copse start <prefix>/<lower-kebab> --agent codex|claude\`.
- Run \`copse verify\` before declaring work complete and \`copse land\` to merge.
- Never remove worktrees with raw Git; use \`copse drop\` so carried files are rescued.
`;
  const enterRoot = 'cd "$(git rev-parse --show-toplevel)"';
  const hook = (event) => `#!/bin/sh\n${enterRoot} || exit 1\nexec ${forward} hook ${event} "$@"\n`;
  const agentCommand = (event) => `${enterRoot} && exec ${forward} hook ${event}`;
  const agentHooks = (projectRoot) => JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: agentCommand('agent-session-start'), additionalContextLimit: 2000 }] }],
      PreToolUse: [{ matcher: 'Bash|apply_patch|Edit|Write', hooks: [{ type: 'command', command: agentCommand('agent-pre-tool-use') }] }],
    },
    ...(projectRoot ? { $schema: 'https://json.schemastore.org/claude-code-settings.json' } : {}),
  }, null, 2) + '\n';
  const workflow = `name: copse\n\non:\n  pull_request:\n  push:\n    branches: [${config.baseBranch ?? 'main'}]\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: copse-\${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n      - run: npm install\n      - run: git config core.hooksPath .githooks\n      - run: ${forward} verify\n`;
  const state = JSON.stringify({ version: 1, features: {} }, null, 2) + '\n';
  const files = new Map([
    ['.githooks/pre-commit', hook('pre-commit')],
    ['.githooks/pre-push', hook('pre-push')],
    ['.codex/hooks.json', agentHooks(false)],
    ['.claude/settings.json', agentHooks(true)],
    ['AGENTS.md', agentContract],
    ['CLAUDE.md', agentContract],
    [config.coordinationFile ?? '.copse/features.json', state],
  ]);
  if ((config.verify ?? []).length > 0) files.set('.github/workflows/copse.yml', workflow);
  return files;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.copse-tmp-${process.pid}`;
  writeFileSync(temp, content);
  renameSync(temp, path);
}

function agentSettingsPath(relative) {
  return relative === '.codex/hooks.json' || relative === '.claude/settings.json';
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function includesGroup(groups, wanted) {
  const encoded = JSON.stringify(wanted);
  return Array.isArray(groups) && groups.some((group) => JSON.stringify(group) === encoded);
}

export function wiringMatches(relative, actual, expected) {
  if (relative === '.github/workflows/copse.yml') {
    return actual === expected || (/^\s{2}verify:\s*$/m.test(actual) && /(?:copse|src\/cli\.mjs)[^\n]*\sverify\s*$/m.test(actual));
  }
  if (!agentSettingsPath(relative)) return actual === expected;
  const have = parseJson(actual);
  const want = parseJson(expected);
  if (!have || !want) return false;
  return Object.entries(want.hooks).every(([event, groups]) => groups.every((group) => includesGroup(have.hooks?.[event], group)));
}

function mergedAgentSettings(actual, expected) {
  const have = parseJson(actual);
  const want = parseJson(expected);
  if (!have || !want || typeof have !== 'object' || Array.isArray(have)) return null;
  const merged = { ...have, hooks: { ...(have.hooks ?? {}) } };
  if (!merged.$schema && want.$schema) merged.$schema = want.$schema;
  for (const [event, groups] of Object.entries(want.hooks)) {
    merged.hooks[event] = [...(merged.hooks[event] ?? [])];
    for (const group of groups) if (!includesGroup(merged.hooks[event], group)) merged.hooks[event].push(group);
  }
  return JSON.stringify(merged, null, 2) + '\n';
}

export function reconcileWiring(root, desired, { apply = false } = {}) {
  const report = { missing: [], matching: [], conflicts: [], created: [], updated: [] };
  for (const [relative, content] of desired) {
    const path = join(root, relative);
    if (!existsSync(path)) {
      report.missing.push(relative);
      if (apply) {
        atomicWrite(path, content);
        if (relative.startsWith('.githooks/')) chmodSync(path, 0o755);
        report.created.push(relative);
      }
    } else {
      const actual = readFileSync(path, 'utf8');
      if (wiringMatches(relative, actual, content)) report.matching.push(relative);
      else if (apply && agentSettingsPath(relative)) {
        const merged = mergedAgentSettings(actual, content);
        if (merged) { atomicWrite(path, merged); report.updated.push(relative); }
        else report.conflicts.push(relative);
      } else report.conflicts.push(relative);
    }
  }
  return report;
}
