import { spawn as nodeSpawn, spawnSync } from 'node:child_process';

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

export function runInteractive(command, args = [], {
  cwd = process.cwd(),
  env = process.env,
  spawn = nodeSpawn,
  onSpawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: 'inherit',
      shell: false,
    });
    const forwarded = [];
    const cleanup = () => {
      for (const [signal, listener] of forwarded) process.off(signal, listener);
    };
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const listener = () => {
        if (typeof child.kill === 'function') child.kill(signal);
      };
      process.on(signal, listener);
      forwarded.push([signal, listener]);
    }
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 1 : 0));
    });
    try {
      onSpawn?.(child.pid);
    } catch (error) {
      cleanup();
      if (typeof child.kill === 'function') child.kill('SIGTERM');
      reject(error);
    }
  });
}
