import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { coordinationStatePath, featureBlockers, loadCoordination } from '../coordination.mjs';
import { git, mainWorktree, worktrees } from '../git.mjs';
import { agentHookOutput, gitHookDecision } from '../hooks.mjs';

function currentEntry(cwd) {
  const resolved = resolve(cwd);
  return worktrees({ cwd }).find((entry) => resolved === resolve(entry.path) || resolved.startsWith(resolve(entry.path) + sep));
}

export function commandHook(event, { cwd = process.cwd(), config, inputText } = {}) {
  if (event === 'pre-commit' || event === 'pre-push') {
    const branch = git(['branch', '--show-current'], { cwd });
    const updates = event === 'pre-push' ? (inputText ?? readFileSync(0, 'utf8')).split('\n').filter(Boolean) : [];
    const decision = gitHookDecision(event, { branch, config, updates });
    if (!decision.ok) throw new Error(decision.reason);
    return {};
  }
  const input = JSON.parse(inputText ?? readFileSync(0, 'utf8'));
  if (!input.hook_event_name && !input.hookEventName && !input.event) {
    input.hook_event_name = event === 'agent-session-start' ? 'SessionStart' : 'PreToolUse';
  }
  const entry = currentEntry(input.cwd ?? cwd);
  const main = mainWorktree({ cwd: input.cwd ?? cwd });
  const branch = entry?.branch ?? null;
  const coordination = loadCoordination(coordinationStatePath({ cwd: input.cwd ?? cwd }));
  const output = agentHookOutput(input, {
    config,
    mainPath: main.path,
    branch,
    worktreePath: entry?.path ?? input.cwd ?? cwd,
    feature: branch ? coordination.features[branch] ?? null : null,
    blockedBy: branch ? featureBlockers(coordination, branch) : [],
  });
  process.stdout.write(JSON.stringify(output));
  return output;
}
