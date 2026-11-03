import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'url';
import { chooseCatalog } from '../catalog.js';
import { AuctionEngine } from '../auction-engine.js';
import { CardDeckManager } from '../card-deck-manager.js';
import { simulateMatch } from '../match-simulator.js';
import { presentCard, cardArtFileExistsIn } from '../public-card.js';
import { RoomManager } from '../room-manager.js';
import { captureLiveRoom, materializeLiveRoom } from '../room-snapshot.js';
import { commitBuiltTeam } from '../squad-service.js';
import { readStoredCatalogue } from '../players/local-catalogue.js';
import { partitionSelectedCards } from '../players/selected-card-partition.js';
import { UNRATED_OPENING_PRICE, buildLiveImagePool, servableCardArt } from '../players/live-image-pool.js';
import { evaluateSquad } from '../../shared/squad-evaluation.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const catalogueFile = path.join(repoRoot, 'data', 'local-catalogue', 'catalogue.json');
const cardArtRoot = path.join(repoRoot, 'frontend', 'public', 'player-cards');

function identity(playerId, name, card) {
  return {
    players: [{
      playerId,
      name,
      primaryCardId: card.cardId,
      nationality: card.nationality ?? null,
      club: null,
      league: null
    }],
    cards: [card]
  };
}

describe('live image auction pool', () => {
  it('keeps incomplete cards and does not invent a missing rating', () => {
    const stored = {
      players: [
        {
          playerId: 'fut23_rated',
          name: 'Rated Player',
          primaryCardId: 'fut23_rated_selected',
          nationality: 'France',
          club: null,
          league: null
        },
        {
          playerId: 'fut23_blank',
          name: 'Blank Player',
          primaryCardId: 'fut23_blank_selected',
          nationality: null,
          club: null,
          league: null
        }
      ],
      cards: [
        {
          cardId: 'fut23_rated_selected',
          playerId: 'fut23_rated',
          isPrimary: true,
          imageAssociation: 'selected-card',
          imagePath: '/player-cards/fut23_rated_primary.png',
          overallRating: 91,
          position: 'ST',
          pace: 90,
          shooting: 92,
          passing: null,
          dribbling: 88,
          defending: 40,
          physical: 80
        },
        {
          cardId: 'fut23_blank_selected',
          playerId: 'fut23_blank',
          isPrimary: true,
          imageAssociation: 'selected-card',
          imagePath: '/player-cards/fut23_blank_primary.png',
          overallRating: null,
          position: null,
          pace: null,
          shooting: null,
          passing: null,
          dribbling: null,
          defending: null,
          physical: null
        }
      ]
    };
    const pool = buildLiveImagePool(stored, { fileExists: () => true });
    assert.equal(pool.report.entered, 2);
    assert.equal(pool.report.excluded.length, 0);
    assert.equal(pool.report.auctionEligible, true);
    const rated = pool.cards.find((card) => card.id === 'fut23_rated');
    const blank = pool.cards.find((card) => card.id === 'fut23_blank');
    assert.equal(rated.basePriceSource, 'overall-band');
    assert.equal(rated.stats.overall, 91);
    assert.equal(rated.stats.passing, null);
    assert.equal(rated.auctionEligible, true);
    assert.equal(blank.basePrice, UNRATED_OPENING_PRICE);
    assert.equal(blank.basePriceSource, 'unrated-opening');
    assert.equal(blank.stats.overall, null);
    assert.equal(blank.position, null);
    assert.equal(blank.name, 'Blank Player');
    assert.equal(blank.cardArtUrl, '/player-cards/fut23_blank_primary.png');

    const presented = presentCard(blank, { cardArtEnabled: false });
    assert.equal(presented.auctionEligible, true);
    assert.equal(presented.imageCatalogue, true);
    assert.equal(presented.testAuction, undefined);
    assert.equal(presented.basePriceSource, 'unrated-opening');
    assert.equal(presented.stats.overall, null);
    assert.equal(presented.cardArtUrl, '/player-cards/fut23_blank_primary.png');
  });

  it('excludes a card whose image cannot be served and a fallback image', () => {
    const missing = buildLiveImagePool(identity('fut23_gone', 'Gone', {
      cardId: 'fut23_gone_selected',
      playerId: 'fut23_gone',
      isPrimary: true,
      imageAssociation: 'selected-card',
      imagePath: '/player-cards/fut23_gone_primary.png',
      overallRating: 80,
      position: 'CM'
    }), { fileExists: () => false });
    assert.equal(missing.report.entered, 0);
    assert.match(missing.report.excluded[0].reason, /missing/);

    const fallback = buildLiveImagePool(identity('fut23_silhouette', 'Silhouette', {
      cardId: 'fut23_silhouette_selected',
      playerId: 'fut23_silhouette',
      isPrimary: true,
      imageAssociation: 'fallback',
      imagePath: '/player-cards/fut23_silhouette_primary.png',
      overallRating: 80,
      position: 'CM'
    }), { fileExists: () => true });
    assert.equal(fallback.report.entered, 0);
    assert.match(fallback.report.excluded[0].reason, /not the selected card/);
  });

  it('keeps a matching FIFA card for recovery and does not auction it as well', () => {
    const pool = buildLiveImagePool(identity('fut23_erling_haaland', 'Haaland', {
      cardId: 'fut23_erling_haaland_selected',
      playerId: 'fut23_erling_haaland',
      isPrimary: true,
      imageAssociation: 'selected-card',
      imagePath: '/player-cards/fut23_erling_haaland_primary.png',
      overallRating: 91,
      position: 'ST'
    }), {
      fileExists: () => true,
      historicalCards: [{ id: 'fifa_158023', name: 'Haaland' }]
    });
    const fifa = {
      id: 'fifa_158023',
      name: 'Haaland',
      position: 'ST',
      basePrice: 25,
      category: 'LEGENDARY',
      stats: { overall: 91 }
    };
    const chosen = chooseCatalog({
      mongoCards: [fifa],
      fileCards: [fifa],
      imageCards: pool.cards
    });
    assert.deepEqual(chosen.auction.map((card) => card.id), ['fut23_erling_haaland']);
    assert.equal(chosen.recovery.some((card) => card.id === 'fifa_158023'), true);
    assert.deepEqual(pool.report.historicalOverlaps[0].historicalCardIds, ['fifa_158023']);
  });

  it('keeps two rooms on one engine without sharing bids', () => {
    const pool = buildLiveImagePool({
      players: [
        { playerId: 'fut23_one', name: 'One', primaryCardId: 'fut23_one_selected', nationality: null },
        { playerId: 'fut23_two', name: 'Two', primaryCardId: 'fut23_two_selected', nationality: null }
      ],
      cards: [
        {
          cardId: 'fut23_one_selected',
          playerId: 'fut23_one',
          isPrimary: true,
          imageAssociation: 'selected-card',
          imagePath: '/player-cards/fut23_one_primary.png',
          overallRating: null,
          position: null
        },
        {
          cardId: 'fut23_two_selected',
          playerId: 'fut23_two',
          isPrimary: true,
          imageAssociation: 'selected-card',
          imagePath: '/player-cards/fut23_two_primary.png',
          overallRating: 88,
          position: 'GK'
        }
      ]
    }, { fileExists: () => true });
    const decks = new CardDeckManager(pool.cards);
    const rooms = new RoomManager();
    const engine = new AuctionEngine();
    const first = rooms.createRoom();
    const second = rooms.createRoom();
    rooms.takeSeat(first, 'sock-a', 'ada');
    rooms.takeSeat(second, 'sock-b', 'bea');
    const deckA = decks.initializeRoomDeck(first);
    const deckB = decks.initializeRoomDeck(second);
    assert.equal(deckA.length, 2);
    assert.equal(deckB.length, 2);
    engine.startAuction(first, deckA, rooms.getRoom(first).players);
    engine.startAuction(second, deckB, rooms.getRoom(second).players);
    engine.presentNextCard(first);
    engine.presentNextCard(second);
    const opening = engine.getAuction(first).currentCard.basePrice;
    const bid = engine.processBid(first, 'sock-a', opening + 5);
    assert.equal(bid.success, true);
    assert.equal(engine.getAuction(second).highestBidder, null);
    assert.equal(engine.getAuction(second).bidHistory.length, 0);
    const saved = captureLiveRoom(rooms.getRoom(first), engine.getAuction(first));
    assert.equal(saved.auctionPool, undefined);
    const restored = materializeLiveRoom(saved, { catalog: new Map(pool.cards.map((card) => [card.id, card])) });
    assert.equal(restored.auction.currentCard.auctionEligible, true);
    assert.equal(restored.auction.currentCard.imageCatalogue, true);
  });

  it('evaluates and simulates a squad when attributes are missing', () => {
    const blank = {
      id: 'fut23_blank',
      name: '',
      position: null,
      basePrice: UNRATED_OPENING_PRICE,
      basePriceSource: 'unrated-opening',
      stats: {
        overall: null,
        pace: null,
        shooting: null,
        passing: null,
        dribbling: null,
        defense: null,
        physical: null
      }
    };
    const evaluation = evaluateSquad([blank], {
      formation: '4-3-3',
      slots: [{ slotId: 'st', cardId: blank.id }]
    });
    const placed = evaluation.slots.find((slot) => slot.slotId === 'st');
    assert.equal(placed.overall, null);
    assert.equal(placed.suitability, null);

    const roles = ['GK', 'CB', 'CB', 'CB', 'CM', 'CM', 'CM', 'CM', 'LW', 'ST', 'RW'];
    const owned = roles.map((role, index) => ({
      ...blank,
      id: `seat-${index}`,
      assignedPosition: role
    }));
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.takeSeat(code, 'sock-a', 'ada');
    for (const card of owned) rooms.addCardToTeam(code, 'sock-a', card);
    const built = commitBuiltTeam(rooms, code, 'sock-a', {
      source: 'build',
      formation: '3-4-3',
      selectedCards: owned.map((card) => ({ id: card.id, assignedPosition: card.assignedPosition }))
    });
    assert.equal(built.ok, true);
    assert.equal(built.overall, null);
    const side = (playerId, username) => ({
      playerId,
      username,
      overall: null,
      team: owned.map((card) => ({ ...card, id: `${playerId}-${card.id}` }))
    });
    const result = simulateMatch(side('a', 'Ada'), side('b', 'Bea'), () => 0.4);
    assert.equal(typeof result.team1.goals, 'number');
    assert.equal(owned[0].stats.overall, null);
  });

  it('loads every servable catalogue identity and rejects a shortened production deck', () => {
    const before = fs.statSync(catalogueFile).mtimeMs;
    const stored = readStoredCatalogue(catalogueFile);
    const selected = partitionSelectedCards(stored);
    const pool = buildLiveImagePool(selected.live, { fileExists: servableCardArt(cardArtRoot) });
    assert.equal(fs.statSync(catalogueFile).mtimeMs, before);
    assert.equal(stored.players.length, 1147);
    assert.equal(selected.archived.players.length, 138);
    assert.equal(pool.report.identities, 1009);
    assert.equal(pool.report.entered, 1009);
    assert.equal(pool.cards.some((card) => card.id === 'fut23_carvajal' || card.id === 'fut23_rvajal'), false);
    assert.equal(pool.report.excluded.length, 0);
    assert.equal(pool.report.duplicateImageAssignments.length, 0);
    assert.equal(pool.report.liveAuctionActivated, true);
    assert.equal(new Set(pool.cards.map((card) => card.id)).size, pool.cards.length);
    const previousLimit = process.env.AUCTION_CARD_LIMIT;
    const previousFlag = process.env.DRAFT11_TEST_CARD_LIMIT;
    process.env.AUCTION_CARD_LIMIT = '22';
    delete process.env.DRAFT11_TEST_CARD_LIMIT;
    try {
      const full = new CardDeckManager(pool.cards).initializeRoomDeck('FULL01');
      assert.equal(full.length, 1009);
      process.env.DRAFT11_TEST_CARD_LIMIT = '1';
      const shortened = new CardDeckManager(pool.cards).initializeRoomDeck('SHORT01');
      assert.equal(shortened.length, 22);
    } finally {
      if (previousLimit == null) delete process.env.AUCTION_CARD_LIMIT;
      else process.env.AUCTION_CARD_LIMIT = previousLimit;
      if (previousFlag == null) delete process.env.DRAFT11_TEST_CARD_LIMIT;
      else process.env.DRAFT11_TEST_CARD_LIMIT = previousFlag;
    }
    for (const card of pool.cards) {
      assert.equal(card.auctionEligible, true);
      assert.equal(card.testAuction, undefined);
      assert.equal(cardArtFileExistsIn(cardArtRoot)(card.cardArtUrl), true);
    }
  });

  it('excludes a duplicated image assignment and does not mark a room as a separate test pool', () => {
    const stored = {
      players: [
        { playerId: 'fut23_left', name: 'Left', primaryCardId: 'fut23_left_selected' },
        { playerId: 'fut23_right', name: 'Right', primaryCardId: 'fut23_right_selected' }
      ],
      cards: [
        {
          cardId: 'fut23_left_selected',
          playerId: 'fut23_left',
          isPrimary: true,
          imageAssociation: 'selected-card',
          imagePath: '/player-cards/fut23_shared_primary.png'
        },
        {
          cardId: 'fut23_right_selected',
          playerId: 'fut23_right',
          isPrimary: true,
          imageAssociation: 'selected-card',
          imagePath: '/player-cards/fut23_shared_primary.png'
        }
      ]
    };
    const pool = buildLiveImagePool(stored, { fileExists: () => true });
    assert.equal(pool.report.entered, 0);
    assert.equal(pool.report.duplicateImageAssignments.length, 1);
    assert.equal(pool.report.excluded.length, 2);
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    assert.equal(captureLiveRoom(rooms.getRoom(code), null).auctionPool, undefined);
  });

  it('keeps a departed seat readable after the catalogue card is only in the snapshot', () => {
    const rooms = new RoomManager();
    const code = rooms.createRoom();
    rooms.takeSeat(code, 'sock-a', 'ada');
    rooms.takeSeat(code, 'sock-b', 'bea');
    const bought = {
      id: 'fut23_kept',
      name: 'Kept',
      basePrice: 10,
      position: null,
      stats: { overall: null },
      imageCatalogue: true,
      auctionEligible: true,
      basePriceSource: 'unrated-opening',
      cardArtUrl: '/player-cards/fut23_kept_primary.png',
      cardArtApproved: true,
      cardArtApprovalStatus: 'approved_for_use',
      cardArtRightsStatus: 'approved_for_use',
      cardArtValidated: true
    };
    rooms.addCardToTeam(code, 'sock-a', bought);
    rooms.removePlayerFromRoom(code, 'sock-a');
    const room = rooms.getRoom(code);
    assert.equal(room.hostUsername, 'bea');
    assert.equal(room.players.get('sock-b').team.length, 0);
    const doc = captureLiveRoom(room, null);
    const restored = materializeLiveRoom(doc, { catalog: new Map() });
    assert.equal(restored.room.departedSeats[0].team[0].name, 'Kept');
    assert.equal(restored.room.departedSeats[0].team[0].stats.overall, null);
    assert.equal(restored.room.departedSeats[0].team[0].imageCatalogue, true);
  });
});
