import {
  appendFileSync,
  lstatSync,
  mkdirSync,
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
import type { PublisherConfig, SourceEntry } from './lib/types';
import { resolveGitHubRelease } from './lib/release';

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
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
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
  if (!Array.isArray(value.declaredCapabilities))
    throw new Error('declaredCapabilities must be an array.');
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

function sourceEntries(root: string): SourceEntry[] {
  const entries: SourceEntry[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      const normalized = relative(root, path).split(sep).join('/');
      if (
        normalized === '.git' ||
        normalized.startsWith('.git/') ||
        normalized === '.github' ||
        normalized.startsWith('.github/') ||
        normalized === '.vanahub' ||
        normalized.startsWith('.vanahub/') ||
        normalized === '.vanahub.json'
      )
        continue;
      if (stat.isSymbolicLink())
        throw new Error(`Symbolic link is not publishable: ${normalized}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile())
        entries.push({
          path: normalized,
          bytes: new Uint8Array(readFileSync(path)),
        });
    }
  };
  walk(root);
  return entries;
}

async function main() {
  const workspace = resolve(process.env.GITHUB_WORKSPACE || '.');
  const repository = process.env.GITHUB_REPOSITORY || '';
  const [owner, repositoryName] = repository.split('/');
  if (!owner || !repositoryName)
    throw new Error('GITHUB_REPOSITORY is required.');
  const event = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || '', 'utf8'),
  );
  const release = await resolveGitHubRelease(
    event,
    repository,
    input('release-tag'),
    input('github-token'),
  );
  const configPath = resolve(
    workspace,
    input('config-path', '.vanahub/package.json'),
  );
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  validateConfig(config);
  const authorization = JSON.parse(
    readFileSync(resolve(workspace, '.vanahub.json'), 'utf8'),
  );
  const maintainers = authorization?.packages?.[config.id]?.maintainers;
  if (!Array.isArray(maintainers) || !maintainers.length)
    throw new Error(`.vanahub.json does not authorize ${config.id}.`);
  const version = semverFromTag(release.tag_name);
  const metadata = {
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
    declaredCapabilities: config.declaredCapabilities || [],
    mode: 'built-in' as const,
  };
  const metadataProblems = validateMetadata(metadata);
  if (metadataProblems.length) throw new Error(metadataProblems.join('\n'));
  const sourceRoot = resolve(workspace, config.sourcePath);
  if (sourceRoot !== workspace && !sourceRoot.startsWith(`${workspace}${sep}`))
    throw new Error('sourcePath escapes the repository.');
  const entries = sourceEntries(sourceRoot);
  const report = scanEntries(entries, '', metadata);
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
  const outputDirectory = resolve(
    workspace,
    input('output-directory', '.vanahub-output'),
  );
  if (
    outputDirectory !== workspace &&
    !outputDirectory.startsWith(`${workspace}${sep}`)
  )
    throw new Error('output-directory escapes the repository.');
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(
    join(outputDirectory, artifactName),
    Buffer.from(await artifact.arrayBuffer()),
  );
  writeFileSync(
    join(outputDirectory, 'vanahub-manifest.json'),
    stableJson(manifest),
  );
  writeFileSync(
    join(outputDirectory, 'validation-report.json'),
    stableJson(report),
  );
  writeFileSync(
    join(outputDirectory, 'SHA256SUMS.txt'),
    `${digest}  ${artifactName}\n`,
  );
  output('artifact-name', artifactName);
  output('output-directory', outputDirectory);
  output('package-id', config.id);
  output('version', version);
  console.log(`Prepared ${artifactName} (${artifact.size} bytes, ${digest}).`);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exitCode = 1;
});
