import { readFileSync, lstatSync, readdirSync } from 'fs';
import { join, relative, sep } from 'path';
import { scanEntries } from './src/lib/scanner';

function sourceEntries(root: string) {
  const entries = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const normalized = relative(root, path).split(sep).join('/');
      if (
        normalized === '.git' ||
        normalized.startsWith('.git/') ||
        normalized === '.github' ||
        normalized.startsWith('.github/') ||
        normalized === '.vanahub' ||
        normalized.startsWith('.vanahub/')
      )
        continue;
      if (stat.isDirectory()) {
        walk(path);
      } else {
        entries.push({
          path: normalized,
          bytes: readFileSync(path),
        });
      }
    }
  };
  walk(root);
  return entries;
}

const entries = sourceEntries('/tmp/xiui');
const metadata = { id: 'xiui', version: '1.8.3', mode: 'built-in' as const, sourceUrl: 'https://github.com/tirem/XIUI' };
const report = scanEntries(entries, '', metadata);
console.log(JSON.stringify(report.findings.filter(f => f.severity === 'error'), null, 2));
