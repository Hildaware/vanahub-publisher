import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';

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
  await page
    .getByLabel('Choose addon folder')
    .setInputFiles(resolve('../vanahub-test-addon/addon/vanahub-test-addon'));
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
