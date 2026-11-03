import assert from 'node:assert/strict';
import fs from 'fs';
import { isDeepStrictEqual } from 'node:util';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';
import { chooseCatalog, isFifaCatalogCard } from '../catalog.js';
import { auctionEligible, playerIdForRecord } from '../players/catalogue-adapter.js';
import { applyFut23Import, createMemoryCatalogue } from '../players/fut23-apply.js';
import {
  buildFut23Plan,
  expectedPlayerId,
  fut23CardId,
  Fut23PlanError
} from '../players/fut23-plan.js';
import { defaultFut23Paths, loadFut23Sources } from '../players/fut23-sources.js';
import { cardArtNameKey } from '../../shared/player-card-art.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const NOW = '2026-11-01T00:00:00.000Z';

function master(name, status = 'name_group_consistent', reason = '') {
  const normalizedName = cardArtNameKey(name);
  return {
    draft11_player_id: expectedPlayerId(normalizedName),
    display_name: name,
    name_normalized: normalizedName,
    identity_status: status,
    identity_review_reason: reason,
    nationality: '',
    club_name: null,
    league_name: '',
    age: '',
    sofifa_id: ''
  };
}

function csvRow(rowNumber, name, overall, position, version, stats = {}) {
  return {
    rowNumber,
    Name: name,
    RAT: String(overall),
    POS: position,
    VER: version,
    PAC: stats.pac ?? '80',
    SHO: stats.sho ?? '81',
    PAS: stats.pas ?? '82',
    DRI: stats.dri ?? '83',
    DEF: stats.def ?? '84',
    PHY: stats.phy ?? '85'
  };
}

function workbookCard(rowNumber, name, representative) {
  const normalizedName = cardArtNameKey(name);
  return {
    source_row_number: rowNumber,
    source_card_id: fut23CardId(rowNumber),
    draft11_player_id: expectedPlayerId(normalizedName),
    name_normalized: normalizedName,
    is_representative: representative ? 'yes' : 'no'
  };
}

function sampleInput(overrides = {}) {
  const haaland = 'Erling Haaland';
  const quiet = 'Quiet Player';
  return {
    now: NOW,
    liveCards: [
      { id: 'fifa_158023', name: 'L. Messi', longName: 'Lionel Andrés Messi Cuccittini' },
      { id: 'fifa_20801', name: 'Cristiano Ronaldo', longName: 'Cristiano Ronaldo dos Santos Aveiro' },
      { id: 'fifa_99999', name: 'A. Nobody', longName: 'Absent Nobody' }
    ],
    legacyCards: [
      { id: 'card_00001', name: 'Pelé' }
    ],
    masterRows: [
      master('Lionel Messi'),
      master('Cristiano Ronaldo', 'needs_identity_review', 'Several Ronaldo cards share a short name.'),
      master(haaland),
      master(quiet),
      master('Mystery Striker', 'needs_identity_review', 'Name collides with another striker.')
    ],
    csvRecords: [
      csvRow(10, 'Lionel Messi', 99, 'RW  CF', 'Futties', { pac: '97' }),
      csvRow(11, 'Cristiano Ronaldo', 99, 'ST', 'Futties'),
      csvRow(20, haaland, 94, 'ST', 'Gold', { sho: '95' }),
      csvRow(21, haaland, 91, 'ST  LW', 'Rulebreakers', { sho: '92', def: '' }),
      csvRow(30, quiet, 86, 'GK', 'Gold', { pac: '48' }),
      csvRow(40, 'Mystery Striker', 88, 'ST', 'Gold'),
      csvRow(2, 'Low Player', 70, 'CB', 'Gold')
    ],
    workbookCards: [
      workbookCard(10, 'Lionel Messi', true),
      workbookCard(11, 'Cristiano Ronaldo', true),
      workbookCard(20, haaland, true),
      workbookCard(21, haaland, false),
      workbookCard(30, quiet, true),
      workbookCard(40, 'Mystery Striker', true)
    ],
    imageFiles: [
      'fut23_erling_haaland_primary.webp',
      'fut23_erling_haaland_card_02.webp',
      'fut23_erling_haalander_primary.webp'
    ],
    ...overrides
  };
}

