import { expect, test } from '@playwright/test';

const STATS = ['overall', 'pace', 'shooting', 'passing', 'defense', 'physical'];

async function readCards(locator) {
  const cards = await locator.evaluateAll((nodes) => nodes.map((node) => ({
    id: node.getAttribute('data-card-id'),
    name: node.getAttribute('data-name'),
    overall: node.getAttribute('data-overall'),
    pace: node.getAttribute('data-pace'),
    shooting: node.getAttribute('data-shooting'),
    passing: node.getAttribute('data-passing'),
    defense: node.getAttribute('data-defense'),
    physical: node.getAttribute('data-physical')
  })));
  return cards.sort((left, right) => left.id.localeCompare(right.id));
}

async function ownSquad(page) {
  return page.locator('.panel').filter({ has: page.getByRole('heading', { name: /\(You\)/ }) });
}

async function captureSquad(page) {
  const panel = await ownSquad(page);
  await expect(panel.getByTestId('own-squad-summary')).toBeVisible();
  return {
    summary: (await panel.getByTestId('own-squad-summary').innerText()).trim(),
    cards: await readCards(panel.locator('[data-card-id]'))
  };
}

async function buyCard(buyer, passer) {
  const bid = buyer.getByLabel('Bid amount');
  const done = buyer.getByRole('heading', { name: 'Lineup' });
  await expect(bid.or(done)).toBeVisible();
  if (await done.isVisible()) return false;
  await expect(passer.getByRole('button', { name: 'Skip card' })).toBeVisible();
  await passer.getByRole('button', { name: 'Skip card' }).click();
  await bid.fill('50');
  await buyer.getByRole('button', { name: 'Place bid' }).click();
  const ready = buyer.getByRole('button', { name: "I'm ready" });
  const passerReady = passer.getByRole('button', { name: "I'm ready" });
  await expect(ready.or(done)).toBeVisible();
  if (await done.isVisible()) return false;
  await expect(passerReady).toBeVisible();
  await buyer.getByRole('button', { name: "I'm ready" }).click();
  await passer.getByRole('button', { name: "I'm ready" }).click();
  return true;
}

