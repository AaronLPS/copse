import { spawnSync } from 'node:child_process';

export function runCommand(command, args = [], {
  cwd = process.cwd(),
  allowFailure = false,
  inherit = false,
  input,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const result = spawn(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    stdio: inherit ? (input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit']) : ['pipe', 'pipe', 'pipe'],
    shell: false,
  });
  if (result.error) {
    if (allowFailure) return { ok: false, status: null, stdout: '', stderr: result.error.message, error: result.error };
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`);
  }
  const status = result.status ?? 1;
  const output = { ok: status === 0, status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  if (!output.ok && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed (${status}):\n${output.stderr || output.stdout}`);
  }
  return output;
}
