import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { HANDOFF_TTL_MS, MemoryHandoffStore, MongoHandoffStore, hashSeatToken } from '../handoff-store.js';
import { createLeagueService, LEAGUE_ERRORS } from '../league-service.js';
import { MemoryLeagueStore, MongoLeagueStore } from '../league-store.js';
import { AuctionHandoff, Fixture, League } from '../models.js';
import { RoomManager } from '../room-manager.js';

dotenv.config();

function cards(prefix, overall = 70) {
  return ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'LW', 'ST', 'RW'].map((position, index) => ({
    id: `${prefix}-${index}`,
    name: `${prefix} ${index}`,
    position,
    stats: {
      pace: 60,
      shooting: 61,
      passing: 62,
      defense: 63,
      physical: 64,
      overall: overall + index
    }
  }));
}

function publishSeat(store, token, cardIds, now = Date.now()) {
  return store.publish({
    tokenHash: hashSeatToken(token),
    roomId: 'room-1',
    seatId: 'seat-1',
    cardIds,
    now,
    socketId: 'socket-should-not-be-stored'
  });
}

async function leaguePair(store, handoffs, catalog) {
  const options = {
    store,
    catalog,
    handoffs,
    catalogSquads: false,
    readSeat: () => null
  };
  const first = createLeagueService(options);
  const second = createLeagueService(options);
  const created = await first.create({ name: 'Handoff Cup', displayName: 'Ada' });
  assert.equal(created.ok, true, created.message);
  await second.load();
  const joined = await first.join({ inviteCode: created.inviteCode, displayName: 'Bea' });
  assert.equal(joined.ok, true, joined.message);
  await second.load();
  return {
    first,
    second,
    ada: {
      leagueId: created.view.leagueId,
      memberId: created.memberId,
      memberToken: created.memberToken
    },
    bea: {
      leagueId: joined.view.leagueId,
      memberId: joined.memberId,
      memberToken: joined.memberToken
    }
  };
}

describe('finished auction handoff', () => {
  it('rejects catalog registration on an auction-only service', async () => {
    const leagues = createLeagueService({
      store: new MemoryLeagueStore(),
      catalog: cards('ada'),
      catalogSquads: false
    });
    const created = await leagues.create({ name: 'Closed', displayName: 'Ada' });
    const auth = {
      leagueId: created.view.leagueId,
      memberId: created.memberId,
      memberToken: created.memberToken
    };
    const manual = await leagues.registerSquad({ ...auth, cardIds: cards('ada').map((card) => card.id) });
    const suggested = await leagues.registerSuggestedSquad(auth);
    assert.equal(manual.error, LEAGUE_ERRORS.SQUAD_INVALID);
    assert.equal(suggested.error, LEAGUE_ERRORS.SQUAD_INVALID);
    assert.equal(manual.message, 'League squads come from a finished auction.');
  });

  it('links from the handoff after the room is gone and ignores client stats', async () => {
    const handoffs = new MemoryHandoffStore();
    const catalog = cards('ada', 80);
    const token = 'a'.repeat(48);
    const record = await publishSeat(handoffs, token, catalog.map((card) => card.id));
    assert.equal(record.tokenHash, hashSeatToken(token));
    assert.equal(Object.hasOwn(record, 'socketId'), false);
    assert.notEqual(record.tokenHash, token);

    const { first, ada } = await leaguePair(new MemoryLeagueStore(), handoffs, catalog);
    const linked = await first.linkAuctionSquad({
      ...ada,
      seatToken: token,
      cardIds: ['client-card'],
      overall: 99,
      balance: 1,
      socketId: 'sock'
    });
    assert.equal(linked.ok, true, linked.message);
    assert.deepEqual(
      linked.view.you.squad.cards.map((card) => card.id),
      catalog.map((card) => card.id)
    );
    assert.equal(linked.view.you.squad.cards[0].stats.overall, 80);
    assert.equal(linked.view.you.squad.cards[0].stats.overall === 99, false);

    const again = await first.linkAuctionSquad({ ...ada, seatToken: token });
    assert.equal(again.ok, true);
    assert.equal(again.alreadyLinked, true);
    assert.equal(again.view.you.squad.revision, linked.view.you.squad.revision);

    await handoffs.deleteExpired(Date.now() + HANDOFF_TTL_MS + 1000);
    assert.equal(await handoffs.find(hashSeatToken(token)), null);
    const afterCleanup = await first.linkAuctionSquad({ ...ada, seatToken: token });
    assert.equal(afterCleanup.alreadyLinked, true);
    assert.equal(afterCleanup.view.you.squad.revision, linked.view.you.squad.revision);
  });

  it('rejects an expired handoff, a bad token, and a second member', async () => {
    const handoffs = new MemoryHandoffStore();
    const catalog = cards('ada', 70);
    const token = 'b'.repeat(48);
    const store = new MemoryLeagueStore();
    await publishSeat(handoffs, token, catalog.map((card) => card.id), Date.now() - HANDOFF_TTL_MS - 1000);
    const { first, ada, bea } = await leaguePair(store, handoffs, catalog);

    const expired = await first.linkAuctionSquad({ ...ada, seatToken: token });
    assert.equal(expired.ok, false);
    assert.equal(expired.message, 'This auction handoff has expired.');
    assert.equal(await handoffs.deleteExpired(Date.now()), 1);

    const missing = await first.linkAuctionSquad({ ...ada, seatToken: 'c'.repeat(48) });
    assert.equal(missing.error, LEAGUE_ERRORS.UNAUTHORIZED);
    const short = await first.linkAuctionSquad({ ...ada, seatToken: 'short' });
    assert.equal(short.error, LEAGUE_ERRORS.INVALID_PARAMETERS);

    await publishSeat(handoffs, token, catalog.map((card) => card.id));
    assert.equal((await first.linkAuctionSquad({ ...ada, seatToken: token })).ok, true);
    const stolen = await first.linkAuctionSquad({ ...bea, seatToken: token });
    assert.equal(stolen.error, LEAGUE_ERRORS.CONFLICT);
    const reloaded = createLeagueService({
      store,
      catalog,
      handoffs,
      catalogSquads: false,
      readSeat: () => null
    });
    await reloaded.load();
    const view = await reloaded.view(ada);
    assert.equal(view.view.members.filter((member) => member.squad).length, 1);
  });

  it('lets one of two simultaneous claims win and keeps the room sweep separate', async () => {
    const handoffs = new MemoryHandoffStore();
    const store = new MemoryLeagueStore();
    const catalog = cards('ada', 75);
    const token = 'd'.repeat(48);
    await publishSeat(handoffs, token, catalog.map((card) => card.id));
    const { first, second, ada, bea } = await leaguePair(store, handoffs, catalog);
    const [left, right] = await Promise.all([
      first.linkAuctionSquad({ ...ada, seatToken: token }),
      second.linkAuctionSquad({ ...bea, seatToken: token })
    ]);
    const results = [left, right];
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.error === LEAGUE_ERRORS.CONFLICT).length, 1);
    const saved = await store.loadLeague(ada.leagueId);
    const squads = saved.members.filter((member) => member.squad?.cards?.length);
    assert.equal(squads.length, 1);
    assert.deepEqual(squads[0].squad.cards.map((card) => card.id), catalog.map((card) => card.id));

    const rooms = new RoomManager();
    const code = rooms.createRoom();
    const room = rooms.getRoom(code);
    room.players.clear();
    room.emptiedAt = Date.now() - 60000;
    assert.deepEqual(rooms.sweep(), [code]);
    assert.equal(rooms.getRoom(code), undefined);
    assert.ok(await handoffs.find(hashSeatToken(token)));
  });

  it('rejects a second handoff that repeats a card', async () => {
    const handoffs = new MemoryHandoffStore();
    const adaCards = cards('ada', 70);
    const beaCards = cards('bea', 71);
    beaCards[0] = { ...adaCards[0] };
    const catalog = [...adaCards, ...beaCards.slice(1)];
    const store = new MemoryLeagueStore();
    await publishSeat(handoffs, 'e'.repeat(48), adaCards.map((card) => card.id));
    await handoffs.publish({
      tokenHash: hashSeatToken('f'.repeat(48)),
      roomId: 'room-2',
      seatId: 'seat-2',
      cardIds: beaCards.map((card) => card.id)
    });
    const { first, ada, bea } = await leaguePair(store, handoffs, catalog);
    assert.equal((await first.linkAuctionSquad({ ...ada, seatToken: 'e'.repeat(48) })).ok, true);
    const overlap = await first.linkAuctionSquad({ ...bea, seatToken: 'f'.repeat(48) });
    assert.equal(overlap.error, LEAGUE_ERRORS.SQUAD_INVALID);
    const saved = await store.loadLeague(ada.leagueId);
    const owners = saved.members.flatMap((member) => (member.squad?.cards || []).map((card) => card.id));
    assert.equal(owners.filter((id) => id === adaCards[0].id).length, 1);
  });
});

