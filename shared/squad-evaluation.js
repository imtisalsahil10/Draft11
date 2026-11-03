/**
 * SQUAD EVALUATION
 * Deterministic lineup rules and ratings. The UI and the server share this
 * module. Persisted ratings are still calculated on the server.
 *
 * Squad strength is the average of the placed players who can be rated.
 * Empty places are not scored as zero. They lower coverage and block confirmation.
 *
 * Each placed player scores three parts, when those parts exist:
 *   position fit  45%
 *   overall       35%
 *   role stats    20%  (pace, shooting, passing, defense, physical)
 * A missing number is skipped and the remaining weights are divided by the
 * weights that are left. Nothing is replaced with a default such as 75.
 * Stats outside 0–99 are clamped only while they are combined.
 *
 * Position fit uses the positions printed on the card, including alternates
 * such as "ST  CF,LW". An unknown or blank position stays unrated.
 *   100  same role
 *   90+  natural (exact, or a very close same-band role)
 *   70+  suitable
 *   50+  compromise
 *   below 50  out of position
 * Goalkeeper and outfield roles score 12 against each other.
 * Wide roles on the same flank (LB/LWB/LM/LW and RB/RWB/RM/RW) score at least 78.
 *
 * Coverage is the percentage of the 11 places filled by a natural or suitable fit.
 */

export const FORMATION_IDS = ['4-3-3', '4-2-3-1', '3-5-2'];

export const SQUAD_RATING = {
  suitabilityWeight: 0.45,
  overallWeight: 0.35,
  attributeWeight: 0.20,
  naturalAt: 90,
  suitableAt: 70,
  compromiseAt: 50,
  statClamp: { min: 0, max: 99 },
  summary:
    'Squad strength averages the placed players. Each score is 45% position fit, 35% overall, and 20% role stats (pace, shooting, passing, defense, physical). Missing numbers are left out and the rest are reweighted. No default rating is filled in. Empty places are not scored as zero. Coverage is how many of the 11 places have a natural or suitable fit.'
};

export const LINEUP_ERRORS = {
  CARD_NOT_OWNED: 'CARD_NOT_OWNED',
  DUPLICATE_PLAYER: 'DUPLICATE_PLAYER',
  STALE_LINEUP: 'STALE_LINEUP',
  INVALID_FORMATION: 'INVALID_FORMATION',
  AUCTION_NOT_FINISHED: 'AUCTION_NOT_FINISHED',
  INVALID_POSITION: 'INVALID_POSITION',
  TEAM_INCOMPLETE: 'TEAM_INCOMPLETE',
  INVALID_PARAMETERS: 'INVALID_PARAMETERS',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND'
};

const ROLES = {
  GK: { band: 'gk', side: 'C' },
  CB: { band: 'def', side: 'C' },
  LB: { band: 'def', side: 'L' },
  RB: { band: 'def', side: 'R' },
  LWB: { band: 'mid', side: 'L' },
  RWB: { band: 'mid', side: 'R' },
  CDM: { band: 'mid', side: 'C' },
  CM: { band: 'mid', side: 'C' },
  CAM: { band: 'mid', side: 'C' },
  LM: { band: 'mid', side: 'L' },
  RM: { band: 'mid', side: 'R' },
  LW: { band: 'att', side: 'L' },
  RW: { band: 'att', side: 'R' },
  CF: { band: 'att', side: 'C' },
  ST: { band: 'att', side: 'C' }
};

const BAND_INDEX = { gk: 0, def: 1, mid: 2, att: 3 };
const WIDE_LEFT = ['LB', 'LWB', 'LM', 'LW'];
const WIDE_RIGHT = ['RB', 'RWB', 'RM', 'RW'];

const ROLE_STAT_WEIGHTS = {
  GK: { defense: 0.4, physical: 0.25, passing: 0.2, pace: 0.15 },
  CB: { defense: 0.45, physical: 0.3, pace: 0.15, passing: 0.1 },
  LB: { pace: 0.3, defense: 0.3, passing: 0.25, physical: 0.15 },
  RB: { pace: 0.3, defense: 0.3, passing: 0.25, physical: 0.15 },
  LWB: { pace: 0.35, passing: 0.25, defense: 0.25, physical: 0.15 },
  RWB: { pace: 0.35, passing: 0.25, defense: 0.25, physical: 0.15 },
  CDM: { defense: 0.3, passing: 0.3, physical: 0.25, pace: 0.15 },
  CM: { passing: 0.4, pace: 0.2, physical: 0.2, defense: 0.2 },
  CAM: { passing: 0.35, shooting: 0.3, pace: 0.25, physical: 0.1 },
  LM: { pace: 0.35, passing: 0.3, shooting: 0.2, physical: 0.15 },
  RM: { pace: 0.35, passing: 0.3, shooting: 0.2, physical: 0.15 },
  LW: { pace: 0.4, shooting: 0.25, passing: 0.25, physical: 0.1 },
  RW: { pace: 0.4, shooting: 0.25, passing: 0.25, physical: 0.1 },
  CF: { shooting: 0.4, pace: 0.25, passing: 0.2, physical: 0.15 },
  ST: { shooting: 0.45, pace: 0.25, physical: 0.2, passing: 0.1 }
};

