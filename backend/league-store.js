/**
 * LEAGUE PERSISTENCE
 * Memory store for tests and for a process without MongoDB.
 * Mongo store for a connected server. Writes compare the previous version
 * or fixture status in the database update itself, so a stale save cannot
 * replace a newer result. Two service instances do not share a lock. The
 * version and status filters are what keep one of them from overwriting
 * the other.
 */

import { Fixture, League } from './models.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * A batch is allowed when nobody plays themselves, each pair meets once,
 * and a manager appears in only one fixture per round. `existing` is the
 * fixtures already stored for the leagues being written.
 */
export function fixtureBatchAllowed(existing, incoming) {
  if (!Array.isArray(incoming) || incoming.length === 0) return true;
  const rows = [...(existing || []), ...incoming];
  const pairs = new Set();
  const appearances = new Set();
  for (const fixture of rows) {
    const home = fixture?.homeMemberId;
    const away = fixture?.awayMemberId;
    if (!home || !away || home === away) return false;
    const participants = Array.isArray(fixture.participants) && fixture.participants.length
      ? fixture.participants
      : [home, away];
    if (new Set(participants.map(String)).size !== 2) return false;
    const pair = `${fixture.leagueId}:${fixture.pairKey || [home, away].sort().join(':')}`;
    if (pairs.has(pair)) return false;
    pairs.add(pair);
    for (const id of participants) {
      const appearance = `${fixture.leagueId}:${fixture.round}:${id}`;
      if (appearances.has(appearance)) return false;
      appearances.add(appearance);
    }
  }
  return true;
}

export class MemoryLeagueStore {
  constructor() {
    this.leagues = new Map();
    this.fixtures = new Map();
  }

  async insertLeague(league) {
    if (this.leagues.has(league.leagueId)) return false;
    this.leagues.set(league.leagueId, clone(league));
    return true;
  }

  async saveLeague(league, expectedVersion) {
    const current = this.leagues.get(league.leagueId);
    if (!current || current.version !== expectedVersion) return false;
    this.leagues.set(league.leagueId, clone(league));
    return true;
  }

  async insertFixtures(fixtures) {
    if (!fixtures.length) return true;
    if (fixtures.some((fixture) => this.fixtures.has(fixture.fixtureId))) return false;
    if (!fixtureBatchAllowed([...this.fixtures.values()], fixtures)) return false;
    for (const fixture of fixtures) this.fixtures.set(fixture.fixtureId, clone(fixture));
    return true;
  }

  async saveFixture(fixture, previousStatus) {
    const current = this.fixtures.get(fixture.fixtureId);
    if (!current || current.status !== previousStatus) return false;
    this.fixtures.set(fixture.fixtureId, clone(fixture));
    return true;
  }

  /**
   * Conditional write. `expected.pendingResult === null` matches only a
   * fixture that does not yet have a durable pending result.
   */
  async compareAndSetFixture(fixtureId, expected = {}, next) {
    const current = this.fixtures.get(fixtureId);
    if (!current) return false;
    if (expected.status != null && current.status !== expected.status) return false;
    if (Object.prototype.hasOwnProperty.call(expected, 'claimToken') && current.claimToken !== expected.claimToken) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'pendingResult') && expected.pendingResult === null) {
      if (current.pendingResult) return false;
    }
    this.fixtures.set(fixtureId, clone(next));
    return true;
  }

  async listLeagues() {
    return [...this.leagues.values()].map((league) => clone(league));
  }

  async listFixtures(leagueId) {
    return [...this.fixtures.values()]
      .filter((fixture) => fixture.leagueId === leagueId)
      .map((fixture) => clone(fixture));
  }

  async loadLeague(leagueId) {
    const current = this.leagues.get(leagueId);
    return current ? clone(current) : null;
  }
}

function plain(doc) {
  if (!doc) return null;
  const value = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete value._id;
  delete value.__v;
  return value;
}

export class MongoLeagueStore {
  constructor(models = {}) {
    this.League = models.League || League;
    this.Fixture = models.Fixture || Fixture;
  }

  async insertLeague(league) {
    try {
      await this.League.create(league);
      return true;
    } catch (err) {
      if (err?.code === 11000) return false;
      throw err;
    }
  }

  async saveLeague(league, expectedVersion) {
    const result = await this.League.updateOne(
      { leagueId: league.leagueId, version: expectedVersion },
      { $set: league }
    );
    return result.matchedCount === 1;
  }

  async insertFixtures(fixtures) {
    if (!fixtures.length) return true;
    const leagueIds = [...new Set(fixtures.map((fixture) => fixture.leagueId))];
    const existing = await this.Fixture.find({ leagueId: { $in: leagueIds } }).lean();
    if (!fixtureBatchAllowed(existing, fixtures)) return false;
    try {
      await this.Fixture.insertMany(fixtures, { ordered: true });
      return true;
    } catch (err) {
      if (err?.code === 11000 || err?.name === 'ValidationError') return false;
      throw err;
    }
  }

  async saveFixture(fixture, previousStatus) {
    const result = await this.Fixture.updateOne(
      { fixtureId: fixture.fixtureId, status: previousStatus },
      { $set: fixture }
    );
    return result.matchedCount === 1;
  }

  async compareAndSetFixture(fixtureId, expected = {}, next) {
    const filter = { fixtureId };
    if (expected.status != null) filter.status = expected.status;
    if (Object.prototype.hasOwnProperty.call(expected, 'claimToken')) {
      filter.claimToken = expected.claimToken;
    }
    if (Object.prototype.hasOwnProperty.call(expected, 'pendingResult') && expected.pendingResult === null) {
      filter.$or = [{ pendingResult: null }, { pendingResult: { $exists: false } }];
    }
    const result = await this.Fixture.updateOne(filter, { $set: next });
    return result.matchedCount === 1;
  }

  async listLeagues() {
    const docs = await this.League.find().lean();
    return docs.map((doc) => plain(doc));
  }

  async listFixtures(leagueId) {
    const docs = await this.Fixture.find({ leagueId }).lean();
    return docs.map((doc) => plain(doc));
  }

  async loadLeague(leagueId) {
    const doc = await this.League.findOne({ leagueId }).lean();
    return plain(doc);
  }
}
