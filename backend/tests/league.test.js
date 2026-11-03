import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEAGUE_SCHEMA_VERSION } from '../constants.js';
import { MemoryLeagueStore, fixtureBatchAllowed } from '../league-store.js';
import { bindLeagueSocket } from '../league-sockets.js';
import {
  DEFAULT_SCORING,
  LEAGUE_ERRORS,
  buildRoundRobin,
  calculateStandings,
  createLeagueService
} from '../league-service.js';

function service() {
  const store = new MemoryLeagueStore();
  return { store, leagues: createLeagueService({ store }) };
}

function authOf(result) {
  return {
    leagueId: result.view.leagueId,
    memberId: result.memberId,
    memberToken: result.memberToken
  };
}

async function managers(count, name = 'Cup') {
  const context = service();
  const created = await context.leagues.create({ name, displayName: 'Ada' });
  assert.equal(created.ok, true);
  const people = [{ name: 'Ada', auth: authOf(created), result: created }];
  const labels = ['Bea', 'Cal', 'Dee', 'Eli', 'Fay'];
  for (let index = 0; index < count - 1; index += 1) {
    const joined = await context.leagues.join({
      inviteCode: created.inviteCode,
      displayName: labels[index]
    });
    assert.equal(joined.ok, true, joined.message);
    people.push({ name: labels[index], auth: authOf(joined), result: joined });
  }
  return { ...context, created, people };
}

function assertRoundRobin(fixtures, memberIds) {
  const count = memberIds.length;
  const expected = (count * (count - 1)) / 2;
  assert.equal(fixtures.length, expected);
  const pairs = new Set();
  const rounds = new Map();
  for (const fixture of fixtures) {
    assert.notEqual(fixture.homeMemberId, fixture.awayMemberId);
    assert.ok(memberIds.includes(fixture.homeMemberId));
    assert.ok(memberIds.includes(fixture.awayMemberId));
    const key = [fixture.homeMemberId, fixture.awayMemberId].sort().join(':');
    assert.equal(pairs.has(key), false);
    pairs.add(key);
    const round = rounds.get(fixture.round) || [];
    round.push(fixture);
    rounds.set(fixture.round, round);
  }
  assert.equal(pairs.size, expected);
  for (const round of rounds.values()) {
    const seen = new Set();
    for (const fixture of round) {
      assert.equal(seen.has(fixture.homeMemberId), false);
      assert.equal(seen.has(fixture.awayMemberId), false);
      seen.add(fixture.homeMemberId);
      seen.add(fixture.awayMemberId);
    }
    if (count % 2 === 0) assert.equal(round.length, count / 2);
    else assert.equal(round.length, (count - 1) / 2);
  }
  assert.equal(rounds.size, count % 2 === 0 ? count - 1 : count);
}

function fakeIo(store) {
  const sent = [];
  return {
    sent,
    to(room) {
      return {
        emit(type, payload) {
          sent.push({
            room,
            type,
            payload,
            fixtureStatuses: [...store.fixtures.values()].map((fixture) => fixture.status)
          });
        }
      };
    }
  };
}

function fakeSocket() {
  const handlers = new Map();
  const rooms = new Set();
  return {
    rooms,
    on(event, handler) {
      handlers.set(event, handler);
    },
    join(room) {
      rooms.add(room);
    },
    invoke(event, data) {
      return new Promise((resolve, reject) => {
        const handler = handlers.get(event);
        if (!handler) {
          reject(new Error(`Missing handler ${event}`));
          return;
        }
        Promise.resolve(handler(data, (response) => resolve(response))).catch(reject);
      });
    }
  };
}

