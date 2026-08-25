import type { GitHubRepository, SourceEntry } from './types';
import type { RepositoryProvider } from './repository-provider';

const githubRepository =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

export function parseGitHubRepository(value: string): {
  owner: string;
  name: string;
} | null {
  const match = githubRepository.exec(value.trim());
  return match ? { owner: match[1], name: match[2] } : null;
}

async function githubJson(url: string): Promise<any> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (
    response.status === 403 &&
    response.headers.get('x-ratelimit-remaining') === '0'
  )
    throw new Error(
      'GitHub API rate limit reached. Try again later or use a local folder/ZIP.',
    );
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'Public GitHub repository not found.'
        : `GitHub repository request failed (${response.status}).`,
    );
  return response.json();
}

export async function inspectGitHubRepository(
  value: string,
): Promise<GitHubRepository> {
  const parsed = parseGitHubRepository(value);
  if (!parsed) throw new Error('Enter a public GitHub repository URL.');
  const repository = await githubJson(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}`,
  );
  if (repository.private)
    throw new Error('Private GitHub repositories are not supported yet.');
  const branch = await githubJson(
    `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.name)}/commits/${encodeURIComponent(repository.default_branch)}`,
  );
  return {
    owner: repository.owner.login,
    name: repository.name,
    url: repository.html_url,
    defaultBranch: repository.default_branch,
    commit: branch.sha,
  };
}

export async function downloadGitHubArchive(
  repository: GitHubRepository,
): Promise<Blob> {
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/zipball/${repository.commit}`,
    { headers: { Accept: 'application/vnd.github+json' } },
  );
  if (!response.ok)
    throw new Error(`GitHub archive download failed (${response.status}).`);
  return response.blob();
}

export const githubProvider: RepositoryProvider<GitHubRepository> = {
  id: 'github',
  matches: (value) => parseGitHubRepository(value) !== null,
  inspect: inspectGitHubRepository,
  download: downloadGitHubArchive,
};

export function archiveWrapper(entries: SourceEntry[]): string {
  const files = entries.filter((entry) => !entry.directory);
  const roots = new Set(files.map((entry) => entry.path.split('/')[0]));
  return roots.size === 1 ? [...roots][0] : '';
}

export function addonCandidates(
  entries: SourceEntry[],
  wrapper: string,
): string[] {
  const prefix = wrapper ? `${wrapper}/` : '';
  const candidates = new Set<string>();
  for (const entry of entries) {
    if (entry.directory || !entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    if (!relative.toLowerCase().endsWith('.lua')) continue;
    const directory = relative.includes('/')
      ? relative.slice(0, relative.lastIndexOf('/'))
      : '.';
    candidates.add(directory);
  }
  return [...candidates].sort((a, b) => {
    if (a === '.') return -1;
    if (b === '.') return 1;
    return a.localeCompare(b);
  });
}

export function selectedArchiveRoot(
  wrapper: string,
  sourcePath: string,
): string {
  if (sourcePath === '.') return wrapper;
  return [wrapper, sourcePath].filter(Boolean).join('/');
}
