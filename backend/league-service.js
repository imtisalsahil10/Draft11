/**
 * LEAGUE FOUNDATION
 *
 * Identity
 * Draft11 has no login. A Player document is created from a display name and
 * does not prove who is calling. A seat token proves a seat inside one live
 * room and ends with that room. Neither is a league account.
 * Membership is a member id plus an unguessable member token issued by the
 * server when the league is created or joined. The token is stored only as a
 * hash. Knowing a league id, a fixture id, or a display name does not
 * authorize anything. A lost token cannot be recovered, because there is no
 * account to sign in to. Joining again without that token creates a new
 * member. Presenting the same token again does not.
 *
 * Scoring
 * Win 3, draw 1, loss 0. Standings sort by points, then goal difference, then
 * goals for, then head-to-head points among clubs still tied on those keys,
 * then member id. The table is calculated from completed fixtures whenever it
 * is read. A standingsCache field on a document is ignored.
 * The round shown to a client is derived from fixtures, then stored after
 * the fixture write so a restart does not depend on a missed socket event.
 *
 * Match results
 * simulateLeagueFixture is the playable path. It confirms both managers have
 * a current XI, then asks the existing match simulator for the score. The
 * client cannot submit goals, a winner, or a trusted flag.
 * A fixture is claimed with a conditional status change before the score is
 * kept. The simulated score is stored as pendingResult while the fixture is
 * still simulating, and only then marked completed. A retry of a completed
 * fixture returns that result. A retry after a crash uses the stored seed
 * and the stored XI, so it does not invent a second score once pendingResult
 * exists. Standings are still calculated from completed fixtures only.
 * recordFixtureResult remains for an administrator recording a score that is
 * already known. It does not accept a trusted flag. Sockets do not call it.
 * Each fixture accepts one completed result.
 * Leagues are not LiveRoom documents. A fixture may point at a room code.
 *
 * Auction squads are linked with linkAuctionSquad. The caller must present
 * the seat token and the league member token. Card ids come from the live
 * seat while it is still in the room, or from the finished-seat handoff
 * after that room is gone. Attributes come from the server catalog. The
 * seat itself is left unchanged. A retry with the same tokens returns the
 * association already stored.
 *
 * Squad acquisition
 * The public server is auction-only. It constructs this service with
 * catalogSquads: false. registerSquad and registerSuggestedSquad then
 * reject. Those two methods stay available for in-process tests and for
 * building fixtures inside this process. A socket payload cannot turn
 * them back on. A client squad has to come from linkAuctionSquad.
 *
 * Crash window: if the process dies after the simulator returns and before
 * pendingResult is written, recovery simulates again from the same seed and
 * the same stored XI. The seed makes that replay the same score. If the seed
 * or the stored XI is missing, the claim is released and nothing is awarded.
 * LEAGUE_CRASH_AFTER is unset on a normal server. A test may set it to one
 * of LEAGUE_CRASH_POINTS. The process is then killed with SIGKILL after that
 * durable step and does not run the shutdown flush.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { LEAGUE_SCHEMA_VERSION } from './constants.js';
import { simulateMatch } from './match-simulator.js';
import { SeededRandom } from './utils.js';
import {
  applyLineupChange,
  presentLineup
} from '../shared/squad-evaluation.js';
import {
  canonicalCard,
  clientSuppliedResult,
  confirmationCurrent,
  indexCatalog,
  resultFromSimulation,
  sideFromMember,
  squadCardIds,
  squadsOverlap,
  suggestEleven
} from './league-match.js';

export const LEAGUE_CRASH_POINTS = [
  'before-claim',
  'after-claim',
  'after-simulation',
  'after-pending',
  'after-complete',
  'before-round-reconcile'
];

export const DEFAULT_SCORING = {
  win: 3,
  draw: 1,
  loss: 0,
  tieBreak: ['points', 'goalDifference', 'goalsFor', 'headToHeadPoints', 'memberId'],
  summary: 'Win 3, draw 1, loss 0. Standings sort by points, then goal difference, then goals for, then head-to-head points among clubs still tied on those keys, then member id.'
};

export const LEAGUE_ERRORS = {
  INVALID_PARAMETERS: 'INVALID_PARAMETERS',
  INVITE_INVALID: 'INVITE_INVALID',
  UNAUTHORIZED: 'UNAUTHORIZED',
  DUPLICATE_MEMBER: 'DUPLICATE_MEMBER',
  LEAGUE_FULL: 'LEAGUE_FULL',
  LEAGUE_STARTED: 'LEAGUE_STARTED',
  NOT_ENOUGH_MEMBERS: 'NOT_ENOUGH_MEMBERS',
  ALREADY_SCHEDULED: 'ALREADY_SCHEDULED',
  LAST_ADMIN: 'LAST_ADMIN',
  FIXTURE_PENDING: 'FIXTURE_PENDING',
  FIXTURE_NOT_FOUND: 'FIXTURE_NOT_FOUND',
  FIXTURE_ALREADY_COMPLETE: 'FIXTURE_ALREADY_COMPLETE',
  FIXTURE_NOT_PLAYABLE: 'FIXTURE_NOT_PLAYABLE',
  FIXTURE_SIMULATING: 'FIXTURE_SIMULATING',
  LINEUP_NOT_CONFIRMED: 'LINEUP_NOT_CONFIRMED',
  SQUAD_INVALID: 'SQUAD_INVALID',
  STALE_LINEUP: 'STALE_LINEUP',
  RATE_LIMITED: 'RATE_LIMITED',
  INVALID_RESULT: 'INVALID_RESULT',
  CONFLICT: 'CONFLICT'
};

const MAX_MEMBERS = 20;

function fail(error, message) {
  return { ok: false, error, message, events: [] };
}

function crashIf(point) {
  if (process.env.LEAGUE_CRASH_AFTER !== point) return;
  try {
    process.kill(process.pid, 'SIGKILL');
  } catch {
    process.exit(137);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function instant(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function nowStamp(now) {
  const value = now();
  return value instanceof Date ? value.toISOString() : instant(value) || new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

function hashSecret(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function secretsMatch(raw, digest) {
  if (typeof raw !== 'string' || !raw || typeof digest !== 'string' || digest.length !== 64) return false;
  const actual = Buffer.from(hashSecret(raw), 'hex');
  const expected = Buffer.from(digest, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function cleanName(value, min, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) return null;
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) return null;
  return trimmed;
}

function pairKey(left, right) {
  return [String(left), String(right)].sort().join(':');
}

function publicMember(member) {
  return {
    memberId: member.memberId,
    displayName: member.displayName,
    role: member.role,
    status: member.status,
    joinedAt: member.joinedAt
  };
}

function emptyLineup() {
  return {
    formation: '4-3-3',
    revision: 0,
    confirmed: false,
    slots: []
  };
}

function publicSquad(member) {
  const squad = member?.squad;
  if (!squad || !Array.isArray(squad.cards) || squad.cards.length === 0) return null;
  const cards = squad.cards.map((card) => canonicalCard(card)).filter(Boolean);
  return {
    revision: Number.isInteger(squad.revision) ? squad.revision : 0,
    cards,
    lineup: presentLineup(cards, squad.lineup || emptyLineup())
  };
}

function publicResult(result) {
  if (!result || !Number.isInteger(result.homeGoals) || !Number.isInteger(result.awayGoals)) return null;
  return {
    homeGoals: result.homeGoals,
    awayGoals: result.awayGoals,
    homeOverall: Number.isFinite(result.homeOverall) ? result.homeOverall : null,
    awayOverall: Number.isFinite(result.awayOverall) ? result.awayOverall : null,
    isDraw: result.homeGoals === result.awayGoals,
    winnerMemberId: typeof result.winnerMemberId === 'string' ? result.winnerMemberId : null,
    possession: result.possession && Number.isInteger(result.possession.home) && Number.isInteger(result.possession.away)
      ? { home: result.possession.home, away: result.possession.away }
      : null,
    events: Array.isArray(result.events) ? result.events.map((event) => ({ ...event })) : []
  };
}

function presentFixture(fixture, league) {
  const members = league?.members || [];
  const confirmations = [fixture.homeMemberId, fixture.awayMemberId].map((memberId) => {
    const member = members.find((item) => item.memberId === memberId) || null;
    const saved = (fixture.confirmations || []).find((item) => item.memberId === memberId) || null;
    const current = confirmationCurrent(member, saved);
    return {
      memberId,
      confirmed: current,
      lineupRevision: current ? saved.lineupRevision : null,
      squadRevision: current ? saved.squadRevision : null
    };
  });
  let phase = 'awaiting_lineups';
  if (fixture.status === 'completed' && fixture.result) phase = 'completed';
  else if (fixture.status === 'simulating') phase = 'simulating';
  else if (confirmations.every((item) => item.confirmed)) phase = 'ready';
  return {
    fixtureId: fixture.fixtureId,
    leagueId: fixture.leagueId,
    round: fixture.round,
    homeMemberId: fixture.homeMemberId,
    awayMemberId: fixture.awayMemberId,
    status: fixture.status,
    phase,
    confirmations,
    roomCode: fixture.roomCode || null,
    savedGameId: fixture.savedGameId || null,
    result: publicResult(fixture.result),
    completedAt: fixture.completedAt || null
  };
}

/**
 * Circle method. Odd counts get a bye, which is not a fixture, so nobody
 * plays themselves and every pair meets once.
 * @returns {Array<Array<{home: string, away: string}>>}
 */
