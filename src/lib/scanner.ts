import policy from '../../vendor/vanahub/scanner-policy.json';
import type {
  Capability,
  Finding,
  PackageMetadata,
  Severity,
  SourceEntry,
  ValidationReport,
} from './types';
import { pathProblem } from './path';

const capabilityPatterns: [Capability, RegExp][] = [
  ['ui', /\bimgui\b/i],
  [
    'game-state-read',
    /\b(?:GetPlayerEntity|GetEntity|ffxi\.(?:targets|recast|vanatime|weather))\b/i,
  ],
  ['packet-read', /\bpacket_in\b|\bregister_event\s*\(\s*['"]packet/i],
  ['chat-output', /\b(?:print|chat\.)\s*\(/i],
  ['command-handler', /\bcommand\b|\bregister_event\s*\(\s*['"]command/i],
  ['settings-write', /\bsettings\.(?:save|store)\b/i],
  ['bundled-file-read', /\bio\.open\b|\bread_text\b/i],
];

const blockedCapabilities: Record<string, string> = {
  ffi: 'native-interop',
  socket: 'network',
  'ssl.https': 'network',
  os: 'process-execution',
  io: 'file-access',
  package: 'dynamic-code',
  'os.execute': 'process-execution',
  'io.popen': 'process-execution',
  'package.loadlib': 'native-interop',
  loadstring: 'dynamic-code',
  load: 'dynamic-code',
  dofile: 'dynamic-code',
  debug: 'dynamic-code',
  'ashita.memory.write': 'memory-write',
  InjectPacket: 'packet-injection',
  QueueCommand: 'command-injection',
  CreateProcess: 'process-execution',
  ShellExecute: 'process-execution',
  WinExec: 'process-execution',
  LoadLibrary: 'native-interop',
  RegSetValue: 'registry-write',
  URLDownloadToFile: 'network',
};

function finding(
  ruleId: string,
  message: string,
  structural: boolean,
  path = '',
  line = 0,
  capability = '',
  severity: Severity = 'error',
): Finding {
  return {
    ruleId,
    severity,
    message,
    structural,
    path,
    line,
    capability,
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extension(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

function localModules(entries: SourceEntry[], prefix: string): Set<string> {
  const modules = new Set<string>();
  for (const entry of entries) {
    if (
      !entry.path.startsWith(prefix) ||
      !entry.path.toLowerCase().endsWith('.lua')
    )
      continue;
    const relative = entry.path.slice(prefix.length, -4);
    modules.add(relative.replaceAll('/', '.'));
    modules.add(relative.split('/').at(-1) ?? relative);
  }
  return modules;
}

export function luaFindings(
  text: string,
  path: string,
  local: Set<string>,
): { findings: Finding[]; suggestions: Set<Capability> } {
  const findings: Finding[] = [];
  const suggestions = new Set<Capability>();
  for (const [capability, pattern] of capabilityPatterns)
    if (pattern.test(text)) suggestions.add(capability);

  const blockedSymbols = new Set([
    ...policy.blockedSymbols,
    'loadfile',
    'getfenv',
    'setfenv',
    '_ENV',
    'string.dump',
  ]);
  for (const symbol of blockedSymbols) {
    const pattern = new RegExp(
      `(?<![A-Za-z0-9_.:"'\\-])${escapeRegex(symbol)}(?![A-Za-z0-9_])`,
      'g',
    );
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push(
        finding(
          'lua.blocked-symbol',
          `Prohibited symbol: ${symbol}`,
          false,
          path,
          line,
          blockedCapabilities[symbol] ?? 'elevated',
        ),
      );
    }
  }

  const requires = [
    ...text.matchAll(/\brequire\s*(?:\(\s*)?(['"])([^'"]+)\1\s*\)?/g),
  ].map((match) => match[2]);
  const requireCount = [...text.matchAll(/\brequire\b/g)].length;
  if (requireCount !== new Set(requires).size)
    findings.push(
      finding(
        'lua.computed-require',
        'All require targets must be unique string literals',
        false,
        path,
        0,
        'dynamic-code',
        'warning',
      ),
    );
  for (const module of new Set(requires)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(module)) {
      findings.push(
        finding(
          'lua.invalid-module',
          `Invalid or dynamic-looking module name: ${module}`,
          false,
          path,
          0,
          'dynamic-code',
        ),
      );
    } else if (!policy.allowedModules.includes(module) && !local.has(module)) {
      findings.push(
        finding(
          'lua.disallowed-module',
          `Module is neither policy-approved nor bundled locally: ${module}`,
          false,
          path,
          0,
          'unapproved-module',
        ),
      );
    }
  }
  if (/\b_G\b|\bpackage\s*[.[]/.test(text))
    findings.push(
      finding(
        'lua.environment-manipulation',
        'Global or package environment manipulation is prohibited',
        false,
        path,
        0,
        'dynamic-code',
      ),
    );
  if ((text.match(/\\x[0-9A-Fa-f]{2}/g) ?? []).length > 16)
    findings.push(
      finding(
        'lua.encoded-payload',
        'Large encoded payload detected',
        false,
        path,
        0,
        'obfuscation',
      ),
    );
  if (Math.max(0, ...text.split('\n').map((line) => line.length)) > 4000)
    findings.push(
      finding(
        'lua.obfuscated-line',
        'Source contains an excessively long line',
        false,
        path,
        0,
        'obfuscation',
      ),
    );
  return { findings, suggestions };
}

export function scanEntries(
  entries: SourceEntry[],
  root: string,
  metadata: PackageMetadata,
): ValidationReport {
  const findings: Finding[] = [];
  const files: string[] = [];
  const suggested = new Set<Capability>();
  const seen = new Set<string>();
  const normalizedRoot = root.replace(/^\/+|\/+$/g, '');
  const prefix = normalizedRoot ? `${normalizedRoot}/` : '';
  const locals = localModules(entries, prefix);
  let totalExpanded = 0;
  let entrypointFound = false;

  if (entries.length > policy.limits.entries)
    findings.push(
      finding('zip.too-many-entries', 'Archive entry limit exceeded', true),
    );
  for (const entry of entries) {
    const raw = entry.path.replace(/\/$/, '');
    const problem = pathProblem(raw);
    if (problem) {
      findings.push(finding('zip.unsafe-path', problem, true, entry.path));
      continue;
    }
    const folded = raw.toLocaleLowerCase('en-US');
    if (seen.has(folded))
      findings.push(
        finding(
          'zip.path-collision',
          'Duplicate or case-colliding path',
          true,
          raw,
        ),
      );
    seen.add(folded);
    if (
      entry.externalAttributes &&
      ((entry.externalAttributes >>> 16) & 0xf000) === 0xa000
    )
      findings.push(
        finding('zip.symlink', 'Symbolic links are prohibited', true, raw),
      );
    if (entry.encrypted)
      findings.push(
        finding('zip.encrypted', 'Encrypted entries are prohibited', true, raw),
      );
    if (
      entry.compressionMethod != null &&
      ![0, 8].includes(entry.compressionMethod)
    )
      findings.push(
        finding(
          'zip.compression',
          'Only Stored and DEFLATE are supported',
          true,
          raw,
        ),
      );
    const expandedSize = entry.uncompressedSize ?? entry.bytes.byteLength;
    totalExpanded += expandedSize;
    if (expandedSize > policy.limits.entryBytes)
      findings.push(
        finding(
          'zip.entry-too-large',
          'Entry expanded-size limit exceeded',
          true,
          raw,
        ),
      );
    if (
      entry.compressedSize &&
      expandedSize / entry.compressedSize > policy.limits.compressionRatio
    )
      findings.push(
        finding(
          'zip.compression-ratio',
          'Suspicious compression ratio',
          true,
          raw,
        ),
      );
    if (entry.directory) continue;
    if (prefix && !raw.startsWith(prefix)) continue;
    const relative = prefix ? raw.slice(prefix.length) : raw;
    if (!relative || relative.includes('/..')) continue;
    files.push(relative);
    if (
      !relative.includes('/') &&
      relative.toLocaleLowerCase('en-US') ===
        `${metadata.id}.lua`.toLocaleLowerCase('en-US')
    )
      entrypointFound = true;
    const suffix = extension(relative);
    const privilegedEngine =
      metadata.id === 'vanahub' &&
      metadata.sourceUrl.replace(/\/$/, '').toLowerCase() ===
        'https://github.com/hildaware/vanahub' &&
      relative.toLowerCase() === 'bin/vanahub_engine.dll';
    if (!policy.allowedExtensions.includes(suffix) && !privilegedEngine)
      findings.push(
        finding(
          'zip.file-type',
          `File type ${suffix || '<none>'} is prohibited`,
          true,
          raw,
        ),
      );
    if (suffix === '.lua') {
      try {
        const result = luaFindings(
          new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes),
          raw,
          locals,
        );
        result.findings.forEach((item) => findings.push(item));
        result.suggestions.forEach((item) => suggested.add(item));
      } catch {
        findings.push(
          finding(
            'lua.encoding',
            'Lua source must be valid UTF-8 and readable',
            true,
            raw,
          ),
        );
      }
    }
  }
  if (totalExpanded > policy.limits.expandedBytes)
    findings.push(
      finding('zip.expanded-size', 'Total expanded-size limit exceeded', true),
    );
  if (!entrypointFound)
    findings.push(
      finding(
        'package.entrypoint',
        `Root-level entrypoint ${metadata.id}.lua was not found`,
        true,
      ),
    );
  for (const capability of suggested) {
    const message = (policy.capabilityWarnings as Record<string, string>)[
      capability
    ];
    if (message)
      findings.push(
        finding(
          'lua.capability-warning',
          message,
          false,
          '',
          0,
          capability,
          'warning',
        ),
      );
  }
  if (metadata.mode === 'custom') {
    for (const item of findings)
      if (!item.structural) item.severity = 'warning';
  }
  const structural = !findings.some(
    (item) => item.structural && item.severity === 'error',
  );
  const eligible =
    metadata.mode === 'built-in' &&
    !findings.some((item) => item.severity === 'error');
  return {
    schemaVersion: 1,
    policyVersion: policy.version,
    packageId: metadata.id,
    version: metadata.version,
    mode: metadata.mode,
    eligibleForScreenedCatalog: eligible,
    structurallyValid: structural,
    findings,
    files: files.sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    ),
    suggestedCapabilities: [...suggested].sort(),
  };
}
