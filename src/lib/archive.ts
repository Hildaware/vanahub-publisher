import {
  BlobReader,
  BlobWriter,
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipReader,
  ZipWriter,
} from '@zip.js/zip.js';
import policy from '../../vendor/vanahub/scanner-policy.json';
import type { FileSummary, SourceEntry } from './types';

const epoch = new Date('1980-01-01T00:00:00.000Z');

export async function readZip(
  file: Blob,
  onProgress?: (value: number) => void,
): Promise<SourceEntry[]> {
  if (file.size > policy.limits.compressedBytes) {
    throw new Error('Archive compressed-size limit exceeded.');
  }
  const reader = new ZipReader(new BlobReader(file), { useWebWorkers: false });
  try {
    const zipEntries = await reader.getEntries();
    const expanded = zipEntries.reduce(
      (total, entry: any) => total + (entry.uncompressedSize ?? 0),
      0,
    );
    const entries: SourceEntry[] = [];
    for (let index = 0; index < zipEntries.length; index += 1) {
      const entry = zipEntries[index] as any;
      const unsafeToExpand =
        expanded > policy.limits.expandedBytes ||
        entry.uncompressedSize > policy.limits.entryBytes ||
        (entry.compressedSize &&
          entry.uncompressedSize / entry.compressedSize >
            policy.limits.compressionRatio) ||
        entry.encrypted ||
        ![0, 8].includes(entry.compressionMethod);
      const bytes =
        entry.directory || !entry.getData || unsafeToExpand
          ? new Uint8Array()
          : await entry.getData(new Uint8ArrayWriter());
      entries.push({
        path: entry.filename,
        bytes,
        compressedSize: entry.compressedSize,
        uncompressedSize: entry.uncompressedSize,
        directory: entry.directory,
        encrypted: entry.encrypted,
        compressionMethod: entry.compressionMethod,
        externalAttributes: entry.externalFileAttributes,
      });
      onProgress?.((index + 1) / Math.max(zipEntries.length, 1));
    }
    return entries;
  } finally {
    await reader.close();
  }
}

export async function readFiles(
  files: File[],
  onProgress?: (value: number) => void,
): Promise<SourceEntry[]> {
  const entries: SourceEntry[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    entries.push({
      path: file.webkitRelativePath || file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    onProgress?.((index + 1) / Math.max(files.length, 1));
  }
  return entries;
}

export async function deterministicZip(
  entries: { path: string; bytes: Uint8Array | string }[],
): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    useWebWorkers: false,
  });
  for (const entry of [...entries].sort((a, b) =>
    a.path.localeCompare(b.path, 'en', { sensitivity: 'case' }),
  )) {
    const reader =
      typeof entry.bytes === 'string'
        ? new TextReader(entry.bytes)
        : new Uint8ArrayReader(entry.bytes);
    await writer.add(entry.path, reader, {
      level: 9,
      lastModDate: epoch,
      lastAccessDate: epoch,
      creationDate: epoch,
      extendedTimestamp: false,
      dataDescriptor: false,
    });
  }
  return writer.close();
}

export async function sha256(bytes: Blob | Uint8Array): Promise<string> {
  const buffer =
    bytes instanceof Blob
      ? await bytes.arrayBuffer()
      : new Uint8Array(bytes).buffer;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export async function fingerprints(
  entries: SourceEntry[],
  root: string,
): Promise<FileSummary[]> {
  const prefix = root ? `${root.replace(/\/$/, '')}/` : '';
  const selected = entries.filter(
    (entry) => !entry.directory && entry.path.startsWith(prefix),
  );
  return Promise.all(
    selected.map(async (entry) => ({
      path: entry.path.slice(prefix.length),
      size: entry.bytes.byteLength,
      sha256: await sha256(entry.bytes),
    })),
  );
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
