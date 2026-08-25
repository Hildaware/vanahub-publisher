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
  return `name: VanaHub publishing

on:
  workflow_dispatch:
    inputs:
      release-tag:
        description: Published release tag to package. Leave blank to run repository setup.
        required: false
        type: string
  workflow_call:
    inputs:
      release-tag:
        description: Published release tag to package.
        required: true
        type: string
  release:
    types: [published]

permissions: {}

jobs:
  setup:
    if: github.event_name == 'workflow_dispatch' && inputs.release-tag == ''
    permissions:
      contents: write
      pull-requests: write
    uses: Hildaware/vanahub-publisher/.github/workflows/setup-addon.yml@${payload.publisherRef}
    with:
      setup: ${encoded}
      publisher-ref: ${payload.publisherRef}
  publish:
    if: github.event_name == 'release' || inputs.release-tag != ''
    permissions:
      contents: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          ref: \${{ inputs.release-tag || github.event.release.tag_name }}
          persist-credentials: false
      - name: Resolve published release metadata
        env:
          GH_TOKEN: \${{ github.token }}
          VH_TAG: \${{ inputs.release-tag || github.event.release.tag_name }}
        run: gh api "repos/\${GITHUB_REPOSITORY}/releases/tags/\${VH_TAG}" > "\${RUNNER_TEMP}/vanahub-release.json"
      - id: package
        uses: Hildaware/vanahub-publisher@${payload.publisherRef}
        with:
          release-tag: \${{ inputs.release-tag || github.event.release.tag_name }}
          release-metadata-path: \${{ runner.temp }}/vanahub-release.json
      - name: Attach VanaHub assets
        env:
          GH_TOKEN: \${{ github.token }}
          VH_TAG: \${{ inputs.release-tag || github.event.release.tag_name }}
          VH_OUTPUT: \${{ steps.package.outputs.output-directory }}
        run: gh release upload "$VH_TAG" "$VH_OUTPUT"/* --clobber
      - name: Catalog submission
        env:
          VH_ID: \${{ steps.package.outputs.package-id }}
          VH_REPOSITORY: \${{ github.repository }}
        run: |
          url="https://github.com/Hildaware/vanahub-catalog/issues/new?template=vanahub-submission.yml&repository=https%3A%2F%2Fgithub.com%2F\${VH_REPOSITORY}&package_id=\${VH_ID}"
          echo "### Catalog" >> "$GITHUB_STEP_SUMMARY"
          echo "For first admission, [submit this release to VanaHub](\${url}). Later releases are discovered automatically." >> "$GITHUB_STEP_SUMMARY"
`;
}

export function releaseWorkflowIntegration(): string {
  return `  vanahub:
    needs: release
    uses: ./.github/workflows/vanahub-setup.yml
    with:
      release-tag: v\${{ inputs.version }}
    permissions:
      contents: write
`;
}

export function githubNewFileUrl(repository: string, branch: string): string {
  return `${repository}/new/${encodeURIComponent(branch)}?filename=${encodeURIComponent('.github/workflows/vanahub-setup.yml')}`;
}
