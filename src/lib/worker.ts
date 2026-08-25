/// <reference lib="webworker" />
import { readFiles, readZip } from './archive';
import { scanEntries } from './scanner';
import type { PackageMetadata, SourceEntry } from './types';

type Request =
  | { id: number; type: 'read-zip'; file: File }
  | { id: number; type: 'read-directory'; files: File[] }
  | {
      id: number;
      type: 'scan';
      entries: SourceEntry[];
      root: string;
      metadata: PackageMetadata;
    }
  | { id: number; type: 'cancel' };

const cancelled = new Set<number>();

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelled.add(request.id);
    return;
  }
  try {
    const progress = (value: number) =>
      self.postMessage({ id: request.id, type: 'progress', value });
    let result: unknown;
    if (request.type === 'read-zip')
      result = await readZip(request.file, progress);
    else if (request.type === 'read-directory')
      result = await readFiles(request.files, progress);
    else result = scanEntries(request.entries, request.root, request.metadata);
    if (!cancelled.has(request.id))
      self.postMessage({ id: request.id, type: 'result', result });
  } catch (error) {
    self.postMessage({
      id: request.id,
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    cancelled.delete(request.id);
  }
};

export {};
