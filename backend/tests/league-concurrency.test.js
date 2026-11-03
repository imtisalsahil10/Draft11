/**
 * Two league service instances, one Mongo database.
 * Each instance has its own memory and its own lock. The database version
 * and fixture-status filters are what stop a stale write. This does not
 * start two operating-system servers.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { MongoHandoffStore, hashSeatToken } from '../handoff-store.js';
import { createLeagueService, LEAGUE_ERRORS } from '../league-service.js';
import { MongoLeagueStore } from '../league-store.js';
import { AuctionHandoff, Fixture, League } from '../models.js';

dotenv.config();

const catalog = JSON.parse(readFileSync(new URL('../../cards.json', import.meta.url), 'utf8'));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function open(dbName) {
  const connection = await mongoose.createConnection(process.env.MONGODB_URI, {
    dbName,
    serverSelectionTimeoutMS: 8000,
    connectTimeoutMS: 8000,
    bufferCommands: false
  }).asPromise();
  const models = {
    League: connection.model('League', League.schema.clone()),
    Fixture: connection.model('Fixture', Fixture.schema.clone()),
    AuctionHandoff: connection.model('AuctionHandoff', AuctionHandoff.schema.clone())
  };
  await Promise.all([
    models.League.createIndexes(),
    models.Fixture.createIndexes(),
    models.AuctionHandoff.createIndexes()
  ]);
  return { connection, models };
}

function service(models, extra = {}) {
  return createLeagueService({
    store: new MongoLeagueStore(models),
    catalog,
    catalogSquads: true,
    ...extra
  });
}

async function members(primary, count) {
  const created = await primary.create({ name: 'Race Cup', displayName: 'Ada' });
  assert.equal(created.ok, true, created.message);
  const people = [{
    leagueId: created.view.leagueId,
    memberId: created.memberId,
    memberToken: created.memberToken,
    name: 'Ada'
  }];
  for (let index = 1; index < count; index += 1) {
    const joined = await primary.join({
      inviteCode: created.inviteCode,
      displayName: ['Bea', 'Cal', 'Dee'][index - 1]
    });
    assert.equal(joined.ok, true, joined.message);
    people.push({
      leagueId: joined.view.leagueId,
      memberId: joined.memberId,
      memberToken: joined.memberToken
    });
  }
  return people;
}

function squadIds(view, memberId) {
  const member = view.members.find((item) => item.memberId === memberId);
  return (member?.squad?.cards || []).map((card) => card.id).sort();
}

function sharedIds(view) {
  const seen = new Set();
  const duplicates = new Set();
  for (const member of view.members) {
    for (const card of member.squad?.cards || []) {
      if (seen.has(card.id)) duplicates.add(card.id);
      seen.add(card.id);
    }
  }
  return [...duplicates];
}

let mongoReady = false;
try {
  if (process.env.MONGODB_URI) {
    const probe = `cq${process.pid.toString().slice(-6)}`;
    const connection = await open(probe);
    await connection.connection.dropDatabase();
    await connection.connection.close();
    mongoReady = true;
  }
} catch {
  mongoReady = false;
}

describe('two league services against one database', {
  skip: mongoReady ? false : 'MongoDB is not available',
  concurrency: 1
}, () => {
  it('does not let two members keep the same catalog cards', async () => {
    const dbName = `q${Date.now().toString().slice(-8)}`;
    const { connection, models } = await open(dbName);
    try {
      const first = service(models);
      const second = service(models);
      const [ada, bea] = await members(first, 2);
      await second.load();
      const [left, right] = await Promise.all([
        first.registerSuggestedSquad(ada),
        second.registerSuggestedSquad(bea)
      ]);
      assert.equal([left, right].some((result) => result.ok), true);
      const fresh = service(models);
      await fresh.load();
      const view = (await fresh.view(ada)).view;
      assert.deepEqual(sharedIds(view), []);
      const winner = [left, right].find((result) => result.ok);
      const winnerId = winner.view.you.memberId;
      assert.deepEqual(squadIds(view, winnerId), winner.view.you.squad.cards.map((card) => card.id).sort());
    } finally {
      await connection.dropDatabase().catch(() => {});
      await connection.close().catch(() => {});
    }
  });

  it('does not overwrite a squad saved by the other instance', async () => {
    const dbName = `r${Date.now().toString().slice(-8)}`;
    const { connection, models } = await open(dbName);
    try {
      const first = service(models);
      const second = service(models);
      const [ada, bea] = await members(first, 2);
      await second.load();
      const ids = (await first.registerSuggestedSquad(ada)).view.you.squad.cards.map((card) => card.id);
      const stale = await second.registerSquad({ ...bea, cardIds: ids });
      assert.equal(stale.ok, false);
      assert.equal(stale.error, LEAGUE_ERRORS.SQUAD_INVALID);
      const fresh = service(models);
      await fresh.load();
      const view = (await fresh.view(ada)).view;
      assert.deepEqual(squadIds(view, ada.memberId), [...ids].sort());
      assert.deepEqual(squadIds(view, bea.memberId), []);
    } finally {
      await connection.dropDatabase().catch(() => {});
      await connection.close().catch(() => {});
    }
  });

  it('claims one fixture once when two instances simulate it', async () => {
    const dbName = `s${Date.now().toString().slice(-8)}`;
    const { connection, models } = await open(dbName);
    try {
      const first = service(models);
      const second = service(models);
      const [ada, bea] = await members(first, 2);
      assert.equal((await first.registerSuggestedSquad(ada)).ok, true);
      assert.equal((await first.registerSuggestedSquad(bea)).ok, true);
      assert.equal((await first.schedule(ada)).ok, true);
      const fixtureId = (await first.view(ada)).view.fixtures[0].fixtureId;
      assert.equal((await first.confirmFixtureLineup({ ...ada, fixtureId })).ok, true);
      assert.equal((await first.confirmFixtureLineup({ ...bea, fixtureId })).ok, true);
      await second.load();
      const [left, right] = await Promise.all([
        first.simulateLeagueFixture({ ...ada, fixtureId }),
        second.simulateLeagueFixture({ ...bea, fixtureId })
      ]);
      assert.equal([left, right].some((result) => result.ok), true, [left, right].map((result) => result.message).join(' | '));
      const fresh = service(models);
      await fresh.load();
      const view = (await fresh.view(ada)).view;
      const fixture = view.fixtures.find((item) => item.fixtureId === fixtureId);
      assert.equal(fixture.phase === 'completed' || fixture.result != null, true);
      assert.equal(view.fixtures.filter((item) => item.result).length, 1);
      const points = view.standings.reduce((sum, row) => sum + row.points, 0);
      assert.ok(points === 2 || points === 3);
      const replay = await fresh.simulateLeagueFixture({ ...ada, fixtureId });
      assert.equal(replay.alreadyComplete, true);
      assert.equal(replay.result.homeGoals, fixture.result.homeGoals);
      assert.equal(replay.result.awayGoals, fixture.result.awayGoals);
      assert.equal((await fresh.view(ada)).view.standings.reduce((sum, row) => sum + row.points, 0), points);
    } finally {
      await connection.dropDatabase().catch(() => {});
      await connection.close().catch(() => {});
    }
  });

  it('keeps one result when two instances record different scores', async () => {
    const dbName = `t${Date.now().toString().slice(-8)}`;
    const { connection, models } = await open(dbName);
    try {
      const first = service(models);
      const second = service(models);
      const [ada, bea] = await members(first, 2);
      assert.equal((await first.registerSuggestedSquad(ada)).ok, true);
      assert.equal((await first.registerSuggestedSquad(bea)).ok, true);
      assert.equal((await first.schedule(ada)).ok, true);
      const fixtureId = (await first.view(ada)).view.fixtures[0].fixtureId;
      await second.load();
      const [left, right] = await Promise.all([
        first.recordFixtureResult({ ...ada, fixtureId, homeGoals: 1, awayGoals: 0, trusted: true }),
        second.recordFixtureResult({ ...ada, fixtureId, homeGoals: 4, awayGoals: 0, trusted: true })
      ]);
      const outcomes = [left, right];
      assert.equal(outcomes.filter((result) => result.ok).length, 1);
      assert.equal(outcomes.some((result) => (
        result.error === LEAGUE_ERRORS.FIXTURE_ALREADY_COMPLETE || result.error === LEAGUE_ERRORS.CONFLICT
      )), true);
      const fresh = service(models);
      await fresh.load();
      const fixture = (await fresh.view(ada)).view.fixtures[0];
      assert.ok(
        (fixture.result.homeGoals === 1 && fixture.result.awayGoals === 0)
        || (fixture.result.homeGoals === 4 && fixture.result.awayGoals === 0)
      );
      const points = (await fresh.view(ada)).view.standings.reduce((sum, row) => sum + row.points, 0);
      assert.equal(points, 3);
      const rows = await models.Fixture.find({ fixtureId }).lean();
      assert.equal(rows.length, 1);
    } finally {
      await connection.dropDatabase().catch(() => {});
      await connection.close().catch(() => {});
    }
  });

  it('reconciles the round once when two final fixtures finish together', async () => {
    const dbName = `u${Date.now().toString().slice(-8)}`;
    const { connection, models } = await open(dbName);
    try {
      const first = service(models);
      const second = service(models);
      const people = await members(first, 4);
      for (const person of people) {
        assert.equal((await first.registerSuggestedSquad(person)).ok, true);
      }
      assert.equal((await first.schedule(people[0])).ok, true);
      const before = (await first.view(people[0])).view;
      const roundOne = before.fixtures.filter((fixture) => fixture.round === 1);
      assert.equal(roundOne.length, 2);
      const fixtureCount = before.fixtures.length;
      for (const fixture of roundOne) {
        for (const person of people) {
          if (person.memberId !== fixture.homeMemberId && person.memberId !== fixture.awayMemberId) continue;
          assert.equal((await first.confirmFixtureLineup({ ...person, fixtureId: fixture.fixtureId })).ok, true);
        }
      }
      await second.load();
      const finished = await Promise.all(roundOne.map((fixture, index) => {
        const actor = people.find((person) => person.memberId === fixture.homeMemberId);
        const runner = index === 0 ? first : second;
        return runner.simulateLeagueFixture({ ...actor, fixtureId: fixture.fixtureId });
      }));
      assert.equal(finished.every((result) => result.ok), true, finished.map((result) => result.message).join(' '));

      await models.League.updateOne(
        { leagueId: people[0].leagueId },
        { $set: { currentRound: 1, status: 'active' } }
      );
      const restarted = service(models);
      await restarted.load();
      const view = (await restarted.view(people[0])).view;
      assert.equal(view.currentRound, 2);
      assert.equal(view.fixtures.length, fixtureCount);
      assert.equal(new Set(view.fixtures.map((fixture) => fixture.fixtureId)).size, fixtureCount);
      const decided = view.fixtures.filter((fixture) => fixture.round === 1 && fixture.result);
      assert.equal(decided.length, 2);
      const points = view.standings.reduce((sum, row) => sum + row.points, 0);
      const expectedPoints = decided.reduce((sum, fixture) => (
        sum + (fixture.result.homeGoals === fixture.result.awayGoals ? 2 : 3)
      ), 0);
      assert.equal(points, expectedPoints);
      const again = service(models);
      await again.load();
      const secondView = (await again.view(people[0])).view;
      assert.equal(secondView.currentRound, 2);
      assert.equal(secondView.standings.reduce((sum, row) => sum + row.points, 0), points);
      await sleep(0);
    } finally {
      await connection.dropDatabase().catch(() => {});
      await connection.close().catch(() => {});
    }
  });

  it('links one finished seat when two instances claim it', async () => {
    const dbName = `v${Date.now().toString().slice(-8)}`;
    const { connection, models } = await open(dbName);
    try {
      const handoffs = new MongoHandoffStore(models.AuctionHandoff);
      const extra = { handoffs, catalogSquads: false, readSeat: () => null };
      const first = service(models, extra);
      const second = service(models, extra);
      const [ada, bea] = await members(first, 2);
      await second.load();
      const ids = catalog.slice(0, 11).map((card) => String(card.id));
      const token = 'ab'.repeat(24);
      await handoffs.publish({
        tokenHash: hashSeatToken(token),
        roomId: 'room-race',
        seatId: 'seat-race',
        cardIds: ids
      });
      const [left, right] = await Promise.all([
        first.linkAuctionSquad({ ...ada, seatToken: token, overall: 1, cardIds: ['client'] }),
        second.linkAuctionSquad({ ...bea, seatToken: token, overall: 1, cardIds: ['client'] })
      ]);
      assert.equal([left, right].filter((result) => result.ok).length, 1);
      assert.equal([left, right].filter((result) => result.error === LEAGUE_ERRORS.CONFLICT).length, 1);
      const fresh = service(models, extra);
      await fresh.load();
      const view = (await fresh.view(ada)).view;
      assert.deepEqual(sharedIds(view), []);
      assert.equal(view.members.filter((member) => member.squad).length, 1);
      const winner = view.members.find((member) => member.squad);
      assert.deepEqual(winner.squad.cards.map((card) => card.id), ids);
      const catalogOverall = catalog.find((card) => String(card.id) === ids[0]).stats.overall;
      assert.equal(winner.squad.cards[0].stats.overall, catalogOverall);
      assert.notEqual(winner.squad.cards[0].stats.overall, 1);
      const winnerAuth = winner.memberId === ada.memberId ? ada : bea;
      const replay = await fresh.linkAuctionSquad({ ...winnerAuth, seatToken: token });
      assert.equal(replay.alreadyLinked, true);
    } finally {
      await connection.dropDatabase().catch(() => {});
      await connection.close().catch(() => {});
    }
  });
});