export const FORMATIONS = {
  '4-3-3': {
    id: '4-3-3',
    label: '4-3-3',
    slots: [
      { id: 'gk', role: 'GK', line: 'gk', x: 50, y: 86 },
      { id: 'lb', role: 'LB', line: 'def', x: 14, y: 68 },
      { id: 'lcb', role: 'CB', line: 'def', x: 37, y: 68 },
      { id: 'rcb', role: 'CB', line: 'def', x: 63, y: 68 },
      { id: 'rb', role: 'RB', line: 'def', x: 86, y: 68 },
      { id: 'lcm', role: 'CM', line: 'mid', x: 22, y: 46 },
      { id: 'cm', role: 'CM', line: 'mid', x: 50, y: 46 },
      { id: 'rcm', role: 'CM', line: 'mid', x: 78, y: 46 },
      { id: 'lw', role: 'LW', line: 'att', x: 18, y: 20 },
      { id: 'st', role: 'ST', line: 'att', x: 50, y: 20 },
      { id: 'rw', role: 'RW', line: 'att', x: 82, y: 20 }
    ]
  },
  '4-2-3-1': {
    id: '4-2-3-1',
    label: '4-2-3-1',
    slots: [
      { id: 'gk', role: 'GK', line: 'gk', x: 50, y: 86 },
      { id: 'lb', role: 'LB', line: 'def', x: 14, y: 70 },
      { id: 'lcb', role: 'CB', line: 'def', x: 37, y: 70 },
      { id: 'rcb', role: 'CB', line: 'def', x: 63, y: 70 },
      { id: 'rb', role: 'RB', line: 'def', x: 86, y: 70 },
      { id: 'lcdm', role: 'CDM', line: 'dm', x: 36, y: 52 },
      { id: 'rcdm', role: 'CDM', line: 'dm', x: 64, y: 52 },
      { id: 'lw', role: 'LW', line: 'am', x: 18, y: 32 },
      { id: 'cam', role: 'CAM', line: 'am', x: 50, y: 32 },
      { id: 'rw', role: 'RW', line: 'am', x: 82, y: 32 },
      { id: 'st', role: 'ST', line: 'att', x: 50, y: 14 }
    ]
  },
  '3-5-2': {
    id: '3-5-2',
    label: '3-5-2',
    slots: [
      { id: 'gk', role: 'GK', line: 'gk', x: 50, y: 86 },
      { id: 'lcb', role: 'CB', line: 'def', x: 26, y: 68 },
      { id: 'cb', role: 'CB', line: 'def', x: 50, y: 68 },
      { id: 'rcb', role: 'CB', line: 'def', x: 74, y: 68 },
      { id: 'lwb', role: 'LWB', line: 'mid', x: 12, y: 44 },
      { id: 'lcm', role: 'CM', line: 'mid', x: 31, y: 44 },
      { id: 'cdm', role: 'CDM', line: 'mid', x: 50, y: 44 },
      { id: 'rcm', role: 'CM', line: 'mid', x: 69, y: 44 },
      { id: 'rwb', role: 'RWB', line: 'mid', x: 88, y: 44 },
      { id: 'lst', role: 'ST', line: 'att', x: 38, y: 16 },
      { id: 'rst', role: 'ST', line: 'att', x: 62, y: 16 }
    ]
  }
};

function tokenizePositions(position) {
  return [...new Set(
    String(position)
      .toUpperCase()
      .split(/[^A-Z]+/)
      .filter(Boolean)
  )];
}

function sidePenalty(left, right) {
  if (left === right) return 0;
  if (left === 'C' || right === 'C') return 8;
  return 18;
}

function sameWideChannel(natural, slot) {
  return (WIDE_LEFT.includes(natural) && WIDE_LEFT.includes(slot))
    || (WIDE_RIGHT.includes(natural) && WIDE_RIGHT.includes(slot));
}

