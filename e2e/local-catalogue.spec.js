import { test, expect } from '@playwright/test';

const backend = `http://127.0.0.1:${process.env.E2E_BACKEND_PORT || '3025'}`;

test.describe('local image catalogue', () => {
  test('serves every selected card image and renders catalogue, selection, and squad', async ({ page }, testInfo) => {
    test.setTimeout(240000);
    const response = await page.request.get(`${backend}/api/local-catalogue`);
    expect(response.ok()).toBeTruthy();
    const body = await response.json();
    expect(body.liveAuctionActivated).toBe(false);
    expect(body.auctionEligible).toBe(false);
    expect(body.count).toBe(1009);
    expect(body.audit.imagesServed).toBe(1009);
    expect(body.audit.missingImageFiles).toBe(0);
    expect(body.audit.brokenPaths).toBe(0);
    expect(body.audit.duplicateImageAssignments).toBe(0);
    expect(body.players).toHaveLength(1009);
    expect(body.players.every((player) => player.auctionEligible === false && player.cardArtUrl)).toBe(true);

    await page.goto('/catalogue');
    if (testInfo.project.name === 'desktop') {
      const urls = [...new Set(body.players.map((player) => player.cardArtUrl))];
      const broken = [];
      let cursor = 0;
      async function next() {
        while (cursor < urls.length) {
          const url = urls[cursor];
          cursor += 1;
          const image = await page.request.get(url);
          const type = image.headers()['content-type'] || '';
          if (!image.ok() || !type.startsWith('image/')) broken.push(url);
        }
      }
      await Promise.all(Array.from({ length: 16 }, () => next()));
      expect(broken).toEqual([]);

      const decoded = await page.evaluate(async (list) => {
        const failed = [];
        let index = 0;
        async function worker() {
          while (index < list.length) {
            const url = list[index];
            index += 1;
            const ok = await new Promise((resolve) => {
              const img = new Image();
              img.onload = () => resolve(img.naturalWidth > 0 && img.naturalHeight > 0);
              img.onerror = () => resolve(false);
              img.src = url;
            });
            if (!ok) failed.push(url);
          }
        }
        await Promise.all(Array.from({ length: 12 }, () => worker()));
        return failed;
      }, urls);
      expect(decoded).toEqual([]);
    }

    await expect(page.getByTestId('catalogue-count')).toHaveText('1009 players');
    const first = page.getByTestId('catalogue-card').first();
    await first.click();
    const detail = page.getByTestId('player-detail');
    await detail.scrollIntoViewIfNeeded();
    await expect(detail.locator('img.pcard-art')).toBeVisible();
    await expect(detail.locator('.pcard')).toHaveAttribute('data-card-art', 'shown');
    const box = await detail.locator('.pcard').boundingBox();
    expect(box.width).toBeGreaterThan(80);
    expect(box.height / box.width).toBeGreaterThan(1.2);
    expect(box.height / box.width).toBeLessThan(1.6);

    await page.getByTestId('add-to-squad').click();
    await expect(page.getByTestId('selection-tray').locator('img.pcard-art')).toBeVisible();
    const squad = page.getByTestId('squad-display');
    await expect(squad.locator('.pcard').first()).toBeVisible();
    await squad.locator('.pcard').first().scrollIntoViewIfNeeded();
    await expect(squad.locator('.pcard').first()).toHaveAttribute('data-card-art', 'shown');
    const auction = page.getByTestId('auction-card');
    await auction.scrollIntoViewIfNeeded();
    await expect(auction.locator('.pcard')).toHaveAttribute('data-card-art', 'shown');
    await expect(page.getByTestId('art-fallbacks')).toContainText('No fallback cards');

    const live = await page.request.get(`${backend}/api/cards`);
    const liveBody = await live.json();
    expect(liveBody.count).toBe(1009);
    const renderedIds = await page.locator('[data-testid="catalogue-card"]').evaluateAll((nodes) => (
      nodes.map((node) => node.getAttribute('data-player-id'))
    ));
    expect(renderedIds).toHaveLength(1009);
    expect(new Set(renderedIds).size).toBe(renderedIds.length);
    expect(liveBody.cards.every((card) => String(card.id).startsWith('fut23_'))).toBe(true);
  });

  test('Carvajal appears once, as the highest selected card', async ({ page }) => {
    await page.goto('/catalogue');
    await page.getByLabel('Search').fill('Carvajal');
    const cards = page.getByTestId('catalogue-card');
    await expect(cards).toHaveCount(1);
    await expect(cards).toHaveAttribute('data-player-id', 'fut23_ca_al');
    await expect(cards.getByTestId('card-caption')).toContainText('Carvajal');
    await expect(cards.getByTestId('card-caption')).toContainText('96');
    await expect(cards.getByTestId('card-caption')).toContainText('RB');
  });

  test('the Romagnoli card shows the name, rating and position printed on the artwork', async ({ page }) => {
    await page.goto('/catalogue');
    await page.getByLabel('Search').fill('Romagnoli');
    const card = page.locator('[data-testid="catalogue-card"][data-player-id="fut23_fts"]');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('card-caption')).toContainText('Romagnoli');
    await expect(card.getByTestId('card-caption')).toContainText('91');
    await expect(card.getByTestId('card-caption')).toContainText('CB');
    await card.click();
    await expect(page.getByTestId('detail-name')).toHaveText('Alessio Romagnoli');
    await expect(page.getByTestId('detail-overall')).toHaveText('91');
    await expect(page.getByTestId('detail-position')).toHaveText('CB');
    await expect(page.getByTestId('detail-nationality')).toHaveText('Italy');
    await expect(page.getByTestId('detail-club')).toContainText('crest');
    await expect(page.getByTestId('detail-attributes')).toContainText('PAC 86');
    await expect(page.getByTestId('detail-attributes')).toContainText('DRI 78');
    await expect(page.getByTestId('player-detail').locator('img.pcard-art')).toBeVisible();
  });
});
