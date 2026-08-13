import { worktreeRoot } from '../git.mjs';
import { runCommand } from '../process.mjs';
import { CopseError } from './new.mjs';
import { commandDoctor } from './doctor.mjs';

export function runVerification(commands, { cwd, run = runCommand }) {
  if (commands.length === 0) throw new CopseError('verify: no checks configured in copse.config.json');
  for (const argv of commands) {
    console.log(`\n::group::${argv.join(' ')}`);
    const result = run(argv[0], argv.slice(1), { cwd, inherit: true, allowFailure: true });
    console.log('::endgroup::');
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

export function commandVerify({ cwd = process.cwd(), config, run = runCommand }) {
  const doctor = commandDoctor({ cwd, config });
  if (!doctor.ok) return 1;
  return runVerification(config.verify, { cwd: worktreeRoot({ cwd }), run });
}
