import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  uploadScreenshots,
  validateScreenshotFiles,
} from '../../src/lib/screenshots';

afterEach(() => vi.restoreAllMocks());

describe('screenshot uploads', () => {
  it('validates types, individual sizes, totals, and remaining slots', () => {
    expect(
      validateScreenshotFiles(
        [new File(['image'], 'screen.png', { type: 'image/png' })],
        1,
      ),
    ).toEqual([]);
    expect(
      validateScreenshotFiles(
        [new File(['image'], 'screen.svg', { type: 'image/svg+xml' })],
        1,
      ),
    ).toContain('screen.svg: use PNG, JPEG, or WebP.');
    expect(
      validateScreenshotFiles(
        [
          new File(['a'], 'one.png', { type: 'image/png' }),
          new File(['b'], 'two.png', { type: 'image/png' }),
        ],
        1,
      ),
    ).toContain('Choose no more than 1 additional screenshots.');
  });

  it('exchanges Turnstile for upload slots and returns public URLs', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith('/upload-session'))
          return Response.json({
            token: 'grant',
            uploads: [
              {
                key: 'pending/id.png',
                name: 'screen.png',
                uploadUrl: 'https://worker.example/upload/pending/id.png',
                publicUrl: 'https://uploads.example/pending/id.png',
              },
            ],
          });
        return Response.json({ ok: true }, { status: 201 });
      }),
    );
    const urls = await uploadScreenshots(
      'https://worker.example',
      'turnstile',
      [new File(['image'], 'screen.png', { type: 'image/png' })],
    );
    expect(urls).toEqual(['https://uploads.example/pending/id.png']);
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get('X-Turnstile-Token')).toBe('turnstile');
    const declaration = (await requests[0].json()) as {
      files: { sha256: string }[];
    };
    expect(declaration.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(requests[1].headers.get('Authorization')).toBe('Bearer grant');
  });
});
