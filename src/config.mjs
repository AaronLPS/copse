/**
 * The project's declaration of facts copse cannot infer.
 *
 * Parsing is separated from reading so every rule below is reachable from a
 * test without a file on disk. The rules are not cosmetic: two of them
 * (a hyphen in a prefix, a `..` in a carried path) protect invariants that
 * fail silently and far from their cause if they are ever violated.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILENAME = 'copse.config.json';

/**
 * Defaults chosen so a repository with no config file still works.
 * `baseBranch` is 'main' because that is what a fresh repository has;
 * projects using a devel/main split declare it.
 */
export const DEFAULTS = Object.freeze({
  baseBranch: 'main',
  branchPrefixes: Object.freeze(['feat', 'fix', 'docs', 'chore']),
  carryFiles: Object.freeze([]),
  carryDirs: Object.freeze([]),
  install: null,
  releaseBranch: null,
  verify: Object.freeze([]),
  agents: Object.freeze({ codex: Object.freeze(['codex']), claude: Object.freeze(['claude']) }),
  coordinationFile: '.copse/features.json',
  runner: Object.freeze(['npx', '--yes', 'copse']),
  leaseTimeoutSeconds: 300,
  leaseHeartbeatSeconds: 30,
  resources: Object.freeze({}),
  coordinationBackend: 'local',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A repo-relative path that cannot escape the repository.
 *
 * Rejects absolute paths, `..` segments, and backslashes — the last because a
 * Windows-style separator would defeat the segment check while still being a
 * traversal on a platform that honours it.
 */
function pathProblem(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${field}: every entry must be a non-empty string`;
  }
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    return `${field}: "${value}" is absolute; entries are relative to the repository root`;
  }
  if (value.includes('\\')) {
    return `${field}: "${value}" contains a backslash; use forward slashes`;
  }
  if (value.split('/').includes('..')) {
    return `${field}: "${value}" points outside the repository`;
  }
  return null;
}

function checkStringArray(raw, field, errors, { check }) {
  if (!Array.isArray(raw)) {
    errors.push(`${field}: must be an array`);
    return null;
  }
  for (const entry of raw) {
    const problem = check(entry, field);
    if (problem) errors.push(problem);
  }
  return raw;
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, config: object } | { ok: false, errors: string[] }}
 */
export function parseConfig(raw) {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [`${CONFIG_FILENAME} must contain a JSON object`] };
  }

  const errors = [];
  const config = {
    baseBranch: DEFAULTS.baseBranch,
    branchPrefixes: [...DEFAULTS.branchPrefixes],
    carryFiles: [],
    carryDirs: [],
    install: null,
    releaseBranch: null,
    verify: [],
    agents: { codex: ['codex'], claude: ['claude'] },
    coordinationFile: DEFAULTS.coordinationFile,
    runner: [...DEFAULTS.runner],
    leaseTimeoutSeconds: DEFAULTS.leaseTimeoutSeconds,
    leaseHeartbeatSeconds: DEFAULTS.leaseHeartbeatSeconds,
    resources: {},
    coordinationBackend: DEFAULTS.coordinationBackend,
  };

  const known = new Set([
    'baseBranch', 'branchPrefixes', 'carryFiles', 'carryDirs', 'install',
    'releaseBranch', 'verify', 'agents', 'coordinationFile', 'runner',
    'leaseTimeoutSeconds', 'leaseHeartbeatSeconds', 'resources', 'coordinationBackend',
  ]);
  for (const key of Object.keys(raw)) {
    // An unknown key is almost always a typo, and a typo that is silently
    // ignored looks exactly like a setting that does not work.
    if (!known.has(key)) errors.push(`unknown key "${key}"`);
  }

  if ('baseBranch' in raw) {
    if (typeof raw.baseBranch !== 'string' || raw.baseBranch.trim() === '') {
      errors.push('baseBranch: must be a non-empty string');
    } else {
      config.baseBranch = raw.baseBranch;
    }
  }

  if ('branchPrefixes' in raw) {
    const list = checkStringArray(raw.branchPrefixes, 'branchPrefixes', errors, {
      check(entry, field) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          return `${field}: every entry must be a non-empty string`;
        }
        if (entry.includes('-')) {
          // slugFor joins prefix and rest with a hyphen; branchForSlug splits
          // at the first one. A hyphen inside a prefix makes that inverse
          // wrong, and the symptom is a worktree nobody can find by name.
          return `${field}: "${entry}" contains a hyphen, which breaks the slug round trip`;
        }
        if (!/^[a-z][a-z0-9]*$/.test(entry)) {
          return `${field}: "${entry}" must be lower-case letters and digits, starting with a letter`;
        }
        return null;
      },
    });
    if (list !== null) {
      if (list.length === 0) errors.push('branchPrefixes: must list at least one prefix');
      else config.branchPrefixes = [...list];
    }
  }

  for (const field of ['carryFiles', 'carryDirs']) {
    if (!(field in raw)) continue;
    const list = checkStringArray(raw[field], field, errors, { check: pathProblem });
    if (list !== null) config[field] = [...list];
  }

  const overlap = config.carryFiles.filter((p) => config.carryDirs.includes(p));
  for (const path of overlap) {
    errors.push(`"${path}" is listed in both carryFiles and carryDirs`);
  }

  if ('install' in raw && raw.install !== null) {
    if (!Array.isArray(raw.install) || raw.install.length === 0) {
      errors.push('install: must be null, or a non-empty array like ["pnpm", "install"]');
    } else if (raw.install.some((part) => typeof part !== 'string' || part === '')) {
      errors.push('install: every element must be a non-empty string');
    } else {
      // An array rather than a string, so the command is never handed to a
      // shell and nothing in it can be interpreted as an operator.
      config.install = [...raw.install];
    }
  }

  if ('releaseBranch' in raw && raw.releaseBranch !== null) {
    if (typeof raw.releaseBranch !== 'string' || raw.releaseBranch.trim() === '') {
      errors.push('releaseBranch: must be null or a non-empty string');
    } else {
      config.releaseBranch = raw.releaseBranch;
    }
  }

  function commandProblem(command, field) {
    if (!Array.isArray(command) || command.length === 0) return `${field}: every command must be a non-empty argv array`;
    if (command.some((part) => typeof part !== 'string' || part === '')) return `${field}: every argv element must be a non-empty string`;
    return null;
  }

  if ('verify' in raw) {
    if (!Array.isArray(raw.verify)) errors.push('verify: must be an array of argv arrays');
    else {
      for (const command of raw.verify) {
        const problem = commandProblem(command, 'verify');
        if (problem) errors.push(problem);
      }
      config.verify = raw.verify.map((command) => Array.isArray(command) ? [...command] : command);
    }
  }

  if ('agents' in raw) {
    if (!isPlainObject(raw.agents)) errors.push('agents: must be an object');
    else {
      const parsedAgents = {};
      for (const [name, command] of Object.entries(raw.agents)) {
        if (!/^[a-z][a-z0-9-]*$/.test(name)) errors.push(`agents: invalid agent name "${name}"`);
        const problem = commandProblem(command, `agents.${name}`);
        if (problem) errors.push(problem);
        else parsedAgents[name] = [...command];
      }
      if (Object.keys(parsedAgents).length === 0) errors.push('agents: must declare at least one agent');
      else config.agents = parsedAgents;
    }
  }

  if ('coordinationFile' in raw) {
    const problem = pathProblem(raw.coordinationFile, 'coordinationFile');
    if (problem) errors.push(problem);
    else config.coordinationFile = raw.coordinationFile;
  }

  if ('runner' in raw) {
    const problem = commandProblem(raw.runner, 'runner');
    if (problem) errors.push(problem);
    else config.runner = [...raw.runner];
  }

  for (const field of ['leaseTimeoutSeconds', 'leaseHeartbeatSeconds']) {
    if (!(field in raw)) continue;
    if (!Number.isInteger(raw[field]) || raw[field] <= 0) {
      errors.push(`${field}: must be a positive integer`);
    } else {
      config[field] = raw[field];
    }
  }
  const comparedTimeout = Number.isInteger(raw.leaseTimeoutSeconds)
    ? raw.leaseTimeoutSeconds
    : config.leaseTimeoutSeconds;
  const comparedHeartbeat = Number.isInteger(raw.leaseHeartbeatSeconds)
    ? raw.leaseHeartbeatSeconds
    : config.leaseHeartbeatSeconds;
  if (comparedHeartbeat >= comparedTimeout) {
    errors.push('leaseHeartbeatSeconds: must be shorter than leaseTimeoutSeconds');
  }

  if ('resources' in raw) {
    if (!isPlainObject(raw.resources)) {
      errors.push('resources: must be an object mapping feature branches to resource-name arrays');
    } else {
      for (const [branch, names] of Object.entries(raw.resources)) {
        if (branch.trim() === '') errors.push('resources: feature branch names must not be empty');
        if (!Array.isArray(names)) {
          errors.push(`resources.${branch}: must be an array`);
          continue;
        }
        for (const name of names) {
          if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]*$/.test(name)) {
            errors.push(`resources.${branch}: invalid resource name "${name}"`);
          }
        }
        config.resources[branch] = [...names];
      }
    }
  }

  if ('coordinationBackend' in raw) {
    if (!['local', 'committed'].includes(raw.coordinationBackend)) {
      errors.push('coordinationBackend: must be "local" or "committed"');
    } else {
      config.coordinationBackend = raw.coordinationBackend;
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, config };
}

/**
 * Reads and parses the config in `dir`. A missing file is not an error —
 * it means the defaults.
 *
 * @param {string} dir
 */
export function loadConfig(dir) {
  let text;
  try {
    text = readFileSync(join(dir, CONFIG_FILENAME), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: true, config: parseConfig({}).config };
    return { ok: false, errors: [`could not read ${CONFIG_FILENAME}: ${error.message}`] };
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, errors: [`${CONFIG_FILENAME} is not valid JSON: ${error.message}`] };
  }

  return parseConfig(raw);
}
