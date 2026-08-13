import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export function detectCiMode(root) {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'package-lock.json')) || existsSync(join(root, 'package.json'))) return 'npm';
  return 'none';
}

function shellCommand(argv) {
  return argv.map((part) => /^[a-zA-Z0-9_./:@=-]+$/.test(part)
    ? part
    : `'${part.replaceAll("'", `'\\''`)}'`).join(' ');
}

function ciSetupLines(config) {
  const mode = config.ciMode ?? 'npm';
  const commands = mode === 'npm'
    ? [['npm', 'install']]
    : mode === 'pnpm'
      ? [['corepack', 'enable'], ['pnpm', 'install', '--frozen-lockfile']]
      : mode === 'yarn'
        ? [['corepack', 'enable'], ['yarn', 'install', '--immutable']]
        : mode === 'custom'
          ? (config.ciSetup ?? [])
          : [];
  return commands.map((argv) => `      - run: ${shellCommand(argv)}\n`).join('');
}

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
  const agentCommand = (event) => `${enterRoot} && exec ${forward} hook ${event} --protocol 1`;
  const agentHooks = (projectRoot) => JSON.stringify({
    hooks: {
      SessionStart: [{ matcher: 'startup|resume|clear|compact', hooks: [{ type: 'command', command: agentCommand('agent-session-start'), additionalContextLimit: 2000 }] }],
      PreToolUse: [{ matcher: 'Bash|apply_patch|Edit|Write', hooks: [{ type: 'command', command: agentCommand('agent-pre-tool-use') }] }],
    },
    ...(projectRoot ? { $schema: 'https://json.schemastore.org/claude-code-settings.json' } : {}),
  }, null, 2) + '\n';
  const workflow = `name: copse\n\non:\n  pull_request:\n  push:\n    branches: [${config.baseBranch ?? 'main'}]\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: copse-\${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n${ciSetupLines(config)}      - run: git config core.hooksPath .copse/hooks\n      - run: ${forward} verify\n`;
  const state = JSON.stringify({ version: 1, features: {} }, null, 2) + '\n';
  const files = new Map([
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

function gitHookPath(relative) { return relative.startsWith('.copse/hooks/'); }

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function includesGroup(groups, wanted) {
  const encoded = JSON.stringify(wanted);
  return Array.isArray(groups) && groups.some((group) => JSON.stringify(group) === encoded);
}

export function wiringMatches(relative, actual, expected) {
  if (relative === '.github/workflows/copse.yml') {
    const runner = expected.match(/^\s*- run: (.+) verify\s*$/m)?.[1];
    const escapedRunner = runner?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return actual === expected || (escapedRunner !== undefined
      && new RegExp(`^\\s*- run: ${escapedRunner} verify\\s*$`, 'm').test(actual));
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

function replacedAgentSettings(actual, previous, expected) {
  const have = parseJson(actual);
  const old = parseJson(previous);
  const want = parseJson(expected);
  if (!have || !old || !want || typeof have !== 'object' || Array.isArray(have)) return null;
  const merged = { ...have, hooks: { ...(have.hooks ?? {}) } };
  if (!merged.$schema && want.$schema) merged.$schema = want.$schema;
  for (const [event, groups] of Object.entries(old.hooks ?? {})) {
    const encoded = new Set(groups.map((group) => JSON.stringify(group)));
    merged.hooks[event] = (merged.hooks[event] ?? []).filter((group) => !encoded.has(JSON.stringify(group)));
  }
  for (const [event, groups] of Object.entries(want.hooks ?? {})) {
    merged.hooks[event] = [...(merged.hooks[event] ?? [])];
    for (const group of groups) if (!includesGroup(merged.hooks[event], group)) merged.hooks[event].push(group);
  }
  return JSON.stringify(merged, null, 2) + '\n';
}

export function reconcileWiring(root, desired, { apply = false, previousDesired = null } = {}) {
  const report = { missing: [], matching: [], conflicts: [], created: [], updated: [] };
  for (const [relative, content] of desired) {
    const path = join(root, relative);
    if (!existsSync(path)) {
      report.missing.push(relative);
      if (apply) {
        atomicWrite(path, content);
        if (relative.startsWith('.copse/hooks/')) chmodSync(path, 0o755);
        report.created.push(relative);
      }
    } else {
      const actual = readFileSync(path, 'utf8');
      const previous = previousDesired?.get(relative);
      if (wiringMatches(relative, actual, content)) {
        if (gitHookPath(relative) && !executable(path)) {
          if (apply) {
            chmodSync(path, 0o755);
            report.updated.push(relative);
          } else report.conflicts.push(relative);
        } else report.matching.push(relative);
      }
      else if (apply && previous === actual) {
        atomicWrite(path, content);
        if (relative.startsWith('.copse/hooks/')) chmodSync(path, 0o755);
        report.updated.push(relative);
      }
      else if (apply && agentSettingsPath(relative)) {
        const merged = previous === undefined
          ? mergedAgentSettings(actual, content)
          : replacedAgentSettings(actual, previous, content);
        if (merged) { atomicWrite(path, merged); report.updated.push(relative); }
        else report.conflicts.push(relative);
      } else report.conflicts.push(relative);
    }
  }
  return report;
}