describe('handoff restart', () => {
  it('keeps a claimed seat in Mongo after a new store and service are opened', async () => {
    if (!process.env.MONGODB_URI) return;
    const dbName = `h${Date.now().toString().slice(-8)}`;
    let connection;
    try {
      connection = await mongoose.createConnection(process.env.MONGODB_URI, {
        dbName,
        serverSelectionTimeoutMS: 8000,
        connectTimeoutMS: 8000,
        bufferCommands: false
      }).asPromise();
    } catch {
      return;
    }
    try {
      const models = {
        League: connection.model('League', League.schema),
        Fixture: connection.model('Fixture', Fixture.schema),
        AuctionHandoff: connection.model('AuctionHandoff', AuctionHandoff.schema)
      };
      await models.AuctionHandoff.createIndexes();
      const handoffs = new MongoHandoffStore(models.AuctionHandoff);
      const catalog = cards('ada', 82);
      const token = '9'.repeat(48);
      await publishSeat(handoffs, token, catalog.map((card) => card.id));
      const restarted = new MongoHandoffStore(models.AuctionHandoff);
      const found = await restarted.find(hashSeatToken(token));
      assert.equal(found.cardIds.length, 11);
      assert.equal(Object.hasOwn(found, 'socketId'), false);

      const leagues = createLeagueService({
        store: new MongoLeagueStore(models),
        catalog,
        handoffs: restarted,
        catalogSquads: false,
        readSeat: () => null
      });
      const created = await leagues.create({ name: 'Restart handoff', displayName: 'Ada' });
      assert.equal(created.ok, true, created.message);
      const auth = {
        leagueId: created.view.leagueId,
        memberId: created.memberId,
        memberToken: created.memberToken
      };
      const linked = await leagues.linkAuctionSquad({ ...auth, seatToken: token, overall: 99 });
      assert.equal(linked.ok, true, linked.message);
      const again = createLeagueService({
        store: new MongoLeagueStore(models),
        catalog,
        handoffs: new MongoHandoffStore(models.AuctionHandoff),
        catalogSquads: false,
        readSeat: () => null
      });
      await again.load();
      const replay = await again.linkAuctionSquad({ ...auth, seatToken: token });
      assert.equal(replay.alreadyLinked, true);
      assert.equal(replay.view.you.squad.cards[0].stats.overall, 82);
    } finally {
      await connection.dropDatabase().catch(() => {});
      await connection.close().catch(() => {});
    }
  });
});
