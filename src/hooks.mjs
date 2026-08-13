import { parseBranchName } from './naming.mjs';

export function protectedBranches(config) {
  return new Set([config.baseBranch, config.releaseBranch].filter(Boolean));
}

export function gitHookDecision(event, { branch, config, updates = [] }) {
  const protectedSet = protectedBranches(config);
  if (event === 'pre-push') {
    for (const line of updates) {
      const [localRef, , remoteRef] = line.trim().split(/\s+/);
      const remoteBranch = remoteRef?.startsWith('refs/heads/') ? remoteRef.slice(11) : null;
      if (remoteBranch && protectedSet.has(remoteBranch)) return { ok: false, reason: `${remoteBranch} is protected; use a pull request and copse land` };
      if (localRef?.startsWith('refs/heads/')) {
        const localBranch = localRef.slice(11);
        if (!parseBranchName(localBranch, config).ok) return { ok: false, reason: `branch name ${localBranch} does not match this repository's copse convention` };
      }
    }
    return { ok: true };
  }
  const branches = [branch];
  for (const candidate of branches) {
    if (protectedSet.has(candidate)) return { ok: false, reason: `${candidate} is protected; use a pull request and copse land` };
    if (!parseBranchName(candidate, config).ok) return { ok: false, reason: `branch name ${candidate} does not match this repository's copse convention` };
  }
  return { ok: true };
}

function mutates(input) {
  if (['apply_patch', 'Edit', 'Write'].includes(input.tool_name)) return true;
  if (input.tool_name !== 'Bash') return false;
  const command = input.tool_input?.command ?? input.tool_input?.cmd ?? '';
  return /(^|[;&|]\s*|\s)(git\s+(add|commit|push|merge|rebase|checkout|switch|worktree)|rm\b|mv\b|cp\b|mkdir\b|touch\b|npm\s+(install|uninstall)|sed\s+-i\b)/.test(command);
}

export function agentHookOutput(input, context) {
  if (input.hook_event_name === 'SessionStart') {
    const main = context.worktreePath === context.mainPath;
    const coordination = context.feature
      ? ` Coordination: owner ${context.feature.owner}, status ${context.feature.status}` +
        `${context.feature.dependsOn.length ? `, depends on ${context.feature.dependsOn.join(', ')}` : ''}` +
        `${context.blockedBy?.length ? `, blocked by ${context.blockedBy.join(', ')}` : ''}.`
      : context.branch && !main ? ' Coordination: unclaimed.' : '';
    const text = `copse: branch ${context.branch ?? '(detached)'} in ${context.worktreePath}. ` +
      (main ? `This is the main worktree; start feature work with copse start <branch> --agent codex|claude.` : 'Run copse verify before completion and copse land to merge.') +
      coordination;
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
  }
  if (input.hook_event_name === 'PreToolUse' && context.worktreePath === context.mainPath && protectedBranches(context.config).has(context.branch) && mutates(input)) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Feature edits are blocked in the main worktree. Use copse start <prefix>/<lower-kebab> --agent codex|claude.' } };
  }
  return {};
}
