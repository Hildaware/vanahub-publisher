import { expect, test } from '@playwright/test';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';

test('loads beneath the Pages subpath and navigates accessibly', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page).toHaveTitle('VanaHub Publisher');
  await expect(
    page.getByRole('heading', { name: /Package with confidence/ }),
  ).toBeVisible();
  await page.getByRole('button', { name: /Metadata/ }).click();
  await expect(page.getByRole('heading', { name: 'Metadata' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: /Source/ })).toBeVisible();
});

test('imports source, forgets drafts, and announces status', async ({
  page,
}) => {
  await page.goto('./');
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
  await expect(page.getByText(/Loaded 1 files/)).toBeVisible();
  await expect(page.getByText('1 included files')).toBeVisible();
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
