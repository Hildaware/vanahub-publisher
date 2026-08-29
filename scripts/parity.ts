import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import lock from '../vendor/vanahub/contracts.lock.json';
import { scanEntries } from '../src/lib/scanner';
import { emptyMetadata, type SourceEntry } from '../src/lib/types';

const source = resolve(process.env.VANAHUB_SOURCE ?? '../vanahub');
const scanner = join(source, 'tools/catalog_scan.py');
const actualCommit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
if (actualCommit !== lock.commit)
  throw new Error(
    `Parity requires VanaHub ${lock.commit}; found ${actualCommit}`,
  );

const fixtures = [
  {
    name: 'accepted',
    files: [
      ['sample/sample.lua', "local imgui = require('imgui')\nreturn true\n"],
    ],
    accepted: true,
  },
  {
    name: 'semantic-warning',
    files: [['sample/sample.lua', "local socket = require('socket')\n"]],
    accepted: true,
    rule: 'lua.blocked-symbol',
  },
  {
    name: 'capability-warning',
    files: [['sample/sample.lua', "register_event('packet_in', handler)\n"]],
    accepted: true,
    rule: 'lua.capability-warning',
    declaredCapabilities: ['packet-read'],
  },
  {
    name: 'traversal',
    files: [
      ['sample/sample.lua', 'return true\n'],
      ['../escape.lua', 'return false\n'],
    ],
    accepted: false,
    rule: 'zip.unsafe-path',
  },
  {
    name: 'case-collision',
    files: [
      ['sample/sample.lua', 'return true\n'],
      ['sample/Data.json', '{}'],
      ['sample/data.json', '{}'],
    ],
    accepted: false,
    rule: 'zip.path-collision',
  },
] as const;

const temporary = mkdtempSync(join(tmpdir(), 'vanahub-parity-'));
try {
  for (const fixture of fixtures) {
    const directory = join(temporary, fixture.name);
    execFileSync('mkdir', ['-p', directory]);
    const archive = join(directory, 'sample.zip');
    const python =
      "import json,sys,zipfile\nfiles=json.loads(sys.argv[2])\nwith zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:\n for name,data in files:\n  info=zipfile.ZipInfo(name,(1980,1,1,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED; z.writestr(info,data)\n";
    execFileSync('python3', [
      '-c',
      python,
      archive,
      JSON.stringify(fixture.files),
    ]);
    const archiveBytes = readFileSync(archive);
    const digest = createHash('sha256').update(archiveBytes).digest('hex');
    const manifest = {
      schemaVersion: 1,
      id: 'sample',
      name: 'Sample',
      description: 'Sample addon',
      author: 'author',
      maintainers: ['author'],
      version: '1.0.0',
      changelog: 'Initial',
      sourceUrl: 'https://github.com/author/sample',
      downloadUrl:
        'https://github.com/author/sample/releases/download/v1.0.0/sample.zip',
      sha256: digest,
      compressedSize: archiveBytes.byteLength,
      archiveRoot: 'sample',
      entrypoint: 'sample.lua',
      declaredCapabilities:
        'declaredCapabilities' in fixture
          ? [...fixture.declaredCapabilities]
          : ['ui'],
    };
    const manifestPath = join(directory, 'manifest.json');
    const reportPath = join(directory, 'report.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    try {
      execFileSync('python3', [
        scanner,
        manifestPath,
        '--archive',
        archive,
        '--output',
        reportPath,
      ]);
    } catch {
      /* rejected fixtures exit 1 */
    }
    const pythonReport = JSON.parse(readFileSync(reportPath, 'utf8'));
    const entries: SourceEntry[] = fixture.files.map(([path, text]) => ({
      path,
      bytes: new TextEncoder().encode(text),
    }));
    const browserReport = scanEntries(entries, 'sample', {
      ...emptyMetadata(),
      ...manifest,
      mode: 'built-in',
      iconUrl: '',
      screenshots: [],
      downloadUrl: undefined,
    } as any);
    if (
      pythonReport.accepted !== fixture.accepted ||
      browserReport.eligibleForScreenedCatalog !== fixture.accepted
    ) {
      throw new Error(
        `${fixture.name}: acceptance differs (python=${pythonReport.accepted}, browser=${browserReport.eligibleForScreenedCatalog})`,
      );
    }
    if ('rule' in fixture) {
      if (
        !pythonReport.findings.some(
          (finding: any) => finding.rule_id === fixture.rule,
        )
      )
        throw new Error(`${fixture.name}: Python omitted ${fixture.rule}`);
      if (
        !browserReport.findings.some(
          (finding) => finding.ruleId === fixture.rule,
        )
      )
        throw new Error(`${fixture.name}: browser omitted ${fixture.rule}`);
    }
    console.log(`parity: ${fixture.name} passed`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
