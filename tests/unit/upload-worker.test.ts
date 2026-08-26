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
  CLEANUP_SECRET: 'cleanup-secret-at-least-32-bytes-long',
  UPLOAD_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
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
      sessionRequest([
        {
          name: 'screen.png',
          size: 4,
          type: 'image/png',
          sha256:
            '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a',
        },
      ]),
      env,
    );
    expect(session.status).toBe(200);
    const body = (await session.json()) as {
      token: string;
      uploads: { key: string; uploadUrl: string; publicUrl: string }[];
    };
    expect(body.uploads[0].key).toMatch(
      /^pending\/[0-9a-f-]+\/[a-f0-9]{64}\.png$/,
    );
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

  it('rejects bytes that do not match the declared digest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ success: true, hostname: 'publisher.example.test' }),
      ),
    );
    const env = environment();
    const session = await uploadWorker.fetch(
      sessionRequest([
        {
          name: 'screen.png',
          size: 4,
          type: 'image/png',
          sha256: 'a'.repeat(64),
        },
      ]),
      env,
    );
    const body = (await session.json()) as {
      token: string;
      uploads: { uploadUrl: string }[];
    };
    const response = await uploadWorker.fetch(
      new Request(body.uploads[0].uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${body.token}`,
          'Content-Type': 'image/png',
          'Content-Length': '4',
          Origin: env.PUBLISHER_ORIGIN,
        },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      env,
    );
    expect(response.status).toBe(400);
    expect(env.SCREENSHOTS.objects.size).toBe(0);
  });

  it('serves staged bytes defensively and restricts cleanup keys', async () => {
    const env = environment();
    const key = `pending/12345678-1234-1234-1234-123456789abc/${'a'.repeat(64)}.png`;
    env.SCREENSHOTS.objects.set(key, new Uint8Array([1, 2]));
    const staged = await uploadWorker.fetch(
      new Request(`https://worker.example.test/${key}`),
      env,
    );
    expect(staged.headers.get('Cache-Control')).toContain('no-store');
    expect(staged.headers.get('X-Content-Type-Options')).toBe('nosniff');

    const denied = await uploadWorker.fetch(
      new Request('https://worker.example.test/cleanup', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong' },
        body: JSON.stringify({ keys: [key] }),
      }),
      env,
    );
    expect(denied.status).toBe(403);
    const cleaned = await uploadWorker.fetch(
      new Request('https://worker.example.test/cleanup', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.CLEANUP_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ keys: [key] }),
      }),
      env,
    );
    expect(cleaned.status).toBe(200);
    expect(env.SCREENSHOTS.objects.size).toBe(0);
  });
});
