import { describe, expect, it } from 'vitest';
import { bootstrapWorkflow, publisherConfig } from '../../src/lib/automation';
import { emptyMetadata } from '../../src/lib/types';

describe('repository automation', () => {
  it('keeps release-derived fields out of durable package configuration', () => {
    const metadata = {
      ...emptyMetadata(),
      id: 'sample',
      name: 'Sample',
      description: 'Test',
      author: 'Author',
      version: '9.9.9',
      changelog: 'Transient',
    };
    expect(publisherConfig(metadata, 'addon')).toEqual({
      schemaVersion: 1,
      id: 'sample',
      name: 'Sample',
      description: 'Test',
      author: 'Author',
      sourcePath: 'addon',
      declaredCapabilities: [],
    });
  });

  it('pins the one-file bootstrap to an immutable publisher revision', () => {
    const ref = 'a'.repeat(40);
    const workflow = bootstrapWorkflow({
      repository: 'owner/sample',
      config: {
        schemaVersion: 1,
        id: 'sample',
        name: 'Sample',
        description: 'Test',
        author: 'Author',
        sourcePath: '.',
        declaredCapabilities: [],
      },
      maintainers: ['owner'],
      publisherRef: ref,
    });
    expect(workflow).toContain(`setup-addon.yml@${ref}`);
    expect(workflow).toContain(`publisher-ref: ${ref}`);
    expect(workflow).not.toContain('Transient');
  });
});