function planOf(overrides) {
  return buildFut23Plan(sampleInput(overrides));
}

describe('FIFA 23 catalogue plan', () => {
  it('keeps one player id across card versions and repeats the same ids', () => {
    const first = planOf();
    const second = planOf();
    assert.deepEqual(first.players.map((player) => player.playerId), [
      'fut23_erling_haaland',
      'fut23_quiet_player'
    ]);
    assert.equal(first.cards.filter((card) => card.playerId === 'fut23_erling_haaland').length, 2);
    assert.deepEqual(
      first.cards.filter((card) => card.playerId === 'fut23_erling_haaland').map((card) => card.cardId),
      ['fut23row_000020', 'fut23row_000021']
    );
    assert.equal(first.players.find((player) => player.playerId === 'fut23_erling_haaland').primaryCardId, 'fut23row_000020');
    assert.equal(isDeepStrictEqual(first, second), true);
    assert.equal(fut23CardId(18), 'fut23row_000018');
  });

  it('leaves the live 45-style ids and legacy card ids out of the insert', () => {
    const plan = planOf();
    const ids = new Set([...plan.players.map((player) => player.playerId), ...plan.cards.map((card) => card.cardId)]);
    assert.equal(ids.has('fifa_158023'), false);
    assert.equal(ids.has('fifa_20801'), false);
    assert.equal(ids.has('fifa_99999'), false);
    assert.equal(ids.has('card_00001'), false);
    assert.equal(plan.alreadyLive.map((player) => player.liveCardId).sort().join(), 'fifa_158023,fifa_20801');
    assert.equal(playerIdForRecord({ id: 'fifa_158023', name: 'L. Messi' }), 'fifa_158023');
    assert.equal(playerIdForRecord({ id: 'card_00001', name: 'Pelé' }), 'card_00001');
    assert.equal(playerIdForRecord(plan.cards[0]), plan.cards[0].playerId);
    assert.equal(auctionEligible({ id: 'fifa_158023' }), true);
    assert.equal(isFifaCatalogCard({ id: 'fut23row_000020' }), false);
    assert.equal(auctionEligible({ id: 'fut23_erling_haaland' }), false);
    assert.equal(auctionEligible({ id: 'fut23_erling_haaland', imageCatalogue: true }), true);
    const chosen = chooseCatalog({
      mongoCards: [
        { id: 'card_00001', name: 'Pelé' },
        { id: 'fifa_158023', name: 'L. Messi' },
        { id: 'fut23row_000020', name: 'Erling Haaland' }
      ],
      fileCards: [{ id: 'fifa_158023', name: 'File Messi' }],
      imageCards: [{
        id: 'fut23_erling_haaland',
        name: 'Erling Haaland',
        imageCatalogue: true,
        cardArtUrl: '/player-cards/fut23_erling_haaland_primary.webp'
      }]
    });
    assert.deepEqual(chosen.auction.map((card) => card.id), ['fut23_erling_haaland']);
    assert.equal(chosen.recovery.some((card) => card.id === 'fifa_158023'), true);
    assert.equal(chosen.recovery.some((card) => card.id === 'card_00001'), true);
  });

  it('excludes identity-review players and leaves missing biography blank', () => {
    const plan = planOf();
    assert.deepEqual(plan.excludedReview.map((player) => player.playerId), ['fut23_mystery_striker']);
    assert.equal(plan.players.some((player) => player.playerId === 'fut23_mystery_striker'), false);
    assert.equal(plan.cards.some((card) => card.playerId === 'fut23_cristiano_ronaldo'), false);
    const quiet = plan.players.find((player) => player.playerId === 'fut23_quiet_player');
    assert.equal(quiet.nationality, null);
    assert.equal(quiet.club, null);
    assert.equal(quiet.league, null);
    assert.equal(quiet.age, null);
    assert.equal(quiet.sofifaId, null);
    assert.equal(quiet.sourcePlayerId, null);
    const keeper = plan.cards.find((card) => card.playerId === 'fut23_quiet_player');
    assert.equal(keeper.position, 'GK');
    assert.equal(keeper.goalkeeperAttributes, null);
    assert.equal(keeper.pace, 48);
    const alternate = plan.cards.find((card) => card.cardId === 'fut23row_000021');
    assert.equal(alternate.overallRating, 91);
    assert.equal(alternate.shooting, 92);
    assert.equal(alternate.defending, null);
    assert.deepEqual(alternate.alternatePositions, ['LW']);
    assert.equal(alternate.cardType, 'Rulebreakers');
    assert.notEqual(alternate.overallRating, plan.cards.find((card) => card.cardId === 'fut23row_000020').overallRating);
  });

  it('maps an exact player-id image and leaves a missing or similar-name image blank', () => {
    const plan = planOf();
    const haalandCards = plan.cards.filter((card) => card.playerId === 'fut23_erling_haaland');
    assert.equal(haalandCards.find((card) => card.isPrimary).imagePath, '/player-cards/fut23_erling_haaland_primary.webp');
    assert.equal(haalandCards.find((card) => !card.isPrimary).imagePath, '/player-cards/fut23_erling_haaland_card_02.webp');
    assert.equal(plan.cards.some((card) => String(card.imagePath).includes('haalander')), false);
    const quiet = plan.players.find((player) => player.playerId === 'fut23_quiet_player');
    assert.equal(quiet.imageStatus, 'missing');
    assert.equal(plan.cards.find((card) => card.playerId === quiet.playerId).imagePath, null);
    assert.equal(plan.players.find((player) => player.playerId === 'fut23_erling_haaland').imageStatus, 'present_unapproved');
    assert.equal(JSON.stringify(plan).includes('photoApproved'), false);
    assert.equal(JSON.stringify(plan).includes('cardArtApproved'), false);
  });

  it('stops when the reconciliation workbook disagrees', () => {
    assert.throws(
      () => planOf({ reconciliation: { safeIds: ['fut23_someone_else'], reviewIds: [], liveMasterIds: [] } }),
      (err) => err instanceof Fut23PlanError && err.code === 'RECONCILIATION_MISMATCH'
    );
  });

  it('rejects a duplicate player identity', () => {
    const input = sampleInput();
    input.masterRows.push(master('Erling Haaland'));
    assert.throws(() => buildFut23Plan(input), (err) => err.code === 'DUPLICATE_PLAYER');
  });
});