function pairScore(natural, slot) {
  if (natural === slot) return 100;
  const from = ROLES[natural];
  const to = ROLES[slot];
  if (!from || !to) return null;
  if (from.band === 'gk' || to.band === 'gk') return 12;
  const distance = Math.abs(BAND_INDEX[from.band] - BAND_INDEX[to.band]);
  const penalty = sidePenalty(from.side, to.side);
  let score;
  if (distance === 0) score = Math.max(60, 92 - penalty);
  else if (distance === 1) score = Math.max(30, 56 - penalty);
  else score = Math.max(16, 30 - penalty);
  if (sameWideChannel(natural, slot)) score = Math.max(score, 78);
  return score;
}

export function positionSuitability(position, slotRole) {
  if (position == null || String(position).trim() === '') return null;
  if (!ROLES[slotRole]) return null;
  const known = tokenizePositions(position).filter((token) => ROLES[token]);
  if (known.length === 0) return null;
  return Math.max(...known.map((token) => pairScore(token, slotRole)));
}

export function suitabilityLabel(score) {
  if (score == null) return { key: 'unknown', label: 'Unrated' };
  if (score >= SQUAD_RATING.naturalAt) return { key: 'natural', label: 'Natural' };
  if (score >= SQUAD_RATING.suitableAt) return { key: 'suitable', label: 'Suitable' };
  if (score >= SQUAD_RATING.compromiseAt) return { key: 'compromise', label: 'Compromise' };
  return { key: 'mismatch', label: 'Out of position' };
}

