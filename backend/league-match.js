/**
 * LEAGUE MATCH ADAPTER
 * Turns a confirmed league XI into the squad shape the existing match
 * simulator already accepts. Ratings come from the shared lineup formula.
 * Nothing here invents a score or fills in a missing overall with 75.
 * A live-room seat is not used. Cards come from the member's participating
 * squad, which was copied from the server catalog.
 */

import { assignedStrength, positionSuitability, selectionFromLineup } from '../shared/squad-evaluation.js';
import { LINEUP_ERRORS } from '../shared/squad-evaluation.js';
import { playerPhotoUrl } from '../shared/player-photo.js';
import { photosRequested } from './public-card.js';

const STAT_KEYS = ['pace', 'shooting', 'passing', 'dribbling', 'defense', 'physical', 'overall'];
const GOALKEEPING_KEYS = ['diving', 'handling', 'kicking', 'reflexes', 'speed', 'positioning'];

export const SUGGESTED_XI = [
  ['gk', 'GK'],
  ['lb', 'LB'],
  ['lcb', 'CB'],
  ['rcb', 'CB'],
  ['rb', 'RB'],
  ['lcm', 'CM'],
  ['cm', 'CM'],
  ['rcm', 'CM'],
  ['lw', 'LW'],
  ['st', 'ST'],
  ['rw', 'RW']
];

const RESULT_FIELDS = [
  'homeGoals',
  'awayGoals',
  'winner',
  'winnerMemberId',
  'trusted',
  'overall',
  'simulation',
  'result',
  'goals',
  'admin'
];

export function clientSuppliedResult(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return RESULT_FIELDS.some((key) => payload[key] != null);
}

export function canonicalCard(card) {
  if (!card || card.id == null || card.id === '') return null;
  const stats = {};
  for (const key of STAT_KEYS) {
    const value = card.stats?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) stats[key] = value;
  }
  const name = typeof card.name === 'string' ? card.name.trim() : '';
  const canonical = {
    id: String(card.id),
    name: name || String(card.id),
    position: typeof card.position === 'string' ? card.position : '',
    stats
  };
  if (typeof card.club === 'string' && card.club) canonical.club = card.club;
  if (typeof card.league === 'string' && card.league.trim()) canonical.league = card.league.trim();
  if (card.dataset === 'fifa' || card.source?.dataset === 'fifa') canonical.dataset = 'fifa';
  const goalkeeping = {};
  for (const key of GOALKEEPING_KEYS) {
    const value = card.goalkeeping?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) goalkeeping[key] = value;
  }
  if (Object.keys(goalkeeping).length) canonical.goalkeeping = goalkeeping;
  const photo = playerPhotoUrl(card, { photosEnabled: photosRequested() });
  if (photo) {
    canonical.photoUrl = photo;
    canonical.photoApproved = true;
    if (/\/player-images\/fut23_[a-z0-9_]+\./i.test(photo)) {
      canonical.photoManifestApproved = true;
      canonical.rightsReviewed = true;
      canonical.imageValidated = true;
    }
  }
  return canonical;
}

export function indexCatalog(cards) {
  const index = new Map();
  for (const card of cards || []) {
    const canonical = canonicalCard(card);
    if (!canonical || index.has(canonical.id)) continue;
    index.set(canonical.id, canonical);
  }
  return index;
}

function primaryRole(position) {
  const token = String(position || '').toUpperCase().split(/[^A-Z]+/).find(Boolean);
  return token || '';
}

function listedRole(position, role) {
  return String(position || '')
    .toUpperCase()
    .split(/[^A-Z]+/)
    .filter(Boolean)
    .includes(role);
}

/**
 * Pick 11 catalog cards for a 4-3-3.
 * A printed primary position wins. A listed alternate is next. Otherwise the
 * existing suitability scale may use a compromise fit of 50 or better.
 * Nothing here changes a player's printed position.
 */
