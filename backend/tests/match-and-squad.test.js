import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { simulateMatch, simulateTournament, calculatePossession } from '../match-simulator.js';
import { SeededRandom } from '../utils.js';
import { autoSelectTeam, calculateTeamOverall, suggestFormation, validateFormation } from '../team-builder.js';

function side(id, overall, team = []) {
  return { playerId: id, username: id, overall, team };
}

function assertResult(result) {
  assert.equal(Number.isInteger(result.team1.goals), true);
  assert.equal(Number.isInteger(result.team2.goals), true);
  assert.ok(result.team1.goals >= 0);
  assert.ok(result.team2.goals >= 0);
  assert.equal(result.isDraw, result.team1.goals === result.team2.goals);
  if (result.isDraw) assert.equal(result.winner, null);
  else if (result.team1.goals > result.team2.goals) assert.equal(result.winner, result.team1.playerId);
  else assert.equal(result.winner, result.team2.playerId);
  assert.equal(result.events.length, result.team1.goals + result.team2.goals);
  for (const event of result.events) {
    assert.ok(event.minute >= 1 && event.minute <= 90);
    assert.equal(event.type, 'goal');
  }
  assert.equal(result.matchStats.possession.team1 + result.matchStats.possession.team2, 100);
}

function player(id, position, overall) {
  return { id, name: id, position, stats: { overall } };
}

describe('match simulation', () => {
  it('keeps scores, winners, events, and possession consistent', () => {
    for (let i = 0; i < 25; i += 1) {
      assertResult(simulateMatch(side('home', 70 + (i % 20)), side('away', 60 + (i % 15))));
    }
    assert.deepEqual(calculatePossession(0, 0), { team1: 50, team2: 50 });
    assert.throws(() => simulateMatch(null, side('away', 70)), /Both teams required/);

    const eleven = Array.from({ length: 11 }, (_, index) => ({
      id: `p${index}`,
      name: `P${index}`,
      position: index === 0 ? 'GK' : 'ST'
    }));
    assertResult(simulateMatch(side('home', 80, eleven), side('away', 70, eleven)));
    assert.throws(
      () => simulateMatch(side('home', 80, eleven.slice(0, 10)), side('away', 70, eleven)),
      /exactly 11/
    );
    assert.throws(
      () => simulateMatch(side('home', 80, [...eleven, { id: 'extra', position: 'ST' }]), side('away', 70, eleven)),
      /exactly 11/
    );

    const zero = simulateMatch(side('home', 0, eleven), side('away', 0, eleven));
    assert.equal(zero.team1.overall, 0);
    assert.equal(zero.team2.overall, 0);
    const missing = simulateMatch({ playerId: 'home', username: 'home', team: [] }, { playerId: 'away', username: 'away', team: [] });
    assert.equal(missing.team1.overall, 75);
    assert.equal(missing.team2.overall, 75);

    const seeded = (seed) => {
      const random = new SeededRandom(seed);
      return () => random.next();
    };
    const first = simulateMatch(side('home', 88, eleven), side('away', 61, eleven), seeded(42));
    const second = simulateMatch(side('home', 88, eleven), side('away', 61, eleven), seeded(42));
    assert.deepEqual(first, second);
  });

  it('awards round-robin points that match the matches played', () => {
    const teams = [side('a', 90), side('b', 70), side('c', 50)];
    const tournament = simulateTournament(teams, 'round-robin');
    assert.equal(tournament.matches.length, 3);
    assert.equal(tournament.standings.length, 3);
    for (const standing of tournament.standings) {
      assert.equal(standing.played, 2);
      assert.equal(standing.won + standing.drawn + standing.lost, standing.played);
      assert.equal(standing.points, standing.won * 3 + standing.drawn);
      assert.equal(standing.goalDifference, standing.goalsFor - standing.goalsAgainst);
    }
    const points = tournament.standings.reduce((sum, standing) => sum + standing.points, 0);
    const distributed = tournament.matches.reduce((sum, match) => sum + (match.isDraw ? 2 : 3), 0);
    assert.equal(points, distributed);
    assert.equal(tournament.winner.playerId, tournament.standings[0].playerId);
  });

  it('returns one of the entrants from a knockout, including a bye', () => {
    const teams = [side('a', 80), side('b', 60), side('c', 70)];
    const tournament = simulateTournament(teams, 'knockout');
    assert.ok(teams.some((team) => team.playerId === tournament.winner.playerId));
    assert.ok(tournament.finalMatch);
    assert.throws(() => simulateTournament([side('only', 80)]), /at least 2/);
  });
});

describe('squad limits', () => {
  it('builds a match squad of exactly 11 and rejects any other size', () => {
    const cards = [
      player('gk', 'GK', 80),
      player('lb', 'LB', 70),
      player('cb1', 'CB', 75),
      player('cb2', 'CB', 74),
      player('rb', 'RB', 71),
      player('cm1', 'CM', 78),
      player('cm2', 'CM', 77),
      player('cam', 'CAM', 82),
      player('lw', 'LW', 76),
      player('rw', 'RW', 73),
      player('st', 'ST', 88),
      player('sub', 'ST', 60)
    ];
    assert.equal(suggestFormation(cards), '4-3-3');
    const squad = autoSelectTeam(cards, '4-3-3');
    assert.equal(squad.length, 11);
    assert.equal(new Set(squad.map((card) => card.id)).size, 11);
    assert.equal(squad.filter((card) => card.assignedPosition === 'GK').length, 1);

    const formation = validateFormation(squad, '4-3-3');
    assert.equal(formation.valid, true, formation.errors.join(', '));
    assert.equal(typeof calculateTeamOverall(squad), 'number');

    assert.equal(validateFormation(squad.slice(0, 10), '4-3-3').valid, false);
    assert.equal(validateFormation([...squad, player('extra', 'ST', 50)], '4-3-3').valid, false);
    const twoKeepers = squad.map((card, index) => (
      index === 1 ? { ...card, assignedPosition: 'GK', position: 'GK' } : card
    ));
    assert.equal(validateFormation(twoKeepers, '4-3-3').valid, false);
    const blank = { id: 'blank', name: 'Blank', position: 'ST' };
    const zero = { id: 'zero', name: 'Zero', position: 'ST', stats: { overall: 0 } };
    const base = cards.filter((card) => card.id !== 'st' && card.id !== 'sub');
    const ranked = autoSelectTeam([...base, blank, zero], '4-3-3');
    assert.equal(ranked.some((card) => card.id === 'zero'), true);
    assert.equal(ranked.some((card) => card.id === 'blank'), false);

    assert.throws(() => autoSelectTeam(cards.slice(0, 10)), /at least 11/);
    assert.throws(() => calculateTeamOverall(squad.slice(0, 10)), /exactly 11/);
  });
});
