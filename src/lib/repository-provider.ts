import { githubProvider } from './github';
import type { GitHubRepository, SourceEntry } from './types';

export interface RepositoryProvider<TRepository = GitHubRepository> {
  id: string;
  matches(value: string): boolean;
  inspect(value: string): Promise<TRepository>;
  load(
    repository: TRepository,
    onProgress?: (value: number) => void,
  ): Promise<SourceEntry[]>;
}

const providers: RepositoryProvider[] = [githubProvider];

export function repositoryProvider(value: string): RepositoryProvider | null {
  return providers.find((provider) => provider.matches(value)) ?? null;
}
