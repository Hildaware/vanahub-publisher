import { expect, test } from '@playwright/test';
import { BlobWriter, TextReader, ZipWriter } from '@zip.js/zip.js';

test('loads beneath the Pages subpath with future steps locked', async ({
  page,
}) => {
  await page.goto('./');
  await expect(page).toHaveTitle('VanaHub Publisher');
  await expect(
    page.getByRole('heading', { name: 'Publish an addon' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Repository/ })).toBeEnabled();
  await expect(
    page.getByRole('button', { name: /Addon details/ }),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: /Review/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: /Connect/ })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
});

test('imports source, forgets drafts, and announces status', async ({
  page,
}) => {
  await page.clock.install();
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
  await page.clock.fastForward(5000);
  await expect(page.getByRole('status')).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      localStorage.getItem('vanahub-publisher-draft-v1'),
    ),
  ).not.toContain('vanahub-test-addon.lua');
});

test('unlocks steps as source, details, and review are completed', async ({
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

  const detailsStep = page.getByRole('button', { name: /Addon details/ });
  await expect(detailsStep).toBeEnabled();
  await expect(page.getByRole('button', { name: /Review/ })).toBeDisabled();
  await detailsStep.click();
  await expect(
    page.getByRole('heading', { name: 'Addon details' }),
  ).toBeFocused();

  const media = page.getByRole('group', { name: 'Media' });
  await expect(media).toBeVisible();
  expect(
    await media.locator('.field-heading > span:first-child').allTextContents(),
  ).toEqual(['Icon', 'Screenshots']);

  const continueButton = page.getByRole('button', { name: 'Continue' });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(page.getByRole('alert')).toContainText('Name is required');
  await expect(page.getByRole('alert')).toContainText(
    'Choose at least one category.',
  );

  await page.getByLabel('Package ID').fill('sample');
  await page.getByLabel('Name', { exact: true }).fill('Sample');
  await page.getByLabel('Description', { exact: true }).fill('Sample addon');
  await page.getByLabel('Author', { exact: true }).fill('Owner');
  await page.getByPlaceholder('github-user, second-user').fill('Owner');

  await expect(page.getByLabel(/Screenshot URL/)).toHaveCount(0);
  await expect(
    page.getByText(/Media uploads are temporarily unavailable/),
  ).toBeVisible();
  await page.getByLabel('Quality of Life', { exact: true }).check();

  const reviewStep = page.getByRole('button', { name: /Review/ });
  await expect(reviewStep).toBeEnabled();
  await expect(page.getByRole('button', { name: /Connect/ })).toBeDisabled();
  await continueButton.click();
  await expect(page.getByRole('heading', { name: 'Review' })).toBeFocused();
  await page.getByRole('button', { name: /Repository/ }).click();
  await expect(page.getByRole('heading', { name: 'Repository' })).toBeFocused();
  await reviewStep.click();

  await page.getByRole('button', { name: 'Run validation' }).click();
  await expect(
    page.getByText('All current catalog checks pass.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Connect/ })).toBeEnabled();
});