function readStat(stats, key) {
  const value = stats?.[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function clampStat(value) {
  return Math.min(
    SQUAD_RATING.statClamp.max,
    Math.max(SQUAD_RATING.statClamp.min, value)
  );
}

function ownedCard(cards, cardId) {
  if (cardId == null) return null;
  const key = String(cardId);
  return (cards || []).find((card) => card && card.id != null && String(card.id) === key) || null;
}

function slotSource(lineup) {
  if (!lineup) return [];
  if (Array.isArray(lineup.slots)) return lineup.slots;
  if (Array.isArray(lineup.assignments)) return lineup.assignments;
  return [];
}

export function normalizeSlots(formationId, slots) {
  const formation = FORMATIONS[formationId];
  if (!formation) return [];
  const incoming = new Map();
  for (const slot of slots || []) {
    if (!slot?.slotId || !formation.slots.some((item) => item.id === slot.slotId)) continue;
    incoming.set(slot.slotId, slot.cardId ?? null);
  }
  return formation.slots.map((slot) => ({
    slotId: slot.id,
    cardId: incoming.has(slot.id) ? incoming.get(slot.id) : null
  }));
}

function ratePlayer(card, role) {
  const suitability = card ? positionSuitability(card.position, role) : null;
  const weights = ROLE_STAT_WEIGHTS[role] || {};
  const missing = [];
  const present = [];
  for (const [key, weight] of Object.entries(weights)) {
    const value = readStat(card?.stats, key);
    if (value == null) missing.push(key);
    else present.push({ weight, value: clampStat(value) });
  }
  const overall = readStat(card?.stats, 'overall');
  if (overall == null) missing.push('overall');
  if (card && suitability == null) missing.push('position');

  let attributeFit = null;
  if (present.length > 0) {
    const weightSum = present.reduce((sum, part) => sum + part.weight, 0);
    attributeFit = Math.round(
      present.reduce((sum, part) => sum + (part.value * part.weight), 0) / weightSum
    );
  }

  const parts = [];
  if (suitability != null) parts.push({ weight: SQUAD_RATING.suitabilityWeight, value: suitability });
  if (overall != null) parts.push({ weight: SQUAD_RATING.overallWeight, value: clampStat(overall) });
  if (attributeFit != null) parts.push({ weight: SQUAD_RATING.attributeWeight, value: attributeFit });

  let score = null;
  if (parts.length > 0) {
    const weightSum = parts.reduce((sum, part) => sum + part.weight, 0);
    score = Math.round(parts.reduce((sum, part) => sum + (part.value * part.weight), 0) / weightSum);
  }

  return {
    suitability,
    fit: suitabilityLabel(suitability),
    attributeFit,
    overall: overall == null ? null : clampStat(overall),
    missing,
    score
  };
}

/**
 * Same player score as a placed lineup, for a list of cards that already
 * have roles. Missing numbers are left out. No default such as 75 is filled in.
 * Entries are `{ card, role }` or cards with `assignedPosition`.
 */
export function assignedStrength(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const scores = [];
  for (const entry of entries) {
    if (!entry) continue;
    const card = entry.card || entry;
    const role = entry.role || entry.assignedPosition;
    if (!ROLES[role]) continue;
    const score = ratePlayer(card, role).score;
    if (score != null) scores.push(score);
  }
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function weakReasons(slot) {
  if (slot.cardId == null) return ['Empty'];
  const reasons = [];
  if (slot.suitability == null) reasons.push('Position unknown');
  else if (slot.suitability < SQUAD_RATING.compromiseAt) reasons.push('Out of position');
  else if (slot.suitability < SQUAD_RATING.suitableAt) reasons.push('Compromise');
  if (slot.missing.length > 0) reasons.push('Missing attributes');
  return reasons;
}

function summaryFor(filled, strength, coverage, weak) {
  if (!filled) {
    return 'No players placed yet. Acquired players stay on the bench until you give them a place.';
  }
  const parts = [`${filled} of 11 places filled.`];
  parts.push(strength == null ? 'Squad strength is unavailable.' : `Squad strength ${strength}.`);
  parts.push(`Suitable coverage ${coverage.percent}%.`);
  const flags = weak.filter((item) => item.reason !== 'Missing attributes');
  if (flags.length > 0) {
    const shown = flags.slice(0, 4).map((item) => `${item.role} ${item.reason.toLowerCase()}`);
    parts.push(`Needs attention: ${shown.join(', ')}.`);
  } else if (filled === 11) {
    parts.push('Every place has a natural or suitable fit.');
  }
  return parts.join(' ');
}

export function evaluateSquad(ownedCards, lineup) {
  const formationId = lineup?.formation && FORMATIONS[lineup.formation] ? lineup.formation : null;
  const required = 11;
  if (!formationId) {
    return {
      formation: null,
      complete: false,
      filled: 0,
      required,
      strength: null,
      coverage: { percent: 0, suitable: 0, natural: 0, filled: 0, required },
      slots: [],
      weak: [],
      summary: 'Choose a formation.'
    };
  }

  const formation = FORMATIONS[formationId];
  const assignments = normalizeSlots(formationId, slotSource(lineup));
  const slots = formation.slots.map((slot) => {
    const assignment = assignments.find((item) => item.slotId === slot.id);
    const card = ownedCard(ownedCards, assignment?.cardId);
    const rating = card
      ? ratePlayer(card, slot.role)
      : {
          suitability: null,
          fit: suitabilityLabel(null),
          attributeFit: null,
          overall: null,
          missing: [],
          score: null
        };
    return {
      slotId: slot.id,
      role: slot.role,
      cardId: card ? card.id : null,
      ...rating
    };
  });

  const weak = [];
  for (const slot of slots) {
    for (const reason of weakReasons(slot)) {
      weak.push({
        slotId: slot.slotId,
        role: slot.role,
        cardId: slot.cardId,
        reason
      });
    }
  }

  const scores = slots.map((slot) => slot.score).filter((score) => score != null);
  const strength = scores.length
    ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
    : null;
  const filled = slots.filter((slot) => slot.cardId != null).length;
  const suitable = slots.filter((slot) => (
    slot.suitability != null && slot.suitability >= SQUAD_RATING.suitableAt
  )).length;
  const natural = slots.filter((slot) => (
    slot.suitability != null && slot.suitability >= SQUAD_RATING.naturalAt
  )).length;
  const coverage = {
    percent: Math.round((suitable / required) * 100),
    suitable,
    natural,
    filled,
    required
  };

  return {
    formation: formationId,
    complete: filled === required,
    filled,
    required,
    strength,
    coverage,
    slots,
    weak,
    summary: summaryFor(filled, strength, coverage, weak)
  };
}

export function presentLineup(ownedCards, lineup) {
  const formation = lineup?.formation && FORMATIONS[lineup.formation]
    ? lineup.formation
    : '4-3-3';
  const assignments = normalizeSlots(formation, slotSource(lineup));
  const evaluation = evaluateSquad(ownedCards, { formation, slots: assignments });
  return {
    formation,
    revision: Number.isInteger(lineup?.revision) ? lineup.revision : 0,
    confirmed: Boolean(lineup?.confirmed) && evaluation.complete,
    assignments,
    evaluation
  };
}

export function selectionFromLineup(ownedCards, lineup) {
  if (!lineup?.confirmed || !FORMATIONS[lineup.formation]) return [];
  const formation = FORMATIONS[lineup.formation];
  const assignments = normalizeSlots(lineup.formation, slotSource(lineup));
  const picked = [];
  const seen = new Set();
  for (const slot of formation.slots) {
    const assignment = assignments.find((item) => item.slotId === slot.id);
    const card = ownedCard(ownedCards, assignment?.cardId);
    if (!card) return [];
    const key = String(card.id);
    if (seen.has(key)) return [];
    seen.add(key);
    picked.push({ ...card, assignedPosition: slot.role });
  }
  return picked.length === formation.slots.length ? picked : [];
}

function fail(error, message, lineup) {
  return { ok: false, error, message, lineup: lineup || null };
}

/**
 * Validate a lineup change against cards the seat actually owns.
 * `assignments`, when present, replaces every place in the formation.
 * Omit `assignments` to keep players whose place still exists.
 * Acquired cards are never removed here.
 */
export function applyLineupChange({
  ownedCards,
  lineup,
  formation,
  assignments,
  expectedRevision,
  confirm = false
}) {
  const current = presentLineup(ownedCards, lineup);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return fail(
      LINEUP_ERRORS.INVALID_PARAMETERS,
      'Lineup revision is required.',
      current
    );
  }
  if (expectedRevision !== current.revision) {
    return fail(
      LINEUP_ERRORS.STALE_LINEUP,
      'This lineup is out of date. The saved lineup is shown again.',
      current
    );
  }

  const nextFormation = formation == null ? current.formation : formation;
  if (!FORMATIONS[nextFormation]) {
    return fail(
      LINEUP_ERRORS.INVALID_FORMATION,
      'Choose 4-3-3, 4-2-3-1, or 3-5-2.',
      current
    );
  }

  const hasAssignments = assignments !== undefined && assignments !== null;
  if (hasAssignments && !Array.isArray(assignments)) {
    return fail(
      LINEUP_ERRORS.INVALID_PARAMETERS,
      'Assignments have to be a list of places.',
      current
    );
  }
  if (!hasAssignments && nextFormation === current.formation && !confirm) {
    return { ok: true, unchanged: true, lineup: current };
  }

  let slots;
  if (hasAssignments) {
    const formationSlots = FORMATIONS[nextFormation].slots;
    const chosen = new Map(formationSlots.map((slot) => [slot.id, null]));
    for (const assignment of assignments) {
      if (!assignment || typeof assignment.slotId !== 'string') {
        return fail(
          LINEUP_ERRORS.INVALID_PARAMETERS,
          'Each assignment needs a place.',
          current
        );
      }
      if (!chosen.has(assignment.slotId)) {
        return fail(
          LINEUP_ERRORS.INVALID_POSITION,
          'That place is not in this formation.',
          current
        );
      }
      const raw = assignment.cardId;
      if (raw == null || raw === '') {
        chosen.set(assignment.slotId, null);
        continue;
      }
      const card = ownedCard(ownedCards, raw);
      if (!card) {
        return fail(
          LINEUP_ERRORS.CARD_NOT_OWNED,
          'You can only place players this room bought.',
          current
        );
      }
      chosen.set(assignment.slotId, card.id);
    }
    const used = [];
    for (const cardId of chosen.values()) {
      if (cardId == null) continue;
      if (used.some((id) => String(id) === String(cardId))) {
        return fail(
          LINEUP_ERRORS.DUPLICATE_PLAYER,
          'A player can only take one place.',
          current
        );
      }
      used.push(cardId);
    }
    slots = formationSlots.map((slot) => ({
      slotId: slot.id,
      cardId: chosen.get(slot.id)
    }));
  } else {
    const carried = normalizeSlots(nextFormation, current.assignments);
    const seen = new Set();
    slots = carried.map((slot) => {
      if (slot.cardId == null) return slot;
      const card = ownedCard(ownedCards, slot.cardId);
      const key = card ? String(card.id) : '';
      if (!card || seen.has(key)) return { slotId: slot.slotId, cardId: null };
      seen.add(key);
      return { slotId: slot.slotId, cardId: card.id };
    });
  }

  const filled = slots.filter((slot) => slot.cardId != null).length;
  if (confirm && filled !== 11) {
    return fail(
      LINEUP_ERRORS.TEAM_INCOMPLETE,
      'Fill all 11 places before confirming.',
      current
    );
  }

  const stored = {
    formation: nextFormation,
    revision: current.revision + 1,
    confirmed: Boolean(confirm),
    slots
  };
  return {
    ok: true,
    stored,
    lineup: presentLineup(ownedCards, stored)
  };
}
