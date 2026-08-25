const windowsDevices = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'clock$',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

export function pathProblem(name: string): string | null {
  if (name.includes('\\') || name.includes('\0'))
    return 'Backslashes or NUL bytes are not permitted';
  if (name.startsWith('/') || name.startsWith('//') || /^[A-Za-z]:/.test(name))
    return 'Absolute, UNC, and drive paths are not permitted';
  const parts = name.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..'))
    return 'Empty, dot, and traversal path segments are not permitted';
  for (const part of parts) {
    const stem = part
      .replace(/[ .]+$/, '')
      .split('.', 1)[0]
      .toLowerCase();
    if (
      windowsDevices.has(stem) ||
      part.includes(':') ||
      part !== part.replace(/[ .]+$/, '')
    ) {
      return 'Windows device, stream, or ambiguous path segment';
    }
  }
  return null;
}

export function topLevelRoots(paths: string[]): string[] {
  return [
    ...new Set(paths.filter(Boolean).map((path) => path.split('/')[0])),
  ].sort((a, b) => a.localeCompare(b));
}

export function normalizeEntries(
  entries: { path: string }[],
  root: string,
  packageId: string,
): string[] {
  const prefix = root ? `${root.replace(/\/$/, '')}/` : '';
  return entries
    .filter((entry) => entry.path.startsWith(prefix) && entry.path !== root)
    .map((entry) => `${packageId}/${entry.path.slice(prefix.length)}`);
}