export function suggestEleven(cards) {
  const used = new Set();
  const chosen = [];
  const assignments = [];
  for (const [slotId, role] of SUGGESTED_XI) {
    const available = (cards || []).filter((item) => item && item.id != null && !used.has(String(item.id)));
    const exact = available.find((item) => primaryRole(item.position) === role);
    const listed = exact || available.find((item) => listedRole(item.position, role));
    let card = listed || null;
    if (!card) {
      let bestScore = 0;
      for (const item of available) {
        const score = positionSuitability(item.position, role);
        if (score == null || score < 50 || score <= bestScore) continue;
        card = item;
        bestScore = score;
      }
    }
    if (!card) return null;
    used.add(String(card.id));
    chosen.push(card);
    assignments.push({ slotId, cardId: card.id });
  }
  return { cards: chosen, assignments, formation: '4-3-3' };
}

export function squadCardIds(member) {
  return new Set((member?.squad?.cards || []).map((card) => String(card.id)));
}

export function squadsOverlap(home, away) {
  const owned = squadCardIds(home);
  return [...squadCardIds(away)].some((id) => owned.has(id));
}

/**
 * The simulator receives the confirmed XI and the shared squad strength.
 * A missing strength is a failure. It is not replaced with 75.
 */
export function sideFromMember(member) {
  const lineup = member?.squad?.lineup;
  const cards = member?.squad?.cards || [];
  if (!lineup?.confirmed) {
    return {
      ok: false,
      error: 'LINEUP_NOT_CONFIRMED',
      message: 'Confirm a starting XI before this match can be played.'
    };
  }
  const team = selectionFromLineup(cards, lineup);
  if (team.length !== 11) {
    return {
      ok: false,
      error: LINEUP_ERRORS.TEAM_INCOMPLETE,
      message: 'The confirmed XI needs 11 different players from this squad.'
    };
  }
  const overall = assignedStrength(team.map((card) => ({
    card,
    role: card.assignedPosition
  })));
  if (!Number.isFinite(overall)) {
    return {
      ok: false,
      error: 'SQUAD_INVALID',
      message: 'Squad strength is unavailable for this XI.'
    };
  }
  return {
    ok: true,
    side: {
      playerId: member.memberId,
      username: member.displayName,
      overall,
      team: team.map((card) => ({
        id: card.id,
        name: card.name,
        position: card.position,
        assignedPosition: card.assignedPosition,
        stats: { ...(card.stats || {}) }
      }))
    }
  };
}

export function confirmationCurrent(member, confirmation) {
  if (!confirmation || !member?.squad?.lineup) return false;
  return confirmation.memberId === member.memberId
    && member.squad.lineup.confirmed === true
    && confirmation.lineupRevision === member.squad.lineup.revision
    && confirmation.squadRevision === member.squad.revision;
}

function cleanEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const minute = Number(event.minute);
  if (!Number.isInteger(minute) || minute < 1 || minute > 90) return null;
  return {
    minute,
    team: typeof event.team === 'string' ? event.team.slice(0, 40) : '',
    type: event.type === 'goal' ? 'goal' : 'goal',
    player: typeof event.player === 'string' ? event.player.slice(0, 60) : 'Unknown',
    assist: typeof event.assist === 'string' ? event.assist.slice(0, 60) : null
  };
}

/**
 * Keep the simulator's score. Ignore any winner that does not match the goals.
 */
export function resultFromSimulation(simulated, home, away) {
  const homeGoals = simulated?.team1?.goals;
  const awayGoals = simulated?.team2?.goals;
  if (!Number.isInteger(homeGoals) || homeGoals < 0 || homeGoals > 30) return null;
  if (!Number.isInteger(awayGoals) || awayGoals < 0 || awayGoals > 30) return null;
  if (simulated.team1?.overall !== home.overall || simulated.team2?.overall !== away.overall) {
    return null;
  }
  const possession = simulated.matchStats?.possession;
  const events = Array.isArray(simulated.events)
    ? simulated.events.map(cleanEvent).filter(Boolean).slice(0, 30)
    : [];
  return {
    homeGoals,
    awayGoals,
    homeOverall: home.overall,
    awayOverall: away.overall,
    isDraw: homeGoals === awayGoals,
    winnerMemberId: homeGoals === awayGoals
      ? null
      : (homeGoals > awayGoals ? home.playerId : away.playerId),
    possession: possession && Number.isInteger(possession.team1) && Number.isInteger(possession.team2)
      ? { home: possession.team1, away: possession.team2 }
      : null,
    events
  };
}
