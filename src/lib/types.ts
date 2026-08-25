export const capabilities = [
  'ui',
  'game-state-read',
  'packet-read',
  'chat-output',
  'command-handler',
  'settings-write',
  'bundled-file-read',
] as const;

export type Capability = (typeof capabilities)[number];
export type PublishingMode = 'built-in' | 'custom';
export type Severity = 'error' | 'warning' | 'info';

export interface SourceEntry {
  path: string;
  bytes: Uint8Array;
  compressedSize?: number;
  uncompressedSize?: number;
  directory?: boolean;
  encrypted?: boolean;
  compressionMethod?: number;
  externalAttributes?: number;
}

export interface FileSummary {
  path: string;
  size: number;
  sha256: string;
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  message: string;
  path?: string;
  line?: number;
  capability?: string;
  structural: boolean;
}

export interface PackageMetadata {
  id: string;
  name: string;
  description: string;
  author: string;
  maintainers: string[];
  version: string;
  changelog: string;
  sourceUrl: string;
  iconUrl: string;
  screenshots: string[];
  declaredCapabilities: Capability[];
  mode: PublishingMode;
}

export interface HostingData {
  provider: 'github' | 'generic';
  tag: string;
  artifactUrl: string;
}

export interface ValidationReport {
  schemaVersion: 1;
  policyVersion: number;
  packageId: string;
  version: string;
  mode: PublishingMode;
  eligibleForScreenedCatalog: boolean;
  structurallyValid: boolean;
  findings: Finding[];
  files: string[];
  suggestedCapabilities: Capability[];
}

export interface PublisherProject {
  schemaVersion: 1;
  contract: {
    repository: string;
    commit: string;
    packageSchema: number;
    scannerPolicy: number;
  };
  metadata: PackageMetadata;
  hosting: HostingData;
  source: { files: FileSummary[]; rootHint: string; entrypoint: string } | null;
  savedAt: string;
}

export const emptyMetadata = (): PackageMetadata => ({
  id: '',
  name: '',
  description: '',
  author: '',
  maintainers: [],
  version: '0.1.0',
  changelog: '',
  sourceUrl: '',
  iconUrl: '',
  screenshots: [],
  declaredCapabilities: [],
  mode: 'built-in',
});

export const emptyHosting = (): HostingData => ({
  provider: 'github',
  tag: 'v0.1.0',
  artifactUrl: '',
});
