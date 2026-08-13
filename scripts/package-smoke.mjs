import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const temp = mkdtempSync(join(tmpdir(), 'copse-package-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }));
  const artifact = join(temp, packed[0].filename);
  const names = new Set(packed[0].files.map((file) => file.path));
  for (const required of ['package.json', 'src/cli.mjs', 'src/commands/init.mjs', 'src/commands/land.mjs']) {
    if (!names.has(required)) throw new Error(`package is missing ${required}`);
  }
  const consumer = join(temp, 'consumer');
  execFileSync('git', ['init', '-b', 'main', consumer], { stdio: 'ignore' });
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true }));
  execFileSync('npm', ['install', '--ignore-scripts', artifact], { cwd: consumer, stdio: 'ignore' });
  const help = execFileSync(join(consumer, 'node_modules', '.bin', 'copse'), ['--help'], { cwd: consumer, encoding: 'utf8' });
  if (!help.includes('copse init') || !help.includes('copse land')) throw new Error('installed CLI help is incomplete');
  const installed = JSON.parse(readFileSync(join(consumer, 'node_modules', 'copse', 'package.json'), 'utf8'));
  console.log(`package smoke ok: copse ${installed.version}, ${packed[0].files.length} files`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
