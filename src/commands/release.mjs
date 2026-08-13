import { coordinationStatePath, releaseFeature, updateCoordination } from '../coordination.mjs';

export function commandRelease(branch, { cwd = process.cwd(), config }) {
  const path = coordinationStatePath({ cwd, config });
  updateCoordination(path, (state) => releaseFeature(state, branch));
  console.log(`✓ ${branch} released`);
}
