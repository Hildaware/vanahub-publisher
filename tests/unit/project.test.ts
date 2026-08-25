import { describe, expect, it } from 'vitest';
import { emptyMetadata, type PackageMetadata } from '../../src/lib/types';
import {
  artifactFilename,
  buildCatalogManifest,
  githubArtifactUrl,
  manifestErrors,
  validateMetadata,
} from '../../src/lib/project';

const metadata = (): PackageMetadata => ({
  ...emptyMetadata(),
  id: 'sample',
  name: 'Sample',
  description: 'Sample addon',
  author: 'author',
  maintainers: ['author'],
  version: '1.2.3',
  sourceUrl: 'https://github.com/author/sample',
  declaredCapabilities: ['ui'],
});

describe('publishing contracts', () => {
  it('derives GitHub release URLs and validates the current schema', () => {
    const value = metadata();
    const url = githubArtifactUrl(value, 'v1.2.3');
    expect(url).toBe(
      'https://github.com/author/sample/releases/download/v1.2.3/sample-1.2.3.zip',
    );
    const manifest = buildCatalogManifest(value, url, 'a'.repeat(64), 123);
    expect(manifestErrors(manifest)).toEqual([]);
    expect(artifactFilename(value)).toBe('sample-1.2.3.zip');
  });

  it('rejects incomplete metadata', () =>
    expect(validateMetadata(emptyMetadata()).length).toBeGreaterThan(0));
});
