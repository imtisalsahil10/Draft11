import { expect, test } from '@playwright/test';

async function overflows(page) {
  return page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
}

async function openLeague(page) {
  await page.goto('/league');
  await expect(page.getByRole('heading', { name: 'League', exact: true })).toBeVisible();
}

test('a league does not offer a catalog squad and can still be scheduled', async ({ browser }) => {
  const stamp = Date.now().toString().slice(-5);
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()));
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [ada, bea, cal] = pages;

  try {
    await openLeague(ada);
    await ada.getByLabel('Manager name').fill(`Ada${stamp}`);
    await ada.getByLabel('League name').fill(`Cup ${stamp}`);
    await ada.getByRole('button', { name: 'Create league' }).click();
    const invite = ada.getByTestId('league-invite');
    await expect(invite).toBeVisible();
    const code = (await invite.innerText()).trim();

    for (const [page, name] of [[bea, `Bea${stamp}`], [cal, `Cal${stamp}`]]) {
      await openLeague(page);
      await page.getByLabel('Manager name').fill(name);
      await page.getByLabel('Invite code').fill(code);
      await page.getByRole('button', { name: 'Join league' }).click();
      await expect(page.getByRole('heading', { name: `Cup ${stamp}` })).toBeVisible();
    }

    for (const page of pages) {
      await expect(page.getByRole('button', { name: 'Register suggested squad' })).toHaveCount(0);
      await expect(page.getByText('Finish an auction in this browser, then register that squad.')).toBeVisible();
    }

    await ada.getByRole('button', { name: 'Schedule season' }).click();
    for (const page of pages) {
      await expect(page.getByTestId('league-round')).toHaveText('Round 1');
      const bye = page.getByText('You have a bye this round.');
      const confirm = page.getByRole('button', { name: 'Confirm XI for this match' });
      await expect(bye.or(confirm)).toBeVisible();
      if (await confirm.isVisible()) await expect(confirm).toBeDisabled();
      expect(await overflows(page)).toBe(false);
    }
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
