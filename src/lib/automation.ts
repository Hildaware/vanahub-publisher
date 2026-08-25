import type { PackageMetadata, PublisherConfig } from './types';
import { stableJson } from './project';

export interface SetupPayload {
  repository: string;
  config: PublisherConfig;
  maintainers: string[];
  publisherRef: string;
}

export function publisherConfig(
  metadata: PackageMetadata,
  sourcePath: string,
): PublisherConfig {
  const config: PublisherConfig = {
    schemaVersion: 1,
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    author: metadata.author,
    sourcePath: sourcePath || '.',
    declaredCapabilities: [...metadata.declaredCapabilities],
  };
  if (metadata.iconUrl) config.iconUrl = metadata.iconUrl;
  if (metadata.screenshots.length)
    config.screenshots = [...metadata.screenshots];
  return config;
}

function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function bootstrapWorkflow(payload: SetupPayload): string {
  const encoded = base64(stableJson(payload));
  return `name: Set up VanaHub publishing

on:
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  setup:
    uses: Hildaware/vanahub-publisher/.github/workflows/setup-addon.yml@${payload.publisherRef}
    with:
      setup: ${encoded}
      publisher-ref: ${payload.publisherRef}
`;
}

export function githubNewFileUrl(repository: string, branch: string): string {
  return `${repository}/new/${encodeURIComponent(branch)}?filename=${encodeURIComponent('.github/workflows/vanahub-setup.yml')}`;
}
