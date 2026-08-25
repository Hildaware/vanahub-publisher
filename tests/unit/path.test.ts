import { describe, expect, it } from 'vitest';
import {
  normalizeEntries,
  pathProblem,
  topLevelRoots,
} from '../../src/lib/path';

describe('archive paths', () => {
  it.each([
    '../evil.lua',
    '/absolute.lua',
    '//server/share.lua',
    'C:/drive.lua',
    'root\\evil.lua',
    'root/NUL.txt',
    'root/file.lua:stream',
    'root/trailing.',
  ])('blocks %s', (path) => {
    expect(pathProblem(path)).not.toBeNull();
  });

  it('finds candidate roots and normalizes output', () => {
    expect(topLevelRoots(['source/main.lua', 'docs/readme.md'])).toEqual([
      'docs',
      'source',
    ]);
    expect(
      normalizeEntries([{ path: 'source/main.lua' }], 'source', 'addon'),
    ).toEqual(['addon/main.lua']);
  });
});
