export function runnerForPackage(spec) {
  if (typeof spec !== 'string' || spec.trim() === '' || spec.startsWith('-') || /[\0\r\n]/.test(spec)) {
    throw new Error('runner package spec must be one non-empty npm package spec and must not start with "-"');
  }
  return ['npx', '--yes', spec];
}

export function runnerPackageFromArgv(argv) {
  const indexes = argv.flatMap((value, index) => value === '--runner-package' ? [index] : []);
  if (indexes.length === 0) return null;
  if (indexes.length > 1) throw new Error('--runner-package may be provided only once');
  const value = argv[indexes[0] + 1];
  if (!value || value.startsWith('--')) throw new Error('--runner-package requires a value');
  return value;
}

export function configWithRunner(raw, runner) {
  return { ...structuredClone(raw), runner: [...runner] };
}
