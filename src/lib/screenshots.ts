export const screenshotTypes = ['image/jpeg', 'image/png', 'image/webp'];
export const maximumScreenshotBytes = 10 * 1024 * 1024;
export const maximumScreenshotBatchBytes = 30 * 1024 * 1024;

interface UploadSlot {
  key: string;
  name: string;
  uploadUrl: string;
  publicUrl: string;
}

interface UploadSession {
  token: string;
  verificationToken?: string;
  uploads: UploadSlot[];
}

export interface UploadResult {
  urls: string[];
  verificationToken: string;
}

async function responseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // The upload service can still return a useful HTTP status below.
  }
  return `Screenshot upload failed (${response.status}).`;
}

export function validateScreenshotFiles(files: File[], remaining: number) {
  if (!files.length) return ['Choose at least one screenshot.'];
  if (files.length > remaining)
    return [`Choose no more than ${remaining} additional screenshots.`];
  const errors: string[] = [];
  let total = 0;
  for (const file of files) {
    total += file.size;
    if (!screenshotTypes.includes(file.type))
      errors.push(`${file.name}: use PNG, JPEG, or WebP.`);
    if (file.size < 1 || file.size > maximumScreenshotBytes)
      errors.push(`${file.name}: image must be no larger than 10 MB.`);
  }
  if (total > maximumScreenshotBatchBytes)
    errors.push('A screenshot upload may contain at most 30 MB total.');
  return errors;
}

export async function validateIconDimensions(file: File) {
  try {
    const bitmap = await createImageBitmap(file);
    const valid = bitmap.width <= 512 && bitmap.height <= 512;
    bitmap.close();
    return valid
      ? []
      : [`${file.name}: icon dimensions must not exceed 512×512 pixels.`];
  } catch {
    return [`${file.name}: could not read image dimensions.`];
  }
}

export async function uploadScreenshots(
  endpoint: string,
  turnstileToken: string,
  files: File[],
  verificationToken = '',
): Promise<UploadResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (verificationToken) headers.Authorization = `Bearer ${verificationToken}`;
  else headers['X-Turnstile-Token'] = turnstileToken;
  const sessionResponse = await fetch(
    `${endpoint.replace(/\/$/, '')}/upload-session`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        files: await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            size: file.size,
            type: file.type,
            sha256: [
              ...new Uint8Array(
                await crypto.subtle.digest('SHA-256', await file.arrayBuffer()),
              ),
            ]
              .map((value) => value.toString(16).padStart(2, '0'))
              .join(''),
          })),
        ),
      }),
    },
  );
  if (!sessionResponse.ok)
    throw new Error(await responseError(sessionResponse));
  const session = (await sessionResponse.json()) as UploadSession;
  if (
    !session.token ||
    !Array.isArray(session.uploads) ||
    session.uploads.length !== files.length
  )
    throw new Error('Screenshot upload service returned an invalid session.');

  await Promise.all(
    session.uploads.map(async (slot, index) => {
      const file = files[index];
      const response = await fetch(slot.uploadUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'Content-Type': file.type,
        },
        body: file,
      });
      if (!response.ok) throw new Error(await responseError(response));
    }),
  );
  return {
    urls: session.uploads.map((slot) => slot.publicUrl),
    verificationToken: session.verificationToken || '',
  };
}
