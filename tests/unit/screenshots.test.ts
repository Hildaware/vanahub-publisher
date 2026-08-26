import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  uploadScreenshots,
  validateIconDimensions,
  validateScreenshotFiles,
} from '../../src/lib/screenshots';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it('accepts icons up to 512×512 and rejects larger dimensions', async () => {
    const close = vi.fn();
    const decode = vi
      .fn()
      .mockResolvedValueOnce({ width: 512, height: 512, close })
      .mockResolvedValueOnce({ width: 513, height: 256, close });
    vi.stubGlobal('createImageBitmap', decode);
    const icon = new File(['image'], 'icon.png', { type: 'image/png' });

    expect(await validateIconDimensions(icon)).toEqual([]);
    expect(await validateIconDimensions(icon)).toEqual([
      'icon.png: icon dimensions must not exceed 512×512 pixels.',
    ]);
    expect(close).toHaveBeenCalledTimes(2);
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
            verificationToken: 'verification-grant',
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
    const result = await uploadScreenshots(
      'https://worker.example',
      'turnstile',
      [new File(['image'], 'screen.png', { type: 'image/png' })],
    );
    expect(result).toEqual({
      urls: ['https://uploads.example/pending/id.png'],
      verificationToken: 'verification-grant',
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].headers.get('X-Turnstile-Token')).toBe('turnstile');
    const declaration = (await requests[0].json()) as {
      files: { sha256: string }[];
    };
    expect(declaration.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(requests[1].headers.get('Authorization')).toBe('Bearer grant');
  });

  it('uses reusable verification instead of a new Turnstile token', async () => {
    let sessionRequest: Request | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.endsWith('/upload-session')) {
          sessionRequest = request;
          return Response.json({
            token: 'upload-grant',
            verificationToken: 'reusable-verification',
            uploads: [
              {
                key: 'pending/id.png',
                name: 'icon.png',
                uploadUrl: 'https://worker.example/upload/pending/id.png',
                publicUrl: 'https://uploads.example/pending/id.png',
              },
            ],
          });
        }
        return Response.json({ ok: true }, { status: 201 });
      }),
    );

    await uploadScreenshots(
      'https://worker.example',
      '',
      [new File(['icon'], 'icon.png', { type: 'image/png' })],
      'reusable-verification',
    );

    expect(sessionRequest?.headers.get('Authorization')).toBe(
      'Bearer reusable-verification',
    );
    expect(sessionRequest?.headers.has('X-Turnstile-Token')).toBe(false);
  });
});