describe('round robin', () => {
  for (const count of [2, 4, 6]) {
    it(`schedules ${count} managers once each pair, with no byes`, () => {
      const ids = Array.from({ length: count }, (_, index) => `m${index}`);
      const rounds = buildRoundRobin(ids);
      const fixtures = rounds.flatMap((pairs, index) => pairs.map((pair) => ({
        round: index + 1,
        homeMemberId: pair.home,
        awayMemberId: pair.away
      })));
      assertRoundRobin(fixtures, ids);
    });
  }

  for (const count of [3, 5]) {
    it(`schedules ${count} managers with one bye per round and no duplicate fixtures`, () => {
      const ids = Array.from({ length: count }, (_, index) => `m${index}`);
      const rounds = buildRoundRobin(ids);
      const fixtures = rounds.flatMap((pairs, index) => pairs.map((pair) => ({
        round: index + 1,
        homeMemberId: pair.home,
        awayMemberId: pair.away
      })));
      assertRoundRobin(fixtures, ids);
      for (const id of ids) {
        const played = fixtures.filter((fixture) => (
          fixture.homeMemberId === id || fixture.awayMemberId === id
        ));
        assert.equal(played.length, count - 1);
      }
    });
  }

  it('rejects a manager playing a duplicated id', () => {
    assert.throws(() => buildRoundRobin(['a', 'a']), /Duplicate/);
  });
});

