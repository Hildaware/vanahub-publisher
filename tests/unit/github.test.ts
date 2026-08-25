import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addonCandidates,
  archiveWrapper,
  loadGitHubRepository,
  parseGitHubRepository,
  releaseAutomation,
  selectedArchiveRoot,
} from '../../src/lib/github';
import { repositoryProvider } from '../../src/lib/repository-provider';

describe('GitHub repository sources', () => {
  afterEach(() => vi.unstubAllGlobals());

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

  it('loads an immutable snapshot without GitHub archive redirects', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            truncated: false,
            tree: [
              {
                path: 'addon/sample.lua',
                mode: '100644',
                type: 'blob',
                size: 12,
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response('return true\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const progress: number[] = [];
    const entries = await loadGitHubRepository(
      {
        owner: 'Owner',
        name: 'addon',
        url: 'https://github.com/Owner/addon',
        defaultBranch: 'main',
        commit: 'deadbeef',
      },
      (value) => progress.push(value),
    );

    expect(fetchMock.mock.calls[0][0]).toContain(
      '/git/trees/deadbeef?recursive=1',
    );
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://raw.githubusercontent.com/Owner/addon/deadbeef/addon/sample.lua',
    );
    expect(entries[0].path).toBe('addon/sample.lua');
    expect(new TextDecoder().decode(entries[0].bytes)).toBe('return true\n');
    expect(progress).toEqual([1]);
  });

  it('detects workflows that create GitHub releases', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(
      releaseAutomation([
        {
          path: '.github/workflows/release.yml',
          bytes: encode('run: gh release create "$TAG"'),
        },
        {
          path: '.github/workflows/build.yaml',
          bytes: encode('uses: softprops/action-gh-release@v2'),
        },
        {
          path: '.github/workflows/test.yml',
          bytes: encode('run: npm test'),
        },
      ]),
    ).toEqual([
      '.github/workflows/build.yaml',
      '.github/workflows/release.yml',
    ]);
  });
});
