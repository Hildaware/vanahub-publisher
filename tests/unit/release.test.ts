import { describe, expect, it, vi } from 'vitest';
import { resolveGitHubRelease } from '../../src/lib/release';

const stableRelease = {
  tag_name: 'v1.2.3',
  body: 'Release notes',
  draft: false,
  prerelease: false,
};

describe('GitHub release resolution', () => {
  it('uses release metadata supplied by a release event', async () => {
    await expect(
      resolveGitHubRelease({ release: stableRelease }, 'owner/addon', '', ''),
    ).resolves.toEqual(stableRelease);
  });

  it('loads a published release when a tag is supplied directly', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(stableRelease), { status: 200 }),
      );
    await expect(
      resolveGitHubRelease({}, 'owner/addon', 'v1.2.3', 'token', fetcher),
    ).resolves.toEqual(stableRelease);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/addon/releases/tags/v1.2.3',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer token' }),
      }),
    );
  });

  it('rejects missing, draft, and prerelease releases', async () => {
    await expect(
      resolveGitHubRelease({}, 'owner/addon', '', '', vi.fn()),
    ).rejects.toThrow('release-tag');
    await expect(
      resolveGitHubRelease(
        { release: { ...stableRelease, draft: true } },
        'owner/addon',
        '',
        '',
      ),
    ).rejects.toThrow('published');
    await expect(
      resolveGitHubRelease(
        { release: { ...stableRelease, prerelease: true } },
        'owner/addon',
        '',
        '',
      ),
    ).rejects.toThrow('Prerelease');
  });
});