async function fillAndConfirm(page) {
  await page.getByRole('button', { name: 'Edit lineup' }).click();
  await expect(page.getByRole('heading', { name: 'Lineup' })).toBeVisible();
  for (let placed = 0; placed < 11; placed += 1) {
    await page.locator('.bench-card').first().click();
    await page.locator('[aria-label$=", empty"]').first().click();
    await expect(page.getByText(`${placed + 1}/11`, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Confirm XI for this match' }).click();
}

test('an 11-card auction squad links into a league and the fixture is saved', async ({ browser }) => {
  const stamp = Date.now().toString().slice(-6);
  const adaContext = await browser.newContext();
  const beaContext = await browser.newContext();
  const ada = await adaContext.newPage();
  const bea = await beaContext.newPage();
  ada.on('dialog', (dialog) => dialog.accept());
  bea.on('dialog', (dialog) => dialog.accept());

  try {
    await ada.goto('/');
    await ada.getByLabel('Username').fill(`Ada${stamp}`);
    await ada.getByRole('button', { name: 'Create Room' }).click();
    const roomCode = (await ada.locator('.room-code').innerText()).trim();

    await bea.goto('/');
    await bea.getByLabel('Username').fill(`Bea${stamp}`);
    await bea.getByLabel('Room code').fill(roomCode);
    await bea.getByRole('button', { name: 'Join Room' }).click();
    await expect(ada.getByText(`Bea${stamp}`)).toBeVisible();
    await ada.getByRole('button', { name: 'Start auction' }).click();

    for (let card = 0; card < 11; card += 1) {
      expect(await buyCard(ada, bea)).toBe(true);
    }
    for (let card = 0; card < 11; card += 1) {
      expect(await buyCard(bea, ada)).toBe(true);
    }
    await expect(ada.getByRole('heading', { name: 'Lineup' })).toBeVisible();
    await expect(bea.getByRole('heading', { name: 'Lineup' })).toBeVisible();

    await ada.getByRole('button', { name: 'Review squads' }).click();
    await bea.getByRole('button', { name: 'Review squads' }).click();
    const adaAuction = await captureSquad(ada);
    const beaAuction = await captureSquad(bea);
    expect(adaAuction.cards).toHaveLength(11);
    expect(beaAuction.cards).toHaveLength(11);
    const beaIds = new Set(beaAuction.cards.map((card) => card.id));
    expect(adaAuction.cards.some((card) => beaIds.has(card.id))).toBe(false);
    const adaRoom = ada.url();
    const beaRoom = bea.url();

    await ada.getByRole('button', { name: 'Take squad to a league' }).click();
    await ada.getByLabel('Manager name').fill(`Ada${stamp}`);
    await ada.getByLabel('League name').fill(`Cup ${stamp}`);
    await ada.getByRole('button', { name: 'Create league' }).click();
    const invite = ada.getByTestId('league-invite');
    await expect(invite).toBeVisible();
    const code = (await invite.innerText()).trim();
    await ada.getByRole('button', { name: 'Register auction squad' }).click();
    await expect(ada.getByTestId('league-squad')).toBeVisible();

    await bea.getByRole('button', { name: 'Take squad to a league' }).click();
    await bea.getByLabel('Manager name').fill(`Bea${stamp}`);
    await bea.getByLabel('Invite code').fill(code);
    await bea.getByRole('button', { name: 'Join league' }).click();
    await expect(bea.getByRole('heading', { name: `Cup ${stamp}` })).toBeVisible();
    await bea.getByRole('button', { name: 'Register auction squad' }).click();
    await expect(bea.getByTestId('league-squad')).toBeVisible();

    const adaImported = await readCards(ada.getByTestId('league-squad').locator('[data-card-id]'));
    const beaImported = await readCards(bea.getByTestId('league-squad').locator('[data-card-id]'));
    expect(adaImported).toEqual(adaAuction.cards);
    expect(beaImported).toEqual(beaAuction.cards);
    for (const card of [...adaImported, ...beaImported]) {
      expect(card.id).toMatch(/^fut23_/);
    }

    await ada.goto(adaRoom);
    await bea.goto(beaRoom);
    for (const page of [ada, bea]) {
      const lineup = page.getByRole('heading', { name: 'Lineup' });
      const squads = page.getByRole('heading', { name: 'Squads' });
      await expect(lineup.or(squads)).toBeVisible();
      if (await lineup.isVisible()) await page.getByRole('button', { name: 'Review squads' }).click();
    }
    expect(await captureSquad(ada)).toEqual(adaAuction);
    expect(await captureSquad(bea)).toEqual(beaAuction);

    await ada.getByRole('button', { name: 'Take squad to a league' }).click();
    await bea.getByRole('button', { name: 'Take squad to a league' }).click();
    await expect(ada.getByRole('heading', { name: `Cup ${stamp}` })).toBeVisible();
    await expect(bea.getByRole('heading', { name: `Cup ${stamp}` })).toBeVisible();
    await expect(ada.getByRole('button', { name: 'Register auction squad' })).toHaveCount(0);
    await ada.getByRole('button', { name: 'Schedule season' }).click();
    await expect(ada.getByTestId('league-round')).toHaveText('Round 1');
    await expect(bea.getByTestId('league-round')).toHaveText('Round 1');

    await fillAndConfirm(ada);
    await expect(ada.getByText('XI confirmed')).toHaveCount(1);
    await expect(ada.getByRole('button', { name: 'Simulate match' })).toBeDisabled();
    await fillAndConfirm(bea);
    await expect(ada.getByText('XI confirmed')).toHaveCount(2);
    await expect(bea.getByText('XI confirmed')).toHaveCount(2);

    const simulate = ada.getByRole('button', { name: 'Simulate match' });
    await expect(simulate).toBeEnabled();
    await simulate.click();
    const score = ada.locator('.league-list').getByText(/\d+–\d+/).first();
    await expect(score).toBeVisible();
    const scoreText = (await score.innerText()).trim();
    const [homeGoals, awayGoals] = scoreText.split('–').map((value) => Number(value));
    const standings = ada.locator('section').filter({ has: ada.getByRole('heading', { name: 'Standings' }) });
    if (homeGoals === awayGoals) {
      await expect(standings.getByText('1 pts')).toHaveCount(2);
    } else {
      await expect(standings.getByText('3 pts')).toHaveCount(1);
      await expect(standings.getByText('0 pts')).toHaveCount(1);
    }
    const points = await standings.locator('strong').allTextContents();
    await expect(ada.getByText('The season is complete. Standings are final.')).toBeVisible();

    await ada.reload();
    await expect(ada.locator('.league-list').getByText(/\d+–\d+/).first()).toHaveText(scoreText);
    await expect(standings.locator('strong')).toHaveText(points);
    await expect(ada.getByTestId('league-squad').locator('[data-card-id]')).toHaveCount(11);
    const restored = await readCards(ada.getByTestId('league-squad').locator('[data-card-id]'));
    expect(restored).toEqual(adaImported);
    await expect(bea.locator('.league-list').getByText(/\d+–\d+/).first()).toHaveText(scoreText);
  } finally {
    await adaContext.close();
    await beaContext.close();
  }
});
