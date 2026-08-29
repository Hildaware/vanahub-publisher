import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import packageSchema from '../vendor/vanahub/package.schema.json';
import { deterministicZip, sha256 } from './lib/archive';
import { scanEntries } from './lib/scanner';
import {
  buildCatalogManifest,
  stableJson,
  validateMetadata,
} from './lib/project';
import {
  addonCategories,
  type PackageMetadata,
  type PublisherConfig,
  type SourceEntry,
} from './lib/types';
import { resolveGitHubRelease } from './lib/release';
import policy from '../vendor/vanahub/scanner-policy.json';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateManifest = ajv.compile(packageSchema);

function input(name: string, fallback = ''): string {
  return (
    process.env[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`] || fallback
  );
}

function output(name: string, value: string): void {
  const target = process.env.GITHUB_OUTPUT;
  if (target) appendFileSync(target, `${name}=${value}\n`);
}

function semverFromTag(tag: string): string {
  const versionPart = tag.includes('/') ? tag.split('/').pop()! : tag;
  const version = versionPart.startsWith('v')
    ? versionPart.slice(1)
    : versionPart;
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      version,
    )
  )
    throw new Error(`Release tag ${tag} is not SemVer (v prefix is optional).`);
  return version;
}

function validateConfig(value: any): asserts value is PublisherConfig {
  if (!value || value.schemaVersion !== 1)
    throw new Error('Unsupported .vanahub/package.json schema.');
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(value.id || ''))
    throw new Error('Invalid package ID in .vanahub/package.json.');
  if (
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.author !== 'string'
  )
    throw new Error('Package name, description, and author are required.');
  if (
    value.categories != null &&
    (!Array.isArray(value.categories) ||
      value.categories.length < 1 ||
      value.categories.length > 3 ||
      new Set(value.categories).size !== value.categories.length ||
      value.categories.some(
        (category: unknown) => !addonCategories.includes(category as never),
      ))
  )
    throw new Error('categories contains an unsupported addon category.');
  if (
    typeof value.sourcePath !== 'string' ||
    value.sourcePath.startsWith('/') ||
    value.sourcePath
      .split('/')
      .some((part: string) => !part || part === '.' || part === '..')
  ) {
    if (value.sourcePath !== '.')
      throw new Error(
        'sourcePath must be a safe repository-relative directory.',
      );
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function sourceEntries(root: string, excludedRoot: string): SourceEntry[] {
  const entries: SourceEntry[] = [];
  let totalBytes = 0;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (isWithin(excludedRoot, path)) continue;
      const stat = lstatSync(path);
      const normalized = relative(root, path).split(sep).join('/');
      const parts = normalized.split('/');
      if (
        parts.some((part) => ['.git', '.github', '.vanahub'].includes(part)) ||
        parts.at(-1) === '.vanahub.json'
      )
        continue;
      if (stat.isSymbolicLink())
        throw new Error(`Symbolic link is not publishable: ${normalized}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        if (stat.size > policy.limits.entryBytes)
          throw new Error(`Source file is too large: ${normalized}`);
        totalBytes += stat.size;
        if (totalBytes > policy.limits.expandedBytes)
          throw new Error('Source expanded-size limit exceeded.');
        if (entries.length >= policy.limits.entries)
          throw new Error('Source entry limit exceeded.');
        entries.push({
          path: normalized,
          bytes: new Uint8Array(readFileSync(path)),
        });
      }
    }
  };
  walk(root);
  return entries;
}