describe('FIFA 23 import apply', () => {
  it('is idempotent and does not touch auction or league references', async () => {
    const plan = planOf();
    const protectedState = {
      cards: ['fifa_158023', 'card_00001'],
      leagues: [{ member: 'Ada', cardIds: ['fifa_158023'] }],
      fixtures: [{ result: { cards: ['card_00001'] } }],
      handoffs: [{ cardIds: ['fifa_158023'] }]
    };
    const store = createMemoryCatalogue({ protectedState });
    const first = await applyFut23Import(store, plan, { protectedIds: protectedState.cards });
    assert.equal(first.ok, true);
    assert.equal(first.written, true);
    assert.equal(first.insertPlayers.length, 2);
    assert.equal(first.insertCards.length, 3);
    const second = await applyFut23Import(store, plan, { protectedIds: protectedState.cards });
    assert.equal(second.ok, true);
    assert.equal(second.written, false);
    assert.equal(second.skipPlayers.length, 2);
    assert.equal(second.skipCards.length, 3);
    assert.equal((await store.readPlayers()).length, 2);
    assert.deepEqual(await store.readProtected(), protectedState);
    assert.equal(store.writes.every((name) => name === 'catalogue_players' || name === 'player_cards'), true);
  });

  it('stops when an existing id belongs to a different person', async () => {
    const plan = planOf();
    const store = createMemoryCatalogue({
      players: [{
        playerId: 'fut23_erling_haaland',
        name: 'Other Haaland',
        normalizedName: 'other haaland',
        createdAt: NOW,
        updatedAt: NOW
      }]
    });
    const result = await applyFut23Import(store, plan);
    assert.equal(result.ok, false);
    assert.equal(result.written, false);
    assert.equal(result.code, 'IDENTITY_CONFLICT');
    assert.equal((await store.readPlayers())[0].name, 'Other Haaland');
    assert.equal((await store.readCards()).length, 0);
  });

  it('rolls back a failed import', async () => {
    const plan = planOf();
    const store = createMemoryCatalogue();
    const result = await applyFut23Import(store, plan, {
      afterPlayerWrites() {
        throw new Error('disk full');
      }
    });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, true);
    assert.equal((await store.readPlayers()).length, 0);
    assert.equal((await store.readCards()).length, 0);
  });
});

