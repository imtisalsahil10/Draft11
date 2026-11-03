import { test, expect } from '@playwright/test';

const backend = `http://127.0.0.1:${process.env.E2E_BACKEND_PORT || '3025'}`;

async function balanceText(page) {
  return page.locator('.stat').filter({ hasText: 'Balance' }).locator('.stat-value').innerText();
}

test.describe('live image auction', () => {
  test('bids image cards through to a squad', async ({ page }, testInfo) => {
    test.setTimeout(180000);
    page.on('dialog', (dialog) => dialog.accept());

    const removed = await page.request.get(`${backend}/api/local-test-auction`);
    expect(removed.status()).toBe(404);

    const live = await (await page.request.get(`${backend}/api/cards`)).json();
    expect(live.count).toBe(1009);
    expect(live.source).toBe('image-catalogue');
    expect(live.excluded).toBe(0);
    expect(live.cards.every((card) => card.imageCatalogue === true && /^fut23_/.test(card.id) && card.cardArtUrl)).toBe(true);

    const catalogue = await (await page.request.get(`${backend}/api/local-catalogue`)).json();

    if (testInfo.project.name === 'desktop') {
      const sample = catalogue.players.slice(0, 8).map((player) => player.cardArtUrl);
      for (const url of sample) {
        const image = await page.request.get(url);
        expect(image.ok()).toBeTruthy();
        expect(image.headers()['content-type'] || '').toMatch(/^image\//);
      }
    }

    const name = `lt${Date.now().toString().slice(-6)}`;
    await page.goto('/');
    await page.getByLabel('Username').fill(name);
    await expect(page.getByRole('button', { name: 'Local Test Auction' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Create Room' }).click();
    await page.getByRole('button', { name: 'Start auction' }).click();

    const bid = page.getByLabel('Bid amount');
    await expect(bid).toBeVisible();
    const presented = page.locator('.pcard-large');
    await expect(presented).toHaveAttribute('data-card-art', 'shown');
    await expect(presented).toHaveAttribute('data-card-id', /^fut23_/);
    const width = await presented.locator('img.pcard-art').evaluate((img) => img.naturalWidth);
    expect(width).toBeGreaterThan(0);
    const facts = page.getByTestId('card-facts');
    const printedOverall = await presented.getAttribute('data-overall');
    if (printedOverall) await expect(facts).toContainText(`Overall ${printedOverall}`);
    else await expect(facts).toContainText('Overall Unavailable');
    const cardId = await presented.getAttribute('data-card-id');

    await page.reload();
    await expect(page.locator('.pcard-large')).toHaveAttribute('data-card-id', cardId);
    await expect(page.locator('.pcard-large')).toHaveAttribute('data-card-art', 'shown');

    const minimum = (await page.locator('.metric').nth(2).locator('.metric-value').innerText()).replace(/[^\d]/g, '');
    await page.getByLabel('Bid amount').fill(minimum);
    await page.getByRole('button', { name: 'Place bid' }).click();
    const ready = page.getByRole('button', { name: "I'm ready" });
    await expect(ready).toBeVisible({ timeout: 15000 });
    await ready.click();
    await expect(page.getByLabel('Bid amount')).toBeVisible();
    const spent = await balanceText(page);
    expect(spent.startsWith('£')).toBe(true);
    expect(Number(spent.slice(1))).toBeLessThan(1000);

    await expect.poll(async () => {
      if (await page.getByRole('heading', { name: 'Lineup' }).isVisible()) return 'lineup';
      const readyButton = page.getByRole('button', { name: "I'm ready" });
      if (await readyButton.isVisible()) {
        await readyButton.click();
        return 'ready';
      }
      const skipButton = page.getByRole('button', { name: 'Skip card' });
      if (await skipButton.isVisible()) {
        const art = page.locator('.pcard-large');
        await expect(art).toHaveAttribute('data-card-art', 'shown');
        await expect(art).toHaveAttribute('data-card-id', /^fut23_/);
        await skipButton.click();
        return 'skip';
      }
      return 'waiting';
    }, { timeout: 90000, intervals: [200] }).toBe('lineup');

    await expect(page.getByRole('heading', { name: 'Lineup' })).toBeVisible();
    await expect(page.getByText('Squad strength', { exact: true })).toBeVisible();
    await page.locator('.bench-card').first().click();
    await expect(page.locator('.field-hint').filter({ hasText: /Overall: Unavailable|OVR \d+/ })).toBeVisible();
    await page.getByRole('button', { name: 'GK, empty' }).click();
    await expect(page.getByText('1/11')).toBeVisible();
    await expect(page.locator('.pitch .pcard')).toHaveAttribute('data-card-art', 'shown');
    const overflows = await page.evaluate(() => (
      document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    ));
    expect(overflows).toBe(false);
    await page.getByRole('button', { name: 'Review squads' }).click();
    await expect(page.getByRole('heading', { name: 'Squads' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Take squad to a league' })).toBeVisible();
  });

  test('runs two local test rooms without sharing bids', async ({ page, browser }) => {
    test.setTimeout(120000);
    page.on('dialog', (dialog) => dialog.accept());
    const other = await browser.newContext();
    const second = await other.newPage();
    second.on('dialog', (dialog) => dialog.accept());

    const suffix = Date.now().toString().slice(-6);
    await page.goto('/');
    await page.getByLabel('Username').fill(`aa${suffix}`);
    await page.getByRole('button', { name: 'Create Room' }).click();
    const roomA = (await page.locator('.room-code').innerText()).trim();

    await second.goto('/');
    await second.getByLabel('Username').fill(`bb${suffix}`);
    await second.getByLabel('Room code').fill(roomA);
    await second.getByRole('button', { name: 'Join Room' }).click();
    await expect(page.getByText(`bb${suffix}`)).toBeVisible();

    await page.getByRole('button', { name: 'Start auction' }).click();
    await expect(page.locator('.pcard-large')).toHaveAttribute('data-card-art', 'shown');
    await expect(second.locator('.pcard-large')).toHaveAttribute('data-card-art', 'shown');
    const sharedId = await page.locator('.pcard-large').getAttribute('data-card-id');
    await expect(second.locator('.pcard-large')).toHaveAttribute('data-card-id', sharedId);

    const firstMinimum = (await page.locator('.metric').nth(2).locator('.metric-value').innerText()).replace(/[^\d]/g, '');
    await page.getByLabel('Bid amount').fill(firstMinimum);
    await page.getByRole('button', { name: 'Place bid' }).click();
    await expect(second.locator('.metric-note').filter({ hasText: `aa${suffix}` })).toBeVisible();
    await expect.poll(async () => {
      const text = await second.locator('.metric').nth(2).locator('.metric-value').innerText();
      return Number(text.replace(/[^\d]/g, ''));
    }).toBeGreaterThan(Number(firstMinimum));
    const secondMinimum = (await second.locator('.metric').nth(2).locator('.metric-value').innerText()).replace(/[^\d]/g, '');
    await second.getByLabel('Bid amount').fill(secondMinimum);
    await second.getByRole('button', { name: 'Place bid' }).click();

    const third = await browser.newContext();
    const roomB = await third.newPage();
    roomB.on('dialog', (dialog) => dialog.accept());
    await roomB.goto('/');
    await roomB.getByLabel('Username').fill(`cc${suffix}`);
    await roomB.getByRole('button', { name: 'Create Room' }).click();
    const codeB = (await roomB.locator('.room-code').innerText()).trim();
    expect(codeB).not.toBe(roomA);
    await roomB.getByRole('button', { name: 'Start auction' }).click();
    await expect(roomB.locator('.pcard-large')).toHaveAttribute('data-card-art', 'shown');
    expect(await balanceText(roomB)).toBe('£1000');

    await expect(page.getByRole('button', { name: "I'm ready" })).toBeVisible({ timeout: 15000 });
    await expect(second.getByRole('button', { name: "I'm ready" })).toBeVisible();
    await page.getByRole('button', { name: "I'm ready" }).click();
    await second.getByRole('button', { name: "I'm ready" }).click();
    await expect(page.getByLabel('Bid amount')).toBeVisible();
    await expect(second.getByLabel('Bid amount')).toBeVisible();
    expect(await balanceText(page)).toBe('£1000');
    expect(Number((await balanceText(second)).slice(1))).toBeLessThan(1000);

    await third.close();
    await other.close();
  });

  test('quits the lobby without removing the other participant', async ({ page, browser }) => {
    page.on('dialog', (dialog) => dialog.accept());
    const other = await browser.newContext();
    const second = await other.newPage();
    const suffix = Date.now().toString().slice(-6);
    await page.goto('/');
    await page.getByLabel('Username').fill(`qa${suffix}`);
    await page.getByRole('button', { name: 'Create Room' }).click();
    const code = (await page.locator('.room-code').innerText()).trim();

    await second.goto('/');
    await second.getByLabel('Username').fill(`qb${suffix}`);
    await second.getByLabel('Room code').fill(code);
    await second.getByRole('button', { name: 'Join Room' }).click();
    await expect(page.getByText(`qb${suffix}`)).toBeVisible();

    await page.getByTestId('quit-auction').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Quit Auction?');
    await expect(dialog).toContainText('Are you sure you want to leave this auction and return to the auction home screen?');
    await dialog.getByRole('button', { name: 'Stay in Auction' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.room-code')).toHaveText(code);

    await page.getByTestId('quit-auction').click();
    await page.getByTestId('quit-auction-confirm').click();
    await expect(page.getByRole('heading', { name: 'Football Auction' })).toBeVisible();
    await expect(second.locator('.room-code')).toHaveText(code);
    await expect(second.getByText(`qb${suffix}`)).toBeVisible();
    await expect(second.getByText(`qa${suffix}`)).toHaveCount(0);
    await other.close();
  });

  test('keeps the auction going when one participant quits, including the host', async ({ page, browser }) => {
    test.setTimeout(120000);
    page.on('dialog', (dialog) => dialog.accept());
    const other = await browser.newContext();
    const second = await other.newPage();
    second.on('dialog', (dialog) => dialog.accept());
    const suffix = Date.now().toString().slice(-6);

    await page.goto('/');
    await page.getByLabel('Username').fill(`ha${suffix}`);
    await page.getByRole('button', { name: 'Create Room' }).click();
    const code = (await page.locator('.room-code').innerText()).trim();
    await expect(page.getByText('Host')).toBeVisible();

    await second.goto('/');
    await second.getByLabel('Username').fill(`hb${suffix}`);
    await second.getByLabel('Room code').fill(code);
    await second.getByRole('button', { name: 'Join Room' }).click();
    const closed = await browser.newContext();
    const late = await closed.newPage();
    await late.goto('/');
    await late.getByLabel('Username').fill(`hc${suffix}`);
    await late.getByLabel('Room code').fill('ZZZZZZ');
    await late.getByRole('button', { name: 'Join Room' }).click();
    await expect(late.getByRole('alert')).toContainText('Room not found');
    await late.getByLabel('Room code').fill(code);
    await late.getByRole('button', { name: 'Join Room' }).click();
    await expect(late.locator('.room-code')).toHaveText(code);
    await late.getByTestId('quit-auction').click();
    await late.getByTestId('quit-auction-confirm').click();

    await page.getByRole('button', { name: 'Start auction' }).click();
    await expect(page.locator('.pcard-large')).toBeVisible();
    await expect(second.locator('.pcard-large')).toBeVisible();
    const cardId = await page.locator('.pcard-large').getAttribute('data-card-id');
    await expect(second.locator('.pcard-large')).toHaveAttribute('data-card-id', cardId);

    await late.goto('/');
    await late.getByLabel('Username').fill(`hd${suffix}`);
    await late.getByLabel('Room code').fill(code);
    await late.getByRole('button', { name: 'Join Room' }).click();
    await expect(late.getByRole('alert')).toContainText('closed');

    const minimum = (await second.locator('.metric').nth(2).locator('.metric-value').innerText()).replace(/[^\d]/g, '');
    await second.getByLabel('Bid amount').fill(minimum);
    await second.getByRole('button', { name: 'Place bid' }).click();
    await expect(page.locator('.metric-note').filter({ hasText: `hb${suffix}` })).toBeVisible();
    const ready = second.getByRole('button', { name: "I'm ready" });
    await expect(ready).toBeVisible({ timeout: 15000 });
    const seated = async () => {
      const body = await (await page.request.get(`${backend}/api/room/${code}`)).json();
      return body.players.find((player) => player.username === `hb${suffix}`);
    };
    const winner = await seated();
    expect(winner.balance).toBeLessThan(1000);
    expect(winner.isHost).toBe(false);

    await second.reload();
    await expect(second.getByRole('button', { name: "I'm ready" })).toBeVisible();

    await page.getByTestId('quit-auction').click();
    await page.getByTestId('quit-auction-confirm').click();
    await expect(page.getByRole('heading', { name: 'Football Auction' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Football Auction' })).toBeVisible();
    await expect(second.getByRole('button', { name: "I'm ready" })).toBeVisible();
    const continuing = await seated();
    expect(continuing.balance).toBe(winner.balance);
    expect(continuing.isHost).toBe(true);

    await page.getByLabel('Username').fill(`ha${suffix}`);
    await page.getByRole('button', { name: 'Create Room' }).click();
    const nextCode = (await page.locator('.room-code').innerText()).trim();
    expect(nextCode).not.toBe(code);
    await second.getByRole('button', { name: "I'm ready" }).click();
    await expect(second.getByLabel('Bid amount')).toBeVisible();
    await expect(second.locator('.pcard-large')).not.toHaveAttribute('data-card-id', cardId);

    await closed.close();
    await other.close();
  });

  test('plays a match from two saved local test squads and keeps the score', async ({ page, browser }) => {
    test.setTimeout(240000);
    page.on('dialog', (dialog) => dialog.accept());
    const other = await browser.newContext();
    const second = await other.newPage();
    second.on('dialog', (dialog) => dialog.accept());
    const suffix = Date.now().toString().slice(-6);

    await page.goto('/');
    await page.getByLabel('Username').fill(`ma${suffix}`);
    await page.getByRole('button', { name: 'Create Room' }).click();
    const code = (await page.locator('.room-code').innerText()).trim();
    await second.goto('/');
    await second.getByLabel('Username').fill(`mb${suffix}`);
    await second.getByLabel('Room code').fill(code);
    await second.getByRole('button', { name: 'Join Room' }).click();
    await page.getByRole('button', { name: 'Start auction' }).click();

    const lineup = async (target) => target.getByRole('heading', { name: 'Lineup' }).isVisible();
    for (let index = 0; index < 22; index += 1) {
      if (await lineup(page) && await lineup(second)) break;
      const buyer = index % 2 === 0 ? page : second;
      const partner = index % 2 === 0 ? second : page;
      await expect(buyer.getByLabel('Bid amount')).toBeVisible({ timeout: 20000 });
      const minimum = (await buyer.locator('.metric').nth(2).locator('.metric-value').innerText()).replace(/[^\d]/g, '');
      await buyer.getByLabel('Bid amount').fill(minimum);
      await buyer.getByRole('button', { name: 'Place bid' }).click();
      await expect.poll(async () => {
        if (await lineup(buyer)) return 'lineup';
        if (await buyer.getByRole('button', { name: "I'm ready" }).isVisible()) return 'ready';
        return 'wait';
      }, { timeout: 20000 }).not.toBe('wait');
      if (await lineup(buyer)) break;
      if (await partner.getByRole('button', { name: "I'm ready" }).isVisible()) {
        await partner.getByRole('button', { name: "I'm ready" }).click();
      }
      await buyer.getByRole('button', { name: "I'm ready" }).click();
    }

    async function confirmSquad(target) {
      await expect(target.getByRole('heading', { name: 'Lineup' })).toBeVisible({ timeout: 20000 });
      for (let placed = 0; placed < 11; placed += 1) {
        const empty = target.getByRole('button', { name: /, empty$/ });
        const before = await empty.count();
        await target.locator('.bench-card').first().click();
        await empty.first().click();
        await expect.poll(async () => empty.count()).toBeLessThan(before);
      }
      const confirm = target.getByRole('button', { name: 'Confirm lineup' });
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await expect(target.getByRole('heading', { name: 'Squads' })).toBeVisible();
    }

    await confirmSquad(page);
    await confirmSquad(second);
    await expect(page.getByRole('button', { name: 'Take squad to a league' })).toBeVisible();
    await expect(second.getByRole('button', { name: 'Take squad to a league' })).toBeVisible();
    await page.getByTestId('play-match').click();
    await expect(page.getByTestId('match-score')).toBeVisible({ timeout: 20000 });
    const score = (await page.getByTestId('match-score').innerText()).trim();
    await expect(second.getByTestId('match-score')).toHaveText(score);
    expect(score).toMatch(/ma\S+ \d+ – \d+ mb/);
    await page.reload();
    await expect(page.getByTestId('match-score')).toHaveText(score);
    await second.reload();
    await expect(second.getByTestId('match-score')).toHaveText(score);

    await other.close();
  });
});
