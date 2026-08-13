import { rulesetPayload } from '../protection.mjs';
import { runCommand } from '../process.mjs';
import { CopseError } from './new.mjs';

export function commandProtect({ cwd = process.cwd(), config, apply = false, run = runCommand } = {}) {
  const payload = rulesetPayload(config);
  if (!apply) {
    console.log(JSON.stringify(payload, null, 2));
    return payload;
  }
  const repo = run('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd, allowFailure: true });
  if (!repo.ok || !repo.stdout.trim()) throw new CopseError('could not determine GitHub repository; run gh auth login');
  const name = repo.stdout.trim();
  const listed = run('gh', ['api', `repos/${name}/rulesets`], { cwd, allowFailure: true });
  let existing = null;
  if (listed.ok) {
    try { existing = JSON.parse(listed.stdout).find((item) => item.name === payload.name) ?? null; } catch { /* create below */ }
  }
  const method = existing ? 'PUT' : 'POST';
  const endpoint = existing ? `repos/${name}/rulesets/${existing.id}` : `repos/${name}/rulesets`;
  const result = run('gh', ['api', '--method', method, endpoint, '--input', '-'], { cwd, input: JSON.stringify(payload), inherit: true, allowFailure: true });
  if (!result.ok) throw new CopseError('GitHub ruleset creation failed');
  return payload;
}