describe('league membership', () => {
  it('creates a league for the creator and hides the invite from other managers', async () => {
    const { leagues, created, people } = await managers(2);
    assert.equal(created.view.schemaVersion, LEAGUE_SCHEMA_VERSION);
    assert.equal(created.view.creatorId, created.memberId);
    assert.equal(created.view.you.role, 'admin');
    assert.equal(created.view.status, 'forming');
    assert.equal(created.view.currentRound, 0);
    assert.equal(created.view.scoring.win, 3);
    assert.equal(created.view.scoring.draw, 1);
    assert.equal(created.view.scoring.loss, 0);
    assert.equal(created.view.scoring.summary, DEFAULT_SCORING.summary);
    assert.equal(created.view.inviteCode, created.inviteCode);
    const current = await leagues.view(people[0].auth);
    assert.equal(current.view.members.length, 2);

    const joined = await leagues.join({ inviteCode: created.inviteCode, displayName: 'Gus' });
    assert.equal(joined.view.inviteCode, undefined);
    assert.equal(joined.view.members.some((item) => item.tokenHash), false);
  });

  it('rejects an invalid invitation', async () => {
    const { leagues } = service();
    const rejected = await leagues.join({ inviteCode: 'not-a-real-code', displayName: 'Bea' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, LEAGUE_ERRORS.INVITE_INVALID);
    assert.deepEqual(rejected.events, []);
  });

  it('does not create a second membership for the same token', async () => {
    const { leagues, created } = await managers(1);
    const again = await leagues.join({
      inviteCode: created.inviteCode,
      displayName: 'Ada Again',
      memberId: created.memberId,
      memberToken: created.memberToken
    });
    assert.equal(again.ok, true);
    assert.equal(again.memberId, created.memberId);
    assert.equal(again.memberToken, undefined);
    assert.equal(again.view.members.filter((member) => member.status === 'active').length, 1);

    const wrong = await leagues.join({
      inviteCode: created.inviteCode,
      displayName: 'Ada',
      memberId: created.memberId,
      memberToken: 'wrong-token'
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.error, LEAGUE_ERRORS.UNAUTHORIZED);
    const viewed = await leagues.view(authOf(created));
    assert.equal(viewed.view.members.length, 1);
  });

  it('lets a manager leave and lets an administrator remove someone', async () => {
    const { leagues, people } = await managers(3);
    const [ada, bea, cal] = people;
    const memberRemoves = await leagues.remove({ ...bea.auth, targetMemberId: ada.auth.memberId });
    assert.equal(memberRemoves.ok, false);
    assert.equal(memberRemoves.error, LEAGUE_ERRORS.UNAUTHORIZED);
    assert.equal((await leagues.view(ada.auth)).view.you.role, 'admin');

    const left = await leagues.leave(bea.auth);
    assert.equal(left.ok, true);
    assert.equal(left.view.members.find((member) => member.memberId === bea.auth.memberId).status, 'removed');
    assert.equal(left.events.some((event) => event.type === 'league:members'), true);
    assert.equal((await leagues.view(bea.auth)).ok, false);

    const removed = await leagues.remove({ ...ada.auth, targetMemberId: cal.auth.memberId });
    assert.equal(removed.ok, true);
    assert.equal(removed.view.members.find((member) => member.memberId === cal.auth.memberId).status, 'removed');

    assert.equal((await leagues.leave(ada.auth)).error, LEAGUE_ERRORS.LAST_ADMIN);
  });

  it('refuses league actions that only know the league id', async () => {
    const { leagues, created } = await managers(2);
    const refused = await leagues.view({ leagueId: created.view.leagueId });
    assert.equal(refused.ok, false);
    assert.equal(refused.error, LEAGUE_ERRORS.UNAUTHORIZED);
    assert.deepEqual(refused.events, []);
    const scheduled = await leagues.schedule({ leagueId: created.view.leagueId });
    assert.equal(scheduled.ok, false);
    assert.equal((await leagues.view(authOf(created))).view.fixtures.length, 0);
  });
});

describe('fixtures and standings', () => {
  it('persists one round robin for even and odd leagues and does not duplicate it', async () => {
    for (const count of [4, 5]) {
      const { leagues, people, created } = await managers(count, `Cup ${count}`);
      const ada = people[0];
      const memberAttempt = await leagues.schedule(people[1].auth);
      assert.equal(memberAttempt.ok, false);
      assert.equal(memberAttempt.error, LEAGUE_ERRORS.UNAUTHORIZED);

      const scheduled = await leagues.schedule(ada.auth);
      assert.equal(scheduled.ok, true);
      assert.equal(scheduled.view.status, 'active');
      assert.equal(scheduled.view.currentRound, 1);
      assertRoundRobin(
        scheduled.view.fixtures,
        people.map((person) => person.auth.memberId)
      );
      const again = await leagues.schedule(ada.auth);
      assert.equal(again.ok, true);
      assert.equal(again.view.fixtures.length, scheduled.view.fixtures.length);
      assert.deepEqual(
        again.view.fixtures.map((fixture) => fixture.fixtureId),
        scheduled.view.fixtures.map((fixture) => fixture.fixtureId)
      );
      const late = await leagues.join({ inviteCode: created.inviteCode, displayName: 'Late' });
      assert.equal(late.ok, false);
      assert.equal(late.error, LEAGUE_ERRORS.LEAGUE_STARTED);
    }
  });

  it('keeps a single result and calculates points from it', async () => {
    const { leagues, people } = await managers(2);
    const [ada, bea] = people;
    const scheduled = await leagues.schedule(ada.auth);
    const fixture = scheduled.view.fixtures[0];
    const goals = { [ada.auth.memberId]: 2, [bea.auth.memberId]: 0 };
    assert.equal(
      (await leagues.remove({ ...ada.auth, targetMemberId: bea.auth.memberId })).error,
      LEAGUE_ERRORS.FIXTURE_PENDING
    );
    assert.equal(
      (await leagues.recordFixtureResult({
        ...ada.auth,
        fixtureId: fixture.fixtureId,
        homeGoals: 1.5,
        awayGoals: 0
      })).error,
      LEAGUE_ERRORS.INVALID_RESULT
    );
    const denied = await leagues.recordFixtureResult({
      ...bea.auth,
      fixtureId: fixture.fixtureId,
      homeGoals: 9,
      awayGoals: 9
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.error, LEAGUE_ERRORS.UNAUTHORIZED);
    assert.deepEqual(denied.events, []);

    const linked = await leagues.linkFixture({
      ...bea.auth,
      fixtureId: fixture.fixtureId,
      roomCode: 'ROOM01',
      savedGameId: 'game-1'
    });
    assert.equal(linked.ok, true);
    assert.equal(linked.view.fixtures[0].status, 'in_progress');
    assert.equal(linked.view.fixtures[0].roomCode, 'ROOM01');
    assert.equal(linked.events[0].type, 'league:fixture');

    const recorded = await leagues.recordFixtureResult({
      ...ada.auth,
      fixtureId: fixture.fixtureId,
      homeGoals: goals[fixture.homeMemberId],
      awayGoals: goals[fixture.awayMemberId],
      savedGameId: 'game-1'
    });
    assert.equal(recorded.ok, true);
    assert.equal(recorded.view.status, 'completed');
    assert.equal(recorded.view.fixtures[0].result.homeGoals, goals[fixture.homeMemberId]);
    assert.equal(recorded.view.fixtures[0].roomCode, 'ROOM01');
    assert.equal(recorded.view.fixtures[0].savedGameId, 'game-1');
    const adaRow = recorded.view.standings.find((row) => row.memberId === ada.auth.memberId);
    const beaRow = recorded.view.standings.find((row) => row.memberId === bea.auth.memberId);
    assert.equal(adaRow.played, 1);
    assert.equal(adaRow.won, 1);
    assert.equal(adaRow.points, 3);
    assert.equal(adaRow.goalsFor, 2);
    assert.equal(adaRow.goalDifference, 2);
    assert.equal(beaRow.lost, 1);
    assert.equal(beaRow.points, 0);
    assert.equal(beaRow.goalDifference, -2);
    assert.equal(recorded.view.standings[0].memberId, ada.auth.memberId);

    const second = await leagues.recordFixtureResult({
      ...ada.auth,
      fixtureId: fixture.fixtureId,
      homeGoals: 0,
      awayGoals: 5
    });
    assert.equal(second.ok, false);
    assert.equal(second.error, LEAGUE_ERRORS.FIXTURE_ALREADY_COMPLETE);
    const still = await leagues.view(ada.auth);
    assert.equal(still.view.fixtures[0].result.homeGoals, goals[fixture.homeMemberId]);
    assert.equal(still.view.standings[0].points, 3);
  });

  it('rejects a second completion even when both arrive together', async () => {
    const { leagues, people } = await managers(2);
    const scheduled = await leagues.schedule(people[0].auth);
    const fixture = scheduled.view.fixtures[0];
    const [first, second] = await Promise.all([
      leagues.recordFixtureResult({
        ...people[0].auth,
        fixtureId: fixture.fixtureId,
        homeGoals: 1,
        awayGoals: 0
      }),
      leagues.recordFixtureResult({
        ...people[0].auth,
        fixtureId: fixture.fixtureId,
        homeGoals: 4,
        awayGoals: 4
      })
    ]);
    const results = [first, second];
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.error === LEAGUE_ERRORS.FIXTURE_ALREADY_COMPLETE).length, 1);
    const viewed = await leagues.view(people[0].auth);
    const winner = results.find((result) => result.ok);
    assert.deepEqual(viewed.view.fixtures[0].result, winner.view.fixtures[0].result);
    assert.equal(viewed.view.fixtures.filter((fixture) => fixture.status === 'completed').length, 1);
  });

  it('ignores a trusted flag and keeps one round advance when final fixtures finish together', async () => {
    const { leagues, people, store } = await managers(4);
    const scheduled = await leagues.schedule(people[0].auth);
    const fixtureCount = scheduled.view.fixtures.length;
    const roundOne = scheduled.view.fixtures.filter((fixture) => fixture.round === 1);
    assert.equal(roundOne.length, 2);

    const forged = await leagues.recordFixtureResult({
      leagueId: people[0].auth.leagueId,
      fixtureId: roundOne[0].fixtureId,
      homeGoals: 9,
      awayGoals: 0,
      trusted: true
    });
    assert.equal(forged.ok, false);
    assert.equal(forged.error, LEAGUE_ERRORS.UNAUTHORIZED);
    assert.equal(store.fixtures.get(roundOne[0].fixtureId).status, 'scheduled');

    const outsider = await leagues.recordFixtureResult({
      ...people[1].auth,
      fixtureId: roundOne[0].fixtureId,
      homeGoals: 1,
      awayGoals: 0,
      trusted: true
    });
    assert.equal(outsider.error, LEAGUE_ERRORS.UNAUTHORIZED);
    assert.equal(store.fixtures.get(roundOne[0].fixtureId).result, null);

    const [firstSchedule, secondSchedule] = await Promise.all([
      leagues.schedule(people[0].auth),
      leagues.schedule(people[0].auth)
    ]);
    assert.equal(firstSchedule.ok && secondSchedule.ok, true);
    assert.equal(firstSchedule.view.fixtures.length, fixtureCount);
    assert.equal(secondSchedule.view.fixtures.length, fixtureCount);

    const [left, right] = await Promise.all(roundOne.map((fixture) => leagues.recordFixtureResult({
      ...people[0].auth,
      fixtureId: fixture.fixtureId,
      homeGoals: 1,
      awayGoals: 0,
      trusted: true,
      winner: people[0].auth.memberId
    })));
    assert.equal(left.ok && right.ok, true, `${left.message} ${right.message}`);
    const view = (await leagues.view(people[0].auth)).view;
    assert.equal(view.currentRound, 2);
    assert.equal(view.status, 'active');
    assert.equal(view.fixtures.length, fixtureCount);
    assert.equal(view.fixtures.filter((fixture) => fixture.status === 'completed').length, 2);
    assert.equal(view.standings.reduce((sum, row) => sum + row.points, 0), 6);
    const advanced = [left, right].filter((result) => (
      result.events.some((event) => event.type === 'league:round:advanced')
    ));
    assert.equal(advanced.length, 1);
    const again = await leagues.schedule(people[0].auth);
    assert.equal(again.alreadyScheduled, true);
    assert.equal(again.view.fixtures.length, fixtureCount);
  });

  it('orders tied clubs by goal difference, goals for, head-to-head, then member id', () => {
    const members = [
      { memberId: 'a', displayName: 'Ada', status: 'active' },
      { memberId: 'b', displayName: 'Bea', status: 'active' },
      { memberId: 'c', displayName: 'Cal', status: 'active' },
      { memberId: 'd', displayName: 'Dee', status: 'active' }
    ];
    const fixtures = [
      { status: 'completed', homeMemberId: 'b', awayMemberId: 'a', result: { homeGoals: 1, awayGoals: 0 } },
      { status: 'completed', homeMemberId: 'a', awayMemberId: 'c', result: { homeGoals: 1, awayGoals: 0 } },
      { status: 'completed', homeMemberId: 'c', awayMemberId: 'b', result: { homeGoals: 1, awayGoals: 0 } },
      { status: 'completed', homeMemberId: 'a', awayMemberId: 'd', result: { homeGoals: 0, awayGoals: 0 } },
      { status: 'completed', homeMemberId: 'b', awayMemberId: 'd', result: { homeGoals: 0, awayGoals: 0 } },
      { status: 'completed', homeMemberId: 'c', awayMemberId: 'd', result: { homeGoals: 1, awayGoals: 0 } }
    ];
    const table = calculateStandings(members, fixtures);
    const ada = table.find((row) => row.memberId === 'a');
    const bea = table.find((row) => row.memberId === 'b');
    assert.equal(ada.points, bea.points);
    assert.equal(ada.goalDifference, bea.goalDifference);
    assert.equal(ada.goalsFor, bea.goalsFor);
    assert.ok(table.findIndex((row) => row.memberId === 'b') < table.findIndex((row) => row.memberId === 'a'));

    const byGoals = calculateStandings(
      [
        { memberId: 'z', displayName: 'Zoe', status: 'active' },
        { memberId: 'a', displayName: 'Amy', status: 'active' }
      ],
      [
        { status: 'completed', homeMemberId: 'z', awayMemberId: 'a', result: { homeGoals: 3, awayGoals: 1 } }
      ]
    );
    assert.equal(byGoals[0].memberId, 'z');
    assert.equal(byGoals[0].goalDifference, 2);
    assert.deepEqual(DEFAULT_SCORING.tieBreak, [
      'points',
      'goalDifference',
      'goalsFor',
      'headToHeadPoints',
      'memberId'
    ]);

    const tied = [
      { memberId: 'm-b', displayName: 'Bea', status: 'active' },
      { memberId: 'm-a', displayName: 'Ada', status: 'active' },
      { memberId: 'm-c', displayName: 'Cal', status: 'active' },
      { memberId: 'm-d', displayName: 'Dee', status: 'active' }
    ];
    const byDifference = calculateStandings(tied, [
      { status: 'completed', homeMemberId: 'm-a', awayMemberId: 'm-c', result: { homeGoals: 2, awayGoals: 0 } },
      { status: 'completed', homeMemberId: 'm-b', awayMemberId: 'm-d', result: { homeGoals: 3, awayGoals: 2 } },
      { status: 'scheduled', homeMemberId: 'm-a', awayMemberId: 'm-b', result: { homeGoals: 9, awayGoals: 0 } }
    ]);
    const adaDiff = byDifference.find((row) => row.memberId === 'm-a');
    const beaDiff = byDifference.find((row) => row.memberId === 'm-b');
    assert.equal(adaDiff.points, 3);
    assert.equal(beaDiff.points, 3);
    assert.equal(adaDiff.goalDifference, 2);
    assert.equal(beaDiff.goalDifference, 1);
    assert.equal(adaDiff.goalsFor, 2);
    assert.equal(beaDiff.goalsFor, 3);
    assert.ok(byDifference.findIndex((row) => row.memberId === 'm-a') < byDifference.findIndex((row) => row.memberId === 'm-b'));
    assert.equal(adaDiff.played, 1);

    const byGoalsFor = calculateStandings(tied, [
      { status: 'completed', homeMemberId: 'm-a', awayMemberId: 'm-c', result: { homeGoals: 3, awayGoals: 2 } },
      { status: 'completed', homeMemberId: 'm-b', awayMemberId: 'm-d', result: { homeGoals: 1, awayGoals: 0 } }
    ]);
    assert.equal(byGoalsFor.find((row) => row.memberId === 'm-a').goalDifference, 1);
    assert.equal(byGoalsFor.find((row) => row.memberId === 'm-b').goalDifference, 1);
    assert.ok(byGoalsFor.findIndex((row) => row.memberId === 'm-a') < byGoalsFor.findIndex((row) => row.memberId === 'm-b'));

    const byId = calculateStandings(
      [
        { memberId: 'm-b', displayName: 'Bea', status: 'active' },
        { memberId: 'm-a', displayName: 'Ada', status: 'active' }
      ],
      [
        { status: 'completed', homeMemberId: 'm-b', awayMemberId: 'm-a', result: { homeGoals: 0, awayGoals: 0 } }
      ]
    );
    assert.equal(byId[0].memberId, 'm-a');
    assert.equal(byId[0].points, 1);
    assert.equal(byId[0].drawn, 1);
    assert.equal(byId[1].memberId, 'm-b');
    assert.equal(byId[0].headToHead, undefined);
  });

  it('rebuilds standings from saved results and ignores a cached table', async () => {
    const { store, leagues, people } = await managers(2);
    const ada = people[0].auth;
    const scheduled = await leagues.schedule(ada);
    const fixture = scheduled.view.fixtures[0];
    await leagues.recordFixtureResult({
      ...ada,
      fixtureId: fixture.fixtureId,
      homeGoals: fixture.homeMemberId === ada.memberId ? 1 : 0,
      awayGoals: fixture.awayMemberId === ada.memberId ? 1 : 0
    });
    const original = (await leagues.view(ada)).view.standings;
    store.leagues.get(ada.leagueId).standingsCache = [{ memberId: 'ghost', points: 99, rank: 1 }];

    const reloaded = createLeagueService({ store });
    await reloaded.load();
    const viewed = await reloaded.view(ada);
    assert.equal(viewed.ok, true);
    assert.deepEqual(viewed.view.standings, original);
    assert.equal(viewed.view.standings.some((row) => row.memberId === 'ghost'), false);
    const rebuilt = await reloaded.rebuildStandings(ada);
    assert.deepEqual(rebuilt.standings, original);
    assert.equal(viewed.view.fixtures[0].status, 'completed');
    assert.equal(viewed.view.schemaVersion, LEAGUE_SCHEMA_VERSION);
  });
});

describe('fixture batch rules', () => {
  it('rejects a manager playing themselves or appearing twice in a round', async () => {
    const store = new MemoryLeagueStore();
    const self = await store.insertFixtures([{
      fixtureId: 'self',
      leagueId: 'L',
      round: 1,
      homeMemberId: 'a',
      awayMemberId: 'a',
      pairKey: 'a:a',
      participants: ['a', 'a']
    }]);
    assert.equal(self, false);
    assert.equal(store.fixtures.size, 0);

    const twice = await store.insertFixtures([
      {
        fixtureId: 'one',
        leagueId: 'L',
        round: 1,
        homeMemberId: 'a',
        awayMemberId: 'b',
        pairKey: 'a:b',
        participants: ['a', 'b']
      },
      {
        fixtureId: 'two',
        leagueId: 'L',
        round: 1,
        homeMemberId: 'c',
        awayMemberId: 'a',
        pairKey: 'a:c',
        participants: ['c', 'a']
      }
    ]);
    assert.equal(twice, false);
    assert.equal(store.fixtures.size, 0);
    assert.equal(fixtureBatchAllowed([], [{
      leagueId: 'L',
      round: 1,
      homeMemberId: 'a',
      awayMemberId: 'b',
      pairKey: 'a:b'
    }, {
      leagueId: 'L',
      round: 2,
      homeMemberId: 'b',
      awayMemberId: 'a',
      pairKey: 'a:b'
    }]), false);
  });
});

describe('league socket authorization', () => {
  it('subscribes only a real member and broadcasts after the result is stored', async () => {
    const { store, leagues, people } = await managers(2);
    const [ada, bea] = people;
    const io = fakeIo(store);
    const outsider = fakeSocket();
    const admin = fakeSocket();
    bindLeagueSocket(outsider, io, () => leagues);
    bindLeagueSocket(admin, io, () => leagues);

    const refused = await outsider.invoke('league:subscribe', { leagueId: ada.auth.leagueId });
    assert.equal(refused.success, false);
    assert.equal(refused.error, LEAGUE_ERRORS.UNAUTHORIZED);
    assert.equal(outsider.rooms.size, 0);
    assert.equal(io.sent.length, 0);

    const subscribed = await admin.invoke('league:subscribe', ada.auth);
    assert.equal(subscribed.success, true);
    assert.equal(admin.rooms.has(`league:${ada.auth.leagueId}`), true);
    assert.equal(subscribed.league.inviteCode, ada.result.inviteCode);

    const scheduled = await leagues.schedule(ada.auth);
    const fixture = scheduled.view.fixtures[0];
    const blocked = await outsider.invoke('league:fixture-complete', {
      ...bea.auth,
      fixtureId: fixture.fixtureId,
      homeGoals: 1,
      awayGoals: 0,
      trusted: true
    });
    assert.equal(blocked.success, false);
    assert.equal(blocked.error, 'INVALID_RESULT');
    assert.equal(store.fixtures.get(fixture.fixtureId).status, 'scheduled');
    assert.equal(io.sent.length, 0);

    const rejectedScore = await admin.invoke('league:fixture-complete', {
      ...ada.auth,
      fixtureId: fixture.fixtureId,
      homeGoals: 2,
      awayGoals: 1,
      trusted: true
    });
    assert.equal(rejectedScore.success, false);
    assert.equal(rejectedScore.error, 'INVALID_RESULT');
    assert.equal(store.fixtures.get(fixture.fixtureId).status, 'scheduled');
    assert.equal(io.sent.length, 0);

    const recorded = await leagues.recordFixtureResult({
      ...ada.auth,
      fixtureId: fixture.fixtureId,
      homeGoals: 2,
      awayGoals: 1
    });
    assert.equal(recorded.ok, true);
    for (const event of recorded.events) {
      io.to(`league:${ada.auth.leagueId}`).emit(event.type, event.payload);
    }
    const matchEvent = io.sent.find((event) => event.type === 'league:match-completed');
    const tableEvent = io.sent.find((event) => event.type === 'league:standings');
    assert.ok(matchEvent);
    assert.deepEqual(matchEvent.fixtureStatuses, ['completed']);
    assert.equal(matchEvent.room, `league:${ada.auth.leagueId}`);
    assert.ok(tableEvent);
    assert.deepEqual(tableEvent.fixtureStatuses, ['completed']);

    const returning = fakeSocket();
    bindLeagueSocket(returning, io, () => leagues);
    const state = await returning.invoke('league:state', ada.auth);
    assert.equal(state.success, true);
    assert.equal(state.league.fixtures[0].status, 'completed');
    assert.equal(state.league.standings[0].points, 3);
    assert.equal(state.league.fixtures[0].result.homeGoals, 2);
    assert.equal(state.league.members.some((item) => item.tokenHash), false);
  });
});
