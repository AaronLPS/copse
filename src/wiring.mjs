import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { repositoryFileState } from './path-safety.mjs';

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
  return commands.map((argv) => `      - run: ${JSON.stringify(shellCommand(argv))}\n`).join('');
}

export function desiredWiring(config) {
  const quote = (part) => `'${part.replaceAll("'", `'\\''`)}'`;
  const forward = (config.runner ?? ['npx', '--yes', '@aaronlps/copse']).map(quote).join(' ');
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
  const workflow = `name: copse\n\non:\n  pull_request:\n  push:\n    branches: [${config.baseBranch ?? 'main'}]\n\npermissions:\n  contents: read\n\nconcurrency:\n  group: copse-\${{ github.workflow }}-\${{ github.ref }}\n  cancel-in-progress: true\n\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 20\n${ciSetupLines(config)}      - run: ${JSON.stringify('git config core.hooksPath .copse/hooks')}\n      - run: ${JSON.stringify(`${forward} verify`)}\n`;
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

export function gitHookFileState(root, relative) {
  return repositoryFileState(root, relative);
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function includesGroup(groups, wanted) {
  const encoded = JSON.stringify(wanted);
  return Array.isArray(groups) && groups.some((group) => JSON.stringify(group) === encoded);
}

function runCommand(line) {
  const scalar = line.match(/^\s*- run: (.+)$/)?.[1];
  if (!scalar) return null;
  try { return JSON.parse(scalar); } catch { return scalar; }
}

function structuralYamlLines(text) {
  const lines = [];
  let blockIndent = null;
  for (const line of text.split('\n')) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const indent = line.match(/^\s*/)[0].length;
    if (blockIndent !== null) {
      if (indent > blockIndent) continue;
      blockIndent = null;
    }
    lines.push({ indent, line });
    if (/^\s*-\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/.test(line)
        || /:\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/.test(line)) {
      blockIndent = indent;
    }
  }
  return lines;
}

function mappingKey(line) {
  return line.match(/^\s*([^\s:#][^:]*)\s*:\s*(?:#.*)?$/)?.[1] ?? null;
}

function workflowJobCommands(text, wantedJob) {
  const lines = structuralYamlLines(text);
  const jobsIndex = lines.findIndex(({ indent, line }) => indent === 0 && mappingKey(line) === 'jobs');
  if (jobsIndex === -1) return [];
  let jobIndent = null;
  let jobStart = -1;
  for (let index = jobsIndex + 1; index < lines.length; index += 1) {
    const { indent, line } = lines[index];
    if (indent === 0) break;
    if (jobIndent === null) jobIndent = indent;
    if (indent === jobIndent && mappingKey(line) === wantedJob) {
      jobStart = index + 1;
      break;
    }
  }
  if (jobStart === -1) return [];

  let propertyIndent = null;
  let stepsStart = -1;
  for (let index = jobStart; index < lines.length; index += 1) {
    const { indent, line } = lines[index];
    if (indent <= jobIndent) break;
    if (propertyIndent === null) propertyIndent = indent;
    if (indent === propertyIndent && mappingKey(line) === 'steps') {
      stepsStart = index + 1;
      break;
    }
  }
  if (stepsStart === -1) return [];

  const commands = [];
  let stepIndent = null;
  for (let index = stepsStart; index < lines.length; index += 1) {
    const { indent, line } = lines[index];
    if (indent <= propertyIndent) break;
    if (stepIndent === null) stepIndent = indent;
    if (indent === stepIndent) {
      const command = runCommand(line);
      if (command !== null) commands.push(command);
    }
  }
  return commands;
}

export function wiringMatches(relative, actual, expected) {
  if (relative === '.github/workflows/copse.yml') {
    const expectedVerify = workflowJobCommands(expected, 'verify').at(-1);
    return actual === expected || (expectedVerify !== undefined
      && workflowJobCommands(actual, 'verify').includes(expectedVerify));
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

function hasStaleAgentGroups(actual, previous, expected) {
  const have = parseJson(actual);
  const old = parseJson(previous);
  const want = parseJson(expected);
  if (!have || !old || !want) return false;
  return Object.entries(old.hooks ?? {}).some(([event, groups]) => {
    const wanted = new Set((want.hooks?.[event] ?? []).map((group) => JSON.stringify(group)));
    const present = new Set((have.hooks?.[event] ?? []).map((group) => JSON.stringify(group)));
    return groups.some((group) => {
      const encoded = JSON.stringify(group);
      return !wanted.has(encoded) && present.has(encoded);
    });
  });
}

function replacedAgentSettings(actual, previous, expected) {
  const have = parseJson(actual);
  const old = parseJson(previous);
  const want = parseJson(expected);
  if (!have || !old || !want || typeof have !== 'object' || Array.isArray(have)) return null;
  const merged = { ...have, hooks: { ...(have.hooks ?? {}) } };
  if (!merged.$schema && want.$schema) merged.$schema = want.$schema;
  const events = new Set([...Object.keys(old.hooks ?? {}), ...Object.keys(want.hooks ?? {})]);
  for (const event of events) {
    const oldGroups = new Set((old.hooks?.[event] ?? []).map((group) => JSON.stringify(group)));
    const wantedGroups = new Set((want.hooks?.[event] ?? []).map((group) => JSON.stringify(group)));
    const seenWanted = new Set();
    merged.hooks[event] = (merged.hooks[event] ?? []).filter((group) => {
      const encoded = JSON.stringify(group);
      if (oldGroups.has(encoded) && !wantedGroups.has(encoded)) return false;
      if (!wantedGroups.has(encoded)) return true;
      if (seenWanted.has(encoded)) return false;
      seenWanted.add(encoded);
      return true;
    });
    for (const group of want.hooks?.[event] ?? []) {
      const encoded = JSON.stringify(group);
      if (!seenWanted.has(encoded)) {
        merged.hooks[event].push(group);
        seenWanted.add(encoded);
      }
    }
  }
  return JSON.stringify(merged, null, 2) + '\n';
}

export function reconcileWiring(root, desired, { apply = false, previousDesired = null } = {}) {
  const report = { missing: [], matching: [], conflicts: [], created: [], updated: [] };
  for (const [relative, content] of desired) {
    const path = join(root, relative);
    const fileState = gitHookFileState(root, relative);
    if (!fileState.safe) {
      report.conflicts.push(relative);
      continue;
    }
    const pathExists = fileState.exists;
    if (!pathExists) {
      report.missing.push(relative);
      if (apply) {
        atomicWrite(path, content);
        if (relative.startsWith('.copse/hooks/')) chmodSync(path, 0o755);
        report.created.push(relative);
      }
    } else {
      const actual = readFileSync(path, 'utf8');
      const previous = previousDesired?.get(relative);
      if (agentSettingsPath(relative) && previous !== undefined
          && hasStaleAgentGroups(actual, previous, content)) {
        if (apply) {
          const merged = replacedAgentSettings(actual, previous, content);
          if (merged) { atomicWrite(path, merged); report.updated.push(relative); }
          else report.conflicts.push(relative);
        } else report.conflicts.push(relative);
        continue;
      }
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
