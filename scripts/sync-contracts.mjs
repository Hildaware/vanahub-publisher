import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, 'vendor/vanahub');
const lockPath = join(vendor, 'contracts.lock.json');
const lock = JSON.parse(await readFile(lockPath, 'utf8'));
const check = process.argv.includes('--check');
const sourceFlag = process.argv.indexOf('--source');
const requestedSource =
  sourceFlag >= 0 ? process.argv[sourceFlag + 1] : process.env.VANAHUB_SOURCE;
const files = {
  'schemas/package.schema.json': 'package.schema.json',
  'policy/scanner-policy.json': 'scanner-policy.json',
};

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

if (check) {
  for (const [upstream, local] of Object.entries(files)) {
    const actual = sha256(await readFile(join(vendor, local)));
    if (actual !== lock.contracts[upstream]) {
      throw new Error(`${local} differs from contracts.lock.json (${actual})`);
    }
  }
  console.log(`contracts match ${lock.repository}@${lock.commit}`);
  process.exit(0);
}

let source = requestedSource;
let temporary;
if (!source) {
  temporary = await mkdtemp(join(tmpdir(), 'vanahub-contracts-'));
  execFileSync(
    'git',
    [
      'clone',
      '--quiet',
      '--filter=blob:none',
      '--no-checkout',
      lock.repository,
      temporary,
    ],
    { stdio: 'inherit' },
  );
  source = temporary;
}

try {
  const commit = execFileSync('git', ['-C', source, 'rev-parse', lock.commit], {
    encoding: 'utf8',
  }).trim();
  if (commit !== lock.commit)
    throw new Error(`expected full commit ${lock.commit}, got ${commit}`);
  const hashes = {};
  for (const [upstream, local] of Object.entries(files)) {
    const data = execFileSync('git', [
      '-C',
      source,
      'show',
      `${lock.commit}:${upstream}`,
    ]);
    hashes[upstream] = sha256(data);
    await writeFile(join(vendor, local), data);
  }
  lock.contracts = hashes;
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`synchronized contracts from ${lock.repository}@${lock.commit}`);
} finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
}
