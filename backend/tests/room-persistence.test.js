import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AuctionEngine } from '../auction-engine.js';
import { RoomManager } from '../room-manager.js';
import { GAME_CONFIG, ROOM_SCHEMA_VERSION } from '../constants.js';
import { captureLiveRoom, materializeLiveRoom, shouldRecover, indexCards } from '../room-snapshot.js';
import { MemoryRoomWriter, createRoomStore } from '../room-store.js';
import { Validator } from '../validators.js';
import { hashSeatToken } from '../security/seat-token.js';

function card(id, name = id, basePrice = 10, overall = 70) {
  return {
    id,
    name,
    basePrice,
    position: 'ST',
    category: 'BASIC',
    stats: { pace: overall, shooting: overall, passing: overall, defense: overall, physical: overall, overall }
  };
}

function wire(enabled = () => true) {
  const rooms = new RoomManager();
  const engine = new AuctionEngine();
  const writer = new MemoryRoomWriter();
  const store = createRoomStore({
    roomExists: (code) => Boolean(rooms.getRoom(code)),
    capture: (code) => captureLiveRoom(rooms.getRoom(code), engine.getAuction(code)),
    applyVersion: (code, previous, next) => {
      const room = rooms.getRoom(code);
      if (room && (room.stateVersion || 0) === previous) room.stateVersion = next;
    },
    enabled,
    writer
  });
  rooms.onChange = (code) => store.touch(code);
  rooms.onRemove = (code) => store.forget(code);
  engine.onChange = (code) => store.touch(code);
  return { rooms, engine, writer, store };
}

describe('live room snapshots', () => {
  it('stores card ids, seat tokens, and the deadline, and omits socket ids', async () => {
    const { rooms, engine, writer, store } = wire();
    const code = rooms.createRoom();
    const ada = rooms.takeSeat(code, 'sock-ada-999', 'ada');
    rooms.takeSeat(code, 'sock-bea-999', 'bea');
    const catalogCard = card('alpha', 'Alpha', 10, 91);
    const later = card('later', 'Later', 25, 73);
    rooms.addCardToTeam(code, 'sock-ada-999', card('owned', 'Owned', 10, 80));
    rooms.getPlayer(code, 'sock-ada-999').balance = 985;

    const deck = [catalogCard, later];
    assert.ok(engine.startAuction(code, deck, rooms.getRoom(code).players));
    engine.presentNextCard(code);
    assert.equal(engine.processBid(code, 'sock-ada-999', 15).success, true);
    engine.getAuction(code).players.get('sock-ada-999').balance = 985;
    engine.getAuction(code).timerStarted = Date.now() - 10000;
    engine.getAuction(code).timerDuration = 30000;
    rooms.getRoom(code).rematchVotes = new Set(['ada']);
    await store.flush(code);

    const doc = writer.docs.get(code);
    assert.equal(doc.schemaVersion, ROOM_SCHEMA_VERSION);
    assert.equal(doc.stateVersion, 1);
    assert.equal(doc.code, code);
    assert.equal(typeof doc.roomId, 'string');
    assert.ok(doc.createdAt);
    assert.ok(doc.updatedAt);
    assert.ok(doc.expiresAt);
    assert.equal(doc.hostUsername, 'ada');
    assert.equal(doc.hostSeatId, ada.player.seatId);
    assert.equal(doc.phase, 'bidding');
    assert.deepEqual(doc.state.auction.deckCardIds, ['alpha', 'later']);
    assert.equal(doc.state.auction.currentCardId, 'alpha');
    assert.equal(doc.state.auction.highestBid, 15);
    assert.equal(doc.state.auction.highestBidderSeatId, ada.player.seatId);
    assert.equal(doc.state.auction.bidHistory[0].seatId, ada.player.seatId);
    assert.equal(doc.state.auction.deadline, doc.state.auction.timerStarted + 30000);
    assert.equal(doc.state.seats[0].seatToken, undefined);
    assert.equal(doc.state.seats[0].seatTokenHash, hashSeatToken(ada.seatToken));
    assert.equal(JSON.stringify(doc).includes(ada.seatToken), false);
    assert.equal(doc.state.seats[0].isOnline, true);
    assert.deepEqual(doc.state.seats[0].cardIds, ['owned']);
    assert.equal(doc.state.cardCache.owned.name, 'Owned');
    assert.equal(doc.state.cardCache.later, undefined);
    assert.equal(JSON.stringify(doc).includes('sock-ada-999'), false);
    assert.equal(JSON.stringify(doc).includes('sock-bea-999'), false);
    assert.equal(JSON.stringify(doc.state.cardCache).includes('"overall":73'), false);

    const restored = materializeLiveRoom(doc, {
      catalog: indexCards([catalogCard, later, card('owned', 'Owned', 10, 80)]),
      socketsDead: true
    });
    assert.equal(restored.room.players.get(ada.player.seatId).isOnline, false);
    assert.equal(restored.room.players.get(ada.player.seatId).socketId, null);
    assert.equal(restored.room.players.get(ada.player.seatId).team[0].stats.overall, 80);
    assert.equal(restored.auction.deck[1].stats.overall, 73);
    assert.equal(restored.auction.highestBidder, ada.player.seatId);
    assert.equal(restored.auction.players.get(ada.player.seatId).balance, 985);
    assert.equal(restored.auction.players.get(ada.player.seatId).online, false);
  });

  it('rejects a stale state version and drops a removed room', async () => {
    const writer = new MemoryRoomWriter();
    const first = { code: 'ABC123', stateVersion: 1, status: 'waiting' };
    assert.equal(await writer.save(first, 0), true);
    assert.equal(await writer.save({ ...first, stateVersion: 2, status: 'auction' }, 1), true);
    assert.equal(await writer.save({ ...first, stateVersion: 2, status: 'finished' }, 1), false);
    assert.equal(writer.docs.get('ABC123').status, 'auction');

    const { rooms, store, writer: live } = wire();
    const code = rooms.createRoom();
    rooms.takeSeat(code, 's1', 'ada');
    await store.flush(code);
    assert.equal(live.docs.get(code).stateVersion, 1);
    rooms.takeSeat(code, 's2', 'bea');
    await store.flush(code);
    assert.equal(live.docs.get(code).stateVersion, 2);
    assert.equal(live.docs.get(code).state.seats.length, 2);

    rooms.removePlayerFromRoom(code, 's1');
    rooms.removePlayerFromRoom(code, 's2');
    await store.flush(code);
    assert.equal(live.docs.has(code), false);
    assert.equal(rooms.getRoom(code), undefined);
  });

  it('skips expired, abandoned, and unknown-schema documents', () => {
    const now = Date.now();
    const base = {
      roomId: 'room',
      code: 'ABC123',
      schemaVersion: ROOM_SCHEMA_VERSION,
      expiresAt: new Date(now + 60000),
      state: { seats: [{ seatId: 'a' }], lastActivity: now, createdAt: now }
    };
    assert.equal(shouldRecover(base, now), true);
    assert.equal(shouldRecover({ ...base, schemaVersion: 99 }, now), false);
    assert.equal(shouldRecover({ ...base, expiresAt: new Date(now - 1) }, now), false);
    assert.equal(shouldRecover({
      ...base,
      state: { seats: [], emptiedAt: now - GAME_CONFIG.DISCONNECT_TIMEOUT_MS, lastActivity: now }
    }, now), false);
    assert.equal(shouldRecover({
      ...base,
      state: { seats: [{ seatId: 'a' }], lastActivity: now - GAME_CONFIG.ROOM_TIMEOUT_MS, createdAt: now - GAME_CONFIG.ROOM_TIMEOUT_MS }
    }, now), false);
  });
});

