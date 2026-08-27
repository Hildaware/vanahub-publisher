interface UploadFileRequest {
  name: string;
  size: number;
  type: string;
  sha256: string;
}

interface UploadGrant {
  kind: 'upload';
  exp: number;
  files: Record<string, { size: number; type: string; sha256: string }>;
}

interface VerificationGrant {
  kind: 'verification';
  exp: number;
  client: string;
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
    value: ReadableStream | ArrayBuffer | Uint8Array,
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
  CLEANUP_SECRET: string;
  UPLOAD_RATE_LIMITER: {
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
}

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_BATCH_BYTES = 30 * 1024 * 1024;
const GRANT_SECONDS = 10 * 60;
const VERIFICATION_SECONDS = 10 * 60;
const SHA256 = /^[a-f0-9]{64}$/;
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

function audit(event: string, fields: Record<string, string | number>) {
  console.log(JSON.stringify({ event, ...fields }));
}

function stagedHeaders(): Headers {
  return new Headers({
    'Cache-Control': 'no-store, private, max-age=0',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
  });
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

async function grantToken(
  env: Env,
  grant: UploadGrant | VerificationGrant,
): Promise<string> {
  const payload = base64url(new TextEncoder().encode(JSON.stringify(grant)));
  return `${payload}.${base64url(await hmac(env.UPLOAD_SIGNING_SECRET, payload))}`;
}

async function readGrant(
  env: Env,
  token: string,
): Promise<UploadGrant | VerificationGrant | null> {
  try {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const actual = decodeBase64url(signature);
    if (!(await validHmac(env.UPLOAD_SIGNING_SECRET, payload, actual)))
      return null;
    const grant = JSON.parse(
      new TextDecoder().decode(decodeBase64url(payload)),
    ) as UploadGrant | VerificationGrant;
    if (
      !Number.isInteger(grant.exp) ||
      grant.exp < Math.floor(Date.now() / 1000) ||
      (grant.kind !== 'upload' && grant.kind !== 'verification')
    )
      return null;
    if (
      grant.kind === 'upload' &&
      (!grant.files || typeof grant.files !== 'object')
    )
      return null;
    if (grant.kind === 'verification' && typeof grant.client !== 'string')
      return null;
    return grant;
  } catch {
    return null;
  }
}

async function clientBinding(env: Env, client: string): Promise<string> {
  return base64url(await hmac(env.UPLOAD_SIGNING_SECRET, `client:${client}`));
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
      typeof file.sha256 !== 'string' ||
      !SHA256.test(file.sha256) ||
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
  const client = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  if (
    !(await env.UPLOAD_RATE_LIMITER.limit({ key: `session:${client}` })).success
  ) {
    audit('upload_rate_limited', { route: 'session' });
    return json(env, 429, {
      error: 'Too many upload requests. Try again later.',
    });
  }

  const authorization = request.headers.get('Authorization') ?? '';
  const suppliedVerificationToken = authorization.replace(/^Bearer\s+/i, '');
  const suppliedGrant = await readGrant(env, suppliedVerificationToken);
  const binding = await clientBinding(env, client);
  const hasReusableVerification =
    suppliedGrant?.kind === 'verification' &&
    constantTimeEqual(suppliedGrant.client, binding);
  if (
    !hasReusableVerification &&
    !(await verifyTurnstile(
      env,
      request.headers.get('X-Turnstile-Token') ?? '',
      client === 'unknown' ? '' : client,
    ))
  )
    return json(env, 403, { error: 'Upload verification failed.' });
  const verificationToken = hasReusableVerification
    ? suppliedVerificationToken
    : await grantToken(env, {
        kind: 'verification',
        exp: Math.floor(Date.now() / 1000) + VERIFICATION_SECONDS,
        client: binding,
      });

  const grant: UploadGrant = {
    kind: 'upload',
    exp: Math.floor(Date.now() / 1000) + GRANT_SECONDS,
    files: {},
  };
  const uploads = files.map((file) => {
    const extension = allowedTypes.get(file.type)!;
    const key = `pending/${crypto.randomUUID()}/${file.sha256}.${extension}`;
    grant.files[key] = {
      size: file.size,
      type: file.type,
      sha256: file.sha256,
    };
    return {
      key,
      name: file.name,
      uploadUrl: new URL(`/upload/${key}`, request.url).toString(),
      publicUrl: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`,
    };
  });
  audit('upload_session_created', {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.size, 0),
  });
  return json(env, 200, {
    token: await grantToken(env, grant),
    verificationToken,
    uploads,
  });
}

async function readBounded(
  stream: ReadableStream,
  maximum: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const { done, value } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('upload timed out')),
            30_000,
          );
        }),
      ]).finally(() => clearTimeout(timeout));
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      length += chunk.byteLength;
      if (length > maximum) throw new Error('upload exceeds its size grant');
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new Uint8Array(bytes).buffer;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

async function upload(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const authorization = request.headers.get('Authorization') ?? '';
  const grant = await readGrant(env, authorization.replace(/^Bearer\s+/i, ''));
  const expected = grant?.kind === 'upload' ? grant.files[key] : undefined;
  if (!expected) return json(env, 403, { error: 'Upload grant is invalid.' });
  if (
    !(await env.UPLOAD_RATE_LIMITER.limit({ key: `upload:${key}` })).success
  ) {
    audit('upload_rate_limited', { route: 'upload' });
    return json(env, 429, { error: 'Too many upload attempts.' });
  }
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
  let bytes: Uint8Array;
  try {
    bytes = await readBounded(request.body, expected.size);
  } catch {
    return json(env, 400, { error: 'Uploaded bytes exceeded the size grant.' });
  }
  if (
    bytes.byteLength !== expected.size ||
    (await sha256(bytes)) !== expected.sha256
  )
    return json(env, 400, {
      error: 'Uploaded bytes did not match the declared SHA-256.',
    });
  const existing = await env.SCREENSHOTS.get(key);
  if (existing) {
    const stored = await readBounded(existing.body, expected.size);
    if (
      stored.byteLength === bytes.byteLength &&
      (await sha256(stored)) === expected.sha256
    )
      return json(env, 200, { ok: true, existing: true });
    return json(env, 409, { error: 'Upload key is already occupied.' });
  }
  await env.SCREENSHOTS.put(key, bytes, {
    httpMetadata: { contentType: type },
  });
  const stored = await env.SCREENSHOTS.head(key);
  if (!stored || stored.size !== expected.size) {
    await env.SCREENSHOTS.delete(key);
    return json(env, 400, { error: 'Stored upload size did not match.' });
  }
  audit('upload_stored', { bytes: expected.size, type: expected.type });
  return json(env, 201, { ok: true });
}

function constantTimeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let different = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++)
    different |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return different === 0;
}

async function cleanup(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get('Authorization') ?? '';
  if (
    !env.CLEANUP_SECRET ||
    !constantTimeEqual(authorization, `Bearer ${env.CLEANUP_SECRET}`)
  )
    return json(env, 403, { error: 'Cleanup authorization failed.' });
  let body: { keys?: unknown };
  try {
    body = (await request.json()) as { keys?: unknown };
  } catch {
    return json(env, 400, { error: 'Expected a JSON cleanup request.' });
  }
  if (
    !Array.isArray(body.keys) ||
    body.keys.length < 1 ||
    body.keys.length > 11 ||
    body.keys.some(
      (key) =>
        typeof key !== 'string' ||
        !/^pending\/[0-9a-f-]{36}\/[a-f0-9]{64}\.(?:jpg|png|webp)$/.test(key),
    )
  )
    return json(env, 400, { error: 'Cleanup keys are invalid.' });
  await Promise.all(
    [...new Set(body.keys as string[])].map((key) =>
      env.SCREENSHOTS.delete(key),
    ),
  );
  audit('upload_cleanup', { keys: new Set(body.keys as string[]).size });
  return json(env, 200, { ok: true });
}

async function serveStaged(
  request: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const object = await env.SCREENSHOTS.get(key);
  if (!object) return new Response('Not found', { status: 404 });
  const headers = stagedHeaders();
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
      (env.UPLOAD_SIGNING_SECRET?.length ?? 0) < 32 ||
      (env.CLEANUP_SECRET?.length ?? 0) < 32 ||
      !env.TURNSTILE_SECRET ||
      !env.UPLOAD_RATE_LIMITER ||
      !env.PUBLIC_BASE_URL?.startsWith('https://')
    )
      return new Response('Upload service is not configured.', { status: 503 });
    if (request.method === 'POST' && url.pathname === '/cleanup')
      return cleanup(request, env);
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