export function buildRoundRobin(memberIds) {
  const ids = [...memberIds];
  if (new Set(ids.map(String)).size !== ids.length) {
    throw new Error('Duplicate managers cannot be scheduled');
  }
  if (ids.length < 2) throw new Error('Need at least 2 managers');

  const teams = [...ids];
  if (teams.length % 2 === 1) teams.push(null);
  const count = teams.length;
  const rounds = count - 1;
  const half = count / 2;
  const rotation = [...teams];
  const schedule = [];

  for (let round = 0; round < rounds; round += 1) {
    const fixtures = [];
    for (let index = 0; index < half; index += 1) {
      const left = rotation[index];
      const right = rotation[count - 1 - index];
      if (left == null || right == null) continue;
      const swap = round % 2 === 1;
      fixtures.push(swap ? { home: right, away: left } : { home: left, away: right });
    }
    schedule.push(fixtures);
    const fixed = rotation[0];
    const rest = rotation.slice(1);
    rest.unshift(rest.pop());
    rotation.splice(0, rotation.length, fixed, ...rest);
  }

  return schedule;
}

function headToHeadPoints(fixtures, memberIds, scoring) {
  const ids = new Set(memberIds);
  const points = new Map(memberIds.map((id) => [id, 0]));
  for (const fixture of fixtures) {
    if (fixture.status !== 'completed' || !fixture.result) continue;
    if (!ids.has(fixture.homeMemberId) || !ids.has(fixture.awayMemberId)) continue;
    const home = fixture.result.homeGoals;
    const away = fixture.result.awayGoals;
    if (home > away) points.set(fixture.homeMemberId, points.get(fixture.homeMemberId) + scoring.win);
    else if (away > home) points.set(fixture.awayMemberId, points.get(fixture.awayMemberId) + scoring.win);
    else {
      points.set(fixture.homeMemberId, points.get(fixture.homeMemberId) + scoring.draw);
      points.set(fixture.awayMemberId, points.get(fixture.awayMemberId) + scoring.draw);
    }
  }
  return points;
}

/**
 * Standings from completed fixtures only. Incomplete fixtures add nothing.
 */
export function calculateStandings(members, fixtures, scoring = DEFAULT_SCORING) {
  const rows = new Map();
  for (const member of members) {
    rows.set(member.memberId, {
      memberId: member.memberId,
      displayName: member.displayName,
      played: 0,
      won: 0,
      drawn: 0,
      lost: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      goalDifference: 0,
      points: 0
    });
  }

  const completed = (fixtures || []).filter((fixture) => fixture.status === 'completed' && fixture.result);
  for (const fixture of completed) {
    const home = rows.get(fixture.homeMemberId);
    const away = rows.get(fixture.awayMemberId);
    if (!home || !away) continue;
    const homeGoals = fixture.result.homeGoals;
    const awayGoals = fixture.result.awayGoals;
    home.played += 1;
    away.played += 1;
    home.goalsFor += homeGoals;
    home.goalsAgainst += awayGoals;
    away.goalsFor += awayGoals;
    away.goalsAgainst += homeGoals;
    if (homeGoals > awayGoals) {
      home.won += 1;
      home.points += scoring.win;
      away.lost += 1;
      away.points += scoring.loss;
    } else if (awayGoals > homeGoals) {
      away.won += 1;
      away.points += scoring.win;
      home.lost += 1;
      home.points += scoring.loss;
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += scoring.draw;
      away.points += scoring.draw;
    }
  }

  for (const row of rows.values()) row.goalDifference = row.goalsFor - row.goalsAgainst;

  const groupKey = (row) => `${row.points}|${row.goalDifference}|${row.goalsFor}`;
  const groups = new Map();
  for (const row of rows.values()) {
    const bucket = groups.get(groupKey(row)) || [];
    bucket.push(row);
    groups.set(groupKey(row), bucket);
  }

  const h2h = new Map();
  for (const bucket of groups.values()) {
    const points = bucket.length < 2
      ? new Map(bucket.map((row) => [row.memberId, 0]))
      : headToHeadPoints(completed, bucket.map((row) => row.memberId), scoring);
    for (const [id, value] of points) h2h.set(id, value);
  }

  const list = [...rows.values()];
  list.sort((left, right) => {
    if (right.points !== left.points) return right.points - left.points;
    if (right.goalDifference !== left.goalDifference) return right.goalDifference - left.goalDifference;
    if (right.goalsFor !== left.goalsFor) return right.goalsFor - left.goalsFor;
    const rightHead = h2h.get(right.memberId) || 0;
    const leftHead = h2h.get(left.memberId) || 0;
    if (rightHead !== leftHead) return rightHead - leftHead;
    if (left.memberId < right.memberId) return -1;
    if (left.memberId > right.memberId) return 1;
    return 0;
  });

  return list.map((row, index) => ({ ...row, rank: index + 1 }));
}

function progressFrom(league, fixtures) {
  if (!fixtures.length) {
    return {
      currentRound: 0,
      status: league.status === 'completed' ? 'forming' : (league.status || 'forming')
    };
  }
  const rounds = [...new Set(fixtures.map((fixture) => fixture.round))].sort((a, b) => a - b);
  const open = rounds.find((round) => fixtures.some((fixture) => (
    fixture.round === round && fixture.status !== 'completed'
  )));
  if (open) return { currentRound: open, status: 'active' };
  return { currentRound: rounds[rounds.length - 1], status: 'completed' };
}

function standingMembers(league, fixtures) {
  const played = new Set();
  for (const fixture of fixtures) {
    if (fixture.status !== 'completed') continue;
    played.add(fixture.homeMemberId);
    played.add(fixture.awayMemberId);
  }
  return league.members.filter((member) => member.status === 'active' || played.has(member.memberId));
}

function normalizeLeague(doc) {
  return {
    leagueId: doc.leagueId,
    schemaVersion: doc.schemaVersion || LEAGUE_SCHEMA_VERSION,
    version: Number.isInteger(doc.version) ? doc.version : 0,
    name: doc.name,
    creatorId: doc.creatorId,
    inviteCode: doc.inviteCode,
    inviteCodeHash: doc.inviteCodeHash,
    status: doc.status || 'forming',
    season: {
      name: doc.season?.name || 'Season 1',
      format: doc.season?.format || 'round-robin'
    },
    scoring: {
      win: doc.scoring?.win ?? DEFAULT_SCORING.win,
      draw: doc.scoring?.draw ?? DEFAULT_SCORING.draw,
      loss: doc.scoring?.loss ?? DEFAULT_SCORING.loss,
      tieBreak: Array.isArray(doc.scoring?.tieBreak) ? [...doc.scoring.tieBreak] : [...DEFAULT_SCORING.tieBreak],
      summary: doc.scoring?.summary || DEFAULT_SCORING.summary
    },
    currentRound: Number.isInteger(doc.currentRound) ? doc.currentRound : 0,
    members: (doc.members || []).map((member) => ({
      memberId: member.memberId,
      tokenHash: member.tokenHash,
      displayName: member.displayName,
      role: member.role === 'admin' ? 'admin' : 'member',
      status: member.status === 'removed' ? 'removed' : 'active',
      joinedAt: instant(member.joinedAt),
      auctionSeat: member.auctionSeat?.tokenHash
        ? {
            tokenHash: String(member.auctionSeat.tokenHash),
            roomId: member.auctionSeat.roomId ? String(member.auctionSeat.roomId) : null,
            seatId: member.auctionSeat.seatId ? String(member.auctionSeat.seatId) : null
          }
        : null,
      squad: member.squad && Array.isArray(member.squad.cards)
        ? {
            revision: Number.isInteger(member.squad.revision) ? member.squad.revision : 0,
            cards: member.squad.cards.map((card) => canonicalCard(card)).filter(Boolean),
            lineup: {
              formation: member.squad.lineup?.formation || '4-3-3',
              revision: Number.isInteger(member.squad.lineup?.revision) ? member.squad.lineup.revision : 0,
              confirmed: member.squad.lineup?.confirmed === true,
              slots: Array.isArray(member.squad.lineup?.slots)
                ? member.squad.lineup.slots.map((slot) => ({
                    slotId: slot.slotId,
                    cardId: slot.cardId ?? null
                  }))
                : []
            }
          }
        : null
    })),
    createdAt: instant(doc.createdAt),
    updatedAt: instant(doc.updatedAt)
  };
}

function storedResult(result) {
  const published = publicResult(result);
  return published;
}

