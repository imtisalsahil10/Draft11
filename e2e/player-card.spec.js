import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('player cards keep their frame with a local photo, without one, and with photos disabled', async ({ page }) => {
  const remoteRequests = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('sofifa.com') || url.includes('api-sports.io') || url.includes('evil.example')) {
      remoteRequests.push(url);
    }
  });
  await page.route('**/player-images/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/276.png')) {
      return route.fulfill({
        status: 200,
        contentType: 'image/jpeg',
        path: path.join(root, 'frontend', 'public', 'cards', 'basic.jpg')
      });
    }
    return route.fulfill({ status: 404, body: 'missing' });
  });

  await page.goto('/card-lab');
  const shown = page.getByTestId('photo-shown').locator('.pcard');
  const missing = page.getByTestId('photo-missing').locator('.pcard');
  const disabled = page.getByTestId('photo-disabled').locator('.pcard');
  const broken = page.getByTestId('photo-broken').locator('.pcard');
  const unapproved = page.getByTestId('photo-unapproved').locator('.pcard');
  const remote = page.getByTestId('photo-remote').locator('.pcard');

  await expect(shown).toHaveAttribute('data-photo', 'shown');
  await expect(shown.locator('img.pcard-photo')).toBeVisible();
  await expect(shown.locator('img.pcard-photo')).toHaveAttribute('src', '/player-images/276.png');
  await expect(shown).toHaveAttribute('data-club', 'Manchester United');
  await expect(missing).toHaveAttribute('data-photo', 'fallback');
  await expect(missing.locator('img.pcard-photo')).toHaveCount(0);
  await expect(missing).toHaveAttribute('data-club', '');
  await expect(disabled).toHaveAttribute('data-photo', 'fallback');
  await expect(disabled.locator('img.pcard-photo')).toHaveCount(0);
  await expect(broken).toHaveAttribute('data-photo', 'fallback');
  await expect(unapproved).toHaveAttribute('data-photo', 'fallback');
  await expect(unapproved.locator('img.pcard-photo')).toHaveCount(0);
  await expect(remote).toHaveAttribute('data-photo', 'fallback');
  await expect(remote.locator('img.pcard-photo')).toHaveCount(0);
  expect(remoteRequests).toEqual([]);

  const boxes = await page.locator('.card-lab-row .pcard').evaluateAll((nodes) => (
    nodes.map((node) => node.getBoundingClientRect().height)
  ));
  expect(boxes.length).toBe(6);
  for (const height of boxes) {
    expect(Math.abs(height - boxes[0])).toBeLessThan(2);
  }
  const overflows = await page.evaluate(() => (
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  ));
  expect(overflows).toBe(false);
  await expect(page.getByTestId('league-club')).toHaveText('Arsenal');
  await expect(page.getByTestId('league-numeric-club')).toHaveCount(0);
});