describe('FIFA 23 command', () => {
  it('does not call the destructive seed replace path', () => {
    const source = fs.readFileSync(new URL('../players/fut23-import-cli.js', import.meta.url), 'utf8');
    assert.equal(source.includes('seed.js'), false);
    assert.match(source, /REPLACE_REFUSED/);
    assert.match(source, /--confirm/);
  });
});

describe('FIFA 23 source reconciliation', () => {
  const paths = defaultFut23Paths(repoRoot);
  const ready = [paths.csv, paths.workbook, paths.reconciliation, paths.liveCards, paths.legacyCards, paths.images]
    .every((file) => fs.existsSync(file));

  it('matches the workbook, csv, live catalogue, and image folder', { skip: !ready }, async () => {
    const loaded = await loadFut23Sources(paths);
    const plan = buildFut23Plan({ ...loaded, now: NOW });
    const summary = plan.summary;
    assert.equal(summary.masterPlayers, 949);
    assert.equal(summary.eligiblePlayers, 880);
    assert.equal(summary.excludedReview, 35);
    assert.equal(summary.alreadyLive, 34);
    assert.equal(summary.liveCards, 45);
    assert.equal(summary.legacyCards, 885);
    assert.equal(summary.rowsAt85, 2225);
    assert.equal(summary.normalizedNamesAt85, 949);
    assert.equal(summary.masterExtraCardVersions, 1276);
    assert.equal(summary.imageFiles, 1182);
    assert.equal(summary.distinctImagePlayers, 578);
    assert.equal(summary.playersWithImages, 560);
    assert.equal(summary.playersWithoutImages, 320);
    assert.equal(summary.biographyBlankOnMaster, true);
    assert.equal(summary.eligiblePlayers, summary.playersWithImages + summary.playersWithoutImages);
    assert.equal(plan.players.length, 880);
    assert.equal(new Set(plan.players.map((player) => player.playerId)).size, 880);
    assert.equal(new Set(plan.cards.map((card) => card.cardId)).size, plan.cards.length);
    assert.equal(plan.cards.length, summary.importedCards);
    assert.equal(summary.extraCardVersions, plan.cards.length - plan.players.length);
    const liveIds = new Set(loaded.liveCards.map((card) => card.id));
    const legacyIds = new Set(loaded.legacyCards.map((card) => card.id));
    assert.equal([...liveIds].every((id) => isFifaCatalogCard({ id })), true);
    assert.equal([...legacyIds].every((id) => /^card_\d+$/.test(id)), true);
    for (const player of plan.players) {
      assert.equal(player.nationality, null);
      assert.equal(player.club, null);
      assert.equal(player.league, null);
      assert.equal(player.age, null);
      assert.equal(player.sofifaId, null);
      assert.equal(liveIds.has(player.playerId), false);
      const own = plan.cards.filter((card) => card.playerId === player.playerId);
      assert.equal(own.length >= 1, true);
      assert.equal(own.filter((card) => card.isPrimary).length, 1);
      assert.equal(player.primaryCardId, own.find((card) => card.isPrimary).cardId);
    }
    for (const card of plan.cards) {
      assert.equal(card.goalkeeperAttributes, null);
      assert.equal(isFifaCatalogCard(card), false);
      assert.equal(liveIds.has(card.cardId), false);
      assert.equal(legacyIds.has(card.cardId), false);
      if (card.imagePath) {
        const filename = card.imagePath.slice('/player-cards/'.length);
        assert.equal(filename.startsWith(`${card.playerId}_`), true);
        assert.equal(fs.existsSync(fileURLToPath(new URL(`../../frontend/public/player-cards/${filename}`, import.meta.url))), true);
      }
    }
    const again = buildFut23Plan({ ...loaded, now: NOW });
    assert.equal(isDeepStrictEqual(plan.players, again.players), true);
    assert.equal(isDeepStrictEqual(plan.cards, again.cards), true);
  });
});
