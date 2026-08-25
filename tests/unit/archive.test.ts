import { describe, expect, it } from 'vitest';
import { deterministicZip, readZip, sha256 } from '../../src/lib/archive';

describe('deterministic output', () => {
  it('produces byte-identical archives and the normalized root', async () => {
    const input = [
      {
        path: 'sample/sample.lua',
        bytes: new TextEncoder().encode('return true\n'),
      },
    ];
    const first = await deterministicZip(input);
    const second = await deterministicZip(input);
    expect(await sha256(first)).toBe(await sha256(second));
    expect(
      (await readZip(first))
        .filter((entry) => !entry.directory)
        .map((entry) => entry.path),
    ).toEqual(['sample/sample.lua']);
  });
});
