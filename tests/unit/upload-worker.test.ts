import { afterEach, describe, expect, it, vi } from 'vitest';
import uploadWorker from '../../upload-worker/src/index';

class Bucket {
  objects = new Map<string, Uint8Array>();

  async head(key: string) {
    const value = this.objects.get(key);
    return value ? { size: value.byteLength, httpEtag: 'mock' } : null;
  }

  async get(key: string) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      size: value.byteLength,
      httpEtag: '"mock"',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(value);
          controller.close();
        },
      }),
      writeHttpMetadata(headers: Headers) {
        headers.set('Content-Type', 'image/png');
      },
    };
  }

  async put(key: string, value: ReadableStream) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    this.objects.set(key, bytes);
    return { size: bytes.byteLength, httpEtag: 'mock' };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

const environment = () => ({
  SCREENSHOTS: new Bucket(),
  PUBLIC_BASE_URL: 'https://uploads.example.test',
  PUBLISHER_ORIGIN: 'https://publisher.example.test',
  TURNSTILE_SECRET: 'turnstile-secret',
  UPLOAD_SIGNING_SECRET: 'signing-secret-at-least-32-bytes-long',
});

function sessionRequest(files: object[]) {
  return new Request('https://worker.example.test/upload-session', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://publisher.example.test',
      'X-Turnstile-Token': 'verified',
    },
    body: JSON.stringify({ files }),
  });
}

afterEach(() => vi.restoreAllMocks());

describe('screenshot upload worker', () => {
  it('creates a verified, constrained upload session and stores the file', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          hostname: 'publisher.example.test',
        }),
      ),
    );
    const env = environment();
    const session = await uploadWorker.fetch(
      sessionRequest([{ name: 'screen.png', size: 4, type: 'image/png' }]),
      env,
    );
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      token: string;
      uploads: { key: string; uploadUrl: string; publicUrl: string }[];
    };
    expect(body.uploads[0].key).toMatch(/^pending\/[0-9a-f-]+\.png$/);
    expect(body.uploads[0].publicUrl).toContain(body.uploads[0].key);

    const uploaded = await uploadWorker.fetch(
      new Request(body.uploads[0].uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${body.token}`,
          'Content-Type': 'image/png',
          'Content-Length': '4',
          Origin: 'https://publisher.example.test',
        },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      env,
    );
    expect(uploaded.status).toBe(201);
    expect(env.SCREENSHOTS.objects.get(body.uploads[0].key)).toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
  });

  it('rejects untrusted origins before consuming Turnstile', async () => {
    const verifier = vi.fn();
    vi.stubGlobal('fetch', verifier);
    const response = await uploadWorker.fetch(
      new Request('https://worker.example.test/upload-session', {
        method: 'POST',
        headers: { Origin: 'https://attacker.example' },
      }),
      environment(),
    );
    expect(response.status).toBe(403);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('rejects oversized or unsupported session requests', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          success: true,
          hostname: 'publisher.example.test',
        }),
      ),
    );
    const response = await uploadWorker.fetch(
      sessionRequest([
        { name: 'payload.svg', size: 100, type: 'image/svg+xml' },
      ]),
      environment(),
    );
    expect(response.status).toBe(400);
  });
});
