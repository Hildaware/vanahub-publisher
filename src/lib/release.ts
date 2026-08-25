export interface GitHubRelease {
  tag_name: string;
  body?: string | null;
  draft: boolean;
  prerelease: boolean;
}

export async function resolveGitHubRelease(
  event: { release?: GitHubRelease },
  repository: string,
  requestedTag: string,
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<GitHubRelease> {
  let release = event.release;
  if (release && requestedTag && release.tag_name !== requestedTag)
    throw new Error(
      `Release event tag ${release.tag_name} does not match requested tag ${requestedTag}.`,
    );
  if (!release) {
    if (!requestedTag)
      throw new Error(
        'A published GitHub Release event or release-tag input is required.',
      );
    if (!token)
      throw new Error('github-token is required when publishing by tag.');
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(requestedTag)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!response.ok)
      throw new Error(
        response.status === 404
          ? `Published GitHub Release ${requestedTag} was not found.`
          : `GitHub Release request failed (${response.status}).`,
      );
    release = (await response.json()) as GitHubRelease;
  }
  if (!release || release.draft)
    throw new Error('The action requires a published GitHub Release.');
  if (release.prerelease)
    throw new Error('Prerelease catalog publishing is not supported.');
  return release;
}
