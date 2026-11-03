import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryLeagueStore } from '../league-store.js';
import { bindLeagueSocket } from '../league-sockets.js';
import { LEAGUE_ERRORS, createLeagueService } from '../league-service.js';
import { resultFromSimulation } from '../league-match.js';
import { simulateMatch } from '../match-simulator.js';
import { SeededRandom } from '../utils.js';
import { assignedStrength } from '../../shared/squad-evaluation.js';

const ROLES = ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'LW', 'ST', 'RW'];

function catalogFor(managers) {
  const cards = [];
  for (let manager = 0; manager < managers; manager += 1) {
    ROLES.forEach((role, index) => {
      const overall = 60 + manager * 3 + (index % 5);
      cards.push({
        id: `c-${manager}-${index}`,
        name: `${role} ${manager}-${index}`,
        position: role,
        stats: {
          pace: overall,
          shooting: overall,
          passing: overall,
          defense: overall,
          physical: overall,
          overall
        }
      });
    });
  }
  return cards;
}

function scripted(counter, homeGoals, awayGoals) {
  return (home, away) => {
    counter.n += 1;
    return {
      team1: {
        goals: homeGoals,
        overall: home.overall,
        playerId: home.playerId,
        username: home.username
      },
      team2: {
        goals: awayGoals,
        overall: away.overall,
        playerId: away.playerId,
        username: away.username
      },
      events: [{
        minute: 18,
        team: home.username,
        type: 'goal',
        player: home.team?.[10]?.name || 'Scorer',
        assist: null
      }],
      matchStats: { possession: { team1: 58, team2: 42 } }
    };
  };
}

function serviceFor(count, scorer) {
  const store = new MemoryLeagueStore();
  const counter = { n: 0 };
  const leagues = createLeagueService({
    store,
    catalog: catalogFor(count),
    simulate: scorer || scripted(counter, 2, 0)
  });
  return { store, leagues, counter };
}

async function managers(count, scorer) {
  const context = serviceFor(count, scorer);
  const created = await context.leagues.create({ name: 'League Cup', displayName: 'Ada' });
  assert.equal(created.ok, true, created.message);
  const people = [{ name: 'Ada', auth: authOf(created) }];
  const labels = ['Bea', 'Cal', 'Dee'];
  for (let index = 0; index < count - 1; index += 1) {
    const joined = await context.leagues.join({
      inviteCode: created.inviteCode,
      displayName: labels[index]
    });
    assert.equal(joined.ok, true, joined.message);
    people.push({ name: labels[index], auth: authOf(joined) });
  }
  const scheduled = await context.leagues.schedule(people[0].auth);
  assert.equal(scheduled.ok, true, scheduled.message);
  for (const person of people) {
    const squad = await context.leagues.registerSuggestedSquad(person.auth);
    assert.equal(squad.ok, true, squad.message);
  }
  return { ...context, people, scheduled };
}

function authOf(result) {
  return {
    leagueId: result.view.leagueId,
    memberId: result.memberId,
    memberToken: result.memberToken
  };
}

async function confirmBoth(leagues, people, fixtureId) {
  for (const person of people) {
    const confirmed = await leagues.confirmFixtureLineup({ ...person.auth, fixtureId });
    assert.equal(confirmed.ok, true, confirmed.message);
  }
}

function pointsOf(view, memberId) {
  return view.standings.find((row) => row.memberId === memberId).points;
}

