interface UploadFileRequest {
  name: string;
  size: number;
  type: string;
}

interface UploadGrant {
  exp: number;
  files: Record<string, { size: number; type: string }>;
}

interface R2Object {
  size: number;
  httpEtag: string;
}

interface R2ObjectBody extends R2Object {
  body: ReadableStream;
  writeHttpMetadata(headers: Headers): void;
}

interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string): Promise<R2ObjectBody | null>;
  put(
    key: string,
    value: ReadableStream | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<R2Object | null>;
  delete(key: string): Promise<void>;
}

interface Env {
  SCREENSHOTS: R2Bucket;
  PUBLIC_BASE_URL: string;
  PUBLISHER_ORIGIN: string;
  TURNSTILE_SECRET: string;
  UPLOAD_SIGNING_SECRET: string;
}

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_BYTES = 30 * 1024 * 1024;
const GRANT_SECONDS = 10 * 60;
const allowedTypes = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

function cors(env: Env): HeadersInit {
  return {
    'Access-Control-Allow-Origin': env.PUBLISHER_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers':
      'Authorization, Content-Type, X-Turnstile-Token',
    'Access-Control-Max-Age': '3600',
    Vary: 'Origin',
  };
}

function json(env: Env, status: number, body: unknown): Response {
  return Response.json(body, { status, headers: cors(env) });
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeBase64url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(
    normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(value)),
  );
}

async function validHmac(
  secret: string,
  value: string,
  signature: Uint8Array,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify(
    'HMAC',
    key,
    new Uint8Array(signature).buffer,
    encoder.encode(value),
  );
}

async function grantToken(env: Env, grant: UploadGrant): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(grant)));
  return `${payload}.${base64url(await hmac(env.UPLOAD_SIGNING_SECRET, payload))}`;
}

async function readGrant(env: Env, token: string): Promise<UploadGrant | null> {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const actual = decodeBase64url(signature);
  if (!(await validHmac(env.UPLOAD_SIGNING_SECRET, payload, actual)))
    return null;
  try {
    const grant = JSON.parse(
      new TextDecoder().decode(decodeBase64url(payload)),
    ) as UploadGrant;
    if (
      !Number.isInteger(grant.exp) ||
      grant.exp < Math.floor(Date.now() / 1000) ||
      !grant.files ||
      typeof grant.files !== 'object'
    )
      return null;
    return grant;
  } catch {
    return null;
  }
}

async function verifyTurnstile(env: Env, token: string, ip: string) {
  if (!token) return false;
  const body = new FormData();
  body.set('secret', env.TURNSTILE_SECRET);
  body.set('response', token);
  if (ip) body.set('remoteip', ip);
  const response = await fetch(
    'https://challenges.cloudflare.com/turnstile/v0/siteverify',
    { method: 'POST', body },
  );
  if (!response.ok) return false;
  const result = (await response.json()) as {
    success?: boolean;
    hostname?: string;
  };
  return (
    result.success === true &&
    result.hostname === new URL(env.PUBLISHER_ORIGIN).hostname
  );
}

function validateFiles(value: unknown): UploadFileRequest[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILES)
    return null;
  let total = 0;
  const files: UploadFileRequest[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') return null;
    const file = candidate as Partial<UploadFileRequest>;
    if (
      typeof file.name !== 'string' ||
      file.name.length < 1 ||
      file.name.length > 200 ||
      typeof file.type !== 'string' ||
      !allowedTypes.has(file.type) ||
      !Number.isInteger(file.size) ||
      (file.size ?? 0) < 1 ||
      (file.size ?? 0) > MAX_FILE_BYTES
    )
      return null;
    total += file.size ?? 0;
    files.push(file as UploadFileRequest);
  }
  return total <= MAX_BATCH_BYTES ? files : null;
}

async function createSession(request: Request, env: Env): Promise<Response> {
  let value: { files?: unknown };
  try {
    value = (await request.json()) as { files?: unknown };
  } catch {
    return json(env, 400, { error: 'Expected a JSON upload request.' });
  }
  const files = validateFiles(value.files);
  if (!files)
    return json(env, 400, {
      error: 'Choose 1–10 PNG, JPEG, or WebP files (10 MB each, 30 MB total).',
    });
  if (
    !(await verifyTurnstile(
      env,
      request.headers.get('X-Turnstile-Token') ?? '',
      request.headers.get('CF-Connecting-IP') ?? '',
    ))
  )
    return json(env, 403, { error: 'Upload verification failed.' });

  const grant: UploadGrant = {
    exp: Math.floor(Date.now() / 1000) + GRANT_SECONDS,
    files: {},
  };
  const uploads = files.map((file) => {
    const extension = allowedTypes.get(file.type)!;
    const key = `pending/${crypto.randomUUID()}.${extension}`;
    grant.files[key] = { size: file.size, type: file.type };
    return {
      key,
      name: file.name,
      uploadUrl: new URL(`/upload/${key}`, request.url).toString(),
      publicUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`,
    };
  });
  return json(env, 200, { token: await grantToken(env, grant), uploads });
}

async function upload(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const authorization = request.headers.get('Authorization') ?? '';
  const grant = await readGrant(env, authorization.replace(/^Bearer\s+/i, ''));
  const expected = grant?.files[key];
  if (!expected) return json(env, 403, { error: 'Upload grant is invalid.' });
  const type = request.headers.get('Content-Type')?.split(';', 1)[0] ?? '';
  const length = Number(request.headers.get('Content-Length'));
  if (
    type !== expected.type ||
    !Number.isInteger(length) ||
    length !== expected.size ||
    length > MAX_FILE_BYTES ||
    !request.body
  )
    return json(env, 400, {
      error: 'Upload metadata does not match its grant.',
    });
  if (await env.SCREENSHOTS.head(key))
    return json(env, 409, { error: 'Upload key has already been used.' });
  await env.SCREENSHOTS.put(key, request.body, {
    httpMetadata: { contentType: type },
  });
  const stored = await env.SCREENSHOTS.head(key);
  if (!stored || stored.size !== expected.size) {
    await env.SCREENSHOTS.delete(key);
    return json(env, 400, { error: 'Stored upload size did not match.' });
  }
  return json(env, 201, { ok: true });
}

async function serveStaged(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const object = await env.SCREENSHOTS.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  return new Response(object.body, { headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname.startsWith('/pending/')) {
      return serveStaged(request, env, url.pathname.slice(1));
    }

    if (
      env.UPLOAD_SIGNING_SECRET.length < 32 ||
      !env.TURNSTILE_SECRET ||
      !env.PUBLIC_BASE_URL.startsWith('https://')
    )
      return new Response('Upload service is not configured.', { status: 503 });
    const origin = request.headers.get('Origin');
    if (origin !== env.PUBLISHER_ORIGIN)
      return new Response('Forbidden', { status: 403 });
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: cors(env) });
    if (request.method === 'POST' && url.pathname === '/upload-session')
      return createSession(request, env);
    if (request.method === 'PUT' && url.pathname.startsWith('/upload/pending/'))
      return upload(request, env, url.pathname.slice('/upload/'.length));
    return json(env, 404, { error: 'Not found.' });
  },
};
