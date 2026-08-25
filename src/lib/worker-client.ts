export interface WorkerTask<T> {
  promise: Promise<T>;
  cancel: () => void;
}

let nextId = 1;

export class PublisherWorker {
  private readonly worker = new Worker(
    new URL('./worker.ts', import.meta.url),
    { type: 'module' },
  );

  run<T>(
    payload: Record<string, unknown>,
    onProgress?: (value: number) => void,
  ): WorkerTask<T> {
    const id = nextId++;
    let rejectTask: (reason?: unknown) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
      rejectTask = reject;
      const listener = (event: MessageEvent) => {
        if (event.data.id !== id) return;
        if (event.data.type === 'progress') onProgress?.(event.data.value);
        if (event.data.type === 'result') {
          this.worker.removeEventListener('message', listener);
          resolve(event.data.result);
        }
        if (event.data.type === 'error') {
          this.worker.removeEventListener('message', listener);
          reject(new Error(event.data.message));
        }
      };
      this.worker.addEventListener('message', listener);
      this.worker.postMessage({ ...payload, id });
    });
    return {
      promise,
      cancel: () => {
        this.worker.postMessage({ type: 'cancel', id });
        rejectTask(new DOMException('Operation cancelled', 'AbortError'));
      },
    };
  }

  close(): void {
    this.worker.terminate();
  }
}