function normalizeFixture(doc) {
  const homeMemberId = doc.homeMemberId;
  const awayMemberId = doc.awayMemberId;
  const confirmations = Array.isArray(doc.confirmations)
    ? doc.confirmations.filter((item) => item && typeof item.memberId === 'string').map((item) => ({
        memberId: item.memberId,
        lineupRevision: Number.isInteger(item.lineupRevision) ? item.lineupRevision : 0,
        squadRevision: Number.isInteger(item.squadRevision) ? item.squadRevision : 0,
        confirmedAt: instant(item.confirmedAt)
      }))
    : [];
  return {
    fixtureId: doc.fixtureId,
    schemaVersion: doc.schemaVersion || LEAGUE_SCHEMA_VERSION,
    leagueId: doc.leagueId,
    round: doc.round,
    homeMemberId,
    awayMemberId,
    pairKey: doc.pairKey || pairKey(homeMemberId, awayMemberId),
    participants: [homeMemberId, awayMemberId],
    status: doc.status,
    roomCode: doc.roomCode || null,
    savedGameId: doc.savedGameId || null,
    confirmations,
    claimToken: typeof doc.claimToken === 'string' ? doc.claimToken : null,
    claimFromStatus: doc.claimFromStatus === 'in_progress' ? 'in_progress' : (doc.claimFromStatus ? 'scheduled' : null),
    claimStartedAt: instant(doc.claimStartedAt),
    simulationSeed: Number.isInteger(doc.simulationSeed) ? doc.simulationSeed : null,
    claimedHome: doc.claimedHome || null,
    claimedAway: doc.claimedAway || null,
    pendingResult: storedResult(doc.pendingResult),
    result: storedResult(doc.result),
    completedAt: instant(doc.completedAt),
    createdAt: instant(doc.createdAt),
    updatedAt: instant(doc.updatedAt)
  };
}

