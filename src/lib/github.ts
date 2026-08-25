import type { GitHubRepository, SourceEntry } from './types';
import type { RepositoryProvider } from './repository-provider';
import policy from '../../vendor/vanahub/scanner-policy.json';

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

interface GitTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

interface GitTree {
  truncated: boolean;
  tree: GitTreeEntry[];
}

function rawUrl(repository: GitHubRepository, path: string): string {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/${repository.commit}/${encodedPath}`;
}

export async function loadGitHubRepository(
  repository: GitHubRepository,
  onProgress?: (value: number) => void,
): Promise<SourceEntry[]> {
  const snapshot = (await githubJson(
    `https://api.github.com/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/git/trees/${repository.commit}?recursive=1`,
  )) as GitTree;
  if (snapshot.truncated)
    throw new Error(
      'This repository is too large for browser inspection. Use the local folder/ZIP fallback.',
    );

  const unsupported = snapshot.tree.find((entry) => entry.type === 'commit');
  if (unsupported)
    throw new Error(
      `Git submodules are not supported (${unsupported.path}). Use a local folder/ZIP with the complete addon source.`,
    );
  const files = snapshot.tree.filter((entry) => entry.type === 'blob');
  if (files.length > policy.limits.entries)
    throw new Error('Repository entry limit exceeded.');
  const expanded = files.reduce((total, entry) => total + (entry.size ?? 0), 0);
  if (expanded > policy.limits.expandedBytes)
    throw new Error('Repository expanded-size limit exceeded.');
  const oversized = files.find(
    (entry) => (entry.size ?? 0) > policy.limits.entryBytes,
  );
  if (oversized)
    throw new Error(`Repository file is too large (${oversized.path}).`);

  const entries: SourceEntry[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    let response: Response;
    try {
      response = await fetch(rawUrl(repository, file.path));
    } catch {
      throw new Error(`GitHub file download failed (${file.path}).`);
    }
    if (!response.ok)
      throw new Error(
        `GitHub file download failed (${response.status}: ${file.path}).`,
      );
    const bytes = new Uint8Array(await response.arrayBuffer());
    entries.push({
      path: file.path,
      bytes,
      uncompressedSize: file.size ?? bytes.byteLength,
      externalAttributes: file.mode === '120000' ? 0xa000 << 16 : undefined,
    });
    onProgress?.((index + 1) / Math.max(files.length, 1));
  }
  return entries;
}

export const githubProvider: RepositoryProvider<GitHubRepository> = {
  id: 'github',
  matches: (value) => parseGitHubRepository(value) !== null,
  inspect: inspectGitHubRepository,
  load: loadGitHubRepository,
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

export function releaseAutomation(entries: SourceEntry[]): string[] {
  const decoder = new TextDecoder();
  return entries
    .filter(
      (entry) =>
        !entry.directory &&
        /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(entry.path),
    )
    .filter((entry) => {
      const text = decoder.decode(entry.bytes);
      return /\bgh\s+release\s+create\b|action-gh-release|softprops\/action-gh-release/i.test(
        text,
      );
    })
    .map((entry) => entry.path)
    .sort();
}
