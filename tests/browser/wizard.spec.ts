import { expect, test } from '@playwright/test';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';

test('loads beneath the Pages subpath and navigates accessibly', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page).toHaveTitle('VanaHub Publisher');
  await expect(
    page.getByRole('heading', { name: /Connect once/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Addon details/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Addon details' }),
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: /Repository/ })).toBeVisible();
});

test('imports source, forgets drafts, and announces status', async ({
  page,
}) => {
  await page.goto('./');
  await page.getByText('Use a local folder or ZIP instead').click();
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    useWebWorkers: false,
  });
  await writer.add('sample/sample.lua', new TextReader('return true\n'));
  const archive = await writer.close();
  await page.getByLabel('Choose existing ZIP').setInputFiles({
    name: 'sample.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(await archive.arrayBuffer()),
  });
  await expect(page.getByText(/Loaded 1 local files/)).toBeVisible();
  await page.getByRole('button', { name: 'Forget everything' }).click();
  await expect(
    page.getByText('Draft and in-memory source forgotten.'),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      localStorage.getItem('vanahub-publisher-draft-v1'),
    ),
  ).not.toContain('vanahub-test-addon.lua');
});

test('shows repository files immediately after inspection', async ({
  page,
}) => {
  await page.route('https://api.github.com/**', async (route) => {
    const url = route.request().url();
    if (url.endsWith('/repos/Owner/sample'))
      return route.fulfill({
        json: {
          private: false,
          owner: { login: 'Owner' },
          name: 'sample',
          html_url: 'https://github.com/Owner/sample',
          default_branch: 'main',
        },
      });
    if (url.endsWith('/commits/main'))
      return route.fulfill({ json: { sha: 'deadbeef1234567890' } });
    if (url.includes('/git/trees/deadbeef1234567890?recursive=1'))
      return route.fulfill({
        json: {
          truncated: false,
          tree: [
            {
              path: 'addon/sample/sample.lua',
              mode: '100644',
              type: 'blob',
              size: 12,
            },
          ],
        },
      });
    return route.abort();
  });
  await page.route('https://raw.githubusercontent.com/**', (route) =>
    route.fulfill({ body: 'return true\n', contentType: 'text/plain' }),
  );

  await page.goto('./');
  await page
    .getByLabel('GitHub repository URL')
    .fill('https://github.com/Owner/sample');
  await page.getByRole('button', { name: 'Inspect repository' }).click();

  await expect(page.getByText('1 included files')).toBeVisible();
  await expect(page.getByText('sample.lua', { exact: true })).toBeVisible();
});