describe('crash recovery', () => {
  it('restores the bid and resumes the original deadline once', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const rooms = new RoomManager();
      const engine = new AuctionEngine();
      const code = rooms.createRoom();
      const ada = rooms.takeSeat(code, 'sock-ada', 'ada');
      rooms.takeSeat(code, 'sock-bea', 'bea');
      rooms.addCardToTeam(code, 'sock-ada', card('owned', 'Owned'));
      rooms.getPlayer(code, 'sock-ada').balance = 985;
      engine.startAuction(code, [card('a', 'Alpha'), card('b', 'Bravo')], rooms.getRoom(code).players);
      engine.presentNextCard(code);
      engine.processBid(code, 'sock-ada', 15);
      engine.getAuction(code).players.get('sock-ada').balance = 985;
      const started = Date.now() - 10000;
      engine.getAuction(code).timerStarted = started;
      engine.getAuction(code).timerDuration = 30000;

      const doc = captureLiveRoom(rooms.getRoom(code), engine.getAuction(code));
      const catalog = indexCards([card('a', 'Alpha'), card('b', 'Bravo'), card('owned', 'Owned')]);
      const live = materializeLiveRoom(doc, { catalog, socketsDead: true });
      const rooms2 = new RoomManager();
      const engine2 = new AuctionEngine();
      rooms2.restoreRoom(live.room);
      engine2.restoreAuction(live.auction);

      const adaSeat = live.room.hostSeatId;
      const moved = rooms2.takeSeat(code, 'sock-ada-2', 'ada', ada.seatToken);
      assert.equal(moved.replaced, true);
      engine2.attachPlayer(code, 'sock-ada-2', 'ada', moved.player.balance);

      let timeouts = 0;
      const before = engine2.getAuction(code).timerStarted;
      assert.equal(engine2.resumeTimer(code, () => { timeouts += 1; }), true);
      assert.equal(engine2.resumeTimer(code, () => { timeouts += 1; }), true);
      assert.equal(engine2.getAuction(code).timerStarted, before);

      const state = engine2.getPublicState(code, 'sock-ada-2', rooms2.getPlayer(code, 'sock-ada-2').team);
      assert.equal(state.phase, 'bidding');
      assert.equal(state.card.name, 'Alpha');
      assert.equal(state.highestBid, 15);
      assert.equal(state.highestBidder, 'sock-ada-2');
      assert.equal(state.yourBalance, 985);
      assert.equal(state.yourCards[0].id, 'owned');
      assert.equal(state.minimumBid, Validator.nextMinimumBid(15));
      assert.ok(state.secondsRemaining <= 21 && state.secondsRemaining >= 19);

      t.mock.timers.tick(20000);
      assert.equal(timeouts, 1);
      t.mock.timers.tick(60000);
      assert.equal(timeouts, 1);
      assert.equal(adaSeat, ada.player.seatId);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('keeps a ready vote and a scheduled prompt across a restart', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const rooms = new RoomManager();
      const engine = new AuctionEngine();
      const code = rooms.createRoom();
      const ada = rooms.takeSeat(code, 'sock-ada', 'ada');
      rooms.takeSeat(code, 'sock-bea', 'bea');
      engine.startAuction(code, [card('a', 'Alpha')], rooms.getRoom(code).players);
      engine.presentNextCard(code);
      engine.setWaitingForReady(code);
      assert.equal(engine.setPlayerReady(code, 'sock-ada').success, true);
      engine.scheduleTransition(code, 'ready-prompt', 5000, () => {});

      const doc = captureLiveRoom(rooms.getRoom(code), engine.getAuction(code));
      assert.equal(doc.state.auction.phase, 'waiting-for-ready');
      assert.equal(doc.state.auction.readySeatIds.includes(ada.player.seatId), true);
      assert.equal(doc.state.auction.transitions[0].key, 'ready-prompt');

      const live = materializeLiveRoom(doc, { catalog: indexCards([card('a', 'Alpha')]), socketsDead: true });
      const rooms2 = new RoomManager();
      const engine2 = new AuctionEngine();
      rooms2.restoreRoom(live.room);
      engine2.restoreAuction(live.auction);
      const moved = rooms2.takeSeat(code, 'sock-new', 'ada', ada.seatToken);
      engine2.attachPlayer(code, 'sock-new', 'ada', moved.player.balance);

      const state = engine2.getPublicState(code, 'sock-new');
      assert.equal(state.phase, 'waiting-for-ready');
      assert.equal(state.readyPlayers.some((player) => player.playerId === 'sock-new'), true);

      let prompts = 0;
      const dueAt = engine2.getAuction(code).transitionDeadlines.get('ready-prompt');
      const delay = Math.max(0, dueAt - Date.now());
      assert.ok(delay > 0 && delay <= 5000);
      engine2.scheduleTransition(code, 'ready-prompt', delay, () => { prompts += 1; });
      if (delay > 1) t.mock.timers.tick(delay - 1);
      assert.equal(prompts, 0);
      t.mock.timers.tick(1);
      assert.equal(prompts, 1);
      t.mock.timers.tick(5000);
      assert.equal(prompts, 1);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('restores a finished squad and rematch vote onto the new socket', () => {
    const rooms = new RoomManager();
    const engine = new AuctionEngine();
    const code = rooms.createRoom();
    const ada = rooms.takeSeat(code, 'sock-ada', 'ada');
    rooms.takeSeat(code, 'sock-bea', 'bea');
    rooms.addCardToTeam(code, 'sock-ada', card('kdb', 'Kevin'));
    rooms.getPlayer(code, 'sock-ada').balance = 800;
    rooms.saveFinalSquads(code, [{
      username: 'ada',
      balance: 800,
      cards: [{ id: 'kdb', name: 'Kevin' }]
    }, {
      username: 'bea',
      balance: 1000,
      cards: []
    }]);
    rooms.addRematchVote(code, 'ada');
    engine.startAuction(code, [card('a', 'Alpha')], rooms.getRoom(code).players);
    engine.getAuction(code).phase = 'finished';

    const doc = captureLiveRoom(rooms.getRoom(code), engine.getAuction(code));
    const live = materializeLiveRoom(doc, {
      catalog: indexCards([card('kdb', 'Kevin'), card('a', 'Alpha')]),
      socketsDead: true
    });
    const rooms2 = new RoomManager();
    const engine2 = new AuctionEngine();
    rooms2.restoreRoom(live.room);
    engine2.restoreAuction(live.auction);

    const moved = rooms2.takeSeat(code, 'sock-ada-2', 'ada', ada.seatToken);
    assert.equal(rooms2.applySavedSquad(code, 'sock-ada-2'), true);
    engine2.attachPlayer(code, 'sock-ada-2', 'ada', moved.player.balance);
    const state = engine2.getPublicState(code, 'sock-ada-2', moved.player.team);
    assert.equal(state.phase, 'finished');
    assert.equal(state.yourBalance, 800);
    assert.equal(state.yourCards[0].id, 'kdb');
    const rematch = rooms2.rematchStatus(code);
    assert.equal(rematch.voted, 1);
    assert.deepEqual(rematch.voters, [{ id: 'sock-ada-2', username: 'ada' }]);
  });
});