export function createLeagueService({
  store,
  now = () => new Date(),
  catalog = [],
  simulate = null,
  readSeat = null,
  handoffs = null,
  catalogSquads = true
} = {}) {
  if (!store) throw new Error('League store is required');
  const leagues = new Map();
  const fixtures = new Map();
  const locks = new Map();
  let cardCatalog = indexCatalog(catalog);
  const simulateHits = new Map();
  const playMatch = simulate || ((home, away, seed) => {
    const random = new SeededRandom(seed >>> 0);
    return simulateMatch(home, away, () => random.next());
  });

  function stamp() {
    return nowStamp(now);
  }

  function bucket(leagueId) {
    let rows = fixtures.get(leagueId);
    if (!rows) {
      rows = new Map();
      fixtures.set(leagueId, rows);
    }
    return rows;
  }

  function leagueFixtures(leagueId) {
    return [...(fixtures.get(leagueId)?.values() || [])].map((fixture) => clone(fixture));
  }

  function rememberLeague(league) {
    leagues.set(league.leagueId, normalizeLeague(league));
  }

  function rememberFixture(fixture) {
    const normalized = normalizeFixture(fixture);
    bucket(normalized.leagueId).set(normalized.fixtureId, normalized);
  }

  function lock(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    locks.set(key, current);
    return current;
  }

  function findMember(league, memberId) {
    return league.members.find((member) => member.memberId === memberId) || null;
  }

  function authenticate(league, credentials = {}) {
    if (!league) return null;
    const member = findMember(league, credentials.memberId);
    if (!member || member.status !== 'active') return null;
    if (!secretsMatch(credentials.memberToken, member.tokenHash)) return null;
    return member;
  }

  function viewOf(league, member) {
    const rows = leagueFixtures(league.leagueId);
    const progress = progressFrom(league, rows);
    const scoring = league.scoring || DEFAULT_SCORING;
    const standings = calculateStandings(standingMembers(league, rows), rows, scoring);
    const admin = member.role === 'admin' && member.status === 'active';
    return {
      leagueId: league.leagueId,
      schemaVersion: league.schemaVersion,
      name: league.name,
      creatorId: league.creatorId,
      status: progress.status,
      season: { ...league.season },
      scoring: {
        win: scoring.win,
        draw: scoring.draw,
        loss: scoring.loss,
        tieBreak: [...scoring.tieBreak],
        summary: scoring.summary
      },
      currentRound: progress.currentRound,
      inviteCode: admin ? league.inviteCode : undefined,
      you: {
        ...publicMember(member),
        squad: publicSquad(member)
      },
      members: league.members.map((item) => ({
        ...publicMember(item),
        squad: publicSquad(item)
      })),
      fixtures: rows
        .sort((left, right) => left.round - right.round || left.fixtureId.localeCompare(right.fixtureId))
        .map((fixture) => presentFixture(fixture, league)),
      standings,
      createdAt: league.createdAt,
      updatedAt: league.updatedAt
    };
  }

  function success(league, member, extra = {}, events = []) {
    return {
      ok: true,
      view: viewOf(league, member),
      events,
      ...extra
    };
  }

  async function saveLeague(draft, expectedVersion) {
    draft.updatedAt = stamp();
    const saved = await store.saveLeague(draft, expectedVersion);
    if (!saved) return false;
    rememberLeague(draft);
    return true;
  }

  async function reloadLeague(leagueId) {
    if (typeof store.loadLeague !== 'function') return false;
    const doc = await store.loadLeague(leagueId);
    if (!doc) return false;
    rememberLeague(doc);
    return true;
  }

  async function alignLeague(leagueId) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) {
        const reloaded = await reloadLeague(leagueId);
        if (!reloaded) return false;
      }
      await reloadFixtures(leagueId);
      const latest = leagues.get(leagueId);
      if (!latest) return false;
      const progress = progressFrom(latest, leagueFixtures(leagueId));
      if (latest.currentRound === progress.currentRound && latest.status === progress.status) {
        return true;
      }
      const draft = clone(latest);
      draft.currentRound = progress.currentRound;
      draft.status = progress.status;
      const expected = draft.version;
      draft.version += 1;
      if (await saveLeague(draft, expected)) return true;
    }
    return false;
  }

  async function load() {
    leagues.clear();
    fixtures.clear();
    const savedLeagues = await store.listLeagues();
    for (const league of savedLeagues) {
      rememberLeague(league);
      const rows = await store.listFixtures(league.leagueId);
      for (const fixture of rows) rememberFixture(fixture);
      await alignLeague(league.leagueId);
    }
  }

  async function create({ name, displayName } = {}) {
    const leagueName = cleanName(name, 2, 40);
    const managerName = cleanName(displayName, 2, 20);
    if (!leagueName || !managerName) {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'Enter a league name and a manager name.');
    }

    const createdAt = stamp();
    const memberId = newId('member');
    const memberToken = randomBytes(24).toString('base64url');
    const inviteCode = randomBytes(9).toString('base64url');
    const league = {
      leagueId: newId('league'),
      schemaVersion: LEAGUE_SCHEMA_VERSION,
      version: 0,
      name: leagueName,
      creatorId: memberId,
      inviteCode,
      inviteCodeHash: hashSecret(inviteCode),
      status: 'forming',
      season: { name: 'Season 1', format: 'round-robin' },
      scoring: {
        win: DEFAULT_SCORING.win,
        draw: DEFAULT_SCORING.draw,
        loss: DEFAULT_SCORING.loss,
        tieBreak: [...DEFAULT_SCORING.tieBreak],
        summary: DEFAULT_SCORING.summary
      },
      currentRound: 0,
      members: [{
        memberId,
        tokenHash: hashSecret(memberToken),
        displayName: managerName,
        role: 'admin',
        status: 'active',
        joinedAt: createdAt
      }],
      createdAt,
      updatedAt: createdAt
    };

    const inserted = await store.insertLeague(league);
    if (!inserted) return fail(LEAGUE_ERRORS.CONFLICT, 'Could not create the league.');
    rememberLeague(league);
    const member = league.members[0];
    return success(league, member, { memberId, memberToken, inviteCode }, []);
  }

  async function leagueByInvite(inviteCode) {
    if (typeof inviteCode !== 'string') return null;
    const trimmed = inviteCode.trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(trimmed)) return null;
    const digest = hashSecret(trimmed);
    for (const league of leagues.values()) {
      if (league.inviteCodeHash === digest && secretsMatch(trimmed, league.inviteCodeHash)) {
        return league;
      }
    }
    const saved = await store.listLeagues();
    for (const doc of saved) {
      const league = normalizeLeague(doc);
      if (league.inviteCodeHash === digest && secretsMatch(trimmed, league.inviteCodeHash)) {
        rememberLeague(league);
        return leagues.get(league.leagueId);
      }
    }
    return null;
  }

  async function join({ inviteCode, displayName, memberId, memberToken } = {}) {
    const league = await leagueByInvite(inviteCode);
    if (!league) return fail(LEAGUE_ERRORS.INVITE_INVALID, 'That invitation is not valid.');

    return lock(league.leagueId, async () => {
      const current = leagues.get(league.leagueId);
      if (!current) return fail(LEAGUE_ERRORS.INVITE_INVALID, 'That invitation is not valid.');

      if (memberId && memberToken) {
        const existing = findMember(current, memberId);
        if (existing && secretsMatch(memberToken, existing.tokenHash)) {
          if (existing.status === 'removed') {
            return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'This membership has been removed.');
          }
          return success(current, existing, { memberId: existing.memberId }, []);
        }
        if (existing) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
      }

      const progress = progressFrom(current, leagueFixtures(current.leagueId));
      if (progress.status !== 'forming') {
        return fail(LEAGUE_ERRORS.LEAGUE_STARTED, 'This league is no longer accepting managers.');
      }
      const managerName = cleanName(displayName, 2, 20);
      if (!managerName) return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'Enter a manager name.');
      const activeCount = current.members.filter((member) => member.status === 'active').length;
      if (activeCount >= MAX_MEMBERS) return fail(LEAGUE_ERRORS.LEAGUE_FULL, 'This league is full.');

      const draft = clone(current);
      const nextMemberId = newId('member');
      const nextToken = randomBytes(24).toString('base64url');
      draft.members.push({
        memberId: nextMemberId,
        tokenHash: hashSecret(nextToken),
        displayName: managerName,
        role: 'member',
        status: 'active',
        joinedAt: stamp()
      });
      const expected = draft.version;
      draft.version += 1;
      const saved = await saveLeague(draft, expected);
      if (!saved) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
      const member = findMember(leagues.get(draft.leagueId), nextMemberId);
      const view = viewOf(leagues.get(draft.leagueId), member);
      return {
        ok: true,
        view,
        memberId: nextMemberId,
        memberToken: nextToken,
        events: [
          { type: 'league:members', payload: { leagueId: draft.leagueId, members: view.members } },
          { type: 'league:standings', payload: standingsPayload(view) }
        ]
      };
    });
  }

  function standingsPayload(view) {
    return {
      leagueId: view.leagueId,
      standings: view.standings,
      currentRound: view.currentRound,
      status: view.status
    };
  }

  async function view(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    if (!league) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    const member = authenticate(league, credentials);
    if (!member) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    return success(league, member, {}, []);
  }

  function openFixture(leagueId, memberId) {
    return leagueFixtures(leagueId).some((fixture) => (
      fixture.status !== 'completed'
      && (fixture.homeMemberId === memberId || fixture.awayMemberId === memberId)
    ));
  }

  async function leave(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    if (!league) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    const member = authenticate(league, credentials);
    if (!member) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');

    return lock(league.leagueId, async () => {
      const current = leagues.get(league.leagueId);
      const actor = authenticate(current, credentials);
      if (!actor) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
      const activeAdmins = current.members.filter((item) => item.role === 'admin' && item.status === 'active');
      if (actor.role === 'admin' && activeAdmins.length === 1) {
        return fail(LEAGUE_ERRORS.LAST_ADMIN, 'The last administrator cannot leave.');
      }
      if (openFixture(current.leagueId, actor.memberId)) {
        return fail(LEAGUE_ERRORS.FIXTURE_PENDING, 'Finish or clear this manager’s open fixtures first.');
      }
      const draft = clone(current);
      const target = findMember(draft, actor.memberId);
      target.status = 'removed';
      const expected = draft.version;
      draft.version += 1;
      const saved = await saveLeague(draft, expected);
      if (!saved) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
      const view = viewOf(leagues.get(draft.leagueId), findMember(leagues.get(draft.leagueId), actor.memberId));
      const admin = current.members.find((item) => item.role === 'admin' && item.status === 'active' && item.memberId !== actor.memberId);
      const viewer = admin || findMember(leagues.get(draft.leagueId), actor.memberId);
      const broadcast = viewOf(leagues.get(draft.leagueId), viewer);
      return {
        ok: true,
        view,
        events: [
          { type: 'league:members', payload: { leagueId: draft.leagueId, members: broadcast.members } },
          { type: 'league:standings', payload: standingsPayload(broadcast) }
        ]
      };
    });
  }

  async function remove(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    if (!league) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    const actor = authenticate(league, credentials);
    if (!actor || actor.role !== 'admin') return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Only an administrator can remove a manager.');
    if (!credentials.targetMemberId || credentials.targetMemberId === actor.memberId) {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'Choose another manager to remove.');
    }

    return lock(league.leagueId, async () => {
      const current = leagues.get(league.leagueId);
      const admin = authenticate(current, credentials);
      if (!admin || admin.role !== 'admin') return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Only an administrator can remove a manager.');
      const target = findMember(current, credentials.targetMemberId);
      if (!target || target.status !== 'active') return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'That manager is not in this league.');
      if (target.role === 'admin') return fail(LEAGUE_ERRORS.LAST_ADMIN, 'An administrator cannot be removed this way.');
      if (openFixture(current.leagueId, target.memberId)) {
        return fail(LEAGUE_ERRORS.FIXTURE_PENDING, 'Finish or clear this manager’s open fixtures first.');
      }
      const draft = clone(current);
      findMember(draft, target.memberId).status = 'removed';
      const expected = draft.version;
      draft.version += 1;
      const saved = await saveLeague(draft, expected);
      if (!saved) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
      const view = viewOf(leagues.get(draft.leagueId), authenticate(leagues.get(draft.leagueId), credentials));
      return {
        ok: true,
        view,
        events: [
          { type: 'league:members', payload: { leagueId: draft.leagueId, members: view.members } },
          { type: 'league:standings', payload: standingsPayload(view) }
        ]
      };
    });
  }

  async function schedule(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    if (!league) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    const actor = authenticate(league, credentials);
    if (!actor || actor.role !== 'admin') {
      return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Only an administrator can schedule the league.');
    }

    return lock(league.leagueId, async () => {
      const current = leagues.get(league.leagueId);
      const admin = authenticate(current, credentials);
      if (!admin || admin.role !== 'admin') {
        return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Only an administrator can schedule the league.');
      }
      const existing = leagueFixtures(current.leagueId);
      if (existing.length > 0) {
        const beforeStatus = current.status;
        const beforeRound = current.currentRound;
        const aligned = await alignLeague(current.leagueId);
        if (!aligned) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
        const stored = leagues.get(current.leagueId);
        const view = viewOf(stored, admin);
        const repaired = stored.status !== beforeStatus || stored.currentRound !== beforeRound;
        return {
          ok: true,
          view,
          events: repaired
            ? [
                { type: 'league:fixture', payload: { leagueId: stored.leagueId, fixtures: view.fixtures } },
                { type: 'league:standings', payload: standingsPayload(view) }
              ]
            : [],
          alreadyScheduled: true
        };
      }
      const active = current.members.filter((member) => member.status === 'active');
      if (active.length < 2) return fail(LEAGUE_ERRORS.NOT_ENOUGH_MEMBERS, 'Add at least two managers before scheduling.');

      let rounds;
      try {
        rounds = buildRoundRobin(active.map((member) => member.memberId));
      } catch (err) {
        return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, err.message);
      }

      const createdAt = stamp();
      const rows = [];
      rounds.forEach((pairs, index) => {
        for (const pair of pairs) {
          if (pair.home === pair.away) continue;
          rows.push({
            fixtureId: newId('fixture'),
            schemaVersion: LEAGUE_SCHEMA_VERSION,
            leagueId: current.leagueId,
            round: index + 1,
            homeMemberId: pair.home,
            awayMemberId: pair.away,
            pairKey: pairKey(pair.home, pair.away),
            participants: [pair.home, pair.away],
            status: 'scheduled',
            roomCode: null,
            savedGameId: null,
            confirmations: [],
            claimToken: null,
            claimFromStatus: null,
            claimStartedAt: null,
            simulationSeed: null,
            claimedHome: null,
            claimedAway: null,
            pendingResult: null,
            result: null,
            completedAt: null,
            createdAt,
            updatedAt: createdAt
          });
        }
      });

      const inserted = await store.insertFixtures(rows);
      if (!inserted) return fail(LEAGUE_ERRORS.CONFLICT, 'Could not save the fixtures.');
      for (const fixture of rows) rememberFixture(fixture);

      const aligned = await alignLeague(current.leagueId);
      if (!aligned) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
      const view = viewOf(leagues.get(current.leagueId), admin);
      return {
        ok: true,
        view,
        events: [
          { type: 'league:fixture', payload: { leagueId: current.leagueId, fixtures: view.fixtures } },
          { type: 'league:standings', payload: standingsPayload(view) }
        ]
      };
    });
  }

  function fixtureIn(leagueId, fixtureId) {
    return fixtures.get(leagueId)?.get(fixtureId) || null;
  }

  async function linkFixture(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    if (!league) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    const actor = authenticate(league, credentials);
    if (!actor) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    const fixture = fixtureIn(league.leagueId, credentials.fixtureId);
    if (!fixture) return fail(LEAGUE_ERRORS.FIXTURE_NOT_FOUND, 'Fixture not found.');
    const involved = actor.memberId === fixture.homeMemberId || actor.memberId === fixture.awayMemberId;
    if (actor.role !== 'admin' && !involved) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    if (typeof credentials.roomCode !== 'string' || !credentials.roomCode.trim()) {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'A room code is required.');
    }
    if (fixture.status === 'completed') {
      return fail(LEAGUE_ERRORS.FIXTURE_ALREADY_COMPLETE, 'This fixture already has a result.');
    }

    return lock(league.leagueId, async () => {
      const current = fixtureIn(league.leagueId, credentials.fixtureId);
      if (!current || current.status === 'completed') {
        return fail(LEAGUE_ERRORS.FIXTURE_ALREADY_COMPLETE, 'This fixture already has a result.');
      }
      const previous = current.status;
      const next = {
        ...current,
        status: 'in_progress',
        roomCode: credentials.roomCode.trim(),
        savedGameId: typeof credentials.savedGameId === 'string' && credentials.savedGameId.trim()
          ? credentials.savedGameId.trim()
          : current.savedGameId,
        updatedAt: stamp()
      };
      const saved = await store.saveFixture(next, previous);
      if (!saved) return fail(LEAGUE_ERRORS.CONFLICT, 'The fixture changed. Load it again.');
      rememberFixture(next);
      const view = viewOf(leagues.get(league.leagueId), authenticate(leagues.get(league.leagueId), credentials));
      return {
        ok: true,
        view,
        events: [
          { type: 'league:fixture', payload: { leagueId: league.leagueId, fixture: presentFixture(next, leagues.get(league.leagueId)) } }
        ]
      };
    });
  }

  /**
   * Record the only completed result for a fixture.
   * This does not simulate a match. homeGoals and awayGoals must already be known.
   * The caller must be an active administrator. A trusted flag is ignored.
   * Sockets do not call this function.
   */
  async function recordFixtureResult(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    if (!league) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    const actor = authenticate(league, credentials);
    if (!actor || actor.role !== 'admin') {
      return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Only an administrator can record a result.');
    }
    const fixture = fixtureIn(league.leagueId, credentials.fixtureId);
    if (!fixture) return fail(LEAGUE_ERRORS.FIXTURE_NOT_FOUND, 'Fixture not found.');
    if (!Number.isInteger(credentials.homeGoals) || credentials.homeGoals < 0
      || !Number.isInteger(credentials.awayGoals) || credentials.awayGoals < 0) {
      return fail(LEAGUE_ERRORS.INVALID_RESULT, 'Goals have to be whole numbers.');
    }

    return lock(league.leagueId, async () => {
      const actorNow = authenticate(leagues.get(league.leagueId), credentials);
      if (!actorNow || actorNow.role !== 'admin') {
        return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Only an administrator can record a result.');
      }
      const current = fixtureIn(league.leagueId, credentials.fixtureId);
      if (!current) return fail(LEAGUE_ERRORS.FIXTURE_NOT_FOUND, 'Fixture not found.');
      if (current.status === 'completed' || current.result) {
        return fail(LEAGUE_ERRORS.FIXTURE_ALREADY_COMPLETE, 'This fixture already has a result.');
      }
      if (current.status === 'simulating') {
        return fail(LEAGUE_ERRORS.FIXTURE_SIMULATING, 'This fixture is already being simulated.');
      }
      const previous = current.status;
      const completedAt = stamp();
      const next = {
        ...current,
        status: 'completed',
        result: { homeGoals: credentials.homeGoals, awayGoals: credentials.awayGoals },
        completedAt,
        updatedAt: completedAt,
        roomCode: typeof credentials.roomCode === 'string' && credentials.roomCode.trim()
          ? credentials.roomCode.trim()
          : current.roomCode,
        savedGameId: typeof credentials.savedGameId === 'string' && credentials.savedGameId.trim()
          ? credentials.savedGameId.trim()
          : current.savedGameId
      };
      const saved = await store.saveFixture(next, previous);
      if (!saved) {
        const rows = await store.listFixtures(league.leagueId);
        for (const row of rows) rememberFixture(row);
        const latestFixture = fixtureIn(league.leagueId, credentials.fixtureId);
        if (latestFixture?.status === 'completed' || latestFixture?.result) {
          return fail(LEAGUE_ERRORS.FIXTURE_ALREADY_COMPLETE, 'This fixture already has a result.');
        }
        return fail(LEAGUE_ERRORS.CONFLICT, 'The fixture changed. Load it again.');
      }
      const before = progressFrom(leagues.get(league.leagueId), leagueFixtures(league.leagueId).map((item) => (
        item.fixtureId === next.fixtureId ? { ...item, status: current.status, result: null } : item
      )));
      rememberFixture(next);
      await alignLeague(league.leagueId);

      const viewer = authenticate(leagues.get(league.leagueId), credentials);
      const view = viewOf(leagues.get(league.leagueId), viewer);
      const events = [
        {
          type: 'league:match-completed',
          payload: { leagueId: league.leagueId, fixture: presentFixture(next, leagues.get(league.leagueId)) }
        },
        { type: 'league:standings', payload: standingsPayload(view) }
      ];
      if (view.currentRound !== before.currentRound) {
        events.push({
          type: 'league:round:advanced',
          payload: { leagueId: league.leagueId, currentRound: view.currentRound, status: view.status }
        });
      }
      if (view.status === 'completed' && before.status !== 'completed') {
        events.push({
          type: 'league:completed',
          payload: { leagueId: league.leagueId, currentRound: view.currentRound, status: view.status }
        });
      }
      return { ok: true, view, events };
    });
  }

  function setCatalog(cards) {
    cardCatalog = indexCatalog(cards);
  }

  async function reloadFixtures(leagueId) {
    const rows = await store.listFixtures(leagueId);
    fixtures.set(leagueId, new Map());
    for (const row of rows) rememberFixture(row);
  }

  function takenByOthers(league, memberId) {
    const taken = new Set();
    for (const member of league.members) {
      if (member.memberId === memberId || member.status !== 'active') continue;
      for (const id of squadCardIds(member)) taken.add(id);
    }
    return taken;
  }

  function cardsLeft(league, memberId) {
    const taken = takenByOthers(league, memberId);
    return [...cardCatalog.values()].filter((card) => !taken.has(card.id));
  }

  async function persistSquad(leagueId, memberId, cards, lineup, auctionSeat = null) {
    const current = leagues.get(leagueId);
    const draft = clone(current);
    const member = findMember(draft, memberId);
    if (!member) return false;
    member.squad = {
      revision: (member.squad?.revision || 0) + 1,
      cards,
      lineup
    };
    member.auctionSeat = auctionSeat;
    const expected = draft.version;
    draft.version += 1;
    return saveLeague(draft, expected);
  }

  async function dropConfirmations(leagueId, memberId) {
    const rows = leagueFixtures(leagueId).filter((fixture) => (
      fixture.status !== 'completed'
      && fixture.status !== 'simulating'
      && (fixture.confirmations || []).some((item) => item.memberId === memberId)
    ));
    for (const fixture of rows) {
      const next = {
        ...fixture,
        confirmations: fixture.confirmations.filter((item) => item.memberId !== memberId),
        updatedAt: stamp()
      };
      const saved = await store.saveFixture(next, fixture.status);
      if (!saved) {
        await reloadFixtures(leagueId);
        return false;
      }
      rememberFixture(next);
    }
    return true;
  }

  function memberView(leagueId, memberId) {
    const league = leagues.get(leagueId);
    const member = findMember(league, memberId);
    return { league, member, view: viewOf(league, member) };
  }

  async function registerSquad(credentials = {}) {
    if (catalogSquads === false) {
      return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'League squads come from a finished auction.');
    }
    const league = leagues.get(credentials.leagueId);
    const actor = authenticate(league, credentials);
    if (!actor) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    if (progressFrom(league, leagueFixtures(league.leagueId)).status === 'completed') {
      return fail(LEAGUE_ERRORS.LEAGUE_STARTED, 'This league has finished.');
    }
    if (!Array.isArray(credentials.cardIds) || credentials.cardIds.length > 40) {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'Choose the players in this squad.');
    }
    if (credentials.cardIds.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 80)) {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'Choose the players in this squad.');
    }

    return lock(league.leagueId, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = leagues.get(league.leagueId);
        const member = authenticate(current, credentials);
        if (!member) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
        const ids = credentials.cardIds.map((id) => String(id));
        if (ids.length < 11 || ids.length > 18) {
          return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'A squad needs 11 to 18 different players.');
        }
        if (new Set(ids).size !== ids.length) {
          return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'A player can only be added once.');
        }
        const cards = [];
        for (const id of ids) {
          const card = cardCatalog.get(id);
          if (!card) return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'That player is not in the catalog.');
          cards.push(card);
        }
        if (member.squad?.cards?.length && sameCardSet(member, ids)) {
          const opened = memberView(current.leagueId, member.memberId);
          return { ok: true, view: opened.view, events: [] };
        }
        if (cards.some((card) => takenByOthers(current, member.memberId).has(card.id))) {
          return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'Another manager already has one of those players.');
        }
        const lineup = {
          formation: '4-3-3',
          revision: 0,
          confirmed: false,
          slots: []
        };
        const saved = await persistSquad(current.leagueId, member.memberId, cards, lineup);
        if (saved) {
          const dropped = await dropConfirmations(current.leagueId, member.memberId);
          if (!dropped) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
          const opened = memberView(current.leagueId, member.memberId);
          return {
            ok: true,
            view: opened.view,
            events: [{ type: 'league:members', payload: { leagueId: current.leagueId, members: opened.view.members } }]
          };
        }
        await reloadLeague(current.leagueId);
      }
      return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
    });
  }

  async function registerSuggestedSquad(credentials = {}) {
    if (catalogSquads === false) {
      return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'League squads come from a finished auction.');
    }
    const league = leagues.get(credentials.leagueId);
    const actor = authenticate(league, credentials);
    if (!actor) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    if (progressFrom(league, leagueFixtures(league.leagueId)).status === 'completed') {
      return fail(LEAGUE_ERRORS.LEAGUE_STARTED, 'This league has finished.');
    }

    return lock(league.leagueId, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = leagues.get(league.leagueId);
        const member = authenticate(current, credentials);
        if (!member) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
        if (member.squad?.cards?.length) {
          const opened = memberView(current.leagueId, member.memberId);
          return { ok: true, view: opened.view, events: [] };
        }
        const suggestion = suggestEleven(cardsLeft(current, member.memberId));
        if (!suggestion) {
          return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'Not enough catalog players are left for a full XI.');
        }
        const placed = applyLineupChange({
          ownedCards: suggestion.cards,
          lineup: null,
          formation: suggestion.formation,
          assignments: suggestion.assignments,
          expectedRevision: 0,
          confirm: true
        });
        if (!placed.ok) return { ok: false, error: placed.error, message: placed.message, lineup: placed.lineup, events: [] };
        const saved = await persistSquad(current.leagueId, member.memberId, suggestion.cards, placed.stored);
        if (saved) {
          const dropped = await dropConfirmations(current.leagueId, member.memberId);
          if (!dropped) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
          const opened = memberView(current.leagueId, member.memberId);
          return {
            ok: true,
            view: opened.view,
            events: [{ type: 'league:members', payload: { leagueId: current.leagueId, members: opened.view.members } }]
          };
        }
        await reloadLeague(current.leagueId);
      }
      return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
    });
  }

  function sameCardSet(member, ids) {
    const owned = [...squadCardIds(member)];
    if (owned.length !== ids.length) return false;
    const wanted = new Set(ids);
    return owned.every((id) => wanted.has(id));
  }

  function lineupFromSeat(cards, lineup) {
    if (!lineup || typeof lineup.formation !== 'string' || !Array.isArray(lineup.slots)) {
      return emptyLineup();
    }
    const placed = applyLineupChange({
      ownedCards: cards,
      lineup: null,
      formation: lineup.formation,
      assignments: lineup.slots.map((slot) => ({
        slotId: slot?.slotId,
        cardId: slot?.cardId ?? null
      })),
      expectedRevision: 0,
      confirm: lineup.confirmed === true
    });
    if (!placed.ok) return emptyLineup();
    return placed.stored;
  }

  /**
   * Register the squad from a finished auction seat.
   * seatToken proves the seat. memberToken proves the membership.
   * Card ids come from the live seat or, once that room is gone, from the
   * handoff written when the auction finished. Attributes come from the
   * catalog. Client card lists, stats, ratings, names, and room codes are
   * ignored. The same pair of tokens returns the association already stored.
   */
  async function linkAuctionSquad(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    const actor = authenticate(league, credentials);
    if (!actor) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    if (typeof credentials.seatToken !== 'string' || credentials.seatToken.length < 32) {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'The auction seat could not be verified.');
    }
    if (typeof readSeat !== 'function' && !handoffs?.find) {
      return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'That auction seat could not be verified.');
    }

    return lock(league.leagueId, async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await linkOnce(credentials);
        if (outcome.ok || outcome.error !== LEAGUE_ERRORS.CONFLICT || attempt === 1) return outcome;
        await reloadLeague(league.leagueId);
      }
      return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
    });
  }

  async function linkOnce(credentials) {
    const current = leagues.get(credentials.leagueId);
    const member = authenticate(current, credentials);
    if (!member) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');

    const tokenHash = hashSecret(credentials.seatToken);
    const holder = current.members.find((item) => (
      item.status === 'active' && item.auctionSeat?.tokenHash === tokenHash
    ));
    if (holder && holder.memberId !== member.memberId) {
      return fail(LEAGUE_ERRORS.CONFLICT, 'This auction seat is already registered in the league.');
    }
    if (holder && holder.memberId === member.memberId) {
      const opened = memberView(current.leagueId, member.memberId);
      return { ok: true, alreadyLinked: true, view: opened.view, events: [] };
    }
    if (progressFrom(current, leagueFixtures(current.leagueId)).status === 'completed') {
      return fail(LEAGUE_ERRORS.LEAGUE_STARTED, 'This league has finished.');
    }

    const live = typeof readSeat === 'function' ? readSeat(credentials.seatToken) : null;
    if (live?.state === 'not-finished') {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'Finish the auction before registering this squad.');
    }
    const row = handoffs?.find ? await handoffs.find(tokenHash) : null;
    const fresh = Boolean(row && Date.parse(row.expiresAt) > Date.now());
    if (row?.claim && (row.claim.leagueId !== current.leagueId || row.claim.memberId !== member.memberId)) {
      return fail(LEAGUE_ERRORS.CONFLICT, 'This finished auction seat is already linked.');
    }

    let source = null;
    if (live?.state === 'ready' && Array.isArray(live.cardIds)) {
      source = live;
    } else if (fresh) {
      source = {
        roomId: row.roomId,
        seatId: row.seatId,
        cardIds: row.cardIds,
        lineup: null
      };
    } else if (row) {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'This auction handoff has expired.');
    } else {
      return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'That auction seat could not be verified.');
    }

    if (member.auctionSeat?.tokenHash && member.auctionSeat.tokenHash !== tokenHash) {
      return fail(LEAGUE_ERRORS.CONFLICT, 'This manager is already linked to another auction seat.');
    }
    const ids = source.cardIds.map((id) => String(id));
    if (member.squad?.cards?.length && !sameCardSet(member, ids)) {
      return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'This manager already has a squad.');
    }
    if (ids.length < 11 || ids.length > 18 || new Set(ids).size !== ids.length) {
      return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'A squad needs 11 to 18 different players.');
    }
    const cards = [];
    for (const id of ids) {
      const card = cardCatalog.get(id);
      if (!card) return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'That auction squad could not be verified.');
      cards.push(card);
    }
    if (cards.some((card) => takenByOthers(current, member.memberId).has(card.id))) {
      return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'Another manager already has one of those players.');
    }

    if (fresh) {
      const claimed = await handoffs.claim(tokenHash, {
        leagueId: current.leagueId,
        memberId: member.memberId
      });
      if (!claimed.ok) {
        return fail(LEAGUE_ERRORS.CONFLICT, 'This finished auction seat is already linked.');
      }
    }

    const seatBinding = {
      tokenHash,
      roomId: source.roomId ? String(source.roomId) : null,
      seatId: source.seatId ? String(source.seatId) : null
    };
    if (member.squad?.cards?.length && sameCardSet(member, ids) && !member.auctionSeat?.tokenHash) {
      const draft = clone(current);
      findMember(draft, member.memberId).auctionSeat = seatBinding;
      const expected = draft.version;
      draft.version += 1;
      const adopted = await saveLeague(draft, expected);
      if (!adopted) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
      const opened = memberView(current.leagueId, member.memberId);
      return { ok: true, alreadyLinked: true, view: opened.view, events: [] };
    }

    const lineup = lineupFromSeat(cards, source.lineup);
    const saved = await persistSquad(current.leagueId, member.memberId, cards, lineup, seatBinding);
    if (!saved) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
    const dropped = await dropConfirmations(current.leagueId, member.memberId);
    if (!dropped) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
    const opened = memberView(current.leagueId, member.memberId);
    return {
      ok: true,
      alreadyLinked: false,
      view: opened.view,
      events: [{ type: 'league:members', payload: { leagueId: current.leagueId, members: opened.view.members } }]
    };
  }

  async function applyMemberLineup(leagueId, memberId, payload) {
    const current = leagues.get(leagueId);
    const member = findMember(current, memberId);
    const owned = member?.squad?.cards || [];
    if (owned.length < 11) {
      return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'Register a squad before setting a lineup.');
    }
    const result = applyLineupChange({
      ownedCards: owned,
      lineup: member.squad.lineup || null,
      formation: payload.formation,
      assignments: payload.assignments,
      expectedRevision: payload.expectedRevision,
      confirm: payload.confirm === true
    });
    if (!result.ok) {
      return { ok: false, error: result.error, message: result.message, lineup: result.lineup, events: [] };
    }
    if (result.unchanged) {
      const opened = memberView(leagueId, memberId);
      return { ok: true, unchanged: true, view: opened.view, lineup: result.lineup, events: [] };
    }
    const draft = clone(current);
    findMember(draft, memberId).squad.lineup = result.stored;
    const expected = draft.version;
    draft.version += 1;
    const saved = await saveLeague(draft, expected);
    if (!saved) return fail(LEAGUE_ERRORS.CONFLICT, 'The league changed. Load it again.');
    const opened = memberView(leagueId, memberId);
    return {
      ok: true,
      view: opened.view,
      lineup: presentLineup(owned, result.stored),
      events: [{ type: 'league:members', payload: { leagueId, members: opened.view.members } }]
    };
  }

  async function updateLineup(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    const actor = authenticate(league, credentials);
    if (!actor) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    return lock(league.leagueId, async () => {
      const current = leagues.get(league.leagueId);
      const member = authenticate(current, credentials);
      if (!member) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
      return applyMemberLineup(current.leagueId, member.memberId, credentials);
    });
  }

  async function confirmFixtureLineup(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    const actor = authenticate(league, credentials);
    if (!actor) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    if (typeof credentials.fixtureId !== 'string' || !credentials.fixtureId.trim()) {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'Choose a fixture.');
    }

    return lock(league.leagueId, async () => {
      let current = leagues.get(league.leagueId);
      let member = authenticate(current, credentials);
      if (!member) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
      const fixture = fixtureIn(current.leagueId, credentials.fixtureId);
      if (!fixture) return fail(LEAGUE_ERRORS.FIXTURE_NOT_FOUND, 'Fixture not found.');
      const involved = member.memberId === fixture.homeMemberId || member.memberId === fixture.awayMemberId;
      if (!involved) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'You can only confirm your own lineup.');
      if (fixture.status === 'completed' || fixture.result) {
        return fail(LEAGUE_ERRORS.FIXTURE_ALREADY_COMPLETE, 'This fixture already has a result.');
      }
      if (fixture.status === 'simulating') {
        return fail(LEAGUE_ERRORS.FIXTURE_SIMULATING, 'This fixture is already being simulated.');
      }
      const progress = progressFrom(current, leagueFixtures(current.leagueId));
      if (progress.status !== 'active' || fixture.round !== progress.currentRound) {
        return fail(LEAGUE_ERRORS.FIXTURE_NOT_PLAYABLE, 'This fixture is not in the current round.');
      }

      const changing = credentials.assignments != null || credentials.formation != null;
      if (changing) {
        const updated = await applyMemberLineup(current.leagueId, member.memberId, {
          formation: credentials.formation,
          assignments: credentials.assignments,
          expectedRevision: credentials.expectedRevision,
          confirm: true
        });
        if (!updated.ok) return updated;
        current = leagues.get(current.leagueId);
        member = findMember(current, member.memberId);
      } else if (Number.isInteger(credentials.expectedRevision)
        && credentials.expectedRevision !== member.squad?.lineup?.revision) {
        return {
          ok: false,
          error: LEAGUE_ERRORS.STALE_LINEUP,
          message: 'This lineup is out of date. The saved lineup is shown again.',
          lineup: publicSquad(member)?.lineup || null,
          events: []
        };
      }

      const side = sideFromMember(member);
      if (!side.ok) return fail(side.error, side.message);
      const opponentId = member.memberId === fixture.homeMemberId ? fixture.awayMemberId : fixture.homeMemberId;
      const opponent = findMember(current, opponentId);
      if (opponent && squadsOverlap(member, opponent)) {
        return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'Another manager already has one of those players.');
      }
      const latest = fixtureIn(current.leagueId, fixture.fixtureId);
      if (!latest || latest.status === 'completed' || latest.status === 'simulating') {
        return fail(LEAGUE_ERRORS.CONFLICT, 'The fixture changed. Load it again.');
      }
      const confirmations = (latest.confirmations || []).filter((item) => item.memberId !== member.memberId);
      confirmations.push({
        memberId: member.memberId,
        lineupRevision: member.squad.lineup.revision,
        squadRevision: member.squad.revision,
        confirmedAt: stamp()
      });
      const next = { ...latest, confirmations, updatedAt: stamp() };
      const saved = await store.saveFixture(next, latest.status);
      if (!saved) {
        await reloadFixtures(current.leagueId);
        return fail(LEAGUE_ERRORS.CONFLICT, 'The fixture changed. Load it again.');
      }
      rememberFixture(next);
      const opened = memberView(current.leagueId, member.memberId);
      const shown = presentFixture(next, opened.league);
      return {
        ok: true,
        view: opened.view,
        events: [
          {
            type: 'league:fixture:updated',
            payload: {
              leagueId: current.leagueId,
              fixture: shown,
              currentRound: opened.view.currentRound,
              status: opened.view.status
            }
          }
        ]
      };
    });
  }

  function tooManySimulations(memberId, fixtureId) {
    const key = `${memberId}:${fixtureId}`;
    const nowMs = Date.now();
    const hits = (simulateHits.get(key) || []).filter((time) => nowMs - time < 10000);
    if (hits.length >= 6) return true;
    hits.push(nowMs);
    simulateHits.set(key, hits);
    return false;
  }

  function playablePair(league, fixture) {
    const progress = progressFrom(league, leagueFixtures(league.leagueId));
    if (progress.status !== 'active') {
      return fail(LEAGUE_ERRORS.FIXTURE_NOT_PLAYABLE, 'This league is not playing matches.');
    }
    if (fixture.round !== progress.currentRound) {
      return fail(LEAGUE_ERRORS.FIXTURE_NOT_PLAYABLE, 'This fixture is not in the current round.');
    }
    const homeMember = findMember(league, fixture.homeMemberId);
    const awayMember = findMember(league, fixture.awayMemberId);
    if (!homeMember || !awayMember || homeMember.status !== 'active' || awayMember.status !== 'active') {
      return fail(LEAGUE_ERRORS.FIXTURE_NOT_PLAYABLE, 'Both managers have to be active.');
    }
    if (homeMember.memberId === awayMember.memberId) {
      return fail(LEAGUE_ERRORS.FIXTURE_NOT_PLAYABLE, 'A manager cannot play themselves.');
    }
    if (squadsOverlap(homeMember, awayMember)) {
      return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'These squads share a player.');
    }
    const homeSaved = (fixture.confirmations || []).find((item) => item.memberId === homeMember.memberId);
    const awaySaved = (fixture.confirmations || []).find((item) => item.memberId === awayMember.memberId);
    if (!homeSaved || !awaySaved) {
      return fail(LEAGUE_ERRORS.LINEUP_NOT_CONFIRMED, 'Both managers have to confirm the current XI.');
    }
    if (!confirmationCurrent(homeMember, homeSaved) || !confirmationCurrent(awayMember, awaySaved)) {
      return fail(LEAGUE_ERRORS.STALE_LINEUP, 'A confirmed lineup changed. Confirm the current XI.');
    }
    const home = sideFromMember(homeMember);
    if (!home.ok) return fail(home.error, home.message);
    const away = sideFromMember(awayMember);
    if (!away.ok) return fail(away.error, away.message);
    const homeIds = new Set(home.side.team.map((card) => String(card.id)));
    if (away.side.team.some((card) => homeIds.has(String(card.id)))) {
      return fail(LEAGUE_ERRORS.SQUAD_INVALID, 'These lineups share a player.');
    }
    return { ok: true, home: home.side, away: away.side };
  }

  function scoreFromSides(home, away, seed) {
    let simulated;
    try {
      simulated = playMatch(home, away, seed);
    } catch (err) {
      return { ok: false, message: err.message || 'The match could not be simulated.' };
    }
    const result = resultFromSimulation(simulated, home, away);
    if (!result) return { ok: false, message: 'The match simulator did not return a usable score.' };
    return { ok: true, result };
  }

  async function claimFixture(leagueId, fixture, home, away) {
    const next = {
      ...fixture,
      status: 'simulating',
      claimToken: randomBytes(12).toString('hex'),
      claimFromStatus: fixture.status === 'in_progress' ? 'in_progress' : 'scheduled',
      claimStartedAt: stamp(),
      simulationSeed: randomBytes(4).readUInt32BE(0),
      claimedHome: home,
      claimedAway: away,
      pendingResult: null,
      updatedAt: stamp()
    };
    const saved = await store.saveFixture(next, fixture.status);
    if (!saved) {
      await reloadFixtures(leagueId);
      return { ok: false, fixture: fixtureIn(leagueId, fixture.fixtureId) };
    }
    rememberFixture(next);
    return { ok: true, fixture: next };
  }

  async function releaseClaim(leagueId, fixture) {
    if (!fixture || fixture.status !== 'simulating' || fixture.pendingResult || !fixture.claimToken) return false;
    const next = {
      ...fixture,
      status: fixture.claimFromStatus === 'in_progress' ? 'in_progress' : 'scheduled',
      claimToken: null,
      claimFromStatus: null,
      claimStartedAt: null,
      simulationSeed: null,
      claimedHome: null,
      claimedAway: null,
      pendingResult: null,
      updatedAt: stamp()
    };
    const saved = await store.compareAndSetFixture(fixture.fixtureId, {
      status: 'simulating',
      claimToken: fixture.claimToken,
      pendingResult: null
    }, next);
    if (saved) rememberFixture(next);
    else await reloadFixtures(leagueId);
    return saved;
  }

  async function storePending(leagueId, fixtureId, claimToken, pending) {
    const current = fixtureIn(leagueId, fixtureId);
    if (!current || current.claimToken !== claimToken) return { ok: false };
    if (current.status === 'completed' && current.result) return { ok: true, done: true, fixture: current };
    if (current.pendingResult) return { ok: true, pending: current.pendingResult, fixture: current };
    const next = { ...current, pendingResult: pending, updatedAt: stamp() };
    const saved = await store.compareAndSetFixture(fixtureId, {
      status: 'simulating',
      claimToken,
      pendingResult: null
    }, next);
    if (!saved) {
      await reloadFixtures(leagueId);
      const latest = fixtureIn(leagueId, fixtureId);
      if (latest?.status === 'completed' && latest.result) return { ok: true, done: true, fixture: latest };
      if (latest?.pendingResult) return { ok: true, pending: latest.pendingResult, fixture: latest };
      return { ok: false };
    }
    rememberFixture(next);
    return { ok: true, pending, fixture: next };
  }

  async function finalizeFixture(leagueId, fixtureId) {
    const current = fixtureIn(leagueId, fixtureId);
    if (!current) return { ok: false };
    if (current.status === 'completed' && current.result) return { ok: true, fixture: current, already: true };
    if (current.status !== 'simulating' || !current.pendingResult || !current.claimToken) return { ok: false };
    const completedAt = stamp();
    const next = {
      ...current,
      status: 'completed',
      result: { ...current.pendingResult },
      completedAt,
      updatedAt: completedAt
    };
    const saved = await store.compareAndSetFixture(fixtureId, {
      status: 'simulating',
      claimToken: current.claimToken
    }, next);
    if (!saved) {
      await reloadFixtures(leagueId);
      const latest = fixtureIn(leagueId, fixtureId);
      if (latest?.status === 'completed' && latest.result) return { ok: true, fixture: latest, already: true };
      return { ok: false };
    }
    rememberFixture(next);
    crashIf('before-round-reconcile');
    await alignLeague(leagueId);
    return { ok: true, fixture: fixtureIn(leagueId, fixtureId), already: false };
  }

  function finishSimulation(leagueId, memberId, finalized, before) {
    const league = leagues.get(leagueId);
    const member = findMember(league, memberId);
    const fixture = finalized.fixture;
    if (finalized.already) {
      return success(league, member, { alreadyComplete: true, result: publicResult(fixture.result) }, []);
    }
    const view = viewOf(league, member);
    const shown = view.fixtures.find((item) => item.fixtureId === fixture.fixtureId);
    const events = [
      {
        type: 'league:fixture:updated',
        payload: { leagueId, fixture: shown, currentRound: view.currentRound, status: view.status }
      },
      { type: 'league:match-completed', payload: { leagueId, fixture: shown } },
      { type: 'league:standings', payload: standingsPayload(view) }
    ];
    if (view.currentRound !== before.currentRound) {
      events.push({
        type: 'league:round:advanced',
        payload: { leagueId, currentRound: view.currentRound, status: view.status }
      });
    }
    if (view.status === 'completed' && before.status !== 'completed') {
      events.push({
        type: 'league:completed',
        payload: { leagueId, currentRound: view.currentRound, status: view.status }
      });
    }
    return success(league, member, { alreadyComplete: false, result: publicResult(fixture.result) }, events);
  }

  async function simulateLeagueFixture(credentials = {}) {
    const league = leagues.get(credentials.leagueId);
    const actor = authenticate(league, credentials);
    if (!actor) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
    if (typeof credentials.fixtureId !== 'string' || !credentials.fixtureId.trim()) {
      return fail(LEAGUE_ERRORS.INVALID_PARAMETERS, 'Choose a fixture.');
    }

    return lock(league.leagueId, async () => {
      const currentLeague = leagues.get(league.leagueId);
      const member = authenticate(currentLeague, credentials);
      if (!member) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Not allowed.');
      let fixture = fixtureIn(currentLeague.leagueId, credentials.fixtureId);
      if (!fixture) return fail(LEAGUE_ERRORS.FIXTURE_NOT_FOUND, 'Fixture not found.');
      const involved = member.memberId === fixture.homeMemberId || member.memberId === fixture.awayMemberId;
      if (!involved) return fail(LEAGUE_ERRORS.UNAUTHORIZED, 'Only the two managers in this fixture can simulate it.');
      if (clientSuppliedResult(credentials)) {
        return fail(LEAGUE_ERRORS.INVALID_RESULT, 'The server simulates the match. A score cannot be submitted.');
      }

      if (fixture.status === 'completed' && fixture.result) {
        return success(currentLeague, member, { alreadyComplete: true, result: publicResult(fixture.result) }, []);
      }

      if (fixture.status === 'simulating' && fixture.pendingResult) {
        const before = progressFrom(currentLeague, leagueFixtures(currentLeague.leagueId));
        const finalized = await finalizeFixture(currentLeague.leagueId, fixture.fixtureId);
        if (!finalized.ok) return fail(LEAGUE_ERRORS.CONFLICT, 'The result could not be saved.');
        return finishSimulation(currentLeague.leagueId, member.memberId, finalized, before);
      }

      if (fixture.status === 'simulating' && fixture.claimedHome && fixture.claimedAway && Number.isInteger(fixture.simulationSeed)) {
        const scored = scoreFromSides(fixture.claimedHome, fixture.claimedAway, fixture.simulationSeed);
        if (!scored.ok) return fail(LEAGUE_ERRORS.CONFLICT, scored.message);
        const pending = await storePending(currentLeague.leagueId, fixture.fixtureId, fixture.claimToken, scored.result);
        if (!pending.ok) return fail(LEAGUE_ERRORS.CONFLICT, 'The result could not be saved.');
        if (pending.done) {
          return success(
            leagues.get(currentLeague.leagueId),
            member,
            { alreadyComplete: true, result: publicResult(pending.fixture.result) },
            []
          );
        }
        const before = progressFrom(leagues.get(currentLeague.leagueId), leagueFixtures(currentLeague.leagueId));
        const finalized = await finalizeFixture(currentLeague.leagueId, fixture.fixtureId);
        if (!finalized.ok) return fail(LEAGUE_ERRORS.CONFLICT, 'The result could not be saved.');
        return finishSimulation(currentLeague.leagueId, member.memberId, finalized, before);
      }

      if (fixture.status === 'simulating') {
        await releaseClaim(currentLeague.leagueId, fixture);
        return fail(LEAGUE_ERRORS.CONFLICT, 'The fixture was reset. Try again.');
      }

      if (fixture.status !== 'scheduled' && fixture.status !== 'in_progress') {
        return fail(LEAGUE_ERRORS.FIXTURE_NOT_PLAYABLE, 'This fixture cannot be simulated.');
      }
      if (tooManySimulations(member.memberId, fixture.fixtureId)) {
        return fail(LEAGUE_ERRORS.RATE_LIMITED, 'Wait a moment before simulating this fixture again.');
      }

      const ready = playablePair(currentLeague, fixture);
      if (!ready.ok) return ready;
      crashIf('before-claim');
      const claimed = await claimFixture(currentLeague.leagueId, fixture, ready.home, ready.away);
      if (!claimed.ok) {
        const latest = claimed.fixture;
        if (latest?.status === 'completed' && latest.result) {
          return success(
            leagues.get(currentLeague.leagueId),
            member,
            { alreadyComplete: true, result: publicResult(latest.result) },
            []
          );
        }
        return fail(LEAGUE_ERRORS.CONFLICT, 'The fixture changed. Load it again.');
      }

      crashIf('after-claim');
      const scored = scoreFromSides(claimed.fixture.claimedHome, claimed.fixture.claimedAway, claimed.fixture.simulationSeed);
      if (!scored.ok) {
        await releaseClaim(currentLeague.leagueId, fixtureIn(currentLeague.leagueId, fixture.fixtureId));
        return fail(LEAGUE_ERRORS.CONFLICT, scored.message || 'The match could not be simulated.');
      }
      crashIf('after-simulation');
      const pending = await storePending(
        currentLeague.leagueId,
        fixture.fixtureId,
        claimed.fixture.claimToken,
        scored.result
      );
      if (!pending.ok) return fail(LEAGUE_ERRORS.CONFLICT, 'The result could not be saved.');
      if (pending.done) {
        return success(
          leagues.get(currentLeague.leagueId),
          member,
          { alreadyComplete: true, result: publicResult(pending.fixture.result) },
          []
        );
      }
      crashIf('after-pending');
      const before = progressFrom(leagues.get(currentLeague.leagueId), leagueFixtures(currentLeague.leagueId));
      const finalized = await finalizeFixture(currentLeague.leagueId, fixture.fixtureId);
      if (!finalized.ok) return fail(LEAGUE_ERRORS.CONFLICT, 'The result could not be saved.');
      crashIf('after-complete');
      return finishSimulation(currentLeague.leagueId, member.memberId, finalized, before);
    });
  }

  async function rebuildStandings(credentials = {}) {
    const opened = await view(credentials);
    if (!opened.ok) return opened;
    const league = leagues.get(credentials.leagueId);
    const rows = leagueFixtures(league.leagueId);
    const standings = calculateStandings(standingMembers(league, rows), rows, league.scoring);
    return { ok: true, standings, events: [] };
  }

  return {
    load,
    create,
    join,
    view,
    leave,
    remove,
    schedule,
    linkFixture,
    recordFixtureResult,
    setCatalog,
    registerSquad,
    registerSuggestedSquad,
    linkAuctionSquad,
    updateLineup,
    confirmFixtureLineup,
    simulateLeagueFixture,
    rebuildStandings
  };
}