describe('league fixture simulation', () => {
  it('simulates a fixture only after both current XIs are confirmed', async () => {
    const { leagues, people, counter } = await managers(2);
    const [ada, bea] = people;
    const fixtureId = (await leagues.view(ada.auth)).view.fixtures[0].fixtureId;
    const homeOnly = await leagues.confirmFixtureLineup({ ...ada.auth, fixtureId });
    assert.equal(homeOnly.ok, true, homeOnly.message);

    const blocked = await leagues.simulateLeagueFixture({ ...ada.auth, fixtureId });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error, LEAGUE_ERRORS.LINEUP_NOT_CONFIRMED);
    assert.equal(counter.n, 0);
    assert.equal((await leagues.view(ada.auth)).view.fixtures[0].phase, 'awaiting_lineups');

    const away = await leagues.confirmFixtureLineup({ ...bea.auth, fixtureId });
    assert.equal(away.ok, true, away.message);
    const ready = await leagues.view(ada.auth);
    assert.equal(ready.view.fixtures[0].phase, 'ready');

    const played = await leagues.simulateLeagueFixture({ ...ada.auth, fixtureId });
    assert.equal(played.ok, true, played.message);
    assert.equal(played.view.fixtures[0].status, 'completed');
    assert.equal(played.view.fixtures[0].result.homeGoals, 2);
    assert.equal(played.view.fixtures[0].result.awayGoals, 0);
    assert.equal(played.result.events[0].type, 'goal');
    assert.equal(counter.n, 1);
    const homeId = played.view.fixtures[0].homeMemberId;
    const awayId = played.view.fixtures[0].awayMemberId;
    assert.equal(pointsOf(played.view, homeId), 3);
    assert.equal(pointsOf(played.view, awayId), 0);
    assert.equal(played.view.status, 'completed');
    assert.equal(played.events.some((event) => event.type === 'league:completed'), true);
    assert.equal(played.events.some((event) => event.type === 'league:round:advanced'), false);
  });

  it('rejects an incomplete, duplicate, unowned, or stale lineup and another manager’s players', async () => {
    const { leagues, people } = await managers(2);
    const [ada, bea] = people;
    const fixtureId = (await leagues.view(ada.auth)).view.fixtures[0].fixtureId;
    const adaView = await leagues.view(ada.auth);
    const ownIds = adaView.view.you.squad.cards.map((card) => card.id);
    const beaIds = (await leagues.view(bea.auth)).view.you.squad.cards.map((card) => card.id);

    const short = await leagues.registerSquad({ ...ada.auth, cardIds: ownIds.slice(0, 10) });
    assert.equal(short.error, LEAGUE_ERRORS.SQUAD_INVALID);
    const duplicated = await leagues.registerSquad({ ...ada.auth, cardIds: [...ownIds, ownIds[0]] });
    assert.equal(duplicated.error, LEAGUE_ERRORS.SQUAD_INVALID);
    const unknown = await leagues.registerSquad({ ...ada.auth, cardIds: ownIds.map((id, index) => (index === 0 ? 'missing-card' : id)) });
    assert.equal(unknown.error, LEAGUE_ERRORS.SQUAD_INVALID);
    const stolen = await leagues.registerSquad({ ...ada.auth, cardIds: beaIds });
    assert.equal(stolen.error, LEAGUE_ERRORS.SQUAD_INVALID);

    const lineup = adaView.view.you.squad.lineup;
    const duplicatePlace = await leagues.updateLineup({
      ...ada.auth,
      formation: lineup.formation,
      expectedRevision: lineup.revision,
      assignments: lineup.assignments.map((slot, index) => (
        index === 1 ? { slotId: slot.slotId, cardId: lineup.assignments[0].cardId } : slot
      ))
    });
    assert.equal(duplicatePlace.ok, false);
    assert.equal(duplicatePlace.error, 'DUPLICATE_PLAYER');

    const unowned = await leagues.updateLineup({
      ...ada.auth,
      formation: lineup.formation,
      expectedRevision: lineup.revision,
      assignments: lineup.assignments.map((slot, index) => (
        index === 0 ? { slotId: slot.slotId, cardId: beaIds[0] } : slot
      ))
    });
    assert.equal(unowned.error, 'CARD_NOT_OWNED');

    const wrongPlace = await leagues.updateLineup({
      ...ada.auth,
      formation: lineup.formation,
      expectedRevision: lineup.revision,
      assignments: [{ slotId: 'not-a-place', cardId: ownIds[0] }]
    });
    assert.equal(wrongPlace.error, 'INVALID_POSITION');

    const stale = await leagues.confirmFixtureLineup({
      ...ada.auth,
      fixtureId,
      expectedRevision: lineup.revision + 9
    });
    assert.equal(stale.error, LEAGUE_ERRORS.STALE_LINEUP);

    await confirmBoth(leagues, people, fixtureId);
    const edited = await leagues.updateLineup({
      ...ada.auth,
      formation: lineup.formation,
      expectedRevision: lineup.revision,
      assignments: lineup.assignments,
      confirm: true
    });
    assert.equal(edited.ok, true, edited.message);
    const blocked = await leagues.simulateLeagueFixture({ ...bea.auth, fixtureId });
    assert.equal(blocked.error, LEAGUE_ERRORS.STALE_LINEUP);
    assert.equal((await leagues.view(ada.auth)).view.fixtures[0].status, 'scheduled');
  });

  it('refuses another manager, a client score, and a trusted flag', async () => {
    const { leagues, people, store } = await managers(3);
    const [ada, bea, cal] = people;
    const view = (await leagues.view(ada.auth)).view;
    const fixture = view.fixtures.find((item) => item.round === view.currentRound);
    assert.ok(fixture);
    const outsiderPerson = [ada, bea, cal].find((person) => (
      person.auth.memberId !== fixture.homeMemberId && person.auth.memberId !== fixture.awayMemberId
    ));
    assert.ok(outsiderPerson);
    const outsider = await leagues.confirmFixtureLineup({ ...outsiderPerson.auth, fixtureId: fixture.fixtureId });
    assert.equal(outsider.error, LEAGUE_ERRORS.UNAUTHORIZED);
    const denied = await leagues.simulateLeagueFixture({
      ...outsiderPerson.auth,
      fixtureId: fixture.fixtureId,
      homeGoals: 9,
      awayGoals: 0,
      trusted: true
    });
    assert.equal(denied.error, LEAGUE_ERRORS.UNAUTHORIZED);
    assert.equal(store.fixtures.get(fixture.fixtureId).status, 'scheduled');

    const participants = people.filter((person) => (
      person.auth.memberId === fixture.homeMemberId || person.auth.memberId === fixture.awayMemberId
    ));
    await confirmBoth(leagues, participants, fixture.fixtureId);
    const scored = await leagues.simulateLeagueFixture({
      ...participants[0].auth,
      fixtureId: fixture.fixtureId,
      homeGoals: 4,
      awayGoals: 1,
      trusted: true,
      winner: participants[0].auth.memberId
    });
    assert.equal(scored.error, LEAGUE_ERRORS.INVALID_RESULT);
    assert.equal(store.fixtures.get(fixture.fixtureId).status, 'scheduled');
    assert.equal(store.fixtures.get(fixture.fixtureId).result, null);
  });

  it('returns the same result on retry and does not award points twice', async () => {
    const { leagues, people, counter } = await managers(2);
    const fixtureId = (await leagues.view(people[0].auth)).view.fixtures[0].fixtureId;
    await confirmBoth(leagues, people, fixtureId);
    const first = await leagues.simulateLeagueFixture({ ...people[0].auth, fixtureId });
    const second = await leagues.simulateLeagueFixture({ ...people[1].auth, fixtureId });
    assert.equal(first.ok, true, first.message);
    assert.equal(second.ok, true, second.message);
    assert.equal(second.alreadyComplete, true);
    assert.deepEqual(second.result, first.result);
    assert.equal(counter.n, 1);
    assert.equal(second.view.standings.reduce((sum, row) => sum + row.points, 0), 3);
    assert.deepEqual(second.events, []);
  });

  it('awards a draw one point each and keeps a concurrent pair to one result', async () => {
    const counter = { n: 0 };
    const { leagues, people } = await managers(2, scripted(counter, 1, 1));
    const fixtureId = (await leagues.view(people[0].auth)).view.fixtures[0].fixtureId;
    await confirmBoth(leagues, people, fixtureId);
    const [first, second] = await Promise.all([
      leagues.simulateLeagueFixture({ ...people[0].auth, fixtureId }),
      leagues.simulateLeagueFixture({ ...people[1].auth, fixtureId })
    ]);
    const results = [first, second];
    assert.equal(results.every((result) => result.ok), true, results.map((result) => result.message).join(' '));
    assert.equal(results.filter((result) => result.alreadyComplete).length, 1);
    assert.equal(counter.n, 1);
    const view = (await leagues.view(people[0].auth)).view;
    assert.equal(view.fixtures.filter((fixture) => fixture.status === 'completed').length, 1);
    assert.equal(view.fixtures[0].result.homeGoals, 1);
    assert.equal(view.fixtures[0].result.awayGoals, 1);
    assert.equal(view.standings.every((row) => row.points === 1 && row.drawn === 1), true);
  });

  it('does not advance a round until every fixture in it is complete, then advances once', async () => {
    const { leagues, people } = await managers(4);
    const view = (await leagues.view(people[0].auth)).view;
    const roundOne = view.fixtures.filter((fixture) => fixture.round === 1);
    assert.equal(roundOne.length, 2);
    const fixtureCount = view.fixtures.length;

    const playersFor = (fixture) => people.filter((person) => (
      person.auth.memberId === fixture.homeMemberId || person.auth.memberId === fixture.awayMemberId
    ));
    await confirmBoth(leagues, playersFor(roundOne[0]), roundOne[0].fixtureId);
    const first = await leagues.simulateLeagueFixture({
      ...playersFor(roundOne[0])[0].auth,
      fixtureId: roundOne[0].fixtureId
    });
    assert.equal(first.ok, true, first.message);
    assert.equal(first.view.currentRound, 1);
    assert.equal(first.view.status, 'active');
    assert.equal(first.view.fixtures.filter((fixture) => fixture.round === 1 && fixture.status !== 'completed').length, 1);
    assert.equal(first.events.some((event) => event.type === 'league:round:advanced'), false);

    await confirmBoth(leagues, playersFor(roundOne[1]), roundOne[1].fixtureId);
    const [left, right] = await Promise.all([
      leagues.simulateLeagueFixture({ ...playersFor(roundOne[1])[0].auth, fixtureId: roundOne[1].fixtureId }),
      leagues.simulateLeagueFixture({ ...playersFor(roundOne[1])[1].auth, fixtureId: roundOne[1].fixtureId })
    ]);
    assert.equal(left.ok && right.ok, true, `${left.message} ${right.message}`);
    const after = (await leagues.view(people[0].auth)).view;
    assert.equal(after.currentRound, 2);
    assert.equal(after.status, 'active');
    assert.equal(after.fixtures.length, fixtureCount);
    assert.equal(after.fixtures.filter((fixture) => fixture.round === 2 && fixture.status === 'scheduled').length, 2);
    const advanced = [left, right].filter((result) => result.events?.some((event) => event.type === 'league:round:advanced'));
    assert.equal(advanced.length, 1);
  });

  it('passes the confirmed XI to the real simulator and keeps that score', async () => {
    const store = new MemoryLeagueStore();
    let seen = null;
    const leagues = createLeagueService({
      store,
      catalog: catalogFor(2),
      simulate(home, away, seed) {
        seen = { home, away, seed };
        const random = new SeededRandom(seed >>> 0);
        return simulateMatch(home, away, () => random.next());
      }
    });
    const created = await leagues.create({ name: 'Real Match', displayName: 'Ada' });
    const bea = await leagues.join({ inviteCode: created.inviteCode, displayName: 'Bea' });
    const people = [
      { auth: authOf(created) },
      { auth: authOf(bea) }
    ];
    assert.equal((await leagues.schedule(people[0].auth)).ok, true);
    assert.equal((await leagues.registerSuggestedSquad(people[0].auth)).ok, true);
    assert.equal((await leagues.registerSuggestedSquad(people[1].auth)).ok, true);
    const fixture = (await leagues.view(people[0].auth)).view.fixtures[0];
    await confirmBoth(leagues, people, fixture.fixtureId);
    const played = await leagues.simulateLeagueFixture({ ...people[0].auth, fixtureId: fixture.fixtureId });
    assert.equal(played.ok, true, played.message);
    assert.ok(seen);
    assert.equal(seen.home.team.length, 11);
    assert.equal(seen.away.team.length, 11);
    const homeStrength = assignedStrength(seen.home.team.map((card) => ({ card, role: card.assignedPosition })));
    const awayStrength = assignedStrength(seen.away.team.map((card) => ({ card, role: card.assignedPosition })));
    assert.equal(seen.home.overall, homeStrength);
    assert.equal(seen.away.overall, awayStrength);
    assert.equal(played.result.homeOverall, homeStrength);
    assert.equal(played.result.awayOverall, awayStrength);
    assert.deepEqual(
      seen.home.team.map((card) => String(card.id)).sort(),
      (await leagues.view(people[0].auth)).view.members
        .find((member) => member.memberId === fixture.homeMemberId)
        .squad.cards.map((card) => String(card.id)).sort()
    );
    const again = await leagues.simulateLeagueFixture({ ...people[1].auth, fixtureId: fixture.fixtureId });
    assert.deepEqual(again.result, played.result);
  });

  it('does not broadcast success when the durable write fails, and a retry keeps the pending score', async () => {
    const counter = { n: 0 };
    class FlakyStore extends MemoryLeagueStore {
      failComplete = true;

      async compareAndSetFixture(fixtureId, expected, next) {
        if (this.failComplete && next?.status === 'completed') {
          this.failComplete = false;
          return false;
        }
        return super.compareAndSetFixture(fixtureId, expected, next);
      }
    }
    const store = new FlakyStore();
    const leagues = createLeagueService({
      store,
      catalog: catalogFor(2),
      simulate: scripted(counter, 3, 1)
    });
    const created = await leagues.create({ name: 'Flaky', displayName: 'Ada' });
    const bea = await leagues.join({ inviteCode: created.inviteCode, displayName: 'Bea' });
    const people = [{ auth: authOf(created) }, { auth: authOf(bea) }];
    await leagues.schedule(people[0].auth);
    await leagues.registerSuggestedSquad(people[0].auth);
    await leagues.registerSuggestedSquad(people[1].auth);
    const fixtureId = (await leagues.view(people[0].auth)).view.fixtures[0].fixtureId;
    await confirmBoth(leagues, people, fixtureId);

    const io = { sent: [] };
    const socket = {
      on(event, handler) { this.handlers.set(event, handler); },
      handlers: new Map(),
      join() {},
      invoke(event, data) {
        return new Promise((resolve, reject) => {
          const handler = this.handlers.get(event);
          if (!handler) {
            reject(new Error(event));
            return;
          }
          Promise.resolve(handler(data, resolve)).catch(reject);
        });
      }
    };
    bindLeagueSocket(socket, {
      to() {
        return {
          emit: (type, payload) => io.sent.push({ type, payload })
        };
      }
    }, () => leagues);

    const failed = await socket.invoke('league:fixture:simulate', { ...people[0].auth, fixtureId });
    assert.equal(failed.success, false);
    assert.equal(failed.error, LEAGUE_ERRORS.CONFLICT);
    assert.equal(io.sent.length, 0);
    assert.equal(store.fixtures.get(fixtureId).status, 'simulating');
    assert.equal(store.fixtures.get(fixtureId).pendingResult.homeGoals, 3);
    assert.equal((await leagues.view(people[0].auth)).view.standings.every((row) => row.points === 0), true);

    const recovered = await socket.invoke('league:fixture:simulate', { ...people[1].auth, fixtureId });
    assert.equal(recovered.success, true, recovered.message);
    assert.equal(recovered.result.homeGoals, 3);
    assert.equal(recovered.result.awayGoals, 1);
    assert.equal(counter.n, 1);
    assert.equal(store.fixtures.get(fixtureId).status, 'completed');
    assert.ok(io.sent.some((event) => event.type === 'league:match-completed'));
    const table = (await leagues.view(people[0].auth)).view;
    assert.equal(table.standings.reduce((sum, row) => sum + row.points, 0), 3);
  });

  it('reloads a saved league and recovers one unfinished claim without a second score', async () => {
    class FlakyStore extends MemoryLeagueStore {
      failPending = true;

      async compareAndSetFixture(fixtureId, expected, next) {
        if (this.failPending && next?.status === 'simulating' && next.pendingResult) {
          this.failPending = false;
          return false;
        }
        return super.compareAndSetFixture(fixtureId, expected, next);
      }
    }
    const store = new FlakyStore();
    const catalog = catalogFor(2);
    const first = createLeagueService({ store, catalog });
    const created = await first.create({ name: 'Restart', displayName: 'Ada' });
    const bea = await first.join({ inviteCode: created.inviteCode, displayName: 'Bea' });
    const ada = authOf(created);
    const other = authOf(bea);
    await first.schedule(ada);
    await first.registerSuggestedSquad(ada);
    await first.registerSuggestedSquad(other);
    const fixtureId = (await first.view(ada)).view.fixtures[0].fixtureId;
    await confirmBoth(first, [{ auth: ada }, { auth: other }], fixtureId);
    const failed = await first.simulateLeagueFixture({ ...ada, fixtureId });
    assert.equal(failed.ok, false);
    assert.equal(failed.events.length, 0);
    const saved = store.fixtures.get(fixtureId);
    assert.equal(saved.status, 'simulating');
    assert.equal(saved.pendingResult, null);
    assert.equal(saved.result, null);
    assert.ok(saved.claimedHome?.team?.length === 11);
    assert.equal(Number.isInteger(saved.simulationSeed), true);

    const random = new SeededRandom(saved.simulationSeed >>> 0);
    const expected = simulateMatch(saved.claimedHome, saved.claimedAway, () => random.next());
    const second = createLeagueService({ store, catalog });
    await second.load();
    const tokenCheck = await second.view(ada);
    assert.equal(tokenCheck.ok, true);
    assert.equal(tokenCheck.view.fixtures[0].confirmations.filter((item) => item.confirmed).length, 2);
    const recovered = await second.simulateLeagueFixture({ ...other, fixtureId });
    assert.equal(recovered.ok, true, recovered.message);
    assert.equal(recovered.result.homeGoals, expected.team1.goals);
    assert.equal(recovered.result.awayGoals, expected.team2.goals);
    assert.deepEqual(
      recovered.result.events,
      resultFromSimulation(expected, saved.claimedHome, saved.claimedAway).events
    );
    const retry = await second.simulateLeagueFixture({ ...ada, fixtureId });
    assert.equal(retry.alreadyComplete, true);
    assert.deepEqual(retry.result, recovered.result);
    assert.equal(store.fixtures.get(fixtureId).status, 'completed');
    const reloaded = createLeagueService({ store, catalog });
    await reloaded.load();
    const viewed = await reloaded.view(ada);
    assert.deepEqual(viewed.view.fixtures[0].result, recovered.view.fixtures[0].result);
    assert.deepEqual(viewed.view.standings, recovered.view.standings);
  });
});
