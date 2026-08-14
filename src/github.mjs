import { runCommand } from './process.mjs';

function json(command, args, { cwd, run = runCommand }) {
  const result = run(command, args, { cwd, allowFailure: true });
  if (!result.ok) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

export function pullRequestStatus(branch, { cwd, run = runCommand } = {}) {
  const rows = json('gh', ['pr', 'list', '--head', branch, '--state', 'open', '--limit', '1', '--json', 'number,state,baseRefName,headRefOid,statusCheckRollup'], { cwd, run });
  const pr = rows?.[0];
  if (!pr) return null;
  const checks = pr.statusCheckRollup ?? [];
  const outcome = (check) => check.conclusion ?? check.state;
  const allConclusive = checks.length > 0
    && checks.every((check) => ['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(outcome(check)));
  const verify = checks.filter((check) => (check.name ?? check.context) === 'verify');
  const green = allConclusive && verify.length > 0
    && verify.every((check) => outcome(check) === 'SUCCESS');
  return {
    number: pr.number,
    state: pr.state,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    checksGreen: green,
  };
}

export function mergePullRequest(number, { headOid, cwd, run = runCommand } = {}) {
  return run('gh', ['pr', 'merge', String(number), '--merge', '--match-head-commit', headOid], {
    cwd, inherit: true, allowFailure: true,
  });
}

export function createPullRequest(branch, {
  base,
  draft = false,
  cwd,
  run = runCommand,
} = {}) {
  const args = ['pr', 'create', '--head', branch, '--base', base];
  if (draft) args.push('--draft');
  args.push('--fill');
  return run('gh', args, { cwd, inherit: true, allowFailure: true });
}
