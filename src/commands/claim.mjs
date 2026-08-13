import { parseBranchName } from '../naming.mjs';
import { claimFeature, coordinationStatePath, updateCoordination } from '../coordination.mjs';
import { CopseError } from './new.mjs';

export function commandClaim(branch, { cwd = process.cwd(), config, owner = process.env.USER || 'unknown', dependsOn = [] }) {
  const parsed = parseBranchName(branch, config);
  if (!parsed.ok) throw new CopseError(parsed.reason);
  for (const dependency of dependsOn) {
    const dep = parseBranchName(dependency, config);
    if (!dep.ok) throw new CopseError(dep.reason);
  }
  const path = coordinationStatePath({ cwd });
  const next = updateCoordination(path, (state) => claimFeature(state, branch, { owner, dependsOn }));
  console.log(`✓ ${branch} claimed by ${owner}`);
  return next.features[branch];
}
