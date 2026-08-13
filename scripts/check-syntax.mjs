import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function modules(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? modules(path) : entry.name.endsWith('.mjs') ? [path] : [];
  });
}

for (const file of [...modules('src'), ...modules('test'), ...modules('scripts')]) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log('syntax ok');
