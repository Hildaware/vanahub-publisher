import { describe, expect, it } from 'vitest';
import {
  addonCandidates,
  archiveWrapper,
  parseGitHubRepository,
  selectedArchiveRoot,
} from '../../src/lib/github';
import { repositoryProvider } from '../../src/lib/repository-provider';

describe('GitHub repository sources', () => {
  it('accepts canonical public repository URLs', () => {
    expect(parseGitHubRepository('https://github.com/Owner/addon.git')).toEqual(
      { owner: 'Owner', name: 'addon' },
    );
    expect(parseGitHubRepository('https://gitlab.com/Owner/addon')).toBeNull();
    expect(repositoryProvider('https://github.com/Owner/addon')?.id).toBe(
      'github',
    );
    expect(repositoryProvider('https://gitlab.com/Owner/addon')).toBeNull();
  });

  it('finds addon directories beneath the provider archive wrapper', () => {
    const entries = [
      { path: 'Owner-addon-deadbeef/addon.lua', bytes: new Uint8Array() },
      {
        path: 'Owner-addon-deadbeef/examples/demo/demo.lua',
        bytes: new Uint8Array(),
      },
      { path: 'Owner-addon-deadbeef/README.md', bytes: new Uint8Array() },
    ];
    const wrapper = archiveWrapper(entries);
    expect(wrapper).toBe('Owner-addon-deadbeef');
    expect(addonCandidates(entries, wrapper)).toEqual(['.', 'examples/demo']);
    expect(selectedArchiveRoot(wrapper, 'examples/demo')).toBe(
      'Owner-addon-deadbeef/examples/demo',
    );
  });
});
