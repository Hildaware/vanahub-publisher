import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { scanEntries } from '../../src/lib/scanner';
import {
  emptyMetadata,
  type PackageMetadata,
  type SourceEntry,
} from '../../src/lib/types';

const bytes = (value: string) => new TextEncoder().encode(value);
const metadata = (
  overrides: Partial<PackageMetadata> = {},
): PackageMetadata => ({
  ...emptyMetadata(),
  id: 'sample',
  name: 'Sample',
  description: 'Sample addon',
  author: 'author',
  maintainers: ['author'],
  version: '1.0.0',
  changelog: 'Initial',
  sourceUrl: 'https://github.com/author/sample',
  declaredCapabilities: ['ui'],
  ...overrides,
});
const entry = (
  path: string,
  text: string,
  overrides: Partial<SourceEntry> = {},
): SourceEntry => ({ path, bytes: bytes(text), ...overrides });

describe('scanner', () => {
  it('accepts a restricted addon with declared capabilities', () => {
    const report = scanEntries(
      [
        entry(
          'sample/sample.lua',
          "local imgui = require('imgui')\nreturn true\n",
        ),
      ],
      'sample',
      metadata(),
    );
    expect(report.eligibleForScreenedCatalog).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('blocks traversal, collisions, unsafe types, symlinks, and compression bombs', () => {
    const report = scanEntries(
      [
        entry('sample/sample.lua', 'return true'),
        entry('../escape.lua', 'return false'),
        entry('sample/Data.json', '{}'),
        entry('sample/data.json', '{}'),
        entry('sample/helper.dll', 'PE'),
        entry('sample/link.lua', '', { externalAttributes: 0xa000 << 16 }),
        entry('sample/bomb.txt', 'x'.repeat(1000), { compressedSize: 1 }),
      ],
      'sample',
      metadata(),
    );
    const rules = new Set(report.findings.map((finding) => finding.ruleId));
    expect(rules).toContain('zip.unsafe-path');
    expect(rules).toContain('zip.path-collision');
    expect(rules).toContain('zip.file-type');
    expect(rules).toContain('zip.symlink');
    expect(rules).toContain('zip.compression-ratio');
    expect(report.structurallyValid).toBe(false);
  });

  it('downgrades elevated Lua only in custom mode', () => {
    const source = [
      entry('sample/sample.lua', "local socket = require('socket')"),
    ];
    const builtIn = scanEntries(source, 'sample', metadata());
    const custom = scanEntries(source, 'sample', metadata({ mode: 'custom' }));
    expect(
      builtIn.findings.find(
        (finding) => finding.ruleId === 'lua.blocked-symbol',
      )?.severity,
    ).toBe('error');
    expect(
      custom.findings
        .filter((finding) => !finding.structural)
        .every((finding) => finding.severity === 'warning'),
    ).toBe(true);
    expect(custom.structurallyValid).toBe(true);
  });

  it('accepts the existing VanaHub test addon', async () => {
    const lua = await readFile(
      '../vanahub-test-addon/addon/vanahub-test-addon/vanahub-test-addon.lua',
      'utf8',
    );
    const report = scanEntries(
      [entry('vanahub-test-addon/vanahub-test-addon.lua', lua)],
      'vanahub-test-addon',
      metadata({
        id: 'vanahub-test-addon',
        name: 'VanaHub Test Addon',
        sourceUrl: 'https://github.com/Hildaware/vanahub-test-addon',
        declaredCapabilities: ['chat-output'],
      }),
    );
    expect(report.eligibleForScreenedCatalog).toBe(true);
  });
});
