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
  it('detects technical capabilities without author declarations', () => {
    const report = scanEntries(
      [
        entry(
          'sample/sample.lua',
          "local imgui = require('imgui')\nreturn true\n",
        ),
      ],
      'sample',
      metadata({ declaredCapabilities: [] }),
    );
    expect(report.eligibleForScreenedCatalog).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.suggestedCapabilities).toEqual(['ui']);
  });

  it('blocks traversal, collisions, unsafe types, symlinks, and compression bombs', () => {
    const report = scanEntries(
      [
        entry('sample/sample.lua', 'return true'),
        entry('../escape.lua', 'return false'),
        entry('sample/Data.json', '{}'),
        entry('sample/data.json', '{}'),
        entry('sample/helper.dll', 'PE'),
        entry('sample/extensionless', 'MZ executable'),
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
    expect(rules).toContain('zip.executable-content');
    expect(rules).toContain('zip.symlink');
    expect(rules).toContain('zip.compression-ratio');
    expect(report.structurallyValid).toBe(false);
  });

  it('reports elevated Lua as warnings in every publishing mode', () => {
    const source = [
      entry('sample/sample.lua', "local socket = require('socket')"),
    ];
    const builtIn = scanEntries(source, 'sample', metadata());
    const custom = scanEntries(source, 'sample', metadata({ mode: 'custom' }));
    expect(
      builtIn.findings.find(
        (finding) => finding.ruleId === 'lua.blocked-symbol',
      )?.severity,
    ).toBe('warning');
    expect(
      custom.findings
        .filter((finding) => !finding.structural)
        .every((finding) => finding.severity === 'warning'),
    ).toBe(true);
    expect(custom.structurallyValid).toBe(true);
  });

  it('requires review for process execution', () => {
    const report = scanEntries(
      [entry('sample/sample.lua', "os.execute('calc')")],
      'sample',
      metadata(),
    );
    expect(report.findings.map((finding) => finding.ruleId)).toContain(
      'lua.elevated-capability',
    );
    expect(
      report.findings.find(
        (finding) => finding.ruleId === 'lua.elevated-capability',
      )?.capability,
    ).toBe('process-execution');
    expect(report.eligibleForScreenedCatalog).toBe(true);
    expect(
      report.findings
        .filter((finding) => !finding.structural)
        .every((finding) => finding.capability),
    ).toBe(true);
  });

  it('still blocks an unreviewable critical download API', () => {
    const report = scanEntries(
      [entry('sample/sample.lua', 'URLDownloadToFile()')],
      'sample',
      metadata(),
    );
    expect(report.eligibleForScreenedCatalog).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'lua.blocked-symbol',
        severity: 'error',
        capability: 'network',
      }),
    );
  });

  it('does not treat ordinary clock use as process execution', () => {
    const report = scanEntries(
      [entry('sample/sample.lua', 'return os.clock()')],
      'sample',
      metadata(),
    );
    expect(report.eligibleForScreenedCatalog).toBe(true);
    expect(report.findings).toEqual([]);
  });

  it('warns without blocking for sensitive allowed capabilities', () => {
    const report = scanEntries(
      [entry('sample/sample.lua', "register_event('packet_in', handler)")],
      'sample',
      metadata({ declaredCapabilities: [] }),
    );
    expect(report.eligibleForScreenedCatalog).toBe(true);
    expect(report.suggestedCapabilities).toEqual(['packet-read']);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        ruleId: 'lua.capability-warning',
        severity: 'warning',
        capability: 'packet-read',
      }),
    );
  });

  it('accepts the existing VanaHub test addon', async () => {
    const lua = await readFile('tests/fixtures/vanahub-test-addon.lua', 'utf8');
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

  it('does not grant the engine DLL exception to an unofficial source', () => {
    const report = scanEntries(
      [
        entry('vanahub/vanahub.lua', 'return true'),
        entry('vanahub/bin/vanahub_engine.dll', 'PE'),
      ],
      'vanahub',
      metadata({
        id: 'vanahub',
        sourceUrl: 'https://github.com/attacker/vanahub',
      }),
    );
    expect(report.findings.map((finding) => finding.ruleId)).toContain(
      'zip.file-type',
    );
  });
});