async function main() {
  const workspace = realpathSync(resolve(process.env.GITHUB_WORKSPACE || '.'));
  const repository = process.env.GITHUB_REPOSITORY || '';
  const [owner, repositoryName] = repository.split('/');
  if (!owner || !repositoryName)
    throw new Error('GITHUB_REPOSITORY is required.');
  const event = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8'),
  );
  const releaseMetadataPath = input('release-metadata-path');
  if (releaseMetadataPath)
    event.release = JSON.parse(readFileSync(releaseMetadataPath, 'utf8'));
  const release = await resolveGitHubRelease(
    event,
    repository,
    input('release-tag'),
    input('github-token'),
  );
  let configPathInput = input('config-path', '.vanahub/package.json');
  if (
    release.tag_name.includes('/') &&
    configPathInput === '.vanahub/package.json'
  ) {
    const prefix = release.tag_name.split('/')[0];
    if (prefix) {
      configPathInput = `.vanahub/${prefix}.json`;
    }
  }
  const configPath = resolve(workspace, configPathInput);
  if (
    !isWithin(workspace, configPath) ||
    !isWithin(workspace, realpathSync(configPath))
  )
    throw new Error('config-path escapes the repository.');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  validateConfig(config);
  const authorizationPath = resolve(workspace, '.vanahub.json');
  if (!isWithin(workspace, realpathSync(authorizationPath)))
    throw new Error('.vanahub.json must not resolve outside the repository.');
  const authorization = JSON.parse(readFileSync(authorizationPath, 'utf8'));
  const maintainers = authorization?.packages?.[config.id]?.maintainers;
  if (!Array.isArray(maintainers) || !maintainers.length)
    throw new Error(`.vanahub.json does not authorize ${config.id}.`);
  const version = semverFromTag(release.tag_name);
  const metadata: PackageMetadata = {
    id: config.id,
    name: config.name,
    description: config.description,
    author: config.author,
    maintainers,
    version,
    changelog: release.body || '',
    sourceUrl: `https://github.com/${repository}`,
    iconUrl: config.iconUrl || '',
    screenshots: config.screenshots || [],
    categories: config.categories || [],
    declaredCapabilities: [],
    mode: 'built-in' as const,
  };
  const metadataProblems = validateMetadata(metadata);
  if (metadataProblems.length) throw new Error(metadataProblems.join('\n'));
  const sourceRoot = resolve(workspace, config.sourcePath);
  if (
    !isWithin(workspace, sourceRoot) ||
    !isWithin(workspace, realpathSync(sourceRoot))
  )
    throw new Error('sourcePath escapes the repository.');
  if (!lstatSync(sourceRoot).isDirectory())
    throw new Error('sourcePath must be a directory.');
  const outputDirectory = resolve(
    workspace,
    input('output-directory', '.vanahub-output'),
  );
  if (
    outputDirectory === workspace ||
    !isWithin(workspace, outputDirectory) ||
    (existsSync(outputDirectory) &&
      !isWithin(workspace, realpathSync(outputDirectory)))
  )
    throw new Error('output-directory escapes the repository.');
  const entries = sourceEntries(sourceRoot, outputDirectory);
  const report = scanEntries(entries, '', metadata);
  metadata.declaredCapabilities = report.suggestedCapabilities;
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    join(outputDirectory, 'validation-report.json'),
    stableJson(report),
  );
  output('output-directory', outputDirectory);
  output('package-id', config.id);
  output('version', version);
  if (!report.eligibleForScreenedCatalog)
    throw new Error(
      `Catalog validation failed:\n${report.findings.map((item) => `${item.ruleId}: ${item.message}`).join('\n')}`,
    );
  const artifactName = `${config.id}-${version}.zip`;
  const artifact = await deterministicZip(
    entries.map((entry) => ({
      path: `${config.id}/${entry.path}`,
      bytes: entry.bytes,
    })),
  );
  const digest = await sha256(artifact);
  const downloadUrl = `https://github.com/${repository}/releases/download/${encodeURIComponent(release.tag_name)}/${artifactName}`;
  const manifest = buildCatalogManifest(
    metadata,
    downloadUrl,
    digest,
    artifact.size,
  );
  if (!validateManifest(manifest))
    throw new Error(
      (validateManifest.errors || [])
        .map((error) => `${error.instancePath || 'manifest'} ${error.message}`)
        .join('\n'),
    );
  writeFileSync(
    join(outputDirectory, artifactName),
    Buffer.from(await artifact.arrayBuffer()),
  );
  writeFileSync(
    join(outputDirectory, 'vanahub-manifest.json'),
    stableJson(manifest),
  );
  writeFileSync(
    join(outputDirectory, `${config.id}-manifest.json`),
    stableJson(manifest),
  );
  writeFileSync(
    join(outputDirectory, 'SHA256SUMS.txt'),
    `${digest}  ${artifactName}\n`,
  );
  output('artifact-name', artifactName);
  console.log(`Prepared ${artifactName} (${artifact.size} bytes, ${digest}).`);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exitCode = 1;
});
