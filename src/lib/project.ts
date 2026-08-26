import contractLock from '../../vendor/vanahub/contracts.lock.json';
import validatePackage from '../generated/package-validator.js';
import { addonCategories } from './types';
import type {
  HostingData,
  PackageMetadata,
  PublisherProject,
  ValidationReport,
} from './types';

export function artifactFilename(metadata: PackageMetadata): string {
  return `${metadata.id}-${metadata.version}.zip`;
}

export function bundleFilename(metadata: PackageMetadata): string {
  return `vanahub-publish-${metadata.id}-${metadata.version}.zip`;
}

export function githubArtifactUrl(
  metadata: PackageMetadata,
  tag: string,
): string {
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(
      metadata.sourceUrl.trim(),
    );
  if (!match || !tag.trim()) return '';
  return `https://github.com/${match[1]}/${match[2]}/releases/download/${encodeURIComponent(tag.trim())}/${artifactFilename(metadata)}`;
}

export function buildCatalogManifest(
  metadata: PackageMetadata,
  downloadUrl: string,
  digest: string,
  size: number,
): Record<string, unknown> {
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    author: metadata.author,
    maintainers: metadata.maintainers,
    version: metadata.version,
    changelog: metadata.changelog,
    sourceUrl: metadata.sourceUrl,
    downloadUrl,
    sha256: digest,
    compressedSize: size,
    archiveRoot: metadata.id,
    entrypoint: `${metadata.id}.lua`,
  };
  if (metadata.categories.length) manifest.categories = [...metadata.categories];
  if (metadata.declaredCapabilities.length) manifest.declaredCapabilities = [...metadata.declaredCapabilities];
  if (metadata.iconUrl) manifest.iconUrl = metadata.iconUrl;
  if (metadata.screenshots.length) manifest.screenshots = [...metadata.screenshots];
  return manifest;
}

export function manifestErrors(manifest: unknown): string[] {
  const validator = validatePackage as typeof validatePackage & {
    errors?: { instancePath: string; message?: string }[] | null;
  };
  if (validator(manifest)) return [];
  return (validator.errors ?? []).map(
    (error: { instancePath: string; message?: string }) =>
      `${error.instancePath || 'manifest'} ${error.message}`,
  );
}

export function validateMetadata(metadata: PackageMetadata): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(metadata.id))
    errors.push(
      'Package ID must be 2–64 lowercase letters, numbers, dots, underscores, or hyphens.',
    );
  if (!metadata.name.trim() || metadata.name.length > 80)
    errors.push('Name is required and must be at most 80 characters.');
  if (!metadata.description.trim() || metadata.description.length > 2000)
    errors.push(
      'Description is required and must be at most 2,000 characters.',
    );
  if (!metadata.author.trim() || metadata.author.length > 80)
    errors.push('Author is required and must be at most 80 characters.');
  if (
    !metadata.maintainers.length ||
    metadata.maintainers.some(
      (name) => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(name),
    )
  )
    errors.push('Add at least one valid GitHub maintainer username.');
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      metadata.version,
    )
  )
    errors.push('Version must be valid SemVer without a leading v.');
  if (metadata.changelog.length > 4000)
    errors.push('Changelog must be at most 4,000 characters.');
  const https = (value: string) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  if (
    metadata.mode === 'built-in' &&
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(
      metadata.sourceUrl,
    )
  )
    errors.push('Built-in mode requires a public GitHub repository URL.');
  if (metadata.mode === 'custom' && !https(metadata.sourceUrl))
    errors.push('Custom mode requires an HTTPS source URL.');
  if (metadata.iconUrl && !https(metadata.iconUrl))
    errors.push('Icon URL must use HTTPS.');
  if (
    metadata.screenshots.length > 10 ||
    metadata.screenshots.some((url) => !https(url))
  )
    errors.push('Use at most 10 unique HTTPS screenshot URLs.');
  if (new Set(metadata.screenshots).size !== metadata.screenshots.length)
    errors.push('Screenshot URLs must be unique.');
  if (
    metadata.categories.length > 3 ||
    new Set(metadata.categories).size !== metadata.categories.length ||
    metadata.categories.some((category) => !addonCategories.includes(category))
  )
    errors.push('Choose no more than 3 supported, unique addon categories.');
  return errors;
}

export function validateHosting(
  metadata: PackageMetadata,
  hosting: HostingData,
): string[] {
  if (!hosting.artifactUrl) return [];
  const expected = githubArtifactUrl(metadata, hosting.tag);
  if (hosting.provider === 'github' && hosting.artifactUrl !== expected)
    return [
      'GitHub artifact URL must match the repository, tag, and expected filename.',
    ];
  try {
    const url = new URL(hosting.artifactUrl);
    if (url.protocol !== 'https:' || url.username || url.password)
      return ['Artifact URL must be HTTPS without embedded credentials.'];
  } catch {
    return ['Artifact URL is invalid.'];
  }
  return [];
}

export function authorizationTemplate(
  metadata: PackageMetadata,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    packages: { [metadata.id]: { maintainers: metadata.maintainers } },
  };
}

export function customPackage(
  metadata: PackageMetadata,
  hosting: HostingData,
  digest: string,
  size: number,
  report: ValidationReport,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'custom',
    package: {
      ...metadata,
      downloadUrl: hosting.artifactUrl || null,
      sha256: digest,
      compressedSize: size,
      archiveRoot: metadata.id,
      entrypoint: `${metadata.id}.lua`,
    },
    elevatedFindings: report.findings.filter((item) => !item.structural),
  };
}

export function projectDocument(
  metadata: PackageMetadata,
  hosting: HostingData,
  source: PublisherProject['source'],
): PublisherProject {
  return {
    schemaVersion: 1,
    contract: {
      repository: contractLock.repository,
      commit: contractLock.commit,
      packageSchema: contractLock.versions.packageSchema,
      scannerPolicy: contractLock.versions.scannerPolicy,
    },
    metadata,
    hosting,
    source,
    savedAt: new Date().toISOString(),
  };
}

export function stableJson(value: unknown): string {
  const normalize = (input: any): any => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((key) => [key, normalize(input[key])]),
      );
    return input;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}
