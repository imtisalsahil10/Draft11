import { test, expect } from '@playwright/test';

test('auction leads to the lineup, results, and edit lineup', async ({ page }) => {
  page.on('dialog', (dialog) => dialog.accept());

  const name = `qa${Date.now().toString().slice(-6)}`;
  await page.goto('/');
  await page.getByLabel('Username').fill(name);
  await page.getByRole('button', { name: 'Create Room' }).click();
  await page.getByRole('button', { name: 'Start auction' }).click();

  let checkedCatalog = false;
  for (let guard = 0; guard < 30; guard += 1) {
    const bid = page.getByLabel('Bid amount');
    const lineup = page.getByRole('heading', { name: 'Lineup' });
    await expect(bid.or(lineup)).toBeVisible();
    if (!checkedCatalog && await bid.isVisible()) {
      const presented = page.locator('.pcard-large').first();
      await expect(presented).toHaveAttribute('data-card-id', /^fut23_/);
      await expect(presented).toHaveAttribute('data-card-art', 'shown');
      checkedCatalog = true;
    }
    if (await lineup.isVisible()) break;
    await bid.fill('50');
    await page.getByRole('button', { name: 'Place bid' }).click();
    const ready = page.getByRole('button', { name: "I'm ready" });
    await expect(ready.or(lineup)).toBeVisible();
    if (await lineup.isVisible()) break;
    await ready.click();
  }

  await expect(page.getByRole('heading', { name: 'Lineup' })).toBeVisible();
  expect(checkedCatalog).toBe(true);
  await expect(page.getByText('Squad strength', { exact: true })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Formation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm lineup' })).toBeDisabled();

  await page.locator('.bench-card').first().click();
  await page.getByRole('button', { name: 'GK, empty' }).click();
  await expect(page.getByText('1/11')).toBeVisible();
  await expect(page.locator('.pitch')).toBeVisible();

  const overflows = await page.evaluate(() => (
    document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  ));
  expect(overflows).toBe(false);

  await page.getByRole('button', { name: 'Review squads' }).click();
  await expect(page.getByRole('heading', { name: 'Squads' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit lineup' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rematch' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit lineup' }).click();
  await expect(page.getByRole('heading', { name: 'Lineup' })).toBeVisible();
  await expect(page.getByText('1/11')).toBeVisible();
  await expect(page.getByRole('button', { name: /GK,/ })).toBeVisible();
});
